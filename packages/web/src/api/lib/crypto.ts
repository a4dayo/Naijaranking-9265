import { createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

const SECRET =
  process.env.SESSION_SECRET ?? process.env.BETTER_AUTH_SECRET ?? "naijarank-dev-secret-change-me";

/** Constant-time string compare that never throws on length mismatch. */
export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(value: string) {
  return createHmac("sha256", SECRET).update(value).digest("base64url");
}

/**
 * Signed opaque token: `<payload>.<hmac>`. The payload is a random id that is also
 * stored (hashed) in the sessions table, so a token is only valid while its row is.
 */
export function signToken(payload: string) {
  return `${payload}.${hmac(payload)}`;
}

export function verifyToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!safeEqual(sig, hmac(payload))) return null;
  return payload;
}

export function newSessionToken() {
  const raw = randomBytes(24).toString("base64url");
  return { raw, token: signToken(raw), tokenHash: sha256(raw) };
}

export function hashSessionPayload(payload: string) {
  return sha256(payload);
}

/** 6-digit OTP, uniformly random. */
export function newOtpCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashOtp(destination: string, code: string) {
  return createHmac("sha256", SECRET).update(`${destination}:${code}`).digest("hex");
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string) {
  const [scheme, salt, derived] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !derived) return false;
  return safeEqual(scryptSync(password, salt, 64).toString("hex"), derived);
}

/** Stable pseudonymous hash for IPs kept past the 90-day raw-retention window. */
export function pseudonymiseIp(ip: string) {
  return createHmac("sha256", SECRET).update(`ip:${ip}`).digest("hex").slice(0, 32);
}
