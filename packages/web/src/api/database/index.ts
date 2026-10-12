import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

/**
 * The database handle, created on first use rather than at import.
 *
 * On Cloudflare Workers the secrets (DATABASE_URL, DATABASE_AUTH_TOKEN) are
 * handed to each request, so nothing may read them while modules load. The
 * `@libsql/client` import resolves to its HTTP build under the `workerd`
 * export condition and to the native build under Bun, so the same code runs in
 * both places.
 */
function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  return drizzle(client, { schema });
}

type Database = ReturnType<typeof connect>;
let instance: Database | undefined;

export const db = new Proxy({} as Database, {
  get(_target, property) {
    instance ??= connect();
    const value = Reflect.get(instance, property, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
