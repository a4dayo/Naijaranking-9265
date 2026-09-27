import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * NaijaRank schema. SQLite (Turso) port of the specified Postgres model.
 *
 * Two constraints are load-bearing and must never be weakened or moved into
 * application code:
 *   1. unique (board_id, voter_id) on votes   — the anti-gaming foundation
 *   2. unique (board_id, name_normalised) on entries — duplicate-entry defence
 * Both are declared here as real database unique indexes.
 */

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

export const sponsors = sqliteTable("sponsors", {
  id: id(),
  name: text("name").notNull(),
  logoUrl: text("logo_url"),
  contact: text("contact"),
  contractStart: text("contract_start"),
  contractEnd: text("contract_end"),
  createdAt: createdAt(),
});

export const boards = sqliteTable(
  "boards",
  {
    id: id(),
    title: text("title").notNull(),
    slug: text("slug").notNull().unique(),
    // Music | Film | People | Places | Culture  (hard policy list — §7)
    category: text("category").notNull(),
    description: text("description"),
    accent: text("accent"),
    entryLimit: integer("entry_limit").notNull().default(10),
    opensAt: integer("opens_at", { mode: "timestamp_ms" }),
    closesAt: integer("closes_at", { mode: "timestamp_ms" }),
    // draft | live | frozen
    status: text("status").notNull().default("draft"),
    sponsorId: text("sponsor_id").references(() => sponsors.id),
    createdBy: text("created_by"),
    // sensitive boards (claims/controversy framing) need explicit operator approval
    sensitive: integer("sensitive", { mode: "boolean" }).notNull().default(false),
    sensitiveApprovedBy: text("sensitive_approved_by"),
    sensitiveApprovedAt: integer("sensitive_approved_at", { mode: "timestamp_ms" }),
    frozenAt: integer("frozen_at", { mode: "timestamp_ms" }),
    totalVotesEffective: real("total_votes_effective").notNull().default(0),
    totalVotesRaw: integer("total_votes_raw").notNull().default(0),
    lastVoteAt: integer("last_vote_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("boards_status_idx").on(t.status), index("boards_category_idx").on(t.category)],
);

export const entries = sqliteTable(
  "entries",
  {
    id: id(),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameNormalised: text("name_normalised").notNull(),
    subtitle: text("subtitle"),
    imageUrl: text("image_url"),
    votesEffective: real("votes_effective").notNull().default(0),
    votesRaw: integer("votes_raw").notNull().default(0),
    delta24h: integer("delta_24h").notNull().default(0),
    claimed: integer("claimed", { mode: "boolean" }).notNull().default(false),
    claimedBy: text("claimed_by"),
    isSponsored: integer("is_sponsored", { mode: "boolean" }).notNull().default(false),
    // seeded | nominated
    source: text("source").notNull().default("seeded"),
    // active | pending | hidden | merged
    status: text("status").notNull().default("active"),
    mergedInto: text("merged_into"),
    createdAt: createdAt(),
  },
  (t) => [
    // MUST EXIST — prevents duplicate entries on a board.
    uniqueIndex("entries_board_name_unique").on(t.boardId, t.nameNormalised),
    index("entries_board_status_idx").on(t.boardId, t.status),
    index("entries_board_votes_idx").on(t.boardId, t.votesEffective),
  ],
);

export const voters = sqliteTable(
  "voters",
  {
    id: id(),
    // E.164 phone when SMS OTP is wired; email OTP identity for this build
    phoneE164: text("phone_e164").unique(),
    email: text("email").unique(),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    deviceFp: text("device_fp"),
    firstSeenIp: text("first_seen_ip"),
    firstSeenAsn: text("first_seen_asn"),
    weight: real("weight").notNull().default(0.25),
    // set when the voter asks for erasure (NDPA 2023 deletion path)
    erasedAt: integer("erased_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("voters_device_idx").on(t.deviceFp)],
);

export const votes = sqliteTable(
  "votes",
  {
    id: id(),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    voterId: text("voter_id")
      .notNull()
      .references(() => voters.id, { onDelete: "cascade" }),
    weight: real("weight").notNull(),
    ip: text("ip"),
    asn: text("asn"),
    deviceFp: text("device_fp"),
    idempotencyKey: text("idempotency_key"),
    // counted | voided
    status: text("status").notNull().default("counted"),
    voidReason: text("void_reason"),
    voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
    voidBatchId: text("void_batch_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: createdAt(),
  },
  (t) => [
    // MUST EXIST — one counted vote per voter per board. Entire anti-gaming foundation.
    uniqueIndex("votes_board_voter_unique").on(t.boardId, t.voterId),
    uniqueIndex("votes_idempotency_key_unique").on(t.idempotencyKey),
    index("votes_entry_idx").on(t.entryId),
    index("votes_board_created_idx").on(t.boardId, t.createdAt),
    index("votes_ip_idx").on(t.ip),
  ],
);

/**
 * Idempotency receipts. votes.idempotency_key is unique as specified, but a
 * toggle-off deletes its vote row — the receipt is what lets a retried request
 * replay the original answer without writing anything.
 */
export const voteReceipts = sqliteTable("vote_receipts", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  voterId: text("voter_id").notNull(),
  boardId: text("board_id").notNull(),
  result: text("result", { mode: "json" }).notNull(),
  createdAt: createdAt(),
});

/** Append-only log of every vote action, used for reconciliation and integrity analytics. */
export const voteEvents = sqliteTable(
  "vote_events",
  {
    id: id(),
    boardId: text("board_id").notNull(),
    entryId: text("entry_id").notNull(),
    voterId: text("voter_id").notNull(),
    // cast | moved_in | moved_out | toggled_off | voided
    kind: text("kind").notNull(),
    weight: real("weight").notNull(),
    ip: text("ip"),
    asn: text("asn"),
    deviceFp: text("device_fp"),
    createdAt: createdAt(),
  },
  (t) => [
    index("vote_events_entry_created_idx").on(t.entryId, t.createdAt),
    index("vote_events_board_created_idx").on(t.boardId, t.createdAt),
  ],
);

export const nominations = sqliteTable(
  "nominations",
  {
    id: id(),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    submittedName: text("submitted_name").notNull(),
    submittedBy: text("submitted_by"),
    // pending | approved | rejected
    status: text("status").notNull().default("pending"),
    screeningResult: text("screening_result"),
    upvotes: integer("upvotes").notNull().default(0),
    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("nominations_board_status_idx").on(t.boardId, t.status)],
);

export const nominationUpvotes = sqliteTable(
  "nomination_upvotes",
  {
    id: id(),
    nominationId: text("nomination_id")
      .notNull()
      .references(() => nominations.id, { onDelete: "cascade" }),
    voterId: text("voter_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("nomination_upvote_unique").on(t.nominationId, t.voterId)],
);

export const claims = sqliteTable(
  "claims",
  {
    id: id(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    requestedPhone: text("requested_phone").notNull(),
    evidenceUrl: text("evidence_url"),
    // pending | approved | rejected
    status: text("status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("claims_status_idx").on(t.status)],
);

export const flags = sqliteTable(
  "flags",
  {
    id: id(),
    entryId: text("entry_id").references(() => entries.id),
    boardId: text("board_id").references(() => boards.id),
    // velocity | spike | asn_cluster | device_cluster | burner_identities
    type: text("type").notNull(),
    // low | medium | high
    severity: text("severity").notNull(),
    detail: text("detail"),
    evidence: text("evidence", { mode: "json" }),
    votesInvolved: integer("votes_involved").notNull().default(0),
    detectedAt: integer("detected_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedBy: text("resolved_by"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    // null while open: voided | dismissed | monitoring
    resolution: text("resolution"),
    // dedupe key so the scanner does not re-raise the same finding every 30s
    fingerprint: text("fingerprint"),
  },
  (t) => [
    index("flags_resolution_idx").on(t.resolution),
    uniqueIndex("flags_fingerprint_unique").on(t.fingerprint),
  ],
);

export const reports = sqliteTable(
  "reports",
  {
    id: id(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    reporterId: text("reporter_id"),
    reason: text("reason"),
    // pending | actioned | dismissed
    status: text("status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("reports_status_idx").on(t.status)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actor: text("actor"),
    actorKind: text("actor_kind").notNull().default("system"), // system | voter | admin
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt)],
);

/** Operators of the console. Email + password for this build; 2FA fields are reserved. */
export const admins = sqliteTable("admins", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("operator"), // operator | owner
  totpSecret: text("totp_secret"),
  totpEnabled: integer("totp_enabled", { mode: "boolean" }).notNull().default(false),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
  lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
});

/** Sessions for both voters (180 days) and admins (12 hours). */
export const sessions = sqliteTable(
  "sessions",
  {
    id: id(),
    kind: text("kind").notNull(), // voter | admin
    subjectId: text("subject_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_subject_idx").on(t.subjectId)],
);

/** One-time codes for email OTP (SMS aggregator swaps in behind the same table). */
export const otpCodes = sqliteTable(
  "otp_codes",
  {
    id: id(),
    channel: text("channel").notNull().default("email"), // email | sms | whatsapp
    destination: text("destination").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
    provider: text("provider"),
    delivered: integer("delivered", { mode: "boolean" }).notNull().default(false),
    costKobo: integer("cost_kobo").notNull().default(0),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("otp_destination_idx").on(t.destination, t.createdAt)],
);

export const reactions = sqliteTable(
  "reactions",
  {
    id: id(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    voterId: text("voter_id").notNull(),
    emoji: text("emoji").notNull(), // 🔥 😂 😐 💯
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reaction_unique").on(t.entryId, t.voterId, t.emoji),
    index("reactions_entry_idx").on(t.entryId),
  ],
);

/** Product instrumentation (§9). */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    boardId: text("board_id"),
    entryId: text("entry_id"),
    voterId: text("voter_id"),
    sessionKey: text("session_key"),
    referrer: text("referrer"),
    props: text("props", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [index("events_name_created_idx").on(t.name, t.createdAt)],
);

/** Rank snapshots, so 24h deltas and the movers panel are real rather than guessed. */
export const rankSnapshots = sqliteTable(
  "rank_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    boardId: text("board_id").notNull(),
    entryId: text("entry_id").notNull(),
    rank: integer("rank").notNull(),
    votesEffective: real("votes_effective").notNull(),
    takenAt: integer("taken_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("rank_snapshots_board_taken_idx").on(t.boardId, t.takenAt)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const nowMs = sql`(cast(strftime('%s','now') as integer) * 1000)`;
