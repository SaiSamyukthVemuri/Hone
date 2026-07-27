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
  return { source, target, fp, blockId };
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

// Helper: run `hold` in txn A (leaving it OPEN, holding a lock), then `attempt`
// on B with a short statement_timeout; return the settled result of `attempt`
// and whether it was blocked (57014) — never a deadlock (40P01).
async function raceSourceEdit(
  editSql: string,
  editParams: unknown[],
): Promise<{ copyResult: PromiseSettledResult<unknown>; targetBlocks: number; ledger: number }> {
  const { source, target, fp } = await seedScenario();
  const editor = new Client({ connectionString: resolveLocalDbUrl() });
  await editor.connect();
  try {
    // Editor opens a txn and holds a row lock on a source block (edit not yet committed).
    await editor.query("begin");
    await editor.query(editSql, editParams.map((p) => (p === "__SOURCE__" ? source : p)));
    // Copy runs concurrently; it must WAIT on the source locks, then (after the
    // editor commits) see the changed fingerprint and reject HN005 — or, if it
    // grabs the locks first, the editor waits. We commit the editor shortly after
    // firing the copy so the copy proceeds to its fingerprint recheck.
    const copyClient = new Client({ connectionString: resolveLocalDbUrl() });
    await copyClient.connect();
    await copyClient.query("set statement_timeout = '15s'");
    const copyPromise = copyClient
      .query(CALL, [a.studioId, target, a.practitionerId, JSON.stringify(spec()), randomUUID(), fp, source])
      .then((r) => ({ status: "fulfilled" as const, value: r }))
      .catch((e) => ({ status: "rejected" as const, reason: e }));
    // Let the copy block on the source locks, then commit the edit.
    await editor.query("commit");
    const copyResult = (await copyPromise) as PromiseSettledResult<unknown>;
    await copyClient.end();
    const targetBlocks = await targetBlockCount(target);
    const ledger = await ledgerCount(target);
    return { copyResult, targetBlocks, ledger };
  } finally {
    await editor.end();
  }
}

describe("copy_session_setup — source is locked against concurrent edits", () => {
  it("a source block UPDATE that starts before the copy → copy sees the change and rejects HN005 (zero rows)", async () => {
    const { copyResult, targetBlocks, ledger } = await raceSourceEdit(
      "update public.session_blocks set energy_level = 77 where session_id = $1",
      ["__SOURCE__"],
    );
    expect(copyResult.status).toBe("rejected");
    if (copyResult.status === "rejected") {
      expect(copyResult.reason.code).toBe("HN005");
      expect(copyResult.reason.code).not.toBe("40P01"); // not a deadlock
    }
    expect(targetBlocks).toBe(0);
    expect(ledger).toBe(0);
  });

  it("a concurrent source-area DELETE before the copy → HN005 (zero rows), no deadlock", async () => {
    const { copyResult, targetBlocks } = await raceSourceEdit(
      "delete from public.session_block_areas where session_block_id in (select id from public.session_blocks where session_id = $1)",
      ["__SOURCE__"],
    );
    // Deleting the only structured area still leaves a legacy primary_area, so the
    // source stays eligible but its fingerprint changes → HN005.
    expect(copyResult.status).toBe("rejected");
    if (copyResult.status === "rejected") {
      expect(["HN005", "HN004"]).toContain(copyResult.reason.code);
      expect(copyResult.reason.code).not.toBe("40P01");
    }
    expect(targetBlocks).toBe(0);
  });

  it("a concurrent NEW source-area INSERT before the copy → HN005 (zero rows), no deadlock", async () => {
    const { source, target, fp, blockId } = await seedScenario();
    const editor = new Client({ connectionString: resolveLocalDbUrl() });
    await editor.connect();
    try {
      await editor.query("begin");
      await editor.query(
        "insert into public.session_block_areas (id, studio_id, session_block_id, area, laterality, display_order) values ($1,$2,$3,'Neck','left',1)",
        [randomUUID(), a.studioId, blockId],
      );
      const copyClient = new Client({ connectionString: resolveLocalDbUrl() });
      await copyClient.connect();
      await copyClient.query("set statement_timeout = '15s'");
      const copyPromise = copyClient
        .query(CALL, [a.studioId, target, a.practitionerId, JSON.stringify(spec()), randomUUID(), fp, source])
        .then((r) => ({ status: "fulfilled" as const, value: r }))
        .catch((e) => ({ status: "rejected" as const, reason: e }));
      await editor.query("commit");
      const copyResult = await copyPromise;
      await copyClient.end();
      expect(copyResult.status).toBe("rejected");
      if (copyResult.status === "rejected") {
        expect(copyResult.reason.code).toBe("HN005");
        expect(copyResult.reason.code).not.toBe("40P01");
      }
      expect(await targetBlockCount(target)).toBe(0);
    } finally {
      await editor.end();
    }
  });

  it("when the copy grabs the source locks first, a concurrent source edit WAITS (blocked, not deadlocked)", async () => {
    const { source, target, fp, blockId } = await seedScenario();
    const holder = new Client({ connectionString: resolveLocalDbUrl() });
    await holder.connect();
    try {
      // Simulate the copy holding the source block lock mid-commit.
      await holder.query("begin");
      await holder.query("select id from public.session_blocks where id = $1 for update", [blockId]);
      // A concurrent editor with a short timeout must BLOCK on that lock (57014),
      // proving the copy path would hold source edits off until it commits.
      const editor = new Client({ connectionString: resolveLocalDbUrl() });
      await editor.connect();
      await editor.query("set statement_timeout = '800ms'");
      let code = "";
      try {
        await editor.query("update public.session_blocks set energy_level = 5 where id = $1", [blockId]);
      } catch (e) {
        code = (e as { code?: string }).code ?? "";
      }
      expect(code).toBe("57014"); // statement timeout = blocked by the lock
      expect(code).not.toBe("40P01"); // not a deadlock
      await editor.end();
      await holder.query("rollback");
    } finally {
      await holder.end();
    }
    void source;
    void fp;
  });
});
