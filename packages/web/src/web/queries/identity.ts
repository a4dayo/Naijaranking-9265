import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { setVoterToken } from "../lib/session";

export function useMe() {
  return useQuery(orpc.identity.me.queryOptions({ staleTime: 60_000 }));
}

export function useRequestCode() {
  return useMutation(orpc.identity.requestCode.mutationOptions());
}

/** On success the voter is verified and every 0.25 vote they cast becomes 1.0. */
export function useVerifyCode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { destination: string; code: string }) => client.identity.verifyCode(input),
    onSuccess: (result) => {
      if (result.issued?.token) setVoterToken(result.issued.token);
      void queryClient.invalidateQueries();
    },
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.identity.signOut(),
    onSuccess: () => {
      setVoterToken(null);
      void queryClient.invalidateQueries();
    },
  });
}

export function useEraseMe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.identity.eraseMe(),
    onSuccess: () => {
      setVoterToken(null);
      void queryClient.invalidateQueries();
    },
  });
}
