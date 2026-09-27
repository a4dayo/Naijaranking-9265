import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

const DAY = 86_400_000;

export interface RankedEntry {
  id: string;
  rank: number;
  name: string;
  subtitle: string | null;
  imageUrl: string | null;
  votesEffective: number;
  votesRaw: number;
  delta24h: number;
  claimed: boolean;
  isSponsored: boolean;
  source: string;
  status: string;
  reactions: Record<string, number>;
}

/** Ranked, votable entries of a board. Ordering is the single source of truth for rank. */
export async function rankedEntries(boardId: string): Promise<RankedEntry[]> {
  const rows = await db
    .select()
    .from(schema.entries)
    .where(and(eq(schema.entries.boardId, boardId), eq(schema.entries.status, "active")))
    .orderBy(
      desc(schema.entries.votesEffective),
      desc(schema.entries.votesRaw),
      asc(schema.entries.createdAt),
    );

  const ids = rows.map((r) => r.id);
  const reactionRows = ids.length
    ? await db
        .select({
          entryId: schema.reactions.entryId,
          emoji: schema.reactions.emoji,
          count: sql<number>`count(*)`,
        })
        .from(schema.reactions)
        .where(inArray(schema.reactions.entryId, ids))
        .groupBy(schema.reactions.entryId, schema.reactions.emoji)
    : [];

  const reactions = new Map<string, Record<string, number>>();
  for (const r of reactionRows) {
    const map = reactions.get(r.entryId) ?? {};
    map[r.emoji] = Number(r.count);
    reactions.set(r.entryId, map);
  }

  return rows.map((row, i) => ({
    id: row.id,
    rank: i + 1,
    name: row.name,
    subtitle: row.subtitle,
    imageUrl: row.imageUrl,
    votesEffective: round2(row.votesEffective),
    votesRaw: row.votesRaw,
    delta24h: row.delta24h,
    claimed: row.claimed,
    isSponsored: row.isSponsored,
    source: row.source,
    status: row.status,
    reactions: reactions.get(row.id) ?? {},
  }));
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * Snapshots current ranks and refreshes delta_24h from the snapshot closest to
 * 24h ago. Positive delta = moved up the board.
 */
export async function snapshotRanks(boardId: string) {
  const ranked = await rankedEntries(boardId);
  if (ranked.length === 0) return { snapshotted: 0 };

  const since = new Date(Date.now() - DAY - 2 * 3_600_000);
  const until = new Date(Date.now() - DAY + 2 * 3_600_000);
  const historic = await db
    .select()
    .from(schema.rankSnapshots)
    .where(
      and(
        eq(schema.rankSnapshots.boardId, boardId),
        gte(schema.rankSnapshots.takenAt, since),
        lte(schema.rankSnapshots.takenAt, until),
      ),
    )
    .orderBy(desc(schema.rankSnapshots.takenAt));

  const oldRank = new Map<string, number>();
  for (const row of historic) if (!oldRank.has(row.entryId)) oldRank.set(row.entryId, row.rank);

  for (const entry of ranked) {
    const previous = oldRank.get(entry.id);
    const delta = previous === undefined ? 0 : previous - entry.rank;
    if (delta !== entry.delta24h) {
      await db
        .update(schema.entries)
        .set({ delta24h: delta })
        .where(eq(schema.entries.id, entry.id));
    }
    await db.insert(schema.rankSnapshots).values({
      boardId,
      entryId: entry.id,
      rank: entry.rank,
      votesEffective: entry.votesEffective,
    });
  }

  // Keep the table small: snapshots older than 8 days carry no product value.
  await db
    .delete(schema.rankSnapshots)
    .where(
      and(
        eq(schema.rankSnapshots.boardId, boardId),
        lte(schema.rankSnapshots.takenAt, new Date(Date.now() - 8 * DAY)),
      ),
    );

  return { snapshotted: ranked.length };
}

/** Biggest movers panel: entries with the largest 24h vote gain. */
export async function biggestMovers(boardId: string, limit = 5) {
  const since = new Date(Date.now() - DAY);
  const rows = await db
    .select({
      entryId: schema.voteEvents.entryId,
      gained: sql<number>`sum(${schema.voteEvents.weight})`,
    })
    .from(schema.voteEvents)
    .where(and(eq(schema.voteEvents.boardId, boardId), gte(schema.voteEvents.createdAt, since)))
    .groupBy(schema.voteEvents.entryId)
    .orderBy(desc(sql`sum(${schema.voteEvents.weight})`))
    .limit(limit);

  if (rows.length === 0) return [];
  const ranked = await rankedEntries(boardId);
  const byId = new Map(ranked.map((e) => [e.id, e]));
  return rows
    .filter((r) => byId.has(r.entryId) && Number(r.gained) > 0)
    .map((r) => {
      const entry = byId.get(r.entryId)!;
      return {
        id: entry.id,
        name: entry.name,
        rank: entry.rank,
        delta24h: entry.delta24h,
        gained24h: round2(Number(r.gained)),
      };
    });
}
