import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "../../api";
import { sessionHeaders } from "./session";

const link = new RPCLink({
  url: `${window.location.origin}/api/rpc`,
  // Bearer mirrors of the session cookies — see lib/session.ts.
  headers: () => sessionHeaders(),
  fetch: (request, init) => fetch(request, { ...init, credentials: "include" }),
});

/** Direct typed client: await client.ping() */
export const client: AppRouterClient = createORPCClient(link);

/** TanStack Query helpers: useQuery(orpc.ping.queryOptions()) */
export const orpc = createTanstackQueryUtils(client);
