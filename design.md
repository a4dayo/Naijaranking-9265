# NaijaRank — Design

Crowdsourced leaderboard platform for Nigeria. Web only (Bun + Vite + React + Hono + Drizzle/Turso).
Visual direction: **live scoreboard** — big rank numerals, movement arrows, ticker energy, zero editorial
voice. Mobile-first: everything usable at 360px with 44px tap targets. Light and dark mode both shipped.

## Brand & Colors

CSS variables in `packages/web/src/web/styles.css`. Naija green as the dominant, hot orange as the single
sharp accent (movement, heat, "vote now"), red reserved for downward movement and destructive admin acts.

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| background | `#FBFAF6` warm paper | `#07100B` green-black | Page background |
| card | `#FFFFFF` | `#0D1A12` | Rank rows, panels |
| foreground | `#0B1410` | `#F2F7F3` | Primary text |
| mutedForeground | `#5C6B61` | `#8FA396` | Meta, timestamps |
| primary | `#0B5D2E` | `#17C964` | Vote button, brand marks |
| accent (heat) | `#FF6B1A` | `#FF7A2F` | Movers, live ticker, CTAs |
| up | `#0FA958` | `#2FD97A` | +delta arrow |
| down | `#D92D20` | `#FF5A4E` | −delta arrow |
| border | `#E6E3D9` | `#1B2C21` | Hairlines |
| gold/silver/bronze | `#C79A2E` / `#8A94A0` / `#A3653B` | same | Top-3 rank numerals |

Sponsored slots get a dashed amber outline + explicit "Sponsored" label — never disguised as rank.

## Typography

- **Display**: Bricolage Grotesque (600/800) — board titles, rank numerals, hero.
- **Body**: Plus Jakarta Sans (400/500/600) — everything else.
- Loaded from Google Fonts with `display=swap`, weight-limited to stay under the 250KB page budget.
- Rank numerals are tabular, oversized (32–56px), tracking-tight.

## Pages

- **Home** (`src/web/pages/index.tsx`) — hero with the live #1 board, single "Start voting" CTA, trust strip
  (one vote per person / live not editorial / open and audited), filterable board grid, activity ticker.
- **Board** (`src/web/pages/board.tsx`, `/b/:slug`) — ranked rows (rank, name, claimed badge, sponsored
  label, 24h delta, votes, vote button), header with total votes + countdown + last-updated, sidebar with
  biggest movers + integrity note, nomination input, share buttons, reactions.
- **Results** (`src/web/pages/results.tsx`, `/b/:slug/results`) — frozen, read-only, indexable final table.
- **Admin** (`src/web/pages/admin.tsx`, `/admin`) — login, board CRUD + publish/freeze, CSV seeding,
  moderation queue (nominations, reports, claims), fraud queue with bulk void, metrics, audit log.
- **Privacy / Terms** (`src/web/pages/legal.tsx`) — NDPA 2023 lawful basis, 90-day IP purge, deletion path.

## Key Flows

1. **Vote**: tap Vote → unverified vote counted at 0.25 immediately (no login wall) → inline OTP modal
   "make your vote count" → verify → same vote reweighted to 1.0 → row shows "✓ Voted" → list reorders →
   share card prompt. Return visit within 180 days: one tap, no OTP.
2. **Move vote**: voting another entry on the same board moves it atomically → toast "Moved your vote from X to Y."
3. **Freeze**: operator freezes a board → `/b/:slug/results` becomes the permanent artifact.

## Motion

One orchestrated page load (staggered rank-row reveal), then only meaningful motion: rank rows animate
their position change on reorder, delta arrows pulse once, vote button has an instant optimistic state.
No decorative animation — the polling refresh (20–30s, active page only) must not feel busy.

## Architecture

- API: oRPC procedures in `src/api/routes/`, Drizzle on Turso (SQLite). Vote logic in one transactional
  service (`src/api/services/vote.ts`) — the server decides all counts; the client only renders.
- Sessions: HMAC-signed tokens, HttpOnly cookie (180 days) + localStorage bearer mirror so voting also
  works inside the preview iframe.
- Jobs: 30s vote reconciliation + integrity scan started once per process in `src/api/services/jobs.ts`.
