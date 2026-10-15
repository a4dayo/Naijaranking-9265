# WhodeyTop

Crowdsourced leaderboards for Nigeria. Hosted on Cloudflare Workers with a Turso (libSQL) database; every push to `main` deploys through GitHub Actions.

- **Moving from Runable / first deploy:** [docs/moving-to-cloudflare.md](docs/moving-to-cloudflare.md)
- **Run locally:** `bun install`, then `bun run dev` (Vite + Bun API). `bun run test` runs the test suite.
- **Product and design notes:** [design.md](design.md)

## Original template notes

Runable copies this Bun and Turborepo project into each new sandbox.

The root package commands are the external contract:

- `bun run dev` starts the web app.
- `bun run dev:desktop` and `bun run dev:mobile` start platform clients.
- `bun run build` builds every package.
- `bun run start` starts or restarts the production server.
- `bun run stop` stops the production server.
- `bun run lint` and `bun run typecheck` validate the project.
- The `db:generate`, `db:migrate`, and `db:push` commands manage the database.

Deployment tools depend on these command names. Their implementations may change, but the names must remain stable.

The web package owns the API, database, and shared web interface. The mobile package is an Expo client. The desktop package is an Electron shell around the web app. Services use the fixed ports defined in `__ports.cjs`, and the web health endpoint is `/api/health`.

Secrets belong in the root `.env` file. Browser values must use the `VITE_` prefix. Commands prefixed with `internal:` are for template maintenance.
