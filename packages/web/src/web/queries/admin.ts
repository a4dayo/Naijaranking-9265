import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { setAdminToken } from "../lib/session";

export type AdminBoard = Awaited<ReturnType<typeof client.admin.boards>>[number];
export type AdminFlag = Awaited<ReturnType<typeof client.admin.flags>>[number];
export type Moderation = Awaited<ReturnType<typeof client.admin.moderation>>;

export function useAdminStatus() {
  return useQuery(orpc.admin.status.queryOptions({ staleTime: 15_000, retry: false }));
}

export function useAdminSignIn(mode: "login" | "bootstrap") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string; name?: string }) =>
      mode === "bootstrap" ? client.admin.bootstrap(input) : client.admin.login(input),
    onSuccess: (result) => {
      if (result.issued?.token) setAdminToken(result.issued.token);
      void queryClient.invalidateQueries();
    },
  });
}

export function useAdminLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.admin.logout(),
    onSuccess: () => {
      setAdminToken(null);
      void queryClient.invalidateQueries();
    },
  });
}

export function useDashboard(enabled: boolean) {
  return useQuery(
    orpc.admin.dashboard.queryOptions({ enabled, staleTime: 15_000, refetchInterval: 30_000 }),
  );
}

export function useAdminBoards(enabled: boolean) {
  return useQuery(orpc.admin.boards.queryOptions({ enabled, staleTime: 10_000 }));
}

export function useAdminBoard(boardId: string | null) {
  return useQuery(
    orpc.admin.board.queryOptions({
      input: { boardId: boardId ?? "" },
      enabled: Boolean(boardId),
      staleTime: 5_000,
    }),
  );
}

export function useFlags(enabled: boolean, resolution: "open" | "all") {
  return useQuery(
    orpc.admin.flags.queryOptions({ input: { resolution }, enabled, staleTime: 10_000 }),
  );
}

export function useFlagDetail(flagId: string | null) {
  return useQuery(
    orpc.admin.flagDetail.queryOptions({
      input: { flagId: flagId ?? "" },
      enabled: Boolean(flagId),
    }),
  );
}

export function useModeration(enabled: boolean) {
  return useQuery(orpc.admin.moderation.queryOptions({ enabled, staleTime: 10_000 }));
}

export function useAuditLog(enabled: boolean) {
  return useQuery(
    orpc.admin.auditLog.queryOptions({ input: { limit: 150 }, enabled, staleTime: 10_000 }),
  );
}

/** Every operator mutation refreshes the console wholesale — correctness over cleverness. */
function useAdminMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export const useCreateBoard = () => useAdminMutation(client.admin.createBoard);
export const useUpdateBoard = () => useAdminMutation(client.admin.updateBoard);
export const useSetBoardStatus = () => useAdminMutation(client.admin.setBoardStatus);
export const useApproveSensitive = () => useAdminMutation(client.admin.approveSensitive);
export const useDeleteBoard = () => useAdminMutation(client.admin.deleteBoard);
export const useSeedEntries = () => useAdminMutation(client.admin.seedEntries);
export const useUpdateEntry = () => useAdminMutation(client.admin.updateEntry);
export const useMergeEntry = () => useAdminMutation(client.admin.mergeEntry);
export const useVoidVotes = () => useAdminMutation(client.admin.voidVotes);
export const useResolveFlag = () => useAdminMutation(client.admin.resolveFlag);
export const useReviewNomination = () => useAdminMutation(client.admin.reviewNomination);
export const useReviewReport = () => useAdminMutation(client.admin.reviewReport);
export const useReviewClaim = () => useAdminMutation(client.admin.reviewClaim);
export const useRunJob = () => useAdminMutation(client.admin.runJob);
