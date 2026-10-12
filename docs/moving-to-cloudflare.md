# Moving NaijaRank from Runable to Cloudflare

NaijaRank now runs as a **Cloudflare Worker**: the website is served as static
assets, `/api/*` runs the Hono API, Cron Triggers run the background jobs, and
a Durable Object holds the rate-limit counters. The database stays on
**Turso** (libSQL), moved into an account you own.

Nothing here touches the Runable site, which keeps running until you switch.
Do steps 1–6 at any time; step 7 is the cutover.

## 1. Get the data out of Runable

**Path A — database credentials (preferred).** Ask Runable for the values of
`DATABASE_URL`, `DATABASE_AUTH_TOKEN` and `SESSION_SECRET` (or
`BETTER_AUTH_SECRET`) from the project's `.env`. With those, the copy script
reads the old database directly.

**Path B — export through the app.** If Runable will not hand over the
credentials, the app itself can export the data: `admin.exportTable` is
owner-only and re-checks the owner's password on every page. It has to be
running on Runable first, so ask Runable to deploy this branch there. Then
use the `SOURCE_APP_URL` form of the copy command in step 4.

> Keep the old `SESSION_SECRET` if you can get it and reuse it in step 5. It
> keys the identity hash that stops erase-and-revote. Admin passwords and
> votes copy over fine without it.

## 2. Create your own Turso database

Install the [Turso CLI](https://docs.turso.tech/cli/introduction), then:

```sh
turso auth signup            # or: turso auth login
turso db create naijarank    # pick the location closest to your users
turso db show naijarank --url
turso db tokens create naijarank
```

Keep the URL (`libsql://…`) and the token. Those are the new
`DATABASE_URL` and `DATABASE_AUTH_TOKEN`.

## 3. Put the schema in the new database

From `packages/web`:

```sh
DATABASE_URL=libsql://naijarank-<you>.turso.io DATABASE_AUTH_TOKEN=<new token> \
  bun scripts/db-push.ts
```

Use this script rather than `drizzle-kit push --force`. The script prints
every statement and refuses anything that would delete data. `--force`
approves deletions silently: adding a `NOT NULL` column, for example, makes
it run `delete from <table>` first.

## 4. Copy the data

Dry run first (reads everything, writes nothing):

```sh
# Path A
SOURCE_DATABASE_URL=<old url> SOURCE_DATABASE_AUTH_TOKEN=<old token> \
TARGET_DATABASE_URL=<new url> TARGET_DATABASE_AUTH_TOKEN=<new token> \
  bun scripts/copy-data.ts --dry-run

# Path B
SOURCE_APP_URL=https://<your-app>.runable.site \
SOURCE_ADMIN_EMAIL=<owner email> SOURCE_ADMIN_PASSWORD=<owner password> \
TARGET_DATABASE_URL=<new url> TARGET_DATABASE_AUTH_TOKEN=<new token> \
  bun scripts/copy-data.ts --dry-run
```

Drop `--dry-run` to copy. The script refuses to write into a non-empty
database, and it checks the row count of every table at the end. Sessions
and one-time codes are not copied; they expire anyway, and sessions are
tied to the old address.

## 5. Connect Cloudflare and GitHub

1. Create a Cloudflare account, then an API token from the **Edit Cloudflare
   Workers** template. Note your **Account ID**, shown in the dashboard sidebar.
2. Choose a plan. The free Workers plan allows only a few milliseconds of CPU
   per request, and admin password hashing needs more than that. **Workers
   Paid** removes the limit. Check current pricing on Cloudflare's site.
3. In GitHub, go to **Settings → Secrets and variables → Actions**. Add these
   secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `DATABASE_URL`
   - `DATABASE_AUTH_TOKEN`
   - `SESSION_SECRET` — the old one if you have it, otherwise a new long random string
   - `RESEND_API_KEY`
4. Under **Settings → Environments**, create an environment called
   `production`. You can add yourself as a required reviewer, so every deploy
   waits for your OK.

## 6. First deploy

Merge to `main`, or run **Actions → Deploy to Cloudflare → Run workflow**.
The workflow:

1. Runs the tests and type-checks the Worker.
2. Applies any schema changes, with the same guard as step 3.
3. Builds the site and deploys the Worker with its secrets.

The site appears at `https://naijarank.<your-subdomain>.workers.dev`. Check it:

- Boards load, with the same totals as on Runable.
- Admin sign-in works with your existing password.
- A test vote shows as pending, then counts after you verify your email.

Within a minute of the first deploy, the reconcile job converts any old
0.25-weight anonymous votes into pending votes. Frozen boards are left as
they closed.

## 7. Cut over

1. Pick a quiet hour. Votes cast on Runable after the final copy are not
   carried over.
2. Empty the new database and copy again for a final, fresh copy. The
   simplest way is to recreate it with `turso db destroy naijarank`, then
   repeat steps 2–4.
3. In Cloudflare, go to **Workers → naijarank → Settings → Domains & Routes**
   and add your custom domain. The domain's DNS must be on Cloudflare.
4. Ask Runable to redirect the old `*.runable.site` address to the new
   domain, or take it down. Share links people have already posted point at
   the old address.

## Running it locally

- `bun run dev` from the repo root is unchanged: Vite plus the Bun API.
- To run the real Worker locally, create `packages/web/.dev.vars` with
  `DATABASE_URL`, `DATABASE_AUTH_TOKEN` and `SESSION_SECRET`, then run
  `bun run dev:worker` in `packages/web`. `DATABASE_URL` must be an `http(s)`
  or `libsql://` address, because a Worker cannot open a local file. For a
  local server, use `turso dev`.

## What changed in the code

| Piece | On Runable (Bun process) | On Cloudflare |
|---|---|---|
| Web + API | `src/__server.ts` | `src/worker.ts` + Static Assets (`wrangler.jsonc`) |
| Background jobs | `setInterval` | Cron Triggers: reconcile every minute (was 30s), scan every 5 min, snapshot hourly, IP purge daily |
| Rate limits | process memory | `RateLimiter` Durable Object, shared by all isolates |
| Client IP / ASN | `X-Forwarded-For` | `cf-connecting-ip` / `request.cf.asn` (cannot be spoofed) |
| Fire-and-forget writes | ran after the response | kept alive with `ctx.waitUntil` |
| Runable badge, analytics script, `@runablehq/website-runtime` | present | removed |

The `desktop` and `mobile` packages were not changed.
