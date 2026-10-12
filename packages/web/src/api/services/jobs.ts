import { inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { purgeOldPersonalData, scanIntegrity } from "./integrity";
import { convertLegacyAnonymousVotes } from "./migrations";
import { snapshotRanks } from "./rank";
import { reconcileBoard } from "./vote";

/**
 * Background jobs.
 *
 *   reconcile — counters against the votes table (drift can never stand); also
 *               converts any legacy 0.25 anonymous votes to pending first
 *   scan      — integrity scan (flags only, never auto-voids)
 *   snapshot  — rank snapshot, which is what makes delta_24h real
 *   purge     — NDPA raw IP/ASN purge past 90 days
 *
 * Under Bun (local dev, any long-lived server) `startJobs` runs them on
 * intervals. On Cloudflare Workers there are no long-lived timers: Cron
 * Triggers call `runJob` instead (see src/worker.ts and wrangler.jsonc).
 */

export type JobName = "reconcile" | "scan" | "snapshot" | "purge";

const RECONCILE_MS = 30_000;
const SCAN_MS = 5 * 60_000;
const SNAPSHOT_MS = 60 * 60_000;
const PURGE_MS = 24 * 60 * 60_000;

let started = false;

async function activeBoardIds() {
  const rows = await db
    .select({ id: schema.boards.id })
    .from(schema.boards)
    .where(inArray(schema.boards.status, ["live", "frozen"]));
  return rows.map((r) => r.id);
}

const JOBS: Record<JobName, () => Promise<unknown>> = {
  reconcile: async () => {
    // Unverified votes from before pending votes existed still carry 0.25.
    // Cheap no-op once converted, so it simply runs ahead of every reconcile.
    const converted = await convertLegacyAnonymousVotes();
    if (converted.converted)
      console.log(`[jobs] converted ${converted.converted} legacy anonymous votes to pending`);
    for (const id of await activeBoardIds()) await reconcileBoard(id);
  },
  scan: () => scanIntegrity(),
  snapshot: async () => {
    for (const id of await activeBoardIds()) await snapshotRanks(id);
  },
  purge: () => purgeOldPersonalData(),
};

/** Runs one job, logging failures instead of throwing. */
export async function runJob(name: JobName) {
  try {
    await JOBS[name]();
  } catch (err) {
    console.error(`[jobs] ${name} failed`, err);
  }
}

export function startJobs() {
  // Test runs drive these jobs explicitly; background intervals would race them.
  if (started || process.env.NODE_ENV === "test") return;
  started = true;

  // The API is a long-lived process, so these intervals are meant to hold it
  // open for as long as it runs; nothing needs to be unref'd.
  setInterval(() => void runJob("reconcile"), RECONCILE_MS);
  setInterval(() => void runJob("scan"), SCAN_MS);
  setInterval(() => void runJob("snapshot"), SNAPSHOT_MS);
  setInterval(() => void runJob("purge"), PURGE_MS);

  // Convert legacy votes straight away, and give a freshly booted process a
  // rank baseline rather than zero deltas for an hour.
  void runJob("reconcile");
  void runJob("snapshot");
  console.log("[jobs] started: reconcile 30s, scan 5m, snapshot 1h, purge 24h");
}
