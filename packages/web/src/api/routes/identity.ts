import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { base } from "../__core/app";
import { db } from "../database";
import * as schema from "../database/schema";
import { audit } from "../services/audit";
import { OtpError, requestOtp, verifyOtp } from "../services/otp";
import { currentVoter, revokeSession, voterToken } from "../services/session";
import { reconcileBoard } from "../services/vote";

function rethrow(err: unknown): never {
  if (err instanceof OtpError) {
    const code = err.code === "RATE_LIMIT" ? "TOO_MANY_REQUESTS" : "BAD_REQUEST";
    throw new ORPCError(code, { message: err.message, data: { reason: err.code } });
  }
  throw err;
}

/** Voter identity: who am I, verify me, forget me. */
export const identity = {
  me: base.handler(async ({ context }) => {
    const voter = await currentVoter(context.headers);
    if (!voter) return { voter: null };
    return {
      voter: {
        id: voter.id,
        verified: Boolean(voter.verifiedAt),
        weight: voter.weight,
        email: voter.email,
        phone: voter.phoneE164,
      },
    };
  }),

  /** Sends a 6-digit code. Email is the live channel; SMS plugs in behind this. */
  requestCode: base
    .input(z.object({ destination: z.string().min(3).max(160) }))
    .handler(async ({ input, context }) => {
      try {
        return await requestOtp(input.destination, context.headers);
      } catch (err) {
        return rethrow(err);
      }
    }),

  /**
   * Verifies the code, links the identity to this voter, and upgrades every vote
   * they already cast from 0.25 to full weight.
   */
  verifyCode: base
    .input(z.object({ destination: z.string().min(3).max(160), code: z.string().min(4).max(8) }))
    .handler(async ({ input, context }) => {
      try {
        const { voter, session, upgradedBoards } = await verifyOtp(
          input.destination,
          input.code,
          context.headers,
        );
        return {
          voter: { id: voter.id, verified: true, weight: voter.weight, email: voter.email },
          upgradedBoards,
          issued: session ? { token: session.token } : null,
        };
      } catch (err) {
        return rethrow(err);
      }
    }),

  signOut: base.handler(async ({ context }) => {
    await revokeSession(voterToken(context.headers), "voter");
    return { signedOut: true };
  }),

  /**
   * NDPA 2023 erasure. The voter's identity and device trail go; their votes stay
   * counted but are detached from any personal data, because retroactively
   * changing a public result would be its own integrity problem.
   */
  eraseMe: base.handler(async ({ context }) => {
    const voter = await currentVoter(context.headers);
    if (!voter) throw new ORPCError("UNAUTHORIZED", { message: "No voter session." });

    const boards = await db
      .select({ boardId: schema.votes.boardId })
      .from(schema.votes)
      .where(and(eq(schema.votes.voterId, voter.id), eq(schema.votes.status, "counted")))
      .groupBy(schema.votes.boardId);

    await db
      .update(schema.votes)
      .set({ ip: null, asn: null, deviceFp: null })
      .where(eq(schema.votes.voterId, voter.id));
    await db
      .update(schema.voteEvents)
      .set({ ip: null, asn: null, deviceFp: null })
      .where(eq(schema.voteEvents.voterId, voter.id));
    await db
      .update(schema.voters)
      .set({
        email: null,
        phoneE164: null,
        deviceFp: null,
        firstSeenIp: null,
        firstSeenAsn: null,
        erasedAt: new Date(),
      })
      .where(eq(schema.voters.id, voter.id));
    await db
      .update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.sessions.subjectId, voter.id));

    for (const row of boards) await reconcileBoard(row.boardId);
    await audit({
      actor: { id: voter.id, kind: "voter" },
      action: "compliance.erasure",
      targetType: "voter",
      targetId: voter.id,
      metadata: { boards: boards.map((b) => b.boardId) },
    });
    return { erased: true };
  }),
};
