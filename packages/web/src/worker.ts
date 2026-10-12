/**
 * Cloudflare Workers entry point.
 *
 *   fetch      /api/* goes to the Hono app; every other path is served from the
 *              built SPA by Workers Static Assets (see wrangler.jsonc), which
 *              never reaches this code.
 *   scheduled  Cron Triggers run the background jobs that the Bun server runs
 *              on intervals (src/api/services/jobs.ts).
 *   RateLimiter  Durable Object holding the rate-limit counters, so every
 *              isolate shares one view instead of keeping its own.
 *
 * The Bun server (src/__server.ts) stays the way to run the app locally.
 */
import { DurableObject } from "cloudflare:workers";
import app from "./api";
import { withBackground } from "./api/lib/background";
import { check, setLimitBackend, type LimitResult } from "./api/lib/ratelimit";
import { runJob, type JobName } from "./api/services/jobs";

interface Env {
  ASSETS: Fetcher;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  [key: string]: unknown;
}

/** Must match the `triggers.crons` list in wrangler.jsonc. */
const CRON_JOBS: Record<string, JobName> = {
  "* * * * *": "reconcile",
  "*/5 * * * *": "scan",
  "7 * * * *": "snapshot",
  "23 2 * * *": "purge",
};

/** Header the Worker stamps with Cloudflare's own ASN for the caller. */
const EDGE_ASN_HEADER = "x-nr-edge-asn";

/**
 * The app reads configuration from process.env. Bindings are usually there
 * already (nodejs_compat populates it), but copy string vars and secrets across
 * in case they are not.
 */
function exposeEnv(env: Env) {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && process.env[key] === undefined) process.env[key] = value;
  }
}

const SHARDS = 32;
function shardFor(key: string) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `limits-${(hash >>> 0) % SHARDS}`;
}

function useSharedLimits(env: Env) {
  setLimitBackend({
    hit: (key, limit, windowMs) =>
      env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(shardFor(key))).hit(key, limit, windowMs),
  });
}

/**
 * Cloudflare sets cf-connecting-ip itself and overwrites any client value. The
 * ASN comes from request.cf; anything a client sent under our header name is
 * replaced, so it can never be spoofed.
 */
function withEdgeHeaders(request: Request) {
  const headers = new Headers(request.headers);
  const asn = (request as Request & { cf?: { asn?: number } }).cf?.asn;
  if (asn) headers.set(EDGE_ASN_HEADER, String(asn));
  else headers.delete(EDGE_ASN_HEADER);
  return new Request(request, { headers });
}

export default {
  async fetch(request, env, ctx) {
    exposeEnv(env);
    useSharedLimits(env);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api")) return env.ASSETS.fetch(request);
    return withBackground(
      (promise) => ctx.waitUntil(promise),
      () => app.fetch(withEdgeHeaders(request), env, ctx),
    );
  },

  async scheduled(controller, env, ctx) {
    exposeEnv(env);
    useSharedLimits(env);
    const job = CRON_JOBS[controller.cron];
    if (!job) {
      console.error(`[cron] no job mapped to "${controller.cron}"`);
      return;
    }
    ctx.waitUntil(runJob(job));
  },
} satisfies ExportedHandler<Env>;

/**
 * Rate-limit counters, sharded across a fixed set of instances by key. Counts
 * live in memory, exactly as they did in the single Bun process: if Cloudflare
 * evicts an idle instance its windows reset, which only ever errs towards
 * letting a request through.
 */
export class RateLimiter extends DurableObject {
  async hit(key: string, limit: number, windowMs: number): Promise<LimitResult> {
    return check(key, limit, windowMs);
  }
}
