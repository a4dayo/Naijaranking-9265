import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { base } from "../__core/app";
import { db } from "../database";
import * as schema from "../database/schema";
import { limited } from "../lib/ratelimit";
import { deviceFingerprint } from "../lib/request";
import { screenNomination } from "../lib/text";
import { track } from "../services/audit";
import { integrityNote } from "../services/integrity";
import { biggestMovers, rankedEntries, round2 } from "../services/rank";
import { currentVoter } from "../services/session";

/** Public board reads. Everything here is safe for an anonymous visitor. */

const publicBoardColumns = {
  id: schema.boards.id,
  title: schema.boards.title,
  slug: schema.boards.slug,
  category: schema.boards.category,
  description: schema.boards.description,
  accent: schema.boards.accent,
  status: schema.boards.status,
  opensAt: schema.boards.opensAt,
  closesAt: schema.boards.closesAt,
  frozenAt: schema.boards.frozenAt,
  entryLimit: schema.boards.entryLimit,
  sponsorId: schema.boards.sponsorId,
  totalVotesEffective: schema.boards.totalVotesEffective,
  totalVotesRaw: schema.boards.totalVotesRaw,
  lastVoteAt: schema.boards.lastVoteAt,
  createdAt: schema.boards.createdAt,
};

async function boardBySlug(slug: string) {
  const [board] = await db
    .select(publicBoardColumns)
    .from(schema.boards)
    .where(eq(schema.boards.slug, slug))
    .limit(1);
  if (!board) throw new ORPCError("NOT_FOUND", { message: "Board not found" });
  // Drafts are operator-only; the public never sees one.
  if (board.status === "draft")
    throw new ORPCError("NOT_FOUND", { message: "Board not found" });
  return board;
}

export const boards = {
  /** Home page: every published board with a small preview of its top entries. */
  list: base.handler(async () => {
    const rows = await db
      .select(publicBoardColumns)
      .from(schema.boards)
      .where(inArray(schema.boards.status, ["live", "frozen"]))
      .orderBy(desc(schema.boards.lastVoteAt), desc(schema.boards.createdAt));

    const ids = rows.map((r) => r.id);
    const topEntries = ids.length
      ? await db
          .select({
            boardId: schema.entries.boardId,
            id: schema.entries.id,
            name: schema.entries.name,
            imageUrl: schema.entries.imageUrl,
            votesEffective: schema.entries.votesEffective,
            delta24h: schema.entries.delta24h,
          })
          .from(schema.entries)
          .where(and(inArray(schema.entries.boardId, ids), eq(schema.entries.status, "active")))
          .orderBy(desc(schema.entries.votesEffective))
      : [];

    const preview = new Map<string, typeof topEntries>();
    for (const row of topEntries) {
      const list = preview.get(row.boardId) ?? [];
      if (list.length < 3) list.push(row);
      preview.set(row.boardId, list);
    }

    const voterCounts = ids.length
      ? await db
          .select({ boardId: schema.votes.boardId, voters: sql<number>`count(*)` })
          .from(schema.votes)
          .where(and(inArray(schema.votes.boardId, ids), eq(schema.votes.status, "counted")))
          .groupBy(schema.votes.boardId)
      : [];
    const voters = new Map(voterCounts.map((v) => [v.boardId, Number(v.voters)]));

    return rows.map((board) => ({
      ...board,
      totalVotesEffective: round2(board.totalVotesEffective),
      voterCount: voters.get(board.id) ?? 0,
      top: (preview.get(board.id) ?? []).map((e, i) => ({
        ...e,
        rank: i + 1,
        votesEffective: round2(e.votesEffective),
      })),
    }));
  }),

  /** The board page: ranked entries, the viewer's own vote, and the integrity note. */
  bySlug: base
    .input(z.object({ slug: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const board = await boardBySlug(input.slug);
      const [entries, note, movers, voter] = await Promise.all([
        rankedEntries(board.id),
        integrityNote(board.id),
        biggestMovers(board.id),
        currentVoter(context.headers),
      ]);

      let myVote: { entryId: string; weight: number } | null = null;
      if (voter) {
        const [row] = await db
          .select({ entryId: schema.votes.entryId, weight: schema.votes.weight })
          .from(schema.votes)
          .where(
            and(
              eq(schema.votes.boardId, board.id),
              eq(schema.votes.voterId, voter.id),
              eq(schema.votes.status, "counted"),
            ),
          )
          .limit(1);
        myVote = row ?? null;
      }

      const [voterCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.votes)
        .where(and(eq(schema.votes.boardId, board.id), eq(schema.votes.status, "counted")));

      const [sponsor] = board.sponsorId
        ? await db
            .select({ name: schema.sponsors.name, logoUrl: schema.sponsors.logoUrl })
            .from(schema.sponsors)
            .where(eq(schema.sponsors.id, board.sponsorId))
            .limit(1)
        : [];

      const myReactions = voter
        ? await db
            .select({ entryId: schema.reactions.entryId, emoji: schema.reactions.emoji })
            .from(schema.reactions)
            .where(eq(schema.reactions.voterId, voter.id))
        : [];

      return {
        board: {
          ...board,
          totalVotesEffective: round2(board.totalVotesEffective),
          voterCount: Number(voterCount?.count ?? 0),
        },
        entries,
        movers,
        integrity: note,
        sponsor: sponsor ?? null,
        me: voter
          ? { id: voter.id, verified: Boolean(voter.verifiedAt), weight: voter.weight }
          : null,
        myVote,
        myReactions: myReactions.map((r) => `${r.entryId}:${r.emoji}`),
      };
    }),

  /** Results page for a frozen board — the final, citable standing. */
  results: base.input(z.object({ slug: z.string().min(1) })).handler(async ({ input }) => {
    const board = await boardBySlug(input.slug);
    const entries = await rankedEntries(board.id);
    const note = await integrityNote(board.id);

    const [stats] = await db
      .select({
        voters: sql<number>`count(*)`,
        verified: sql<number>`sum(case when ${schema.votes.weight} >= 1 then 1 else 0 end)`,
        first: sql<number>`min(${schema.votes.createdAt})`,
        last: sql<number>`max(${schema.votes.createdAt})`,
      })
      .from(schema.votes)
      .where(and(eq(schema.votes.boardId, board.id), eq(schema.votes.status, "counted")));

    const [voided] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.votes)
      .where(and(eq(schema.votes.boardId, board.id), eq(schema.votes.status, "voided")));

    return {
      board: { ...board, totalVotesEffective: round2(board.totalVotesEffective) },
      entries,
      integrity: note,
      stats: {
        voters: Number(stats?.voters ?? 0),
        verifiedVoters: Number(stats?.verified ?? 0),
        votedFrom: stats?.first ? new Date(Number(stats.first)) : null,
        votedTo: stats?.last ? new Date(Number(stats.last)) : null,
        votesVoided: Number(voided?.count ?? 0),
      },
    };
  }),

  /** Published nominations tray for a board (approved-but-unlisted suggestions). */
  nominations: base.input(z.object({ boardId: z.string() })).handler(async ({ input }) => {
    const rows = await db
      .select({
        id: schema.nominations.id,
        submittedName: schema.nominations.submittedName,
        upvotes: schema.nominations.upvotes,
        status: schema.nominations.status,
        createdAt: schema.nominations.createdAt,
      })
      .from(schema.nominations)
      .where(
        and(
          eq(schema.nominations.boardId, input.boardId),
          inArray(schema.nominations.status, ["pending", "approved"]),
        ),
      )
      .orderBy(desc(schema.nominations.upvotes), desc(schema.nominations.createdAt))
      .limit(30);
    return rows;
  }),

  /** Suggest a missing entry. Screened, queued for review — never auto-published. */
  nominate: base
    .input(z.object({ boardId: z.string(), name: z.string().min(2).max(80) }))
    .handler(async ({ input, context }) => {
      const voter = await currentVoter(context.headers);
      const subject = voter?.id ?? deviceFingerprint(context.headers);
      if (!limited("nominationByVoter", subject).ok)
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: "You have sent a few suggestions already. Try again later.",
        });

      const [board] = await db
        .select({ id: schema.boards.id, status: schema.boards.status })
        .from(schema.boards)
        .where(eq(schema.boards.id, input.boardId))
        .limit(1);
      if (!board || board.status === "draft")
        throw new ORPCError("NOT_FOUND", { message: "Board not found" });

      const screen = screenNomination(input.name);
      const [row] = await db
        .insert(schema.nominations)
        .values({
          boardId: input.boardId,
          submittedName: input.name.trim(),
          submittedBy: voter?.id ?? null,
          screeningResult: screen.reason ?? "clean",
          status: "pending",
        })
        .returning();

      void track("nomination_submitted", {
        boardId: input.boardId,
        voterId: voter?.id ?? null,
        screened: screen.verdict,
      });
      return { id: row!.id, status: row!.status, screened: screen.verdict };
    }),

  /** Upvote a nomination. Ten upvotes is the threshold an operator sees as ready. */
  upvoteNomination: base
    .input(z.object({ nominationId: z.string() }))
    .handler(async ({ input, context }) => {
      const voter = await currentVoter(context.headers);
      if (!voter)
        throw new ORPCError("UNAUTHORIZED", { message: "Vote on the board first, then upvote." });

      try {
        await db
          .insert(schema.nominationUpvotes)
          .values({ nominationId: input.nominationId, voterId: voter.id });
      } catch {
        return { alreadyUpvoted: true, upvotes: null };
      }
      const [row] = await db
        .update(schema.nominations)
        .set({ upvotes: sql`${schema.nominations.upvotes} + 1` })
        .where(eq(schema.nominations.id, input.nominationId))
        .returning({ upvotes: schema.nominations.upvotes });
      return { alreadyUpvoted: false, upvotes: row?.upvotes ?? null };
    }),

  /** Report an entry (impersonation, abuse, wrong person). */
  report: base
    .input(z.object({ entryId: z.string(), reason: z.string().min(3).max(500) }))
    .handler(async ({ input, context }) => {
      const voter = await currentVoter(context.headers);
      const subject = voter?.id ?? deviceFingerprint(context.headers);
      if (!limited("reportByVoter", subject).ok)
        throw new ORPCError("TOO_MANY_REQUESTS", { message: "Too many reports. Try again later." });

      await db.insert(schema.reports).values({
        entryId: input.entryId,
        reporterId: voter?.id ?? null,
        reason: input.reason.trim(),
      });
      void track("entry_reported", { entryId: input.entryId, voterId: voter?.id ?? null });
      return { received: true };
    }),

  /** React to an entry. Toggles, one reaction per emoji per voter. */
  react: base
    .input(z.object({ entryId: z.string(), emoji: z.enum(["🔥", "😂", "😐", "💯"]) }))
    .handler(async ({ input, context }) => {
      const voter = await currentVoter(context.headers);
      if (!voter)
        throw new ORPCError("UNAUTHORIZED", { message: "Vote on the board first, then react." });

      const [existing] = await db
        .select({ id: schema.reactions.id })
        .from(schema.reactions)
        .where(
          and(
            eq(schema.reactions.entryId, input.entryId),
            eq(schema.reactions.voterId, voter.id),
            eq(schema.reactions.emoji, input.emoji),
          ),
        )
        .limit(1);

      if (existing) {
        await db.delete(schema.reactions).where(eq(schema.reactions.id, existing.id));
      } else {
        await db
          .insert(schema.reactions)
          .values({ entryId: input.entryId, voterId: voter.id, emoji: input.emoji });
      }

      const [count] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.reactions)
        .where(
          and(eq(schema.reactions.entryId, input.entryId), eq(schema.reactions.emoji, input.emoji)),
        );
      return { on: !existing, count: Number(count?.count ?? 0) };
    }),

  /** Claim an entry as its subject (artist, venue, brand). Reviewed by an operator. */
  claim: base
    .input(
      z.object({
        entryId: z.string(),
        contact: z.string().min(5).max(120),
        evidenceUrl: z.string().max(400).optional(),
      }),
    )
    .handler(async ({ input }) => {
      await db.insert(schema.claims).values({
        entryId: input.entryId,
        requestedPhone: input.contact.trim(),
        evidenceUrl: input.evidenceUrl?.trim() || null,
      });
      void track("claim_submitted", { entryId: input.entryId });
      return { received: true };
    }),

  /** Client-side instrumentation sink (§9 funnel events). */
  event: base
    .input(
      z.object({
        name: z.string().min(2).max(60),
        boardId: z.string().optional(),
        entryId: z.string().optional(),
        referrer: z.string().max(300).optional(),
        props: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const device = deviceFingerprint(context.headers);
      if (!limited("eventsByDevice", device).ok) return { recorded: false };
      const voter = await currentVoter(context.headers);
      await track(input.name, {
        boardId: input.boardId ?? null,
        entryId: input.entryId ?? null,
        voterId: voter?.id ?? null,
        sessionKey: device,
        referrer: input.referrer ?? null,
        ...input.props,
      });
      return { recorded: true };
    }),
};
