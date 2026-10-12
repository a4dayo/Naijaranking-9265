/**
 * Test bootstrap: a throwaway SQLite database with the current schema pushed
 * into it, and a fixed session secret. Runs before any test file imports the API.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "naijarank-test-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.SESSION_SECRET = "test-session-secret";
delete process.env.RESEND_API_KEY;
delete process.env.CLIENT_IP_HEADER;
delete process.env.TRUSTED_PROXY_HOPS;

const push = Bun.spawnSync([process.execPath, "x", "drizzle-kit", "push", "--force"], {
  cwd: join(import.meta.dir, ".."),
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});
if (push.exitCode !== 0) {
  throw new Error(`drizzle-kit push failed:\n${push.stdout.toString()}\n${push.stderr.toString()}`);
}
