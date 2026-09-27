/**
 * Session token storage.
 *
 * The server sets an HttpOnly cookie, but the app is also previewed inside a
 * cross-site iframe where browsers drop those cookies — so every token the API
 * issues is mirrored into localStorage and sent back as a bearer header.
 */
const VOTER_KEY = "nr_voter_token";
const ADMIN_KEY = "nr_admin_token";

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode — the cookie is the fallback */
  }
}

export const voterToken = () => read(VOTER_KEY);
export const setVoterToken = (token: string | null) => write(VOTER_KEY, token);
export const adminToken = () => read(ADMIN_KEY);
export const setAdminToken = (token: string | null) => write(ADMIN_KEY, token);

/** Headers the RPC link attaches to every call. */
export function sessionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const voter = voterToken();
  const admin = adminToken();
  if (voter) headers["x-nr-session"] = voter;
  if (admin) headers["x-nr-admin-session"] = admin;
  return headers;
}

/** Client-generated idempotency key — a retried tap can never double-count. */
export function idempotencyKey(boardId: string, entryId: string) {
  const rand =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${boardId.slice(0, 8)}-${entryId.slice(0, 8)}-${rand}`.slice(0, 80);
}
