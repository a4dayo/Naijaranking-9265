import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { hashSessionPayload, newSessionToken, verifyToken } from "../lib/crypto";
import { buildCookie, clientAsn, clientIp, deviceFingerprint, readCookie } from "../lib/request";

export const VOTER_COOKIE = "nr_voter";
export const ADMIN_COOKIE = "nr_admin";
export const VOTER_TTL_DAYS = 180;
export const ADMIN_TTL_HOURS = 12;

export interface VoterIdentity {
  voter: typeof schema.voters.$inferSelect | null;
  /** Fresh cookie/token to hand back to the client, when a voter row was just created. */
  issued?: { token: string; cookie: string };
}

function tokenFrom(headers: Headers, cookieName: string, headerName: string) {
  // Cookie is the primary carrier (HttpOnly, 180 days). The bearer header mirror
  // exists because the app is previewed inside a cross-site iframe, where some
  // browsers drop SameSite cookies entirely.
  return readCookie(headers, cookieName) ?? headers.get(headerName) ?? null;
}

async function resolveSession(token: string | null, kind: "voter" | "admin") {
  const payload = verifyToken(token);
  if (!payload) return null;
  const [row] = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.tokenHash, hashSessionPayload(payload)),
        eq(schema.sessions.kind, kind),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function createSession(
  kind: "voter" | "admin",
  subjectId: string,
  headers: Headers,
  ttlMs: number,
) {
  const { raw, token, tokenHash } = newSessionToken();
  void raw;
  await db.insert(schema.sessions).values({
    kind,
    subjectId,
    tokenHash,
    userAgent: headers.get("user-agent")?.slice(0, 200) ?? null,
    ip: clientIp(headers),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  const cookieName = kind === "voter" ? VOTER_COOKIE : ADMIN_COOKIE;
  const cookie = buildCookie(cookieName, token, {
    maxAge: Math.floor(ttlMs / 1000),
    sameSite: "None",
  });
  return { token, cookie };
}

export function createVoterSession(voterId: string, headers: Headers) {
  return createSession("voter", voterId, headers, VOTER_TTL_DAYS * 86_400_000);
}

export function createAdminSession(adminId: string, headers: Headers) {
  return createSession("admin", adminId, headers, ADMIN_TTL_HOURS * 3_600_000);
}

export async function revokeSession(token: string | null, kind: "voter" | "admin") {
  const payload = verifyToken(token);
  if (!payload) return;
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.sessions.tokenHash, hashSessionPayload(payload)),
        eq(schema.sessions.kind, kind),
      ),
    );
}

/** Reads the voter behind a request, if any. Does not create one. */
export async function currentVoter(headers: Headers) {
  const session = await resolveSession(tokenFrom(headers, VOTER_COOKIE, "x-nr-session"), "voter");
  if (!session) return null;
  const [voter] = await db
    .select()
    .from(schema.voters)
    .where(eq(schema.voters.id, session.subjectId))
    .limit(1);
  if (!voter || voter.erasedAt) return null;
  return voter;
}

/**
 * Returns the voter behind a request, creating an anonymous one on first vote.
 * Anonymous voters count at weight 0.25 — we never block the first vote behind a
 * login wall, because that kills the funnel.
 */
export async function ensureVoter(headers: Headers): Promise<{
  voter: typeof schema.voters.$inferSelect;
  issued?: { token: string; cookie: string };
}> {
  const existing = await currentVoter(headers);
  if (existing) return { voter: existing };

  const [voter] = await db
    .insert(schema.voters)
    .values({
      deviceFp: deviceFingerprint(headers),
      firstSeenIp: clientIp(headers),
      firstSeenAsn: clientAsn(headers),
      weight: 0.25,
    })
    .returning();
  const issued = await createVoterSession(voter!.id, headers);
  return { voter: voter!, issued };
}

export async function currentAdmin(headers: Headers) {
  const session = await resolveSession(
    tokenFrom(headers, ADMIN_COOKIE, "x-nr-admin-session"),
    "admin",
  );
  if (!session) return null;
  const [admin] = await db
    .select()
    .from(schema.admins)
    .where(eq(schema.admins.id, session.subjectId))
    .limit(1);
  return admin ?? null;
}

export function voterToken(headers: Headers) {
  return tokenFrom(headers, VOTER_COOKIE, "x-nr-session");
}

export function adminToken(headers: Headers) {
  return tokenFrom(headers, ADMIN_COOKIE, "x-nr-admin-session");
}
