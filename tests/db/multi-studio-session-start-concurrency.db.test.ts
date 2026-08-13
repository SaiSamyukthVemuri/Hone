// START_SESSION — REAL TWO-CONNECTION CONCURRENCY (0181).
//
// 0167 asserted, in a comment carried into 0181, that
// "FOR UPDATE closes the read-then-insert race that could produce two sessions
// for one visit". That is only true when the coalesce window ALREADY CONTAINS a
// row: `for update` locks rows, and an EMPTY result set locks nothing. Two
// overlapping FIRST taps therefore both observed an empty window and both
// inserted, and no unique constraint stops them — the guarantee failed in
// exactly the double-tap case coalescing exists to prevent.
//
// Raised by Codex on PR #573, which also correctly noted that the sequential
// DB6 cases in multi-studio-session-authority.db.test.ts cannot reach this: two
// awaited calls never overlap. This file uses TWO REAL CONNECTIONS, in the same
// shape as tests/db/whole-session-copy-concurrency.db.test.ts.
//
// 0181 takes a transaction-scoped advisory lock keyed on the coalesce
// dimensions before the lookup, so the read and the insert are one atomic
// decision per visit.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  adminQuery,
  closePool,
  resolveLocalDbUrl,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

const COALESCE_MINUTES = 90;
const CALL = "select * from public.start_session($1,$2,$3,$4,$5)";

let A: SeededStudio;
let B: SeededStudio;
let sharedUser: string;
let practInB: string;

beforeAll(async () => {
  A = await seedStudio("conc-a");
  B = await seedStudio("conc-b");
  sharedUser = A.userId;
  practInB = randomUUID();
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1,$2,$3,'Conc In B',$4,'practitioner',true)`,
    [practInB, B.studioId, sharedUser, `conc-${practInB.slice(0, 8)}@harness.local`],
  );
});

afterAll(async () => {
  await closePool();
});

/** Two independent connections, each presenting the same authenticated user. */
async function withTwoUserClients<T>(
  userId: string,
  fn: (ca: Client, cb: Client) => Promise<T>,
): Promise<T> {
  const ca = new Client({ connectionString: resolveLocalDbUrl() });
  const cb = new Client({ connectionString: resolveLocalDbUrl() });
  await ca.connect();
  await cb.connect();
  for (const c of [ca, cb]) {
    await c.query("set statement_timeout = '15s'");
    await c.query("set role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
  }
  try {
    return await fn(ca, cb);
  } finally {
    await ca.end();
    await cb.end();
  }
}

async function liveSessionCount(clientId: string): Promise<number> {
  const r = await adminQuery(
    `select count(*)::int n from public.sessions where client_id=$1 and deleted_at is null`,
    [clientId],
  );
  return (r.rows[0] as { n: number }).n;
}

async function purge(clientId: string): Promise<void> {
  await adminQuery(`delete from public.sessions where client_id=$1`, [clientId]);
}

describe("start_session — overlapping first taps (empty coalesce window)", () => {
  it("two RACING starts for one visit produce exactly ONE session, no deadlock", async () => {
    await purge(B.clientId);
    const { settled, count } = await withTwoUserClients(sharedUser, async (ca, cb) => {
      const results = await Promise.allSettled([
        ca.query(CALL, [B.clientId, "electrolysis", null, COALESCE_MINUTES, B.studioId]),
        cb.query(CALL, [B.clientId, "electrolysis", null, COALESCE_MINUTES, B.studioId]),
      ]);
      return { settled: results, count: await liveSessionCount(B.clientId) };
    });

    // Neither caller may fail, and certainly not with a deadlock.
    for (const r of settled) {
      if (r.status === "rejected") {
        expect((r.reason as { code?: string }).code).not.toBe("40P01");
        throw new Error(`racing start rejected: ${String(r.reason)}`);
      }
    }
    // THE ASSERTION. Before the advisory lock this was 2.
    expect(count).toBe(1);

    // Both callers must have been handed the SAME session id — one visit.
    const ids = (settled as PromiseFulfilledResult<{ rows: { session_id: string }[] }>[]).map(
      (r) => r.value.rows[0].session_id,
    );
    expect(ids[0]).toBe(ids[1]);
    // Exactly one of them created it; the other reused.
    const reused = (
      settled as PromiseFulfilledResult<{ rows: { reused: boolean }[] }>[]
    ).map((r) => r.value.rows[0].reused);
    expect(reused.filter(Boolean)).toHaveLength(1);
  });

  it("racing starts in DIFFERENT studios do not block each other or merge", async () => {
    await purge(A.clientId);
    await purge(B.clientId);
    const { settled, aCount, bCount } = await withTwoUserClients(
      sharedUser,
      async (ca, cb) => {
        const results = await Promise.allSettled([
          ca.query(CALL, [A.clientId, "electrolysis", null, COALESCE_MINUTES, A.studioId]),
          cb.query(CALL, [B.clientId, "electrolysis", null, COALESCE_MINUTES, B.studioId]),
        ]);
        return {
          settled: results,
          aCount: await liveSessionCount(A.clientId),
          bCount: await liveSessionCount(B.clientId),
        };
      },
    );
    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
    // The lock is keyed on the coalesce identity, so two different visits are
    // independent — one session each, never merged, never serialized away.
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);

    const rows = await adminQuery(
      `select studio_id, practitioner_id, client_id from public.sessions
        where client_id = any($1) and deleted_at is null`,
      [[A.clientId, B.clientId]],
    );
    const byClient = new Map(
      (rows.rows as Array<{ client_id: string; studio_id: string; practitioner_id: string }>).map(
        (r) => [r.client_id, r],
      ),
    );
    expect(byClient.get(A.clientId)!.studio_id).toBe(A.studioId);
    expect(byClient.get(A.clientId)!.practitioner_id).toBe(A.practitionerId);
    expect(byClient.get(B.clientId)!.studio_id).toBe(B.studioId);
    expect(byClient.get(B.clientId)!.practitioner_id).toBe(practInB);
  });

  it("racing starts of DIFFERENT modalities stay distinct", async () => {
    await purge(B.clientId);
    const { settled, count } = await withTwoUserClients(sharedUser, async (ca, cb) => {
      const results = await Promise.allSettled([
        ca.query(CALL, [B.clientId, "electrolysis", null, COALESCE_MINUTES, B.studioId]),
        cb.query(CALL, [B.clientId, "laser", null, COALESCE_MINUTES, B.studioId]),
      ]);
      return { settled: results, count: await liveSessionCount(B.clientId) };
    });
    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
    // Modality is part of the coalesce identity, so these are two visits.
    expect(count).toBe(2);
  });

  it("the LEGACY four-argument signature is serialized too", async () => {
    // The compatibility wrapper delegates into the explicit command, so it
    // inherits the lock rather than needing its own.
    await purge(B.clientId);
    const LEGACY = "select * from public.start_session($1,$2,$3,$4)";
    const { settled, count } = await withTwoUserClients(sharedUser, async (ca, cb) => {
      const results = await Promise.allSettled([
        ca.query(LEGACY, [B.clientId, "electrolysis", null, COALESCE_MINUTES]),
        cb.query(LEGACY, [B.clientId, "electrolysis", null, COALESCE_MINUTES]),
      ]);
      return { settled: results, count: await liveSessionCount(B.clientId) };
    });
    for (const r of settled) {
      if (r.status === "rejected") {
        expect((r.reason as { code?: string }).code).not.toBe("40P01");
        throw new Error(`racing legacy start rejected: ${String(r.reason)}`);
      }
    }
    expect(count).toBe(1);
  });
});
