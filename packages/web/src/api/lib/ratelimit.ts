/**
 * In-process sliding-window rate limiter.
 *
 * The spec called for Upstash Redis because Vercel runs serverless functions with
 * no shared memory. This app runs as a single long-lived Bun process, so counters
 * live in memory here — same behaviour (per IP, per device, per voter), one less
 * network hop, and never a source of truth for vote counts.
 *
 * If this is ever scaled to multiple instances, swap `hits` for a Redis sorted set;
 * the `check()` signature is the boundary that would stay the same.
 */

interface Window {
  timestamps: number[];
}

const hits = new Map<string, Window>();

let lastSweep = Date.now();

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, win] of hits) {
    if (win.timestamps.length === 0 || now - win.timestamps.at(-1)! > 3_600_000) hits.delete(key);
  }
}

export interface LimitResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

/** Records a hit and reports whether the caller is inside the limit. */
export function check(key: string, limit: number, windowMs: number): LimitResult {
  const now = Date.now();
  sweep(now);
  const win = hits.get(key) ?? { timestamps: [] };
  win.timestamps = win.timestamps.filter((t) => now - t < windowMs);
  if (win.timestamps.length >= limit) {
    hits.set(key, win);
    const oldest = win.timestamps[0]!;
    return { ok: false, remaining: 0, retryAfterMs: windowMs - (now - oldest) };
  }
  win.timestamps.push(now);
  hits.set(key, win);
  return { ok: true, remaining: limit - win.timestamps.length, retryAfterMs: 0 };
}

/** Peek without recording a hit. */
export function peek(key: string, limit: number, windowMs: number): LimitResult {
  const now = Date.now();
  const win = hits.get(key);
  const timestamps = (win?.timestamps ?? []).filter((t) => now - t < windowMs);
  if (timestamps.length >= limit) {
    return { ok: false, remaining: 0, retryAfterMs: windowMs - (now - timestamps[0]!) };
  }
  return { ok: true, remaining: limit - timestamps.length, retryAfterMs: 0 };
}

export const LIMITS = {
  /** Votes: generous enough for real switching, tight enough to stop scripts. */
  voteByIp: { limit: 40, windowMs: 60_000 },
  voteByDevice: { limit: 20, windowMs: 60_000 },
  voteByVoter: { limit: 12, windowMs: 60_000 },
  /** OTP: 3 per destination per hour, 10 per IP per hour (§3). */
  otpByDestination: { limit: 3, windowMs: 3_600_000 },
  otpByIp: { limit: 10, windowMs: 3_600_000 },
  otpVerifyByIp: { limit: 20, windowMs: 3_600_000 },
  nominationByVoter: { limit: 5, windowMs: 3_600_000 },
  reportByVoter: { limit: 10, windowMs: 3_600_000 },
  adminLoginByIp: { limit: 10, windowMs: 900_000 },
  eventsByDevice: { limit: 300, windowMs: 60_000 },
} as const;

export function limited(name: keyof typeof LIMITS, subject: string) {
  const { limit, windowMs } = LIMITS[name];
  return check(`${name}:${subject}`, limit, windowMs);
}
