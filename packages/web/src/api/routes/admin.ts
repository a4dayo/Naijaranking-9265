import { ORPCError } from "@orpc/server";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { base } from "../__core/app";
import { db } from "../database";
import * as schema from "../database/schema";
import { hashPassword, verifyPassword } from "../lib/crypto";
import { errorChain, isUniqueViolation } from "../lib/errors";
import { limited } from "../lib/ratelimit";
import { clientIp } from "../lib/request";
import { ALLOWED_CATEGORIES, isAllowedCategory, normaliseName, slugify } from "../lib/text";
import { audit } from "../services/audit";
import { bulkVoid, purgeOldPersonalData, scanIntegrity, votesForFlag } from "../services/integrity";
import { rankedEntries, snapshotRanks } from "../services/rank";
import {
  adminToken,
  createAdminSession,
  currentAdmin,
  revokeSession,
} from "../services/session";
import { reconcileBoard } from "../services/vote";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Operator-only procedures. Every mutation writes an audit row. */
const operator = base.use(async ({ context, next }) => {
  const admin = await currentAdmin(context.headers);
  if (!admin) throw new ORPCError("UNAUTHORIZED", { message: "Operator sign-in required." });
  return next({ context: { ...context, admin } });
});

const categoryEnum = z.enum(ALLOWED_CATEGORIES);

const boardInput = z.object({
  title: z.string().min(4).max(120),
  category: z.string(),
  description: z.string().max(600).optional(),
  accent: z.string().max(20).optional(),
  entryLimit: z.number().int().min(3).max(100).optional(),
  opensAt: z.number().int().optional(),
  closesAt: z.number().int().optional(),
  sensitive: z.boolean().optional(),
});

function assertCategory(category: string) {
  if (!isAllowedCategory(category))
    throw new ORPCError("BAD_REQUEST", {
      message: `Category must be one of: ${ALLOWED_CATEGORIES.join(", ")}. Boards outside these five need a policy decision, not a code change.`,
    });
  return category;
}

/** How many names currently occupy slots on a board. */
async function activeEntryCount(boardId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.entries)
    .where(and(eq(schema.entries.boardId, boardId), eq(schema.entries.status, "active")));
  return Number(row?.count ?? 0);
}

export const admin = {
  /** Is there an operator account yet? Drives the first-run screen. */
  status: base.handler(async ({ context }) => {
    const [row] = await db.select({ count: sql<number>`count(*)` }).from(schema.admins);
    const me = await currentAdmin(context.headers);
    return {
      bootstrapped: Number(row?.count ?? 0) > 0,
      me: me ? { id: me.id, email: me.email, name: me.name, role: me.role } : null,
    };
  }),

  /** First-run: creates the owner account. Refused once one exists. */
  bootstrap: base
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(10).max(200),
        name: z.string().max(80).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const [row] = await db.select({ count: sql<number>`count(*)` }).from(schema.admins);
      if (Number(row?.count ?? 0) > 0)
        throw new ORPCError("FORBIDDEN", { message: "An operator account already exists." });

      const [created] = await db
        .insert(schema.admins)
        .values({
          email: input.email.toLowerCase(),
          name: input.name ?? null,
          passwordHash: hashPassword(input.password),
          role: "owner",
        })
        .returning();
      const session = await createAdminSession(created!.id, context.headers);
      await audit({
        actor: { id: created!.id, kind: "admin" },
        action: "admin.bootstrap",
        targetType: "admin",
        targetId: created!.id,
      });
      return { admin: { id: created!.id, email: created!.email, role: created!.role }, issued: { token: session.token } };
    }),

  login: base
    .input(z.object({ email: z.string().email(), password: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const ip = clientIp(context.headers);
      if (!limited("adminLoginByIp", ip).ok)
        throw new ORPCError("TOO_MANY_REQUESTS", { message: "Too many attempts. Wait 15 minutes." });

      const [row] = await db
        .select()
        .from(schema.admins)
        .where(eq(schema.admins.email, input.email.toLowerCase()))
        .limit(1);

      const bad = () =>
        new ORPCError("UNAUTHORIZED", { message: "Email or password is not right." });
      if (!row) throw bad();
      if (row.lockedUntil && row.lockedUntil > new Date())
        throw new ORPCError("FORBIDDEN", { message: "Account locked. Try again later." });

      if (!verifyPassword(input.password, row.passwordHash)) {
        const attempts = row.failedAttempts + 1;
        await db
          .update(schema.admins)
          .set({
            failedAttempts: attempts,
            lockedUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60_000) : null,
          })
          .where(eq(schema.admins.id, row.id));
        await audit({ action: "admin.login_failed", targetType: "admin", targetId: row.id, metadata: { ip, attempts } });
        throw bad();
      }

      await db
        .update(schema.admins)
        .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(schema.admins.id, row.id));
      const session = await createAdminSession(row.id, context.headers);
      await audit({ actor: { id: row.id, kind: "admin" }, action: "admin.login", metadata: { ip } });
      return { admin: { id: row.id, email: row.email, name: row.name, role: row.role }, issued: { token: session.token } };
    }),

  logout: base.handler(async ({ context }) => {
    await revokeSession(adminToken(context.headers), "admin");
    return { signedOut: true };
  }),

  /** Console home: the numbers an operator checks every morning. */
  dashboard: operator.handler(async () => {
    const since24 = new Date(Date.now() - DAY);
    const [boardCounts] = await db
      .select({
        total: sql<number>`count(*)`,
        live: sql<number>`sum(case when ${schema.boards.status} = 'live' then 1 else 0 end)`,
        draft: sql<number>`sum(case when ${schema.boards.status} = 'draft' then 1 else 0 end)`,
        frozen: sql<number>`sum(case when ${schema.boards.status} = 'frozen' then 1 else 0 end)`,
      })
      .from(schema.boards);

    const [votes24] = await db
      .select({
        count: sql<number>`count(*)`,
        verified: sql<number>`sum(case when ${schema.votes.weight} >= 1 then 1 else 0 end)`,
      })
      .from(schema.votes)
      .where(and(eq(schema.votes.status, "counted"), gte(schema.votes.createdAt, since24)));

    const [voters] = await db.select({ count: sql<number>`count(*)` }).from(schema.voters);
    const [verifiedVoters] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.voters)
      .where(sql`${schema.voters.verifiedAt} is not null`);

    const [openFlags] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.flags)
      .where(isNull(schema.flags.resolution));
    const [pendingNominations] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.nominations)
      .where(eq(schema.nominations.status, "pending"));
    const [pendingReports] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.reports)
      .where(eq(schema.reports.status, "pending"));
    const [pendingClaims] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.claims)
      .where(eq(schema.claims.status, "pending"));
    const [voided24] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.votes)
      .where(and(eq(schema.votes.status, "voided"), gte(schema.votes.voidedAt, since24)));

    // cast() matters: libsql binds the divisor as a real, so without it the
    // division never truncates and every row lands in its own "hour".
    const bucket = sql<number>`cast(${schema.voteEvents.createdAt} / ${HOUR} as integer)`;
    const hourly = await db
      .select({
        hour: bucket,
        count: sql<number>`count(*)`,
      })
      .from(schema.voteEvents)
      .where(
        and(
          gte(schema.voteEvents.createdAt, since24),
          inArray(schema.voteEvents.kind, ["cast", "moved_in"]),
        ),
      )
      .groupBy(bucket)
      .orderBy(bucket);

    return {
      boards: {
        total: Number(boardCounts?.total ?? 0),
        live: Number(boardCounts?.live ?? 0),
        draft: Number(boardCounts?.draft ?? 0),
        frozen: Number(boardCounts?.frozen ?? 0),
      },
      votes24h: Number(votes24?.count ?? 0),
      verifiedVotes24h: Number(votes24?.verified ?? 0),
      voters: Number(voters?.count ?? 0),
      verifiedVoters: Number(verifiedVoters?.count ?? 0),
      voided24h: Number(voided24?.count ?? 0),
      queues: {
        flags: Number(openFlags?.count ?? 0),
        nominations: Number(pendingNominations?.count ?? 0),
        reports: Number(pendingReports?.count ?? 0),
        claims: Number(pendingClaims?.count ?? 0),
      },
      hourly: hourly.map((h) => ({ hour: Number(h.hour) * HOUR, count: Number(h.count) })),
    };
  }),

  /** Every board including drafts. */
  boards: operator.handler(async () => {
    const rows = await db
      .select()
      .from(schema.boards)
      .orderBy(desc(schema.boards.createdAt));
    const counts = await db
      .select({ boardId: schema.entries.boardId, count: sql<number>`count(*)` })
      .from(schema.entries)
      .where(eq(schema.entries.status, "active"))
      .groupBy(schema.entries.boardId);
    const byBoard = new Map(counts.map((c) => [c.boardId, Number(c.count)]));
    return rows.map((b) => ({ ...b, entryCount: byBoard.get(b.id) ?? 0 }));
  }),

  board: operator.input(z.object({ boardId: z.string() })).handler(async ({ input }) => {
    const [board] = await db
      .select()
      .from(schema.boards)
      .where(eq(schema.boards.id, input.boardId))
      .limit(1);
    if (!board) throw new ORPCError("NOT_FOUND", { message: "Board not found" });
    const entries = await db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.boardId, board.id))
      .orderBy(desc(schema.entries.votesEffective));
    return { board, entries, ranked: await rankedEntries(board.id) };
  }),

  createBoard: operator.input(boardInput).handler(async ({ input, context }) => {
    const category = assertCategory(input.category);
    let slug = slugify(input.title);
    const [clash] = await db
      .select({ id: schema.boards.id })
      .from(schema.boards)
      .where(eq(schema.boards.slug, slug))
      .limit(1);
    if (clash) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

    const [board] = await db
      .insert(schema.boards)
      .values({
        title: input.title.trim(),
        slug,
        category,
        description: input.description?.trim() || null,
        accent: input.accent || null,
        entryLimit: input.entryLimit ?? 10,
        opensAt: input.opensAt ? new Date(input.opensAt) : null,
        closesAt: input.closesAt ? new Date(input.closesAt) : null,
        sensitive: input.sensitive ?? false,
        createdBy: context.admin.id,
        status: "draft",
      })
      .returning();

    await audit({
      actor: { id: context.admin.id, kind: "admin" },
      action: "board.created",
      targetType: "board",
      targetId: board!.id,
      metadata: { title: board!.title, category },
    });
    return board!;
  }),

  updateBoard: operator
    .input(
      z.object({
        boardId: z.string(),
        title: z.string().min(4).max(120).optional(),
        category: z.string().optional(),
        description: z.string().max(600).nullable().optional(),
        accent: z.string().max(20).nullable().optional(),
        entryLimit: z.number().int().min(3).max(100).optional(),
        opensAt: z.number().int().nullable().optional(),
        closesAt: z.number().int().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const patch: Partial<typeof schema.boards.$inferInsert> = {};
      if (input.title !== undefined) patch.title = input.title.trim();
      if (input.category !== undefined) patch.category = assertCategory(input.category);
      if (input.description !== undefined) patch.description = input.description;
      if (input.accent !== undefined) patch.accent = input.accent;
      if (input.entryLimit !== undefined) {
        // Refuse a limit the board already exceeds — lowering it would otherwise
        // leave a "Top 10" quietly showing twelve names.
        const active = await activeEntryCount(input.boardId);
        if (input.entryLimit < active)
          throw new ORPCError("BAD_REQUEST", {
            message: `That board already has ${active} active entries. Hide some before lowering the limit to ${input.entryLimit}.`,
          });
        patch.entryLimit = input.entryLimit;
      }
      if (input.opensAt !== undefined) patch.opensAt = input.opensAt ? new Date(input.opensAt) : null;
      if (input.closesAt !== undefined)
        patch.closesAt = input.closesAt ? new Date(input.closesAt) : null;

      const [board] = await db
        .update(schema.boards)
        .set(patch)
        .where(eq(schema.boards.id, input.boardId))
        .returning();
      if (!board) throw new ORPCError("NOT_FOUND", { message: "Board not found" });
      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: "board.updated",
        targetType: "board",
        targetId: board.id,
        metadata: patch as Record<string, unknown>,
      });
      return board;
    }),

  /**
   * draft → live → frozen. A sensitive board needs explicit approval before it can
   * go live; that gate is the whole reason the field exists.
   */
  setBoardStatus: operator
    .input(z.object({ boardId: z.string(), status: z.enum(["draft", "live", "frozen"]) }))
    .handler(async ({ input, context }) => {
      const [board] = await db
        .select()
        .from(schema.boards)
        .where(eq(schema.boards.id, input.boardId))
        .limit(1);
      if (!board) throw new ORPCError("NOT_FOUND", { message: "Board not found" });

      if (input.status === "live" && board.sensitive && !board.sensitiveApprovedBy)
        throw new ORPCError("FORBIDDEN", {
          message:
            "This board is marked sensitive. An owner must approve it before it can go live.",
        });

      if (input.status === "live") {
        const [count] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.entries)
          .where(and(eq(schema.entries.boardId, board.id), eq(schema.entries.status, "active")));
        if (Number(count?.count ?? 0) < 3)
          throw new ORPCError("BAD_REQUEST", { message: "Seed at least 3 entries before going live." });
      }

      const [updated] = await db
        .update(schema.boards)
        .set({
          status: input.status,
          frozenAt: input.status === "frozen" ? new Date() : null,
        })
        .where(eq(schema.boards.id, board.id))
        .returning();
      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: `board.${input.status}`,
        targetType: "board",
        targetId: board.id,
      });
      return updated!;
    }),

  approveSensitive: operator
    .input(z.object({ boardId: z.string(), approve: z.boolean() }))
    .handler(async ({ input, context }) => {
      if (context.admin.role !== "owner")
        throw new ORPCError("FORBIDDEN", { message: "Only an owner can approve a sensitive board." });
      const [updated] = await db
        .update(schema.boards)
        .set({
          sensitiveApprovedBy: input.approve ? context.admin.id : null,
          sensitiveApprovedAt: input.approve ? new Date() : null,
        })
        .where(eq(schema.boards.id, input.boardId))
        .returning();
      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: input.approve ? "board.sensitive_approved" : "board.sensitive_revoked",
        targetType: "board",
        targetId: input.boardId,
      });
      return updated!;
    }),

  deleteBoard: operator
    .input(z.object({ boardId: z.string() }))
    .handler(async ({ input, context }) => {
      const [board] = await db
        .select({ status: schema.boards.status, title: schema.boards.title })
        .from(schema.boards)
        .where(eq(schema.boards.id, input.boardId))
        .limit(1);
      if (!board) throw new ORPCError("NOT_FOUND", { message: "Board not found" });
      if (board.status !== "draft")
        throw new ORPCError("FORBIDDEN", {
          message: "Only a draft can be deleted. Freeze a published board instead — results stay citable.",
        });
      await db.delete(schema.boards).where(eq(schema.boards.id, input.boardId));
      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: "board.deleted",
        targetType: "board",
        targetId: input.boardId,
        metadata: { title: board.title },
      });
      return { deleted: true };
    }),

  /**
   * Bulk entry seeding. Accepts `Name, Subtitle, ImageUrl` per line (CSV-ish).
   * Duplicates are reported, never silently merged — unique(board_id,
   * name_normalised) is the arbiter.
   */
  seedEntries: operator
    .input(z.object({ boardId: z.string(), csv: z.string().min(1).max(20_000) }))
    .handler(async ({ input, context }) => {
      const [board] = await db
        .select({ id: schema.boards.id, entryLimit: schema.boards.entryLimit })
        .from(schema.boards)
        .where(eq(schema.boards.id, input.boardId))
        .limit(1);
      if (!board) throw new ORPCError("NOT_FOUND", { message: "Board not found" });

      const added: string[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];
      // A "Top 20" board holds twenty names. The limit is enforced here, on the
      // way in, rather than by hiding entries from the public ranking later.
      let active = await activeEntryCount(board.id);

      for (const line of input.csv.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const cells = splitCsvLine(trimmed);
        const name = cells[0]?.trim();
        if (!name) continue;
        if (/^name$/i.test(name)) continue; // header row
        if (active >= board.entryLimit) {
          skipped.push({ name, reason: `board is full (${board.entryLimit} entries)` });
          continue;
        }
        try {
          await db.insert(schema.entries).values({
            boardId: board.id,
            name,
            nameNormalised: normaliseName(name),
            subtitle: cells[1]?.trim() || null,
            imageUrl: cells[2]?.trim() || null,
            source: "seeded",
          });
          added.push(name);
          active += 1;
        } catch (err) {
          skipped.push({
            name,
            reason: isUniqueViolation(err)
              ? "already on this board"
              : errorChain(err).slice(0, 120),
          });
        }
      }

      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: "entries.seeded",
        targetType: "board",
        targetId: board.id,
        metadata: { added: added.length, skipped: skipped.length },
      });
      return { added, skipped };
    }),

  updateEntry: operator
    .input(
      z.object({
        entryId: z.string(),
        name: z.string().min(1).max(120).optional(),
        subtitle: z.string().max(200).nullable().optional(),
        imageUrl: z.string().max(500).nullable().optional(),
        status: z.enum(["active", "pending", "hidden"]).optional(),
        isSponsored: z.boolean().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const patch: Partial<typeof schema.entries.$inferInsert> = {};
      if (input.name !== undefined) {
        patch.name = input.name.trim();
        patch.nameNormalised = normaliseName(input.name);
      }
      if (input.subtitle !== undefined) patch.subtitle = input.subtitle;
      if (input.imageUrl !== undefined) patch.imageUrl = input.imageUrl;
      if (input.status !== undefined) patch.status = input.status;
      if (input.isSponsored !== undefined) patch.isSponsored = input.isSponsored;

      if (input.status === "active") {
        // Un-hiding is an entry arriving on the board, so it answers to the cap too.
        const [current] = await db
          .select({ boardId: schema.entries.boardId, status: schema.entries.status })
          .from(schema.entries)
          .where(eq(schema.entries.id, input.entryId))
          .limit(1);
        if (!current) throw new ORPCError("NOT_FOUND", { message: "Entry not found" });
        if (current.status !== "active") {
          const [board] = await db
            .select({ entryLimit: schema.boards.entryLimit })
            .from(schema.boards)
            .where(eq(schema.boards.id, current.boardId))
            .limit(1);
          if (board && (await activeEntryCount(current.boardId)) >= board.entryLimit)
            throw new ORPCError("CONFLICT", {
              message: `Board is full (${board.entryLimit} entries). Hide another entry first.`,
            });
        }
      }

      let entry: typeof schema.entries.$inferSelect | undefined;
      try {
        [entry] = await db
          .update(schema.entries)
          .set(patch)
          .where(eq(schema.entries.id, input.entryId))
          .returning();
      } catch (err) {
        if (isUniqueViolation(err))
          throw new ORPCError("CONFLICT", { message: "Another entry on this board already has that name." });
        throw err;
      }
      if (!entry) throw new ORPCError("NOT_FOUND", { message: "Entry not found" });
      if (input.status !== undefined) await reconcileBoard(entry.boardId);
      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: "entry.updated",
        targetType: "entry",
        targetId: entry.id,
        metadata: patch as Record<string, unknown>,
      });
      return entry;
    }),

  /** Merges a duplicate into the canonical entry, moving its votes across. */
  mergeEntry: operator
    .input(z.object({ sourceEntryId: z.string(), targetEntryId: z.string() }))
    .handler(async ({ input, context }) => {
      if (input.sourceEntryId === input.targetEntryId)
        throw new ORPCError("BAD_REQUEST", { message: "Pick two different entries." });
      const rows = await db
        .select()
        .from(schema.entries)
        .where(inArray(schema.entries.id, [input.sourceEntryId, input.targetEntryId]));
      const source = rows.find((r) => r.id === input.sourceEntryId);
      const target = rows.find((r) => r.id === input.targetEntryId);
      if (!source || !target) throw new ORPCError("NOT_FOUND", { message: "Entry not found" });
      if (source.boardId !== target.boardId)
        throw new ORPCError("BAD_REQUEST", { message: "Entries are on different boards." });

      // A voter with a vote on both entries keeps the target one; the duplicate
      // is dropped rather than double-counted.
      const sourceVotes = await db
        .select({ id: schema.votes.id, voterId: schema.votes.voterId })
        .from(schema.votes)
        .where(eq(schema.votes.entryId, source.id));
      const targetVoters = new Set(
        (
          await db
            .select({ voterId: schema.votes.voterId })
            .from(schema.votes)
            .where(eq(schema.votes.entryId, target.id))
        ).map((v) => v.voterId),
      );

      let moved = 0;
      let dropped = 0;
      for (const vote of sourceVotes) {
        if (targetVoters.has(vote.voterId)) {
          await db.delete(schema.votes).where(eq(schema.votes.id, vote.id));
          dropped++;
        } else {
          await db
            .update(schema.votes)
            .set({ entryId: target.id, updatedAt: new Date() })
            .where(eq(schema.votes.id, vote.id));
          moved++;
        }
      }

      await db
        .update(schema.entries)
        .set({ status: "merged", mergedInto: target.id })
        .where(eq(schema.entries.id, source.id));
      await reconcileBoard(target.boardId);

      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: "entry.merged",
        targetType: "entry",
        targetId: target.id,
        metadata: { source: source.id, sourceName: source.name, moved, dropped },
      });
      return { moved, dropped };
    }),

  /** The fraud queue. Open flags first, newest first. */
  flags: operator
    .input(z.object({ resolution: z.enum(["open", "all"]).default("open") }).optional())
    .handler(async ({ input }) => {
      const rows = await db
        .select()
        .from(schema.flags)
        .where(input?.resolution === "all" ? undefined : isNull(schema.flags.resolution))
        .orderBy(desc(schema.flags.detectedAt))
        .limit(200);

      const entryIds = rows.map((r) => r.entryId).filter((v): v is string => Boolean(v));
      const boardIds = rows.map((r) => r.boardId).filter((v): v is string => Boolean(v));
      const entryNames = entryIds.length
        ? await db
            .select({ id: schema.entries.id, name: schema.entries.name })
            .from(schema.entries)
            .where(inArray(schema.entries.id, entryIds))
        : [];
      const boardTitles = boardIds.length
        ? await db
            .select({ id: schema.boards.id, title: schema.boards.title, slug: schema.boards.slug })
            .from(schema.boards)
            .where(inArray(schema.boards.id, boardIds))
        : [];
      const entryBy = new Map(entryNames.map((e) => [e.id, e.name]));
      const boardBy = new Map(boardTitles.map((b) => [b.id, b]));

      return rows.map((flag) => ({
        ...flag,
        entryName: flag.entryId ? entryBy.get(flag.entryId) ?? null : null,
        boardTitle: flag.boardId ? boardBy.get(flag.boardId)?.title ?? null : null,
        boardSlug: flag.boardId ? boardBy.get(flag.boardId)?.slug ?? null : null,
      }));
    }),

  /** What a flag is actually about — the operator reads this before voiding. */
  flagDetail: operator.input(z.object({ flagId: z.string() })).handler(async ({ input }) => {
    const [flag] = await db
      .select()
      .from(schema.flags)
      .where(eq(schema.flags.id, input.flagId))
      .limit(1);
    if (!flag) throw new ORPCError("NOT_FOUND", { message: "Flag not found" });
    const voteIds = await votesForFlag(flag);
    const sample = voteIds.length
      ? await db
          .select({
            id: schema.votes.id,
            voterId: schema.votes.voterId,
            entryId: schema.votes.entryId,
            weight: schema.votes.weight,
            ip: schema.votes.ip,
            asn: schema.votes.asn,
            deviceFp: schema.votes.deviceFp,
            createdAt: schema.votes.createdAt,
          })
          .from(schema.votes)
          .where(inArray(schema.votes.id, voteIds.slice(0, 100)))
          .orderBy(desc(schema.votes.createdAt))
      : [];
    return { flag, voteCount: voteIds.length, sample };
  }),

  /** Voids a flagged set. Reason mandatory, action audited, counters reconciled. */
  voidVotes: operator
    .input(
      z.object({
        flagId: z.string().optional(),
        voteIds: z.array(z.string()).max(2000).optional(),
        reason: z.string().min(8).max(500),
      }),
    )
    .handler(async ({ input, context }) => {
      try {
        return await bulkVoid({
          flagId: input.flagId,
          voteIds: input.voteIds,
          reason: input.reason,
          adminId: context.admin.id,
        });
      } catch (err) {
        throw new ORPCError("BAD_REQUEST", { message: (err as Error).message });
      }
    }),

  /** Closes a flag without touching a single vote. */
  resolveFlag: operator
    .input(
      z.object({
        flagId: z.string(),
        resolution: z.enum(["dismissed", "monitoring"]),
        note: z.string().max(500).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const [updated] = await db
        .update(schema.flags)
        .set({
          resolution: input.resolution,
          resolvedBy: context.admin.id,
          resolvedAt: new Date(),
        })
        .where(eq(schema.flags.id, input.flagId))
        .returning();
      if (!updated) throw new ORPCError("NOT_FOUND", { message: "Flag not found" });
      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: `integrity.flag_${input.resolution}`,
        targetType: "flag",
        targetId: input.flagId,
        metadata: { note: input.note ?? null },
      });
      return updated;
    }),

  /** Moderation queue: nominations, reports, claims in one read. */
  moderation: operator.handler(async () => {
    const nominations = await db
      .select({
        id: schema.nominations.id,
        boardId: schema.nominations.boardId,
        boardTitle: schema.boards.title,
        submittedName: schema.nominations.submittedName,
        upvotes: schema.nominations.upvotes,
        screeningResult: schema.nominations.screeningResult,
        createdAt: schema.nominations.createdAt,
      })
      .from(schema.nominations)
      .leftJoin(schema.boards, eq(schema.boards.id, schema.nominations.boardId))
      .where(eq(schema.nominations.status, "pending"))
      .orderBy(desc(schema.nominations.upvotes), desc(schema.nominations.createdAt))
      .limit(100);

    const reports = await db
      .select({
        id: schema.reports.id,
        entryId: schema.reports.entryId,
        entryName: schema.entries.name,
        reason: schema.reports.reason,
        createdAt: schema.reports.createdAt,
      })
      .from(schema.reports)
      .leftJoin(schema.entries, eq(schema.entries.id, schema.reports.entryId))
      .where(eq(schema.reports.status, "pending"))
      .orderBy(desc(schema.reports.createdAt))
      .limit(100);

    const claims = await db
      .select({
        id: schema.claims.id,
        entryId: schema.claims.entryId,
        entryName: schema.entries.name,
        requestedPhone: schema.claims.requestedPhone,
        evidenceUrl: schema.claims.evidenceUrl,
        createdAt: schema.claims.createdAt,
      })
      .from(schema.claims)
      .leftJoin(schema.entries, eq(schema.entries.id, schema.claims.entryId))
      .where(eq(schema.claims.status, "pending"))
      .orderBy(desc(schema.claims.createdAt))
      .limit(100);

    return { nominations, reports, claims };
  }),

  /** Approving a nomination promotes it to a real entry on the board. */
  reviewNomination: operator
    .input(z.object({ nominationId: z.string(), decision: z.enum(["approved", "rejected"]) }))
    .handler(async ({ input, context }) => {
      const [nomination] = await db
        .select()
        .from(schema.nominations)
        .where(eq(schema.nominations.id, input.nominationId))
        .limit(1);
      if (!nomination) throw new ORPCError("NOT_FOUND", { message: "Nomination not found" });

      let entryId: string | null = null;
      if (input.decision === "approved") {
        const [target] = await db
          .select({ entryLimit: schema.boards.entryLimit })
          .from(schema.boards)
          .where(eq(schema.boards.id, nomination.boardId))
          .limit(1);
        if (target && (await activeEntryCount(nomination.boardId)) >= target.entryLimit)
          throw new ORPCError("CONFLICT", {
            message: `Board is full (${target.entryLimit} entries). Hide an entry or raise the limit first.`,
          });
        try {
          const [entry] = await db
            .insert(schema.entries)
            .values({
              boardId: nomination.boardId,
              name: nomination.submittedName,
              nameNormalised: normaliseName(nomination.submittedName),
              source: "nominated",
              status: "active",
            })
            .returning();
          entryId = entry!.id;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          throw new ORPCError("CONFLICT", {
            message: "That name is already on the board — reject this as a duplicate.",
          });
        }
      }

      await db
        .update(schema.nominations)
        .set({
          status: input.decision,
          reviewedBy: context.admin.id,
          reviewedAt: new Date(),
        })
        .where(eq(schema.nominations.id, nomination.id));
      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: `nomination.${input.decision}`,
        targetType: "nomination",
        targetId: nomination.id,
        metadata: { name: nomination.submittedName, entryId },
      });
      return { entryId };
    }),

  reviewReport: operator
    .input(
      z.object({
        reportId: z.string(),
        decision: z.enum(["actioned", "dismissed"]),
        hideEntry: z.boolean().default(false),
      }),
    )
    .handler(async ({ input, context }) => {
      const [report] = await db
        .select()
        .from(schema.reports)
        .where(eq(schema.reports.id, input.reportId))
        .limit(1);
      if (!report) throw new ORPCError("NOT_FOUND", { message: "Report not found" });

      if (input.hideEntry) {
        const [entry] = await db
          .update(schema.entries)
          .set({ status: "hidden" })
          .where(eq(schema.entries.id, report.entryId))
          .returning({ boardId: schema.entries.boardId });
        if (entry) await reconcileBoard(entry.boardId);
      }
      await db
        .update(schema.reports)
        .set({ status: input.decision, reviewedBy: context.admin.id, reviewedAt: new Date() })
        .where(eq(schema.reports.id, report.id));
      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: `report.${input.decision}`,
        targetType: "entry",
        targetId: report.entryId,
        metadata: { reportId: report.id, hidden: input.hideEntry },
      });
      return { done: true };
    }),

  reviewClaim: operator
    .input(z.object({ claimId: z.string(), decision: z.enum(["approved", "rejected"]) }))
    .handler(async ({ input, context }) => {
      const [claim] = await db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.id, input.claimId))
        .limit(1);
      if (!claim) throw new ORPCError("NOT_FOUND", { message: "Claim not found" });
      if (input.decision === "approved") {
        await db
          .update(schema.entries)
          .set({ claimed: true, claimedBy: claim.requestedPhone })
          .where(eq(schema.entries.id, claim.entryId));
      }
      await db
        .update(schema.claims)
        .set({ status: input.decision, reviewedBy: context.admin.id, reviewedAt: new Date() })
        .where(eq(schema.claims.id, claim.id));
      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: `claim.${input.decision}`,
        targetType: "entry",
        targetId: claim.entryId,
        metadata: { claimId: claim.id },
      });
      return { done: true };
    }),

  /** The audit log, read-only, newest first. */
  auditLog: operator
    .input(
      z
        .object({ action: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) })
        .optional(),
    )
    .handler(async ({ input }) => {
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(input?.action ? eq(schema.auditLog.action, input.action) : undefined)
        .orderBy(desc(schema.auditLog.id))
        .limit(input?.limit ?? 100);
      return rows;
    }),

  /** Manual triggers for the background jobs, so an operator is never stuck waiting. */
  runJob: operator
    .input(z.object({ job: z.enum(["reconcile", "scan", "snapshot", "purge"]) }))
    .handler(async ({ input, context }) => {
      const live = await db
        .select({ id: schema.boards.id })
        .from(schema.boards)
        .where(inArray(schema.boards.status, ["live", "frozen"]));

      let result: Record<string, unknown> = {};
      if (input.job === "reconcile") {
        let corrected = 0;
        for (const b of live) corrected += (await reconcileBoard(b.id)).entriesCorrected;
        result = { boards: live.length, entriesCorrected: corrected };
      } else if (input.job === "scan") {
        result = await scanIntegrity();
      } else if (input.job === "snapshot") {
        let snapshotted = 0;
        for (const b of live) snapshotted += (await snapshotRanks(b.id)).snapshotted;
        result = { snapshotted };
      } else {
        result = await purgeOldPersonalData();
      }

      await audit({
        actor: { id: context.admin.id, kind: "admin" },
        action: `job.manual_${input.job}`,
        metadata: result,
      });
      return result;
    }),
};

/** Minimal CSV line split that respects double quotes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(current);
      current = "";
    } else current += ch;
  }
  cells.push(current);
  return cells;
}

export const adminCategories = categoryEnum;
