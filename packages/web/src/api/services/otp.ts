import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { hashOtp, newOtpCode, safeEqual } from "../lib/crypto";
import { clientAsn, clientIp, deviceFingerprint } from "../lib/request";
import { limited } from "../lib/ratelimit";
import { normaliseEmail, normaliseNgPhone } from "../lib/text";
import { audit, track } from "./audit";
import { deliverEmailOtp } from "./notify";
import { createVoterSession, currentVoter } from "./session";
import { reconcileBoard } from "./vote";

const OTP_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;

export class OtpError extends Error {
  constructor(
    message: string,
    readonly code: "RATE_LIMIT" | "INVALID" | "EXPIRED" | "LOCKED" | "BAD_DESTINATION",
  ) {
    super(message);
  }
}

/** Accepts an email (live channel) or a Nigerian phone number (normalised to E.164). */
export function normaliseDestination(raw: string): { channel: "email" | "sms"; destination: string } {
  const email = normaliseEmail(raw);
  if (email) return { channel: "email", destination: email };
  const phone = normaliseNgPhone(raw);
  if (phone) return { channel: "sms", destination: phone };
  throw new OtpError("Enter a valid email address or Nigerian phone number.", "BAD_DESTINATION");
}

export async function requestOtp(raw: string, headers: Headers) {
  const { channel, destination } = normaliseDestination(raw);
  const ip = clientIp(headers);

  if (!limited("otpByIp", ip).ok)
    throw new OtpError("Too many codes requested from this network. Try again later.", "RATE_LIMIT");
  if (!limited("otpByDestination", destination).ok)
    throw new OtpError("You have requested 3 codes in the last hour. Try again later.", "RATE_LIMIT");

  if (channel === "sms") {
    throw new OtpError(
      "SMS codes are not live yet — verify with your email address for now.",
      "BAD_DESTINATION",
    );
  }

  const code = newOtpCode();
  const delivery = await deliverEmailOtp(destination, code);

  await db.insert(schema.otpCodes).values({
    channel,
    destination,
    codeHash: hashOtp(destination, code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    provider: delivery.provider,
    delivered: delivery.delivered,
    costKobo: delivery.costKobo,
    ip,
  });

  await audit({ action: "otp.requested", targetType: "destination", targetId: destination, metadata: { channel, provider: delivery.provider, delivered: delivery.delivered } });
  void track("otp_shown", { channel, provider: delivery.provider });

  return {
    destination,
    channel,
    delivered: delivery.delivered,
    provider: delivery.provider,
    /** Dev mode only — no provider configured, so the code comes back inline. */
    devCode: delivery.devCode,
    expiresInSeconds: OTP_TTL_MS / 1000,
  };
}

export async function verifyOtp(raw: string, code: string, headers: Headers) {
  const { destination } = normaliseDestination(raw);
  const ip = clientIp(headers);
  if (!limited("otpVerifyByIp", ip).ok)
    throw new OtpError("Too many verification attempts. Try again later.", "RATE_LIMIT");

  const [record] = await db
    .select()
    .from(schema.otpCodes)
    .where(and(eq(schema.otpCodes.destination, destination), isNull(schema.otpCodes.consumedAt)))
    .orderBy(desc(schema.otpCodes.createdAt))
    .limit(1);

  if (!record) throw new OtpError("Request a new code.", "EXPIRED");
  if (record.lockedUntil && record.lockedUntil > new Date())
    throw new OtpError("Too many wrong codes. Try again in 15 minutes.", "LOCKED");
  if (record.expiresAt < new Date()) throw new OtpError("That code expired. Request a new one.", "EXPIRED");

  const matches = safeEqual(record.codeHash, hashOtp(destination, code.trim()));
  if (!matches) {
    const attempts = record.attempts + 1;
    await db
      .update(schema.otpCodes)
      .set({
        attempts,
        lockedUntil: attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null,
      })
      .where(eq(schema.otpCodes.id, record.id));
    void track("otp_failed", { destination, attempts });
    throw new OtpError(
      attempts >= MAX_ATTEMPTS ? "Too many wrong codes. Try again in 15 minutes." : "That code is not right.",
      attempts >= MAX_ATTEMPTS ? "LOCKED" : "INVALID",
    );
  }

  await db
    .update(schema.otpCodes)
    .set({ consumedAt: new Date(), attempts: record.attempts + 1 })
    .where(eq(schema.otpCodes.id, record.id));

  const linked = await linkVerifiedIdentity(destination, headers);
  void track("otp_verified", { voterId: linked.voter.id, destination });
  return linked;
}

/**
 * Attaches the verified identity to the current (possibly anonymous) voter and
 * upgrades every vote that voter already cast from 0.25 to full weight.
 *
 * If the identity already belongs to another voter row, that row wins — one
 * person, one identity — and the anonymous row's votes are not merged across,
 * because unique(board_id, voter_id) already caps each identity at one vote per board.
 */
export async function linkVerifiedIdentity(destination: string, headers: Headers) {
  const isEmail = destination.includes("@");
  const anonymous = await currentVoter(headers);

  const [owner] = await db
    .select()
    .from(schema.voters)
    .where(isEmail ? eq(schema.voters.email, destination) : eq(schema.voters.phoneE164, destination))
    .limit(1);

  let voter: typeof schema.voters.$inferSelect;
  let reissue = true;

  if (owner) {
    voter = owner;
    if (anonymous && anonymous.id === owner.id) reissue = false;
    await db
      .update(schema.voters)
      .set({
        verifiedAt: owner.verifiedAt ?? new Date(),
        weight: 1,
        deviceFp: deviceFingerprint(headers),
      })
      .where(eq(schema.voters.id, owner.id));
  } else if (anonymous) {
    const [updated] = await db
      .update(schema.voters)
      .set({
        ...(isEmail ? { email: destination } : { phoneE164: destination }),
        verifiedAt: new Date(),
        weight: 1,
      })
      .where(eq(schema.voters.id, anonymous.id))
      .returning();
    voter = updated!;
    reissue = false;
  } else {
    const [created] = await db
      .insert(schema.voters)
      .values({
        ...(isEmail ? { email: destination } : { phoneE164: destination }),
        verifiedAt: new Date(),
        weight: 1,
        deviceFp: deviceFingerprint(headers),
        firstSeenIp: clientIp(headers),
        firstSeenAsn: clientAsn(headers),
      })
      .returning();
    voter = created!;
  }

  // Upgrade this voter's existing votes to full weight, then reconcile the boards
  // they touched so the counters match the votes table exactly.
  const affected = await db
    .select({ boardId: schema.votes.boardId })
    .from(schema.votes)
    .where(and(eq(schema.votes.voterId, voter.id), eq(schema.votes.status, "counted")))
    .groupBy(schema.votes.boardId);
  if (affected.length) {
    await db
      .update(schema.votes)
      .set({ weight: 1, updatedAt: new Date() })
      .where(
        and(
          eq(schema.votes.voterId, voter.id),
          eq(schema.votes.status, "counted"),
          sql`${schema.votes.weight} < 1`,
        ),
      );
    for (const row of affected) await reconcileBoard(row.boardId);
  }

  await audit({
    actor: { id: voter.id, kind: "voter" },
    action: "voter.verified",
    targetType: "voter",
    targetId: voter.id,
    metadata: { destination, upgradedBoards: affected.map((a) => a.boardId) },
  });

  const session = reissue ? await createVoterSession(voter.id, headers) : null;
  return { voter, session, upgradedBoards: affected.map((a) => a.boardId) };
}
