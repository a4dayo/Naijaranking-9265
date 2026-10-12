/**
 * Guarded schema push. Use this instead of `drizzle-kit push --force` against
 * a database with real data.
 *
 * `drizzle-kit push --force` approves data loss without asking — for example,
 * adding a NOT NULL column makes it run `delete from <table>` first. This
 * script works out the same statements, prints them, and refuses to apply
 * anything destructive unless ALLOW_DATA_LOSS=1 is set on purpose.
 *
 *   DATABASE_URL=... DATABASE_AUTH_TOKEN=... bun scripts/db-push.ts            # plan + apply
 *   DATABASE_URL=... DATABASE_AUTH_TOKEN=... bun scripts/db-push.ts --plan     # plan only
 */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { pushSQLiteSchema } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";

const DESTRUCTIVE = /^\s*(delete\s+from|drop\s+table|drop\s+column|alter\s+table\s+\S+\s+drop)|__new_/i;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = drizzle(createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN }), { schema });

  const plan = await pushSQLiteSchema(schema, db);
  if (plan.statementsToExecute.length === 0) {
    console.log("Schema is already up to date.");
    return;
  }

  console.log("Planned statements:");
  for (const statement of plan.statementsToExecute) console.log(`  ${statement.trim()}`);
  for (const warning of plan.warnings) console.log(`  warning: ${warning}`);

  const destructive = plan.statementsToExecute.filter((statement) => DESTRUCTIVE.test(statement));
  if ((plan.hasDataLoss || destructive.length) && process.env.ALLOW_DATA_LOSS !== "1") {
    console.error(
      "\nRefusing: this push would delete or rebuild data. Make the schema change additive " +
        "(e.g. nullable columns with defaults) or, if the loss is intended, re-run with ALLOW_DATA_LOSS=1.",
    );
    process.exit(1);
  }

  if (process.argv.includes("--plan")) {
    console.log("\nPlan only: nothing applied.");
    return;
  }
  await plan.apply();
  console.log("\nApplied.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
