/**
 * Cross-site request guard for the RPC API.
 *
 * Session cookies are SameSite=None (the app is previewed in a cross-site
 * iframe), and the template's CORS layer reflects any origin with credentials.
 * Together that would let any website cast votes as its visitor or read the
 * admin console as a signed-in operator. This guard refuses any RPC request a
 * browser sends from a foreign origin — preflight included — before it reaches
 * a procedure.
 *
 * Allowed:
 *   - no Origin header (native mobile app, server-to-server, curl)
 *   - same origin as the request's host
 *   - origins listed in ALLOWED_ORIGINS (comma-separated), PUBLIC_BASE_URL, WEBSITE_URL
 *   - outside production: any localhost origin (Vite, Expo web, Electron dev)
 */

function originOf(value: string | undefined | null) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function configuredOrigins() {
  const list = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value: string) => originOf(value.trim()))
    .filter((value: string | null): value is string => Boolean(value));
  for (const value of [process.env.PUBLIC_BASE_URL, process.env.WEBSITE_URL]) {
    const origin = originOf(value);
    if (origin) list.push(origin);
  }
  return new Set(list);
}

export function isAllowedOrigin(origin: string | null, headers: Headers): boolean {
  if (!origin) return true;
  if (origin === "null") return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (host && parsed.host === host.split(",")[0]!.trim()) return true;
  if (configuredOrigins().has(parsed.origin)) return true;
  if (
    process.env.NODE_ENV !== "production" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  )
    return true;
  return false;
}
