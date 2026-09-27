import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createApp } from "./__core/app";
import { db } from "./database";
import * as schema from "./database/schema";
import { admin } from "./routes/admin";
import { boards } from "./routes/boards";
import { identity } from "./routes/identity";
import { ping } from "./routes/ping";
import { vote } from "./routes/vote";
import { startJobs } from "./services/jobs";
import { rankedEntries } from "./services/rank";

export const router = {
  ping,
  boards,
  vote,
  identity,
  admin,
};

export type AppRouter = typeof router;
/** Typed client for the router — used by the web and mobile api clients. */
export type AppRouterClient = RouterClient<AppRouter>;

const app = createApp(router);

/**
 * Crawler-friendly share target. The SPA cannot serve per-board OG tags itself
 * (index.html is static), so share links point here: a real HTML document with
 * the board's own title, description and image, which then forwards a human
 * straight to the board. This is what makes a WhatsApp paste render properly.
 */
app.get("/api/share/:slug", async (c) => {
  const slug = c.req.param("slug");
  const [board] = await db
    .select()
    .from(schema.boards)
    .where(eq(schema.boards.slug, slug))
    .limit(1);

  if (!board || board.status === "draft") return c.notFound();

  const entries = await rankedEntries(board.id);
  const leader = entries[0];
  const title = `${board.title} — NaijaRank`;
  const description = leader
    ? `${leader.name} is No.1 with ${leader.votesEffective} votes, out of ${board.totalVotesRaw} cast so far. Think that's wrong? One tap changes it.`
    : (board.description ?? "Nobody has voted yet. Cast the first one and set the order.");
  const image = leader?.imageUrl ?? "/og-image.png";
  const target = `/b/${board.slug}`;

  return c.html(
    `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="NaijaRank" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${escapeHtml(image)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(image)}" />
<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}" />
</head><body><p>Opening <a href="${escapeHtml(target)}">${escapeHtml(board.title)}</a>…</p>
<script>location.replace(${JSON.stringify(target)});</script>
</body></html>`,
  );
});

/** Plain-text sitemap of every published board. */
app.get("/api/sitemap.txt", async (c) => {
  const rows = await db
    .select({ slug: schema.boards.slug, status: schema.boards.status })
    .from(schema.boards);
  const origin = new URL(c.req.url).origin;
  const lines = [
    origin,
    `${origin}/legal/privacy`,
    `${origin}/legal/terms`,
    `${origin}/legal/how-voting-works`,
  ];
  for (const row of rows) {
    if (row.status === "draft") continue;
    lines.push(`${origin}/b/${row.slug}`);
    lines.push(`${origin}/b/${row.slug}/results`);
  }
  return c.text(lines.join("\n"));
});

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Reconciliation, integrity scanning and rank snapshots run in-process.
startJobs();

export default app;
