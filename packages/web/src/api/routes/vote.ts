import { z } from "zod";
import { base } from "../__core/app";
import { castVote } from "../services/vote";

/**
 * The vote endpoint. One procedure, one transaction behind it — see
 * services/vote.ts. The client sends an idempotency key it generated, so a
 * retried tap on a flaky Nigerian mobile connection can never double-count.
 */
export const vote = {
  cast: base
    .input(
      z.object({
        boardId: z.string().min(1),
        entryId: z.string().min(1),
        idempotencyKey: z.string().min(8).max(80),
      }),
    )
    .handler(({ input, context }) => castVote(input, context.headers)),
};
