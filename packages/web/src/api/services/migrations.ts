import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { audit } from "./audit";
import { reconcileBoard } from "./vote";
import { PENDING_WEIGHT } from "./weights";

/**
 * One-time data fix for the pending-vote change, safe to run on every boot.
 *
 * Before it, unverified votes counted at weight 0.25. They now count for
 * nothing until the voter verifies, so any vote still held by an unverified
 * voter is moved to pending weight and its board is reconciled. Once there is
 * nothing left to convert this is a single cheap query.
 *
 * Frozen boards are left exactly as they closed: their results are published
 * as final, and re-counting them under new rules would change a citable record.
 */
export async function convertLegacyAnonymousVotes() {
  const unverified = db
    .select({ id: schema.voters.id })
    .from(schema.voters)
    .where(isNull(schema.voters.verifiedAt));

  const openBoards = db
    .select({ id: schema.boards.id })
    .from(schema.boards)
    .where(ne(schema.boards.status, "frozen"));

  const legacy = await db
    .select({ id: schema.votes.id, boardId: schema.votes.boardId })
    .from(schema.votes)
    .where(
      and(
        eq(schema.votes.status, "counted"),
        gt(schema.votes.weight, PENDING_WEIGHT),
        inArray(schema.votes.voterId, unverified),
        inArray(schema.votes.boardId, openBoards),
      ),
    );

  await db
    .update(schema.voters)
    .set({ weight: PENDING_WEIGHT })
    .where(and(isNull(schema.voters.verifiedAt), sql`${schema.voters.weight} <> ${PENDING_WEIGHT}`));

  if (legacy.length === 0) return { converted: 0, boards: [] as string[] };

  const ids = legacy.map((row) => row.id);
  for (let i = 0; i < ids.length; i += 500) {
    await db
      .update(schema.votes)
      .set({ weight: PENDING_WEIGHT, updatedAt: new Date() })
      .where(inArray(schema.votes.id, ids.slice(i, i + 500)));
  }

  const boards = Array.from(new Set(legacy.map((row) => row.boardId)));
  for (const boardId of boards) await reconcileBoard(boardId);

  await audit({
    action: "migration.anonymous_votes_to_pending",
    metadata: { converted: legacy.length, boards },
  });
  return { converted: legacy.length, boards };
}
