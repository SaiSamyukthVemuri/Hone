import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// A session with ZERO blocks (harness seedSession pre-inserts one, which would
// skew the copy counts). This matches the real feature gate: the copy panel only
// shows on an EMPTY chart.
async function bareSession(studio: SeededStudio): Promise<string> {
  const sessionId = randomUUID();
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
     values ($1,$2,$3,$4,'electrolysis')`,
    [sessionId, studio.studioId, studio.clientId, studio.practitionerId],
  );
  return sessionId;
}

// Migration 0157 — copy_session_setup RPC, proven on the REAL migrated local DB.
// The RPC is the ONLY writer for a whole-session copy: atomic (all blocks+areas+
// entries in one txn), idempotent (at-most-once per key via the ledger), SETUP-
// ONLY (outcome keys in the payload are ignored), and same-studio gated.

let a: SeededStudio;

beforeAll(async () => {
  a = await seedStudio("wsc");
});
afterAll(async () => {
  await closePool();
});

function specWithOutcomesInjected() {
  // A payload that INCLUDES outcome keys the RPC must ignore.
  return [
    {
      block: {
        mode: "blend",
        apilus_modality: "Omniblend",
        energy_level: 12,
        minutes_performed: 20,
        machine_frequency: "13.56 MHz",
        primary_area: "Chin",
        side: "left",
        // outcomes that MUST NOT be copied:
        numbing_status: "used",
        numbing_notes: "should be ignored",
        tolerance_rating: 3,
        reaction_type: "mild_redness",
        probe_lot_number: "SHOULD-IGNORE",
      },
      areas: [
        { area: "Chin", laterality: "left" },
        { area: "Upper lip", laterality: "bilateral" },
      ],
      entry: {
        mode: "blend",
        thermolysis_intensity_percent: 40,
        galvanic_ma: 0.1,
        units_of_lye: 30,
        pulse_count: 2,
        area: "Chin",
        // outcomes that MUST NOT be copied:
        comments: "should be ignored",
        hairs_treated: 5,
        observation_chips: ["Coarse hair"],
      },
    },
  ];
}

async function callCopy(
  studio: SeededStudio,
  sessionId: string,
  specs: unknown,
  key: string,
) {
  return asUser(studio.userId, async (q) => {
    const r = await q(
      `select public.copy_session_setup($1,$2,$3::jsonb,$4) as result`,
      [studio.studioId, sessionId, JSON.stringify(specs), key],
    );
    return r.rows[0].result as { created_block_ids: string[]; idempotent_replay: boolean };
  });
}

describe("copy_session_setup — atomic batch create", () => {
  it("creates the block + structured areas + first entry from the reviewed spec", async () => {
    const sessionId = await bareSession(a);
    const res = await callCopy(a, sessionId, specWithOutcomesInjected(), "k-create");
    expect(res.created_block_ids).toHaveLength(1);
    expect(res.idempotent_replay).toBe(false);

    const blk = (
      await adminQuery(
        "select mode, minutes_performed, machine_frequency, primary_area, side from public.session_blocks where id=$1",
        [res.created_block_ids[0]],
      )
    ).rows[0];
    expect(blk).toMatchObject({
      mode: "blend",
      minutes_performed: 20,
      machine_frequency: "13.56 MHz",
      primary_area: "Chin",
      side: "left",
    });
    const areas = await adminQuery(
      "select area, laterality from public.session_block_areas where session_block_id=$1 order by display_order",
      [res.created_block_ids[0]],
    );
    expect(areas.rows).toEqual([
      { area: "Chin", laterality: "left" },
      { area: "Upper lip", laterality: "bilateral" },
    ]);
    const entry = (
      await adminQuery(
        "select thermolysis_intensity_percent, galvanic_ma, units_of_lye, pulse_count from public.electrolysis_entries where block_id=$1",
        [res.created_block_ids[0]],
      )
    ).rows[0];
    // numeric columns come back as strings via node-pg → coerce.
    expect(Number(entry.thermolysis_intensity_percent)).toBe(40);
    expect(Number(entry.units_of_lye)).toBe(30);
    expect(Number(entry.pulse_count)).toBe(2);
  });

  it("SETUP-ONLY: injected outcome keys are NOT copied to the block or entry", async () => {
    const sessionId = await bareSession(a);
    const res = await callCopy(a, sessionId, specWithOutcomesInjected(), "k-setuponly");
    const blk = (
      await adminQuery(
        "select numbing_status, numbing_notes, tolerance_rating, reaction_type, probe_lot_number from public.session_blocks where id=$1",
        [res.created_block_ids[0]],
      )
    ).rows[0];
    expect(blk).toEqual({
      numbing_status: null,
      numbing_notes: null,
      tolerance_rating: null,
      reaction_type: null,
      probe_lot_number: null,
    });
    const entry = (
      await adminQuery(
        "select comments, hairs_treated, probe_lot_id from public.electrolysis_entries where block_id=$1",
        [res.created_block_ids[0]],
      )
    ).rows[0];
    expect(entry.comments).toBeNull();
    expect(entry.hairs_treated).toBeNull();
    expect(entry.probe_lot_id).toBeNull();
  });
});

describe("copy_session_setup — idempotency (at-most-once)", () => {
  it("a repeated call with the same key creates NO new blocks and returns the prior ids", async () => {
    const sessionId = await bareSession(a);
    const first = await callCopy(a, sessionId, specWithOutcomesInjected(), "k-idem");
    const second = await callCopy(a, sessionId, specWithOutcomesInjected(), "k-idem");
    expect(second.idempotent_replay).toBe(true);
    expect(second.created_block_ids).toEqual(first.created_block_ids);
    const count = (
      await adminQuery(
        "select count(*)::int as n from public.session_blocks where session_id=$1 and deleted_at is null",
        [sessionId],
      )
    ).rows[0].n;
    expect(count).toBe(1); // not 2
    const ledger = (
      await adminQuery(
        "select count(*)::int as n from public.session_copy_operations where session_id=$1",
        [sessionId],
      )
    ).rows[0].n;
    expect(ledger).toBe(1);
  });

  it("a DIFFERENT key on the same session creates new blocks", async () => {
    const sessionId = await bareSession(a);
    await callCopy(a, sessionId, specWithOutcomesInjected(), "k-A");
    await callCopy(a, sessionId, specWithOutcomesInjected(), "k-B");
    const count = (
      await adminQuery(
        "select count(*)::int as n from public.session_blocks where session_id=$1 and deleted_at is null",
        [sessionId],
      )
    ).rows[0].n;
    expect(count).toBe(2);
  });
});

describe("copy_session_setup — atomicity + authorization", () => {
  it("a bad spec mid-batch rolls back the WHOLE copy (no partial blocks, no ledger row)", async () => {
    const sessionId = await bareSession(a);
    const specs = [
      specWithOutcomesInjected()[0],
      {
        block: { mode: "blend", primary_area: "Neck" },
        // Invalid laterality → violates the session_block_areas CHECK → abort.
        areas: [{ area: "Neck", laterality: "sideways" }],
        entry: null,
      },
    ];
    await expect(callCopy(a, sessionId, specs, "k-atomic")).rejects.toThrow();
    const count = (
      await adminQuery(
        "select count(*)::int as n from public.session_blocks where session_id=$1",
        [sessionId],
      )
    ).rows[0].n;
    expect(count).toBe(0); // the first block was rolled back too
    const ledger = (
      await adminQuery(
        "select count(*)::int as n from public.session_copy_operations where session_id=$1",
        [sessionId],
      )
    ).rows[0].n;
    expect(ledger).toBe(0);
  });

  it("a non-member (cross-studio forge) call is rejected by the is_studio_member gate", async () => {
    const b = await seedStudio("wsc-other");
    const sessionId = await bareSession(a);
    // Studio B's user targets studio A (forged p_studio_id) → is_studio_member
    // fails for B on A → "not authorized". (Passing B's own studio with A's
    // session would instead fail the session-lineage check.)
    await expect(
      asUser(b.userId, (q) =>
        q(`select public.copy_session_setup($1,$2,$3::jsonb,$4)`, [
          a.studioId,
          sessionId,
          JSON.stringify(specWithOutcomesInjected()),
          "k-cross",
        ]),
      ),
    ).rejects.toThrow(/not authorized/i);
    const count = (
      await adminQuery(
        "select count(*)::int as n from public.session_blocks where session_id=$1",
        [sessionId],
      )
    ).rows[0].n;
    expect(count).toBe(0);
  });
});

describe("copy_session_setup — batch-shape guards (hand-crafted RPC defense-in-depth)", () => {
  it("rejects an empty specs array (nothing to copy) and writes no ledger row", async () => {
    const sessionId = await bareSession(a);
    await expect(callCopy(a, sessionId, [], "k-empty")).rejects.toThrow(/no specs to copy/i);
    const ledger = (
      await adminQuery(
        "select count(*)::int as n from public.session_copy_operations where session_id=$1",
        [sessionId],
      )
    ).rows[0].n;
    expect(ledger).toBe(0);
  });

  it("rejects a non-array specs payload", async () => {
    const sessionId = await bareSession(a);
    await expect(
      callCopy(a, sessionId, { block: { mode: "blend" } } as unknown, "k-notarray"),
    ).rejects.toThrow(/must be a JSON array/i);
  });

  it("rejects an oversized batch (>50 specs) and creates no blocks", async () => {
    const sessionId = await bareSession(a);
    const many = Array.from({ length: 51 }, () => specWithOutcomesInjected()[0]);
    await expect(callCopy(a, sessionId, many, "k-toomany")).rejects.toThrow(/too many specs/i);
    const count = (
      await adminQuery(
        "select count(*)::int as n from public.session_blocks where session_id=$1",
        [sessionId],
      )
    ).rows[0].n;
    expect(count).toBe(0);
  });

  it("rejects a block with too many areas (>25) and rolls back atomically", async () => {
    const sessionId = await bareSession(a);
    const areas = Array.from({ length: 26 }, (_, i) => ({
      area: `Area ${i}`,
      laterality: "bilateral",
    }));
    const specs = [{ block: { mode: "blend", primary_area: "Chin" }, areas, entry: null }];
    await expect(callCopy(a, sessionId, specs, "k-toomanyareas")).rejects.toThrow(/too many areas/i);
    const count = (
      await adminQuery(
        "select count(*)::int as n from public.session_blocks where session_id=$1",
        [sessionId],
      )
    ).rows[0].n;
    expect(count).toBe(0);
  });
});
