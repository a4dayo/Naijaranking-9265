/**
 * Replays the attacks found in the September 2026 review against the real
 * HTTP layer, and checks that none of them can change a ranking any more.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import app from "../src/api";
import { clientIp } from "../src/api/lib/request";
import { normaliseEmail } from "../src/api/lib/text";
import { db } from "../src/api/database";
import * as schema from "../src/api/database/schema";
import { convertLegacyAnonymousVotes } from "../src/api/services/migrations";
import { reconcileBoard } from "../src/api/services/vote";

const HOST = "naijarank.test";
let ipCounter = 0;
/** A fresh "real" client address, as our single proxy would append it. */
const nextIp = () => `10.20.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

type Headers = Record<string, string>;

async function rpc<T = any>(path: string, input: unknown, headers: Headers = {}) {
  const response = await app.request(`http://${HOST}/api/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: HOST, ...headers },
    body: JSON.stringify({ json: input ?? {} }),
  });
  const body = (await response.json().catch(() => null)) as { json?: T } | null;
  return { status: response.status, data: body?.json as T };
}

let admin: Headers;
let boardId: string;
let slug: string;
const entry: Record<string, string> = {};

async function board() {
  const { data } = await rpc("boards/bySlug", { slug });
  return data as {
    board: { totalVotesRaw: number; totalVotesPending: number; voterCount: number };
    entries: Array<{ id: string; name: string; rank: number; votesRaw: number; votesPending: number; votesEffective: number }>;
  };
}
const byName = async (name: string) => (await board()).entries.find((e) => e.name === name)!;

/** Requests and verifies an email code (dev mode returns the code inline). */
async function verify(email: string, headers: Headers) {
  const ip = nextIp();
  const sent = await rpc<{ devCode?: string }>("identity/requestCode", { destination: email }, {
    ...headers,
    "x-forwarded-for": ip,
  });
  expect(sent.status).toBe(200);
  const done = await rpc<{ voter: { id: string }; issued: { token: string } | null }>(
    "identity/verifyCode",
    { destination: email, code: sent.data.devCode },
    { ...headers, "x-forwarded-for": ip },
  );
  expect(done.status).toBe(200);
  const token = done.data.issued?.token ?? headers["x-nr-session"];
  return { voterId: done.data.voter.id, session: { "x-nr-session": token! } };
}

async function vote(name: string, headers: Headers = {}) {
  return rpc<{ action: string; pending: boolean; issued?: { token: string } }>(
    "vote/cast",
    { boardId, entryId: entry[name], idempotencyKey: crypto.randomUUID() },
    { "x-forwarded-for": nextIp(), ...headers },
  );
}

beforeAll(async () => {
  const boot = await rpc("admin/bootstrap", { email: "owner@naijarank.test", password: "a-long-password" });
  admin = { "x-nr-admin-session": boot.data.issued.token };
  const created = await rpc("admin/createBoard", { title: "Best Jollof Spot", category: "Places" }, admin);
  boardId = created.data.id;
  slug = created.data.slug;
  await rpc("admin/seedEntries", { boardId, csv: "Alpha\nBravo\nCharlie\nDelta" }, admin);
  await rpc("admin/setBoardStatus", { boardId, status: "live" }, admin);
  for (const e of (await board()).entries) entry[e.name] = e.id;
});

describe("client IP", () => {
  test("ignores addresses the client wrote into X-Forwarded-For", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 41.58.9.9" });
    expect(clientIp(headers)).toBe("41.58.9.9");
  });

  test("honours TRUSTED_PROXY_HOPS and CLIENT_IP_HEADER", () => {
    const headers = new Headers({
      "x-forwarded-for": "1.2.3.4, 41.58.9.9, 172.16.0.1",
      "cf-connecting-ip": "102.89.1.1",
    });
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(headers)).toBe("41.58.9.9");
    delete process.env.TRUSTED_PROXY_HOPS;
    process.env.CLIENT_IP_HEADER = "cf-connecting-ip";
    expect(clientIp(headers)).toBe("102.89.1.1");
    delete process.env.CLIENT_IP_HEADER;
  });
});

describe("attack 1: scripted anonymous votes", () => {
  test("spoofed X-Forwarded-For no longer escapes the per-IP limit", async () => {
    const proxyIp = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) {
      const res = await vote("Charlie", {
        "x-forwarded-for": `41.58.${i}.${i}, ${proxyIp}`,
        "x-nr-device": `device-${i}`,
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200).length).toBe(40);
    expect(statuses.filter((s) => s === 429).length).toBe(20);
  });

  test("unverified votes are pending and never move the ranking", async () => {
    const charlie = await byName("Charlie");
    expect(charlie.votesPending).toBe(40);
    expect(charlie.votesRaw).toBe(0);
    expect(charlie.votesEffective).toBe(0);

    // One verified vote outranks forty pending ones.
    const { session } = await verify("alpha.fan@example.com", {});
    expect((await vote("Alpha", session)).data.pending).toBe(false);
    const after = await board();
    expect(after.entries[0]!.name).toBe("Alpha");
    expect(after.board.totalVotesRaw).toBe(1);
    expect(after.board.totalVotesPending).toBe(40);
    expect(after.board.voterCount).toBe(1);
  });

  test("verifying turns this device's pending vote into a counted one", async () => {
    const first = await vote("Bravo");
    expect(first.data.pending).toBe(true);
    const session = { "x-nr-session": first.data.issued!.token };
    expect((await byName("Bravo")).votesRaw).toBe(0);

    await verify("bravo.fan@example.com", session);
    const bravo = await byName("Bravo");
    expect(bravo.votesRaw).toBe(1);
    expect(bravo.votesPending).toBe(0);
  });

  test("a pending vote from a new device merges into the returning voter", async () => {
    // Returning voter already has a counted vote for Alpha on another device.
    const home = await verify("returning@example.com", {});
    await vote("Delta", home.session);
    const before = await byName("Delta");

    // New phone: votes anonymously, then signs in with the same email.
    const phone = await vote("Bravo");
    const phoneSession = { "x-nr-session": phone.data.issued!.token };
    const linked = await verify("returning@example.com", phoneSession);
    expect(linked.voterId).toBe(home.voterId);

    // Their existing Delta vote stands; the anonymous Bravo vote is dropped, not added.
    expect((await byName("Delta")).votesRaw).toBe(before.votesRaw);
    expect((await byName("Bravo")).votesPending).toBe(0);
  });
});

describe("attack 2: erase and vote again", () => {
  test("re-verifying an erased email restores the same voter and cannot add a vote", async () => {
    const first = await verify("loop@gmail.com", {});
    await vote("Charlie", first.session);
    const counted = (await board()).board.totalVotesRaw;

    // Two rounds: the 3-codes-per-email-per-hour limit caps the loop anyway.
    for (let round = 0; round < 2; round++) {
      const erased = await rpc("identity/eraseMe", {}, first.session);
      expect(erased.status).toBe(200);
      const again = await verify("loop@gmail.com", {});
      expect(again.voterId).toBe(first.voterId);
      const res = await vote(round % 2 === 0 ? "Delta" : "Charlie", again.session);
      expect(res.data.action).toBe("moved");
      first.session = again.session;
    }
    expect((await board()).board.totalVotesRaw).toBe(counted);
  });

  test("Gmail dots, +tags and googlemail.com are one identity", async () => {
    expect(normaliseEmail("Ada.Obi+naijarank@GoogleMail.com")).toBe("adaobi@gmail.com");
    expect(normaliseEmail("ada.obi+x@outlook.com")).toBe("ada.obi@outlook.com");
    expect(normaliseEmail("ada.obi@company.ng")).toBe("ada.obi@company.ng");

    const a = await verify("ada.obi+one@gmail.com", {});
    const b = await verify("ADAOBI@googlemail.com", {});
    expect(b.voterId).toBe(a.voterId);
  });

  test("a verified voter verifying a second email gets a separate voter, not a re-pointed one", async () => {
    const first = await verify("first.identity@example.com", {});
    const second = await verify("second.identity@example.com", first.session);
    expect(second.voterId).not.toBe(first.voterId);
    const again = await verify("first.identity@example.com", {});
    expect(again.voterId).toBe(first.voterId);
  });
});

describe("attack 3: cross-site requests", () => {
  test("a foreign origin cannot call the API, preflight included", async () => {
    const res = await rpc("boards/list", {}, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    const preflight = await app.request(`http://${HOST}/api/rpc/vote/cast`, {
      method: "OPTIONS",
      headers: {
        host: HOST,
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.status).toBe(403);
  });

  test("same-origin and origin-less (mobile) calls still work", async () => {
    expect((await rpc("boards/list", {}, { origin: `https://${HOST}` })).status).toBe(200);
    expect((await rpc("boards/list", {})).status).toBe(200);
  });
});

describe("attack 4: codes handed back to the browser", () => {
  test("production never returns the OTP code, even without an email provider", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await rpc<{ devCode?: string; delivered: boolean }>(
        "identity/requestCode",
        { destination: "prod.check@example.com" },
        { "x-forwarded-for": nextIp() },
      );
      expect(res.data.devCode).toBeUndefined();
      expect(res.data.delivered).toBe(false);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe("upgrade path", () => {
  test("votes cast at the old 0.25 weight become pending on boot", async () => {
    // Simulate a vote from before this change: unverified voter, weight 0.25.
    const [legacyVoter] = await db.insert(schema.voters).values({ weight: 0.25 }).returning();
    await db.insert(schema.votes).values({
      boardId,
      entryId: entry.Delta!,
      voterId: legacyVoter!.id,
      weight: 0.25,
    });
    await reconcileBoard(boardId);
    const before = await byName("Delta");

    const result = await convertLegacyAnonymousVotes();
    expect(result.converted).toBe(1);
    const after = await byName("Delta");
    expect(after.votesRaw).toBe(before.votesRaw - 1);
    expect(after.votesPending).toBe(before.votesPending + 1);

    // Idempotent: a second boot changes nothing.
    expect((await convertLegacyAnonymousVotes()).converted).toBe(0);
  });
});

describe("frozen boards", () => {
  test("verifying later never changes a frozen board's final result", async () => {
    const created = await rpc("admin/createBoard", { title: "Frozen Jollof Final", category: "Places" }, admin);
    const frozenId = created.data.id as string;
    await rpc("admin/seedEntries", { boardId: frozenId, csv: "Echo\nFoxtrot\nGolf" }, admin);
    await rpc("admin/setBoardStatus", { boardId: frozenId, status: "live" }, admin);
    const detail = await rpc("boards/bySlug", { slug: created.data.slug });
    const echo = detail.data.entries.find((e: { name: string }) => e.name === "Echo").id;

    const cast = await rpc<{ issued: { token: string } }>(
      "vote/cast",
      { boardId: frozenId, entryId: echo, idempotencyKey: crypto.randomUUID() },
      { "x-forwarded-for": nextIp() },
    );
    await rpc("admin/setBoardStatus", { boardId: frozenId, status: "frozen" }, admin);
    const final = await rpc("boards/results", { slug: created.data.slug });

    await verify("late.verifier@example.com", { "x-nr-session": cast.data.issued.token });
    const after = await rpc("boards/results", { slug: created.data.slug });
    expect(after.data.entries).toEqual(final.data.entries);
  });
});

describe("counters", () => {
  test("reconciliation agrees with the live counters", async () => {
    const before = await board();
    const run = await rpc<{ entriesCorrected: number }>("admin/runJob", { job: "reconcile" }, admin);
    expect(run.data.entriesCorrected).toBe(0);
    const after = await board();
    expect(after.entries.map((e) => [e.name, e.votesRaw, e.votesPending])).toEqual(
      before.entries.map((e) => [e.name, e.votesRaw, e.votesPending]),
    );
  });
});
