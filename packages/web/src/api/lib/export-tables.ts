/**
 * Tables carried over when the database moves, in an order that satisfies
 * every foreign key. Sessions and OTP codes are left behind on purpose: they
 * expire on their own, and sessions are tied to the old site's address anyway.
 */
export const EXPORT_TABLES = [
  "sponsors",
  "admins",
  "settings",
  "boards",
  "entries",
  "voters",
  "votes",
  "vote_receipts",
  "vote_events",
  "nominations",
  "nomination_upvotes",
  "claims",
  "flags",
  "reports",
  "reactions",
  "rank_snapshots",
  "events",
  "audit_log",
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];
