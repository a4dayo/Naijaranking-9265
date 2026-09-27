/**
 * Error shape helpers.
 *
 * Drizzle wraps driver errors: `err.message` is only the SQL it tried to run
 * ("Failed query: insert into ..."), and the actual SQLite message —
 * "UNIQUE constraint failed: entries.board_id, entries.name_normalised" —
 * lives further down the `cause` chain. Anything deciding behaviour from a
 * constraint violation has to walk that chain, or it silently misses every
 * duplicate.
 */

/** Every message in an error's cause chain, joined. */
export function errorChain(err: unknown, depth = 6): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < depth && current; i += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
      continue;
    }
    parts.push(String(current));
    break;
  }
  return parts.join(" | ");
}

/** True when the error is a unique-index violation, however deeply wrapped. */
export function isUniqueViolation(err: unknown): boolean {
  return /unique/i.test(errorChain(err));
}
