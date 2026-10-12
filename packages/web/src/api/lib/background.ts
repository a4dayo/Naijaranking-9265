import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Keeps fire-and-forget work alive after the response is sent.
 *
 * Under Bun the process outlives every request, so nothing is needed. On
 * Cloudflare Workers, work still running when the response finishes can be
 * cancelled unless it is handed to `ctx.waitUntil`. The Worker runs each request
 * inside `withBackground`, and `inBackground` registers a promise with that
 * request's own context (AsyncLocalStorage keeps concurrent requests apart).
 */
type WaitUntil = (promise: Promise<unknown>) => void;

const current = new AsyncLocalStorage<WaitUntil>();

export function withBackground<T>(waitUntil: WaitUntil, fn: () => T): T {
  return current.run(waitUntil, fn);
}

export function inBackground<T>(promise: Promise<T>): Promise<T> {
  current.getStore()?.(promise);
  return promise;
}
