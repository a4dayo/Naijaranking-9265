/**
 * Copies NaijaRank's data into a new database, e.g. when moving off Runable.
 *
 * Run from packages/web after the target has the schema (`bunx drizzle-kit push`
 * with DATABASE_URL pointing at the target):
 *
 *   TARGET_DATABASE_URL=libsql://new-db.turso.io TARGET_DATABASE_AUTH_TOKEN=... \
 *   <one source, see below> bun scripts/copy-data.ts [--dry-run]
 *
 * Source A — direct database access (preferred):
 *   SOURCE_DATABASE_URL=libsql://old-db.turso.io SOURCE_DATABASE_AUTH_TOKEN=...
 *
 * Source B — through the running app's owner-only export endpoint, when you
 * cannot get database credentials (the app must include admin.exportTable):
 *   SOURCE_APP_URL=https://xyz.runable.site SOURCE_ADMIN_EMAIL=... SOURCE_ADMIN_PASSWORD=...
 *
 * The target must be empty (set ALLOW_NON_EMPTY=1 to override). Row counts are
 * compared table by table at the end; the script exits non-zero on a mismatch.
 */
import { createClient, type Client, type InValue } from "@libsql/client";
import { EXPORT_TABLES, type ExportTable } from "../src/api/lib/export-tables";

const PAGE = 500;
const dryRun = process.argv.includes("--dry-run");

type Page = { columns: string[]; rows: InValue[][]; done: boolean };
interface Source {
  label: string;
  page(table: ExportTable, offset: number): Promise<Page>;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function databaseSource(url: string, authToken?: string): Source {
  const client = createClient({ url, authToken });
  return {
    label: `database ${new URL(url).host || url}`,
    async page(table, offset) {
      const result = await client.execute({
        sql: `select * from "${table}" order by rowid limit ? offset ?`,
        args: [PAGE, offset],
      });
      return {
        columns: result.columns,
        rows: result.rows.map((row) => result.columns.map((_, i) => (row[i] ?? null) as InValue)),
        done: result.rows.length < PAGE,
      };
    },
  };
}

async function appSource(appUrl: string, email: string, password: string): Promise<Source> {
  const base = appUrl.replace(/\/+$/, "");
  async function call<T>(path: string, input: unknown, token?: string): Promise<T> {
    const response = await fetch(`${base}/api/rpc/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-nr-admin-session": token } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
    const body = (await response.json().catch(() => null)) as { json?: T & { message?: string } } | null;
    if (!response.ok) throw new Error(`${path} failed (${response.status}): ${body?.json?.message ?? "no message"}`);
    return body!.json as T;
  }
  const login = await call<{ issued: { token: string } }>("admin/login", { email, password });
  const token = login.issued.token;
  return {
    label: `app ${base}`,
    page: (table, offset) =>
      call<Page>("admin/exportTable", { table, password, offset, limit: PAGE }, token),
  };
}

async function count(client: Client, table: string) {
  const result = await client.execute(`select count(*) as n from "${table}"`);
  return Number(result.rows[0]!.n);
}

async function targetColumns(client: Client, table: string) {
  const result = await client.execute(`select name from pragma_table_info('${table}')`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function main() {
  const target = createClient({
    url: required("TARGET_DATABASE_URL"),
    authToken: process.env.TARGET_DATABASE_AUTH_TOKEN,
  });

  const source = process.env.SOURCE_DATABASE_URL
    ? databaseSource(process.env.SOURCE_DATABASE_URL, process.env.SOURCE_DATABASE_AUTH_TOKEN)
    : await appSource(
        required("SOURCE_APP_URL"),
        required("SOURCE_ADMIN_EMAIL"),
        required("SOURCE_ADMIN_PASSWORD"),
      );
  console.log(`Copying from ${source.label}${dryRun ? " (dry run)" : ""}`);

  // The target needs the schema and must be empty, or rows would collide.
  for (const table of EXPORT_TABLES) {
    const columns = await targetColumns(target, table);
    if (columns.size === 0)
      throw new Error(`Target has no "${table}" table — push the schema to it first.`);
    if (!process.env.ALLOW_NON_EMPTY && (await count(target, table)) > 0)
      throw new Error(`Target table "${table}" is not empty. Set ALLOW_NON_EMPTY=1 to copy anyway.`);
  }

  const copied: Record<string, number> = {};
  for (const table of EXPORT_TABLES) {
    const allowed = await targetColumns(target, table);
    let offset = 0;
    let total = 0;
    for (;;) {
      const page = await source.page(table, offset);
      // Columns the target does not know about are dropped; columns the source
      // lacks (added since) take their defaults.
      const keep = page.columns.map((name, index) => ({ name, index })).filter((c) => allowed.has(c.name));
      if (page.rows.length && !dryRun) {
        const columnList = keep.map((c) => `"${c.name}"`).join(", ");
        const placeholders = keep.map(() => "?").join(", ");
        await target.batch(
          page.rows.map((row) => ({
            sql: `insert into "${table}" (${columnList}) values (${placeholders})`,
            args: keep.map((c) => row[c.index] ?? null),
          })),
          "write",
        );
      }
      total += page.rows.length;
      offset += page.rows.length;
      if (page.done || page.rows.length === 0) break;
    }
    copied[table] = total;
    console.log(`  ${table.padEnd(20)} ${total}`);
  }

  if (dryRun) {
    console.log("Dry run: nothing written.");
    return;
  }

  let mismatches = 0;
  for (const table of EXPORT_TABLES) {
    const landed = await count(target, table);
    if (!process.env.ALLOW_NON_EMPTY && landed !== copied[table]) {
      mismatches++;
      console.error(`  MISMATCH ${table}: read ${copied[table]}, target has ${landed}`);
    }
  }
  if (mismatches) {
    console.error(`${mismatches} table(s) did not copy cleanly.`);
    process.exit(1);
  }
  console.log("All tables copied and counts match.");
  console.log(
    "Counters are recomputed by the first reconcile run after the Worker starts (every minute).",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
