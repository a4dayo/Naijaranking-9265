/**
 * Per-key async mutex. SQLite has a single writer, so two concurrent vote
 * transactions for the same (board, voter) would race to a BUSY error and a
 * retry; serialising them in-process keeps the hot path clean. The database
 * unique constraint is still the real guarantee — this is only a fast path.
 */

const chains = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  chains.set(
    key,
    run.catch(() => undefined),
  );
  // The `.catch` is load-bearing: without it a rejected `run` would surface as
  // an unhandled rejection here (and Node kills the process for those) even
  // though the caller handles the same rejection itself.
  void run
    .finally(() => {
      if (chains.get(key) === undefined) chains.delete(key);
    })
    .catch(() => undefined);
  return run;
}

/** Retries a database operation through transient SQLite BUSY / locked errors. */
export async function withBusyRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const message = String((err as Error)?.message ?? err).toLowerCase();
      const transient =
        message.includes("busy") ||
        message.includes("locked") ||
        message.includes("stream not found") ||
        message.includes("transaction timed out");
      if (!transient) throw err;
      lastError = err;
      await new Promise((r) => setTimeout(r, 25 * 2 ** i + Math.random() * 25));
    }
  }
  throw lastError;
}
