import { ORPCError } from "@orpc/server";
import { and, eq, gt, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { clientAsn, clientIp, deviceFingerprint } from "../lib/request";
import { limited } from "../lib/ratelimit";
import { withBusyRetry, withLock } from "../lib/mutex";
import { isUniqueViolation } from "../lib/errors";
import { audit, track } from "./audit";
import { ensureVoter } from "./session";
import { EMAIL_WEIGHT, PENDING_WEIGHT, isPendingWeight } from "./weights";

export type VoteAction = "cast" | "moved" | "toggled_off" | "replayed";

export interface VoteResult {
  action: VoteAction;
  entryId: string | null;
  newRank: number | null;
  votesEffective: number;
  votesRaw: number;
  votesPending: number;
  /** True when this vote is held as pending (unverified) and does not affect rank. */
  pending: boolean;
  movedFrom: string | null;
  movedFromName: string | null;
  weight: number;
  verified: boolean;
  boardTotalEffective: number;
}

export interface VoteInput {
  boardId: string;
  entryId: string;
  idempotencyKey: string;
}

/**
 * The vote endpoint. Everything that decides a count happens inside one
 * transaction, server-side; the client only renders what comes back.
 *
 * Note on locking: the spec asks for `SELECT ... FOR UPDATE` on the existing
 * (board_id, voter_id) row. SQLite/libSQL has a single writer per database, so a
 * write transaction is already serialised — row locks do not exist and are not
 * needed. `unique (board_id, voter_id)` remains the real guarantee: a concurrent
 * duplicate insert fails with a constraint violation, which we catch and treat as
 * a move, exactly as specified.
 */
export async function castVote(input: VoteInput, headers: Headers): Promise<VoteResult & { issued?: { token: string; cookie: string } }> {
  const ip = clientIp(headers);
  const device = deviceFingerprint(headers);
  const asn = clientAsn(headers);

  if (!limited("voteByIp", ip).ok) throw new ORPCError("TOO_MANY_REQUESTS", { message: "Too many votes from this network. Try again in a minute." });
  if (!limited("voteByDevice", device).ok) throw new ORPCError("TOO_MANY_REQUESTS", { message: "Slow down a moment." });

  const { voter, issued } = await ensureVoter(headers);
  if (!limited("voteByVoter", voter.id).ok) throw new ORPCError("TOO_MANY_REQUESTS", { message: "Slow down a moment." });

  const result = await withLock(`vote:${input.boardId}:${voter.id}`, () =>
    withBusyRetry(() => runVoteTransaction(input, voter, { ip, asn, device })),
  );

  void track(
    result.action === "cast"
      ? "vote_cast"
      : result.action === "moved"
        ? "vote_moved"
        : result.action === "toggled_off"
          ? "vote_toggled_off"
          : "vote_replayed",
    {
      boardId: input.boardId,
      entryId: result.entryId,
      voterId: voter.id,
      weight: result.weight,
      verified: result.verified,
    },
  );

  return issued ? { ...result, issued } : result;
}

async function runVoteTransaction(
  input: VoteInput,
  voter: typeof schema.voters.$inferSelect,
  meta: { ip: string; asn: string; device: string },
): Promise<VoteResult> {
  return db.transaction(async (tx) => {
    // 1. Idempotency: a retried request replays its original answer, writing nothing.
    const [receipt] = await tx
      .select()
      .from(schema.voteReceipts)
      .where(eq(schema.voteReceipts.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (receipt) return { ...(receipt.result as VoteResult), action: "replayed" as const };

    // 2. Board must be live and inside its window.
    const [board] = await tx
      .select()
      .from(schema.boards)
      .where(eq(schema.boards.id, input.boardId))
      .limit(1);
    if (!board) throw new ORPCError("NOT_FOUND", { message: "Board not found" });
    if (board.status !== "live") throw new ORPCError("FORBIDDEN", { message: "This board is not open for voting." });
    const now = new Date();
    if (board.opensAt && board.opensAt > now) throw new ORPCError("FORBIDDEN", { message: "Voting has not opened yet." });
    if (board.closesAt && board.closesAt < now) throw new ORPCError("FORBIDDEN", { message: "Voting has closed on this board." });

    // 3. Entry must belong to this board and be votable.
    const [entry] = await tx
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, input.entryId))
      .limit(1);
    if (!entry) throw new ORPCError("NOT_FOUND", { message: "Entry not found" });
    if (entry.boardId !== input.boardId) throw new ORPCError("BAD_REQUEST", { message: "Entry does not belong to this board." });
    if (entry.status !== "active") throw new ORPCError("FORBIDDEN", { message: "This entry is not votable." });

    // Unverified votes are recorded but held as pending (weight 0): they never
    // move the ranking until the voter verifies. See services/weights.ts.
    let weight = PENDING_WEIGHT;
    if (voter.verifiedAt) weight = voter.weight > PENDING_WEIGHT ? voter.weight : EMAIL_WEIGHT;

    // 4. The voter's existing vote on this board, if any.
    const [existing] = await tx
      .select()
      .from(schema.votes)
      .where(and(eq(schema.votes.boardId, input.boardId), eq(schema.votes.voterId, voter.id)))
      .limit(1);

    let action: VoteAction = "cast";
    let movedFrom: string | null = null;
    let movedFromName: string | null = null;

    if (existing && existing.status === "counted") {
      if (existing.entryId === input.entryId) {
        // 4a. Toggle off.
        await tx.delete(schema.votes).where(eq(schema.votes.id, existing.id));
        await adjustEntry(tx, existing.entryId, existing.weight, -1);
        await logVoteEvent(tx, {
          boardId: input.boardId,
          entryId: existing.entryId,
          voterId: voter.id,
          kind: "toggled_off",
          weight: -existing.weight,
          meta,
        });
        action = "toggled_off";
      } else {
        // 4b. Move: decrement the old entry, increment the new one, keep one row.
        const [oldEntry] = await tx
          .select({ name: schema.entries.name })
          .from(schema.entries)
          .where(eq(schema.entries.id, existing.entryId))
          .limit(1);
        movedFrom = existing.entryId;
        movedFromName = oldEntry?.name ?? null;
        await adjustEntry(tx, existing.entryId, existing.weight, -1);
        await adjustEntry(tx, input.entryId, weight, 1);
        await tx
          .update(schema.votes)
          .set({
            entryId: input.entryId,
            weight,
            ip: meta.ip,
            asn: meta.asn,
            deviceFp: meta.device,
            idempotencyKey: input.idempotencyKey,
            updatedAt: new Date(),
          })
          .where(eq(schema.votes.id, existing.id));
        await logVoteEvent(tx, { boardId: input.boardId, entryId: existing.entryId, voterId: voter.id, kind: "moved_out", weight: -existing.weight, meta });
        await logVoteEvent(tx, { boardId: input.boardId, entryId: input.entryId, voterId: voter.id, kind: "moved_in", weight, meta });
        action = "moved";
      }
    } else if (existing) {
      // A voided row still occupies the unique slot; reinstating it is a fresh cast.
      await tx
        .update(schema.votes)
        .set({
          entryId: input.entryId,
          weight,
          status: "counted",
          voidReason: null,
          voidedAt: null,
          voidBatchId: null,
          ip: meta.ip,
          asn: meta.asn,
          deviceFp: meta.device,
          idempotencyKey: input.idempotencyKey,
          updatedAt: new Date(),
        })
        .where(eq(schema.votes.id, existing.id));
      await adjustEntry(tx, input.entryId, weight, 1);
      await logVoteEvent(tx, { boardId: input.boardId, entryId: input.entryId, voterId: voter.id, kind: "cast", weight, meta });
    } else {
      // 4c. Insert. unique(board_id, voter_id) makes a concurrent duplicate fail
      // safely; we catch the violation and treat it as a move.
      try {
        await tx.insert(schema.votes).values({
          boardId: input.boardId,
          entryId: input.entryId,
          voterId: voter.id,
          weight,
          ip: meta.ip,
          asn: meta.asn,
          deviceFp: meta.device,
          idempotencyKey: input.idempotencyKey,
        });
        await adjustEntry(tx, input.entryId, weight, 1);
        await logVoteEvent(tx, { boardId: input.boardId, entryId: input.entryId, voterId: voter.id, kind: "cast", weight, meta });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const [raced] = await tx
          .select()
          .from(schema.votes)
          .where(and(eq(schema.votes.boardId, input.boardId), eq(schema.votes.voterId, voter.id)))
          .limit(1);
        if (!raced) throw err;
        if (raced.entryId !== input.entryId) {
          movedFrom = raced.entryId;
          await adjustEntry(tx, raced.entryId, raced.weight, -1);
          await adjustEntry(tx, input.entryId, weight, 1);
          await tx
            .update(schema.votes)
            .set({ entryId: input.entryId, weight, updatedAt: new Date() })
            .where(eq(schema.votes.id, raced.id));
          action = "moved";
        } else {
          action = "replayed";
        }
      }
    }

    // 5. Refresh board totals from the entries they were just adjusted on.
    const [totals] = await tx
      .select({
        effective: sql<number>`coalesce(sum(${schema.entries.votesEffective}), 0)`,
        raw: sql<number>`coalesce(sum(${schema.entries.votesRaw}), 0)`,
        pending: sql<number>`coalesce(sum(coalesce(${schema.entries.votesPending}, 0)), 0)`,
      })
      .from(schema.entries)
      .where(and(eq(schema.entries.boardId, input.boardId), eq(schema.entries.status, "active")));
    await tx
      .update(schema.boards)
      .set({
        totalVotesEffective: totals?.effective ?? 0,
        totalVotesRaw: Math.round(totals?.raw ?? 0),
        totalVotesPending: Math.round(totals?.pending ?? 0),
        lastVoteAt: new Date(),
      })
      .where(eq(schema.boards.id, input.boardId));

    // 6. Read back the affected entry and its rank — server-decided, always.
    const target = action === "toggled_off" ? null : input.entryId;
    let votesEffective = 0;
    let votesRaw = 0;
    let votesPending = 0;
    let newRank: number | null = null;
    if (target) {
      const [fresh] = await tx
        .select()
        .from(schema.entries)
        .where(eq(schema.entries.id, target))
        .limit(1);
      votesEffective = fresh?.votesEffective ?? 0;
      votesRaw = fresh?.votesRaw ?? 0;
      votesPending = fresh?.votesPending ?? 0;
      newRank = await rankOf(tx, input.boardId, fresh!);
    }

    const result: VoteResult = {
      action,
      entryId: target,
      newRank,
      votesEffective,
      votesRaw,
      votesPending,
      pending: target !== null && isPendingWeight(weight),
      movedFrom,
      movedFromName,
      weight,
      verified: Boolean(voter.verifiedAt),
      boardTotalEffective: totals?.effective ?? 0,
    };

    // 7. Receipt + audit, inside the same transaction as the count change.
    await tx.insert(schema.voteReceipts).values({
      idempotencyKey: input.idempotencyKey,
      voterId: voter.id,
      boardId: input.boardId,
      result,
    });
    await audit(
      {
        actor: { id: voter.id, kind: "voter" },
        action: `vote.${action}`,
        targetType: "entry",
        targetId: target ?? movedFrom ?? input.entryId,
        metadata: { boardId: input.boardId, weight, movedFrom, ip: meta.ip, asn: meta.asn, device: meta.device },
      },
      tx,
    );

    return result;
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Adds (`direction` 1) or removes (-1) one vote of the given weight from an
 * entry's counters. A pending vote only ever touches `votes_pending`; a
 * verified one touches `votes_raw` and `votes_effective`, which decide rank.
 */
async function adjustEntry(tx: Tx, entryId: string, weight: number, direction: 1 | -1) {
  const pending = isPendingWeight(weight);
  await tx
    .update(schema.entries)
    .set(
      pending
        ? { votesPending: sql`max(0, coalesce(${schema.entries.votesPending}, 0) + ${direction})` }
        : {
            votesRaw: sql`max(0, ${schema.entries.votesRaw} + ${direction})`,
            votesEffective: sql`max(0, ${schema.entries.votesEffective} + ${direction * weight})`,
          },
    )
    .where(eq(schema.entries.id, entryId));
}

async function logVoteEvent(
  tx: Tx,
  args: {
    boardId: string;
    entryId: string;
    voterId: string;
    kind: string;
    weight: number;
    meta: { ip: string; asn: string; device: string };
  },
) {
  await tx.insert(schema.voteEvents).values({
    boardId: args.boardId,
    entryId: args.entryId,
    voterId: args.voterId,
    kind: args.kind,
    weight: args.weight,
    ip: args.meta.ip,
    asn: args.meta.asn,
    deviceFp: args.meta.device,
  });
}

/** 1-based rank of an entry: votes_effective desc, votes_raw desc, created_at asc. */
async function rankOf(tx: Tx, boardId: string, entry: typeof schema.entries.$inferSelect) {
  const [ahead] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(schema.entries)
    .where(
      and(
        eq(schema.entries.boardId, boardId),
        eq(schema.entries.status, "active"),
        or(
          gt(schema.entries.votesEffective, entry.votesEffective),
          and(
            eq(schema.entries.votesEffective, entry.votesEffective),
            gt(schema.entries.votesRaw, entry.votesRaw),
          ),
          and(
            eq(schema.entries.votesEffective, entry.votesEffective),
            eq(schema.entries.votesRaw, entry.votesRaw),
            sql`${schema.entries.createdAt} < ${entry.createdAt.getTime()}`,
          ),
        ),
      ),
    );
  return Number(ahead?.count ?? 0) + 1;
}

/**
 * Recomputes votes_effective / votes_raw for a board straight from the votes
 * table, so a drifted counter can never stand. Called by the 30s reconciliation
 * job and after any bulk void or weight upgrade.
 */
export async function reconcileBoard(boardId: string) {
  const counted = await db
    .select({
      entryId: schema.votes.entryId,
      effective: sql<number>`sum(${schema.votes.weight})`,
      raw: sql<number>`sum(case when ${schema.votes.weight} > ${PENDING_WEIGHT} then 1 else 0 end)`,
      pending: sql<number>`sum(case when ${schema.votes.weight} <= ${PENDING_WEIGHT} then 1 else 0 end)`,
    })
    .from(schema.votes)
    .where(and(eq(schema.votes.boardId, boardId), eq(schema.votes.status, "counted")))
    .groupBy(schema.votes.entryId);

  const byEntry = new Map(counted.map((r) => [r.entryId, r]));
  const boardEntries = await db
    .select()
    .from(schema.entries)
    .where(eq(schema.entries.boardId, boardId));

  let drift = 0;
  for (const entry of boardEntries) {
    const truth = byEntry.get(entry.id);
    const effective = Number(truth?.effective ?? 0);
    const raw = Number(truth?.raw ?? 0);
    const pending = Number(truth?.pending ?? 0);
    if (
      Math.abs(entry.votesEffective - effective) > 1e-9 ||
      entry.votesRaw !== raw ||
      entry.votesPending !== pending
    ) {
      drift++;
      await db
        .update(schema.entries)
        .set({ votesEffective: effective, votesRaw: raw, votesPending: pending })
        .where(eq(schema.entries.id, entry.id));
    }
  }

  const totalEffective = boardEntries.reduce(
    (sum, e) => sum + Number(byEntry.get(e.id)?.effective ?? 0),
    0,
  );
  const totalRaw = boardEntries.reduce((sum, e) => sum + Number(byEntry.get(e.id)?.raw ?? 0), 0);
  const totalPending = boardEntries.reduce(
    (sum, e) => sum + Number(byEntry.get(e.id)?.pending ?? 0),
    0,
  );
  await db
    .update(schema.boards)
    .set({ totalVotesEffective: totalEffective, totalVotesRaw: totalRaw, totalVotesPending: totalPending })
    .where(eq(schema.boards.id, boardId));

  if (drift > 0) {
    await audit({
      action: "reconcile.drift_corrected",
      targetType: "board",
      targetId: boardId,
      metadata: { entriesCorrected: drift },
    });
  }
  return { entriesCorrected: drift, totalEffective, totalRaw, totalPending };
}
