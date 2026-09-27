import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { pseudonymiseIp } from "../lib/crypto";
import { isDatacentreAsn } from "../lib/request";
import { audit } from "./audit";
import { reconcileBoard } from "./vote";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Integrity scanner. Detects and flags for human review — it never deletes or
 * voids a vote by itself. On a ranking product "they rigged it" is fatal and
 * unfalsifiable, so every action against a vote is an operator decision with a
 * written reason, recorded in the audit log.
 */
export async function scanIntegrity() {
  const findings: Array<typeof schema.flags.$inferInsert> = [];
  const now = Date.now();
  const bucket = Math.floor(now / HOUR);

  const liveBoards = await db
    .select({ id: schema.boards.id, title: schema.boards.title })
    .from(schema.boards)
    .where(inArray(schema.boards.status, ["live", "frozen"]));
  if (liveBoards.length === 0) return { raised: 0 };

  const boardIds = liveBoards.map((b) => b.id);

  // Inbound vote events in the last 24h — one read, several detectors.
  const recent = await db
    .select()
    .from(schema.voteEvents)
    .where(
      and(
        inArray(schema.voteEvents.boardId, boardIds),
        gte(schema.voteEvents.createdAt, new Date(now - DAY)),
        inArray(schema.voteEvents.kind, ["cast", "moved_in"]),
      ),
    );

  const lastHour = recent.filter((e) => now - e.createdAt.getTime() < HOUR);

  // 1. Velocity: an entry taking more than 100 votes in an hour.
  const perEntryHour = new Map<string, typeof recent>();
  for (const e of lastHour) {
    const list = perEntryHour.get(e.entryId) ?? [];
    list.push(e);
    perEntryHour.set(e.entryId, list);
  }
  for (const [entryId, list] of perEntryHour) {
    if (list.length > 100) {
      findings.push({
        entryId,
        boardId: list[0]!.boardId,
        type: "velocity",
        severity: list.length > 400 ? "high" : "medium",
        detail: `${list.length} votes in the last hour (threshold 100)`,
        votesInvolved: list.length,
        evidence: { window: "1h", count: list.length },
        fingerprint: `velocity:${entryId}:${bucket}`,
      });
    }
  }

  // 2. Spike: more than 5σ above the entry's own 24h hourly baseline.
  const perEntryBuckets = new Map<string, Map<number, number>>();
  for (const e of recent) {
    const b = Math.floor(e.createdAt.getTime() / HOUR);
    const map = perEntryBuckets.get(e.entryId) ?? new Map<number, number>();
    map.set(b, (map.get(b) ?? 0) + 1);
    perEntryBuckets.set(e.entryId, map);
  }
  for (const [entryId, buckets] of perEntryBuckets) {
    const history: number[] = [];
    for (let i = 1; i <= 23; i++) history.push(buckets.get(bucket - i) ?? 0);
    const current = buckets.get(bucket) ?? 0;
    if (current < 20) continue;
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length;
    const sd = Math.sqrt(variance);
    const threshold = mean + 5 * sd;
    if (sd > 0 ? current > threshold : current > Math.max(20, mean * 5)) {
      findings.push({
        entryId,
        boardId: recent.find((e) => e.entryId === entryId)!.boardId,
        type: "spike",
        severity: "high",
        detail: `${current} votes this hour vs 24h mean ${mean.toFixed(1)} (σ ${sd.toFixed(1)})`,
        votesInvolved: current,
        evidence: { current, mean, sd, threshold },
        fingerprint: `spike:${entryId}:${bucket}`,
      });
    }
  }

  // 3a. Datacentre/VPN ASN clusters.
  const perAsn = new Map<string, typeof recent>();
  for (const e of recent) {
    if (!isDatacentreAsn(e.asn)) continue;
    const key = `${e.boardId}|${e.asn}`;
    const list = perAsn.get(key) ?? [];
    list.push(e);
    perAsn.set(key, list);
  }
  for (const [key, list] of perAsn) {
    if (list.length >= 5) {
      const [boardId, asn] = key.split("|");
      findings.push({
        boardId,
        entryId: mostCommon(list.map((e) => e.entryId)),
        type: "asn_cluster",
        severity: list.length >= 25 ? "high" : "medium",
        detail: `${list.length} votes from datacentre ASN ${asn} in 24h`,
        votesInvolved: list.length,
        evidence: { asn, voters: unique(list.map((e) => e.voterId)).slice(0, 50) },
        fingerprint: `asn:${key}:${Math.floor(now / DAY)}`,
      });
    }
  }

  // 3b. Shared device fingerprints across many voters.
  const perDevice = new Map<string, typeof recent>();
  for (const e of recent) {
    if (!e.deviceFp) continue;
    const key = `${e.boardId}|${e.deviceFp}`;
    const list = perDevice.get(key) ?? [];
    list.push(e);
    perDevice.set(key, list);
  }
  for (const [key, list] of perDevice) {
    const voters = unique(list.map((e) => e.voterId));
    if (voters.length >= 4) {
      const [boardId, device] = key.split("|");
      findings.push({
        boardId,
        entryId: mostCommon(list.map((e) => e.entryId)),
        type: "device_cluster",
        severity: voters.length >= 10 ? "high" : "medium",
        detail: `${voters.length} distinct voters sharing device fingerprint ${device?.slice(0, 12)}`,
        votesInvolved: list.length,
        evidence: { device, voters: voters.slice(0, 50) },
        fingerprint: `device:${key}:${Math.floor(now / DAY)}`,
      });
    }
  }

  // 4. Burner identities: created in the last 24h, voted exactly once, never returned.
  const burners = await db
    .select({
      entryId: schema.votes.entryId,
      boardId: schema.votes.boardId,
      count: sql<number>`count(*)`,
      voters: sql<string>`group_concat(${schema.votes.voterId})`,
    })
    .from(schema.votes)
    .innerJoin(schema.voters, eq(schema.voters.id, schema.votes.voterId))
    .where(
      and(
        eq(schema.votes.status, "counted"),
        gte(schema.voters.createdAt, new Date(now - DAY)),
        isNull(schema.voters.verifiedAt),
        lt(schema.voters.createdAt, new Date(now - HOUR)),
      ),
    )
    .groupBy(schema.votes.entryId, schema.votes.boardId);
  for (const row of burners) {
    if (Number(row.count) >= 15) {
      findings.push({
        entryId: row.entryId,
        boardId: row.boardId,
        type: "burner_identities",
        severity: Number(row.count) >= 50 ? "high" : "medium",
        detail: `${row.count} single-vote unverified identities created in the last 24h`,
        votesInvolved: Number(row.count),
        evidence: { voters: String(row.voters ?? "").split(",").slice(0, 50) },
        fingerprint: `burner:${row.entryId}:${Math.floor(now / DAY)}`,
      });
    }
  }

  let raised = 0;
  for (const finding of findings) {
    try {
      await db.insert(schema.flags).values(finding);
      raised++;
    } catch {
      // fingerprint already flagged this window — nothing to do
    }
  }
  if (raised > 0) {
    await audit({ action: "integrity.flags_raised", metadata: { raised } });
  }
  return { raised };
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Voids a set of votes as one operator action. Reason is mandatory. */
export async function bulkVoid(args: {
  voteIds?: string[];
  flagId?: string;
  reason: string;
  adminId: string;
}) {
  const reason = args.reason.trim();
  if (reason.length < 8) throw new Error("A void reason of at least 8 characters is required.");

  let voteIds = args.voteIds ?? [];
  let flag: typeof schema.flags.$inferSelect | undefined;

  if (args.flagId) {
    [flag] = await db.select().from(schema.flags).where(eq(schema.flags.id, args.flagId)).limit(1);
    if (!flag) throw new Error("Flag not found");
    if (voteIds.length === 0) voteIds = await votesForFlag(flag);
  }
  if (voteIds.length === 0) return { voided: 0, boards: [] as string[] };

  const batchId = crypto.randomUUID();
  const affected = await db
    .select({ id: schema.votes.id, boardId: schema.votes.boardId, entryId: schema.votes.entryId, voterId: schema.votes.voterId, weight: schema.votes.weight })
    .from(schema.votes)
    .where(and(inArray(schema.votes.id, voteIds), eq(schema.votes.status, "counted")));

  for (const vote of affected) {
    await db
      .update(schema.votes)
      .set({ status: "voided", voidReason: reason, voidedAt: new Date(), voidBatchId: batchId })
      .where(eq(schema.votes.id, vote.id));
    await db.insert(schema.voteEvents).values({
      boardId: vote.boardId,
      entryId: vote.entryId,
      voterId: vote.voterId,
      kind: "voided",
      weight: -vote.weight,
    });
  }

  const boards = unique(affected.map((v) => v.boardId));
  for (const boardId of boards) await reconcileBoard(boardId);

  if (flag) {
    await db
      .update(schema.flags)
      .set({ resolution: "voided", resolvedBy: args.adminId, resolvedAt: new Date() })
      .where(eq(schema.flags.id, flag.id));
  }

  await audit({
    actor: { id: args.adminId, kind: "admin" },
    action: "integrity.bulk_void",
    targetType: "vote_batch",
    targetId: batchId,
    metadata: { reason, voided: affected.length, flagId: flag?.id ?? null, boards, voteIds: affected.map((v) => v.id) },
  });

  return { voided: affected.length, boards, batchId };
}

/** The votes a flag is actually about — what the operator reviews before voiding. */
export async function votesForFlag(flag: typeof schema.flags.$inferSelect) {
  const since = new Date(flag.detectedAt.getTime() - DAY);
  const evidence = (flag.evidence ?? {}) as { asn?: string; device?: string; voters?: string[] };
  const filters = [eq(schema.votes.status, "counted"), gte(schema.votes.createdAt, since)];
  if (flag.entryId) filters.push(eq(schema.votes.entryId, flag.entryId));
  if (flag.type === "asn_cluster" && evidence.asn) filters.push(eq(schema.votes.asn, evidence.asn));
  if (flag.type === "device_cluster" && evidence.device)
    filters.push(eq(schema.votes.deviceFp, evidence.device));
  if (flag.type === "burner_identities" && evidence.voters?.length)
    filters.push(inArray(schema.votes.voterId, evidence.voters));

  const rows = await db
    .select({ id: schema.votes.id })
    .from(schema.votes)
    .where(and(...filters))
    .orderBy(desc(schema.votes.createdAt))
    .limit(2000);
  return rows.map((r) => r.id);
}

/** Public integrity note: votes voided in the last 24 hours (§4). */
export async function integrityNote(boardId: string) {
  const since = new Date(Date.now() - DAY);
  const [voided] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.votes)
    .where(
      and(
        eq(schema.votes.boardId, boardId),
        eq(schema.votes.status, "voided"),
        gte(schema.votes.voidedAt, since),
      ),
    );
  const [open] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.flags)
    .where(and(eq(schema.flags.boardId, boardId), isNull(schema.flags.resolution)));
  return {
    voidedLast24h: Number(voided?.count ?? 0),
    openFlags: Number(open?.count ?? 0),
  };
}

/** NDPA 2023: raw IP/ASN are purged after 90 days, keeping only a pseudonymous hash. */
export async function purgeOldPersonalData() {
  const cutoff = new Date(Date.now() - 90 * DAY);
  const stale = await db
    .select({ id: schema.votes.id, ip: schema.votes.ip })
    .from(schema.votes)
    .where(and(lt(schema.votes.createdAt, cutoff), sql`${schema.votes.ip} is not null`))
    .limit(5000);
  for (const row of stale) {
    await db
      .update(schema.votes)
      .set({ ip: row.ip ? `pseudo:${pseudonymiseIp(row.ip)}` : null, asn: null })
      .where(eq(schema.votes.id, row.id));
  }
  await db
    .update(schema.voteEvents)
    .set({ ip: null, asn: null })
    .where(and(lt(schema.voteEvents.createdAt, cutoff), sql`${schema.voteEvents.ip} is not null`));
  if (stale.length) {
    await audit({ action: "compliance.ip_purge", metadata: { rows: stale.length, cutoff: cutoff.toISOString() } });
  }
  return { purged: stale.length };
}
