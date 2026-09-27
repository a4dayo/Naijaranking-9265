import { inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { purgeOldPersonalData, scanIntegrity } from "./integrity";
import { snapshotRanks } from "./rank";
import { reconcileBoard } from "./vote";

/**
 * Background jobs. On Vercel these would be cron functions; here the app is one
 * long-lived Bun process, so they are intervals started once at boot.
 *
 *   every 30s  — reconcile counters against the votes table (drift can never stand)
 *   every 5m   — integrity scan (flags only, never auto-voids)
 *   every 1h   — rank snapshot, which is what makes delta_24h real
 *   every 24h  — NDPA raw IP/ASN purge past 90 days
 */

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

/** Runs a job, logging failures without ever killing the interval. */
function safely(name: string, fn: () => Promise<unknown>) {
  return () => {
    fn().catch((err) => console.error(`[jobs] ${name} failed`, err));
  };
}

const reconcileAll = async () => {
  const ids = await activeBoardIds();
  for (const id of ids) await reconcileBoard(id);
};

const snapshotAll = async () => {
  const ids = await activeBoardIds();
  for (const id of ids) await snapshotRanks(id);
};

export function startJobs() {
  if (started) return;
  started = true;

  // The API is a long-lived process, so these intervals are meant to hold it
  // open for as long as it runs; nothing needs to be unref'd.
  setInterval(safely("reconcile", reconcileAll), RECONCILE_MS);
  setInterval(safely("integrity-scan", scanIntegrity), SCAN_MS);
  setInterval(safely("rank-snapshot", snapshotAll), SNAPSHOT_MS);
  setInterval(safely("ip-purge", purgeOldPersonalData), PURGE_MS);

  // An immediate snapshot means a freshly booted process has a baseline to
  // compute deltas against rather than showing zeroes for an hour.
  safely("rank-snapshot", snapshotAll)();
  console.log("[jobs] started: reconcile 30s, scan 5m, snapshot 1h, purge 24h");
}
