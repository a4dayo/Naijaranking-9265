import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { hashOtp, identityHash, newOtpCode, safeEqual } from "../lib/crypto";
import { clientAsn, clientIp, deviceFingerprint } from "../lib/request";
import { limited } from "../lib/ratelimit";
import { normaliseEmail, normaliseNgPhone } from "../lib/text";
import { audit, track } from "./audit";
import { deliverEmailOtp } from "./notify";
import { createVoterSession, currentVoter } from "./session";
import { reconcileBoard } from "./vote";
import { weightForChannel } from "./weights";

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

  await audit({ action: "otp.requested", targetType: "identity", targetId: identityHash(destination), metadata: { channel, provider: delivery.provider, delivered: delivery.delivered } });
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
    void track("otp_failed", { identity: identityHash(destination), attempts });
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
  void track("otp_verified", { voterId: linked.voter.id });
  return linked;
}

/**
 * Attaches the verified identity to a voter and turns every pending vote that
 * voter holds into a counted one.
 *
 * - The identity already has a voter row (looked up by its keyed hash, which
 *   survives erasure): that row wins — one identity, one voter. An erased row is
 *   restored rather than replaced, so erasing and re-verifying can never mint a
 *   second vote. Pending votes cast from this device before verifying are moved
 *   onto that row, except on boards where it already has a vote.
 * - Otherwise the identity is attached to the current anonymous voter.
 * - A voter who is already verified under a different identity is never
 *   re-pointed; a fresh voter row is created and the session switches to it.
 */
export async function linkVerifiedIdentity(destination: string, headers: Headers) {
  const channel = destination.includes("@") ? "email" : "sms";
  const isEmail = channel === "email";
  const hash = identityHash(destination);
  const weight = weightForChannel(channel);
  const identityFields = isEmail ? { email: destination } : { phoneE164: destination };
  const current = await currentVoter(headers);

  const owners = await db
    .select()
    .from(schema.voters)
    .where(
      or(
        eq(schema.voters.identityHash, hash),
        isEmail ? eq(schema.voters.email, destination) : eq(schema.voters.phoneE164, destination),
      ),
    );
  const owner = owners.find((row) => !row.erasedAt) ?? owners[0];

  let voter: typeof schema.voters.$inferSelect;
  let reissue = true;
  const touchedBoards = new Set<string>();

  if (owner) {
    const [updated] = await db
      .update(schema.voters)
      .set({
        ...identityFields,
        identityHash: hash,
        verifiedAt: owner.verifiedAt && !owner.erasedAt ? owner.verifiedAt : new Date(),
        erasedAt: null,
        weight,
        deviceFp: deviceFingerprint(headers),
      })
      .where(eq(schema.voters.id, owner.id))
      .returning();
    voter = updated!;
    if (current && current.id === owner.id) reissue = false;
    else if (current && !current.verifiedAt) {
      for (const boardId of await mergeAnonymousVotes(current.id, owner.id)) touchedBoards.add(boardId);
    }
  } else if (current && !current.verifiedAt) {
    const [updated] = await db
      .update(schema.voters)
      .set({ ...identityFields, identityHash: hash, verifiedAt: new Date(), weight })
      .where(eq(schema.voters.id, current.id))
      .returning();
    voter = updated!;
    reissue = false;
  } else {
    const [created] = await db
      .insert(schema.voters)
      .values({
        ...identityFields,
        identityHash: hash,
        verifiedAt: new Date(),
        weight,
        deviceFp: deviceFingerprint(headers),
        firstSeenIp: clientIp(headers),
        firstSeenAsn: clientAsn(headers),
      })
      .returning();
    voter = created!;
  }

  // Pending votes become counted. Each upgrade is logged as a vote event so the
  // movers panel and the integrity scanner see verified weight arriving.
  // Frozen boards are final: nothing on them is re-weighted.
  const pending = await db
    .select()
    .from(schema.votes)
    .where(
      and(
        eq(schema.votes.voterId, voter.id),
        eq(schema.votes.status, "counted"),
        sql`${schema.votes.weight} < ${weight}`,
        inArray(schema.votes.boardId, openBoardIds()),
      ),
    );
  if (pending.length) {
    const ip = clientIp(headers);
    await db.transaction(async (tx) => {
      for (const vote of pending) {
        await tx
          .update(schema.votes)
          .set({ weight, updatedAt: new Date() })
          .where(eq(schema.votes.id, vote.id));
        await tx.insert(schema.voteEvents).values({
          boardId: vote.boardId,
          entryId: vote.entryId,
          voterId: voter.id,
          kind: "verified",
          weight: weight - vote.weight,
          ip,
          asn: clientAsn(headers),
          deviceFp: deviceFingerprint(headers),
        });
      }
    });
    for (const vote of pending) touchedBoards.add(vote.boardId);
  }
  for (const boardId of touchedBoards) await reconcileBoard(boardId);

  const upgradedBoards = Array.from(new Set(pending.map((vote) => vote.boardId)));
  await audit({
    actor: { id: voter.id, kind: "voter" },
    action: "voter.verified",
    targetType: "voter",
    targetId: voter.id,
    metadata: { channel, restored: Boolean(owner?.erasedAt), upgradedBoards },
  });

  const session = reissue ? await createVoterSession(voter.id, headers) : null;
  return { voter, session, upgradedBoards };
}

/**
 * Moves an anonymous voter's votes onto the verified voter who just signed in
 * from the same device. Where the verified voter already has a vote on that
 * board, theirs stands and the anonymous one is dropped. Votes on frozen boards
 * are left where they are, so final results never change. Returns touched boards.
 */
async function mergeAnonymousVotes(fromVoterId: string, intoVoterId: string) {
  return db.transaction(async (tx) => {
    const incoming = await tx
      .select()
      .from(schema.votes)
      .where(
        and(eq(schema.votes.voterId, fromVoterId), inArray(schema.votes.boardId, openBoardIds())),
      );
    if (incoming.length === 0) return [] as string[];

    const held = await tx
      .select({ boardId: schema.votes.boardId })
      .from(schema.votes)
      .where(eq(schema.votes.voterId, intoVoterId));
    const heldBoards = new Set(held.map((row) => row.boardId));

    for (const vote of incoming) {
      if (heldBoards.has(vote.boardId)) {
        await tx.delete(schema.votes).where(eq(schema.votes.id, vote.id));
      } else {
        await tx
          .update(schema.votes)
          .set({ voterId: intoVoterId, updatedAt: new Date() })
          .where(eq(schema.votes.id, vote.id));
      }
    }
    return Array.from(new Set(incoming.map((vote) => vote.boardId)));
  });
}

/** Subquery: boards still open to change (not frozen). */
function openBoardIds() {
  return db
    .select({ id: schema.boards.id })
    .from(schema.boards)
    .where(ne(schema.boards.status, "frozen"));
}
