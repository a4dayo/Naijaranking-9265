import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { idempotencyKey, setVoterToken } from "../lib/session";

/** Live boards refresh on a poll — no sockets in the MVP, by design. */
const POLL_MS = 25_000;

export type BoardDetail = Awaited<ReturnType<typeof client.boards.bySlug>>;
export type RankedEntry = BoardDetail["entries"][number];
export type VoteResult = Awaited<ReturnType<typeof client.vote.cast>>;

export function useBoards() {
  return useQuery(orpc.boards.list.queryOptions({ refetchInterval: POLL_MS, staleTime: 10_000 }));
}

export function boardKey(slug: string) {
  return orpc.boards.bySlug.queryOptions({ input: { slug } }).queryKey;
}

export function useBoard(slug: string, options?: { poll?: boolean }) {
  return useQuery(
    orpc.boards.bySlug.queryOptions({
      input: { slug },
      staleTime: 5_000,
      refetchInterval: options?.poll === false ? undefined : POLL_MS,
    }),
  );
}

export function useResults(slug: string) {
  return useQuery(orpc.boards.results.queryOptions({ input: { slug }, staleTime: 60_000 }));
}

export function useNominations(boardId: string | undefined) {
  return useQuery(
    orpc.boards.nominations.queryOptions({
      input: { boardId: boardId ?? "" },
      enabled: Boolean(boardId),
      staleTime: 30_000,
    }),
  );
}

/**
 * The vote. Optimistic on the client for instant feel, but the server's numbers
 * always win: the mutation result replaces the optimistic patch wholesale.
 */
export function useCastVote(slug: string) {
  const queryClient = useQueryClient();
  const key = boardKey(slug);

  return useMutation({
    mutationFn: (input: { boardId: string; entryId: string }) =>
      client.vote.cast({ ...input, idempotencyKey: idempotencyKey(input.boardId, input.entryId) }),

    onMutate: async ({ entryId }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<BoardDetail>(key);
      if (!previous) return { previous };

      const weight = previous.me?.verified ? 1 : 0.25;
      const wasOn = previous.myVote?.entryId === entryId;
      const previousEntryId = previous.myVote?.entryId ?? null;
      const previousWeight = previous.myVote?.weight ?? weight;

      const entries = previous.entries.map((entry) => {
        let effective = entry.votesEffective;
        let raw = entry.votesRaw;
        if (entry.id === previousEntryId) {
          effective -= previousWeight;
          raw -= 1;
        }
        if (!wasOn && entry.id === entryId) {
          effective += weight;
          raw += 1;
        }
        return {
          ...entry,
          votesEffective: Math.max(0, Math.round(effective * 100) / 100),
          votesRaw: Math.max(0, raw),
        };
      });

      entries.sort((a, b) => b.votesEffective - a.votesEffective || b.votesRaw - a.votesRaw);

      queryClient.setQueryData<BoardDetail>(key, {
        ...previous,
        entries: entries.map((entry, index) => ({ ...entry, rank: index + 1 })),
        myVote: wasOn ? null : { entryId, weight },
      });
      return { previous };
    },

    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },

    onSuccess: (result) => {
      // First vote from a new device gets a session — keep it for 180 days.
      if (result.issued?.token) setVoterToken(result.issued.token);
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: orpc.boards.list.queryOptions().queryKey });
    },
  });
}

export function useReact(slug: string) {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.boards.react.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: boardKey(slug) }),
    }),
  );
}

export function useNominate(boardId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.boards.nominate.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: orpc.boards.nominations.queryOptions({ input: { boardId: boardId ?? "" } })
            .queryKey,
        }),
    }),
  );
}

export function useUpvoteNomination(boardId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.boards.upvoteNomination.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: orpc.boards.nominations.queryOptions({ input: { boardId: boardId ?? "" } })
            .queryKey,
        }),
    }),
  );
}

export function useReportEntry() {
  return useMutation(orpc.boards.report.mutationOptions());
}

export function useClaimEntry() {
  return useMutation(orpc.boards.claim.mutationOptions());
}

/** Fire-and-forget funnel event. Never blocks the UI. */
export function trackEvent(
  name: string,
  props?: { boardId?: string; entryId?: string; [key: string]: unknown },
) {
  const { boardId, entryId, ...rest } = props ?? {};
  void client.boards
    .event({
      name,
      boardId,
      entryId,
      referrer: document.referrer?.slice(0, 300) || undefined,
      props: Object.keys(rest).length ? rest : undefined,
    })
    .catch(() => undefined);
}
