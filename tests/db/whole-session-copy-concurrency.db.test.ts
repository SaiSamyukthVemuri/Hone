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

// Migration 0157 — REAL two-connection concurrency for copy_session_setup
// (P1-1). The commit locks the TARGET session row (FOR UPDATE), which serializes
// every copy for that target INDEPENDENTLY of the idempotency key. So:
//   * two DIFFERENT-key commits racing → exactly one batch; the loser sees the
//     now-nonempty target and rejects (HN003) — no duplicate.
//   * two SAME-key commits racing → exactly one batch; the loser converges to a
//     clean idempotent replay (not a raw unique-violation).
// Both cases complete without a deadlock.

let a: SeededStudio;

beforeAll(async () => {
  a = await seedStudio("wsc-conc");
});
afterAll(async () => {
  await closePool();
});

const CALL =
  "select public.copy_session_setup($1,$2,$3,$4::jsonb,$5,$6,$7) as result";

function spec() {
  return [
    {
      block: {
        mode: "blend",
        energy_level: 12,
        machine_frequency: "13.56 MHz",
        primary_area: "Chin",
        side: "left",
      },
      areas: [{ area: "Chin", laterality: "left", display_order: 0 }],
      entry: {
        area: "Chin",
        areas: ["Chin"],
        mode: "blend",
        thermolysis_intensity_percent: 40,
      },
    },
  ];
}

async function seedScenario() {
  const clientId = randomUUID();
  await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Conc')", [clientId, a.studioId]);
  const source = randomUUID();
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, record_status, started_at)
     values ($1,$2,$3,$4,'electrolysis','draft','2026-01-01T10:00:00Z')`,
    [source, a.studioId, clientId, a.practitionerId],
  );
  const blockId = randomUUID();
  await adminQuery(
    `insert into public.session_blocks (id, studio_id, session_id, sort_order, primary_area, side, mode, energy_level)
     values ($1,$2,$3,1,'Chin','left','blend',10)`,
    [blockId, a.studioId, source],
  );
  await adminQuery(
    `insert into public.session_block_areas (id, studio_id, session_block_id, area, laterality, display_order)
     values ($1,$2,$3,'Chin','left',0)`,
    [randomUUID(), a.studioId, blockId],
  );
  const target = randomUUID();
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, record_status, started_at)
     values ($1,$2,$3,$4,'electrolysis','draft','2026-06-01T10:00:00Z')`,
    [target, a.studioId, clientId, a.practitionerId],
  );
  const fp = (await adminQuery("select public._whole_session_copy_fingerprint($1) as fp", [source])).rows[0].fp as string;
  return { source, target, fp };
}

async function withTwoClients<T>(fn: (ca: Client, cb: Client) => Promise<T>): Promise<T> {
  const ca = new Client({ connectionString: resolveLocalDbUrl() });
  const cb = new Client({ connectionString: resolveLocalDbUrl() });
  await ca.connect();
  await cb.connect();
  await ca.query("set statement_timeout = '15s'");
  await cb.query("set statement_timeout = '15s'");
  try {
    return await fn(ca, cb);
  } finally {
    await ca.end();
    await cb.end();
  }
}

async function targetBlockCount(target: string): Promise<number> {
  return (
    await adminQuery("select count(*)::int n from public.session_blocks where session_id=$1 and deleted_at is null", [target])
  ).rows[0].n;
}
async function ledgerCount(target: string): Promise<number> {
  return (await adminQuery("select count(*)::int n from public.session_copy_operations where target_session_id=$1", [target])).rows[0].n;
}

describe("copy_session_setup — two-connection concurrency", () => {
  it("DIFFERENT keys racing → exactly one batch; the loser rejects (HN003), no deadlock", async () => {
    const { source, target, fp } = await seedScenario();
    const { results, count, ledger } = await withTwoClients(async (ca, cb) => {
      const settled = await Promise.allSettled([
        ca.query(CALL, [a.studioId, target, a.practitionerId, JSON.stringify(spec()), randomUUID(), fp, source]),
        cb.query(CALL, [a.studioId, target, a.practitionerId, JSON.stringify(spec()), randomUUID(), fp, source]),
      ]);
      return { results: settled, count: await targetBlockCount(target), ledger: await ledgerCount(target) };
    });
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.code).toBe("HN003"); // target became non-empty; NOT a deadlock (40P01)
    expect(rejected[0].reason.code).not.toBe("40P01");
    expect(count).toBe(1); // exactly one batch (source had one block)
    expect(ledger).toBe(1);
  });

  it("SAME key racing → exactly one batch; the loser converges to a clean replay, no deadlock", async () => {
    const { source, target, fp } = await seedScenario();
    const key = randomUUID();
    const { results, count, ledger } = await withTwoClients(async (ca, cb) => {
      const settled = await Promise.allSettled([
        ca.query(CALL, [a.studioId, target, a.practitionerId, JSON.stringify(spec()), key, fp, source]),
        cb.query(CALL, [a.studioId, target, a.practitionerId, JSON.stringify(spec()), key, fp, source]),
      ]);
      return { results: settled, count: await targetBlockCount(target), ledger: await ledgerCount(target) };
    });
    // Both converge (no raw unique-violation surfaced to a caller).
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const replays = (results as PromiseFulfilledResult<{ rows: { result: { idempotent_replay: boolean } }[] }>[]).map(
      (r) => r.value.rows[0].result.idempotent_replay,
    );
    expect(replays.filter((x) => x === false)).toHaveLength(1); // exactly one real insert
    expect(replays.filter((x) => x === true)).toHaveLength(1); // the other replayed
    expect(count).toBe(1);
    expect(ledger).toBe(1);
  });
});
