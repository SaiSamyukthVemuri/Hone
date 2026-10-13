import { afterAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// 0223 — THE AUTHORITY BOUNDARY, THE RACE, AND CAPTURE COHERENCE.
//
// These were the three blockers an independent source review raised against
// the first implementation, and they are the three things a source-shape test
// cannot see. Everything here calls the real commands against a real database
// as a real role, because every one of these defects passed a source contract:
//
//  1. PUBLICATION AUTHORITY. `sync_machine_profile_contract` once accepted
//     arbitrary fields from ANY active studio owner, and the contract is
//     GLOBAL - so one tenant's owner could change the units and precision
//     every other tenant records against, and rewrite the meaning of a version
//     under which readings had already been captured. Publication is now
//     deployment authority (service_role), and a published version is
//     immutable.
//
//  2. DATABASE VALIDITY. The command derived unit and precision but forwarded
//     raw values, channels and observation source, so a direct RPC caller -
//     which any studio member is, because the command must run as the
//     practitioner for ownership to resolve - could persist a permanent
//     clinical row claiming anything. The rules are quantity-specific now, and
//     they are enforced at the command, not in the application.
//
//  3. CAPTURE COHERENCE. A revision was allocated per FIELD, and retrieval
//     took the latest of each field independently, which can assemble a setup
//     that never existed: a current from one capture beside a duration from
//     another, possibly a different mode, machine or profile version. One
//     capture is now one atomic fact, allocated under a lock.
//
// POSITIVE CONTROLS ARE INCLUDED DELIBERATELY. A file of refusals can pass
// because everything is refused; each section therefore also proves the
// legitimate path still works.
// ===========================================================================

const PROFILE = "synthetic:authority-proof";

/** Publish as DEPLOYMENT AUTHORITY. adminQuery is `postgres`, not a user. */
async function publish(
  version: number,
  opts: {
    channelsMax?: number | null;
    requiresOption?: string | null;
    fields?: Array<{
      field_key: string;
      native_unit: string;
      decimals: number;
      quantity: string;
      stage_key?: string;
    }>;
  } = {},
): Promise<number> {
  const r = await adminQuery(
    `select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb) as n`,
    [
      PROFILE,
      version,
      "galvanic",
      opts.channelsMax === undefined ? 4 : opts.channelsMax,
      opts.requiresOption ?? null,
      JSON.stringify(
        opts.fields ?? [
          { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
          { field_key: "duration", native_unit: "s", decimals: 1, quantity: "duration" },
          { field_key: "reps", native_unit: "count", decimals: 0, quantity: "count" },
        ],
      ),
    ],
  );
  return Number(r.rows[0].n);
}

let unit = 0;
/** Register a unit. Display names are unique per studio, so vary them. */
async function register(
  studio: SeededStudio,
  version = 1,
  options: string[] = [],
): Promise<string> {
  return asUser(studio.userId, async (q) => {
    const r = await q(
      `select public.register_studio_machine($1,$2,$3,$4,$5) as id`,
      [studio.studioId, PROFILE, version, `Unit ${++unit}`, options],
    );
    return r.rows[0].id as string;
  });
}

type Reading = Record<string, unknown>;
const recordAs = (
  userId: string,
  blockId: string,
  machineId: string,
  group: string,
  readings: Reading[],
  channels: number[] = [],
) =>
  asUser(userId, (q) =>
    q(`select public.record_treatment_setup_group($1,$2,$3,$4,$5,$6::jsonb) as n`, [
      blockId,
      machineId,
      "galvanic",
      group,
      channels,
      JSON.stringify(readings),
    ]),
  );

const ok = (field: string, value: string): Reading => ({
  field_key: field,
  value,
  observation_source: "practitioner-entered",
});

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
describe("0223 · publication is DEPLOYMENT authority, never a tenant's", () => {
  it("POSITIVE CONTROL: deployment authority can publish, and a unit then registers", async () => {
    const studio = await seedStudio("auth-pos");
    expect(await publish(1)).toBe(3);
    const id = await register(studio, 1);
    expect(id).toBeTruthy();
  });

  it("a studio OWNER cannot publish a contract", async () => {
    // THE CROSS-TENANT HOLE THIS CLOSES. The contract is global, so an owner
    // authoring one changes what OTHER studios record against.
    const studio = await seedStudio("auth-owner");
    await expect(
      asUser(studio.userId, (q) =>
        q(`select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`, [
          PROFILE,
          9001,
          "galvanic",
          4,
          null,
          JSON.stringify([
            { field_key: "current", native_unit: "mA", decimals: 3, quantity: "current" },
          ]),
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("a PRACTITIONER cannot publish a contract either", async () => {
    const studio = await seedStudio("auth-prac");
    const member = await seedMember(studio, "prac");
    await expect(
      asUser(member.userId, (q) =>
        q(`select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`, [
          PROFILE,
          9002,
          "galvanic",
          4,
          null,
          JSON.stringify([
            { field_key: "current", native_unit: "mA", decimals: 3, quantity: "current" },
          ]),
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("ANOTHER studio's owner cannot alter a contract this studio records against", async () => {
    // The whole point, stated as the attack: B changes what A's readings mean.
    const a = await seedStudio("auth-a");
    const b = await seedStudio("auth-b");
    await publish(2);
    await register(a, 2);

    await expect(
      asUser(b.userId, (q) =>
        q(`select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`, [
          PROFILE,
          2,
          "galvanic",
          99,
          null,
          JSON.stringify([
            { field_key: "current", native_unit: "mA", decimals: 3, quantity: "current" },
          ]),
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);

    // AND THE CONTRACT IS UNCHANGED. The refusal is worth nothing if the row
    // moved anyway.
    const r = await adminQuery(
      `select native_unit, decimals from public.machine_profile_field_contract
        where machine_profile_id = $1 and machine_profile_version = 2
          and field_key = 'current'`,
      [PROFILE],
    );
    expect(r.rows[0].native_unit).toBe("µA");
    expect(r.rows[0].decimals).toBe(0);
  });

  it("neither role published anything, even as a side effect", async () => {
    const r = await adminQuery(
      `select count(*)::int as n from public.machine_profile_mode_contract
        where machine_profile_version in (9001, 9002)`,
    );
    expect(r.rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("0223 · a published version is IMMUTABLE", () => {
  it("identical re-publication is an idempotent no-op", async () => {
    await publish(10);
    // Returns 0 rather than re-inserting, so a deployment may run repeatedly.
    expect(await publish(10)).toBe(0);
  });

  it("different FIELDS for a published version are refused", async () => {
    await publish(11);
    await expect(
      publish(11, {
        fields: [
          { field_key: "current", native_unit: "mA", decimals: 3, quantity: "current" },
        ],
      }),
    ).rejects.toThrow(/already published with different fields/i);
  });

  it("different MODE FACTS for a published version are refused", async () => {
    await publish(12, { channelsMax: 4 });
    await expect(publish(12, { channelsMax: 8 })).rejects.toThrow(
      /already published with different mode facts/i,
    );
  });

  it("a SHRINKING re-publication is refused, not silently accepted as identical", async () => {
    // The subtle one: every incoming field matches an existing row, so a naive
    // "all incoming are present" check would pass while dropping a field.
    await publish(13);
    await expect(
      publish(13, {
        fields: [
          { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
        ],
      }),
    ).rejects.toThrow(/already published with different fields/i);
  });

  it("a NEW version is how a contract is corrected", async () => {
    await publish(14);
    expect(
      await publish(15, {
        fields: [
          { field_key: "current", native_unit: "mA", decimals: 3, quantity: "current" },
        ],
      }),
    ).toBe(1);
    // And the old version is untouched, so readings captured under it stay
    // interpretable.
    const r = await adminQuery(
      `select native_unit from public.machine_profile_field_contract
        where machine_profile_id=$1 and machine_profile_version=14 and field_key='current'`,
      [PROFILE],
    );
    expect(r.rows[0].native_unit).toBe("µA");
  });
});

// ---------------------------------------------------------------------------
describe("0223 · the command refuses FORGED readings, not just bad UI input", () => {
  // Every case here bypasses the server action entirely and calls the granted
  // RPC as an authenticated studio member - which is the only threat model
  // that matters, because the application's own validation is not a boundary.
  let studio: SeededStudio;
  let blockId: string;
  let machineId: string;

  const setup = async () => {
    if (studio) return;
    studio = await seedStudio("forge");
    blockId = (await seedSession(studio)).blockId;
    await publish(20);
    machineId = await register(studio, 20);
  };

  it("POSITIVE CONTROL: a valid capture succeeds", async () => {
    await setup();
    const r = await recordAs(studio.userId, blockId, machineId, "pos", [
      ok("current", "120"),
      ok("duration", "300.5"),
      ok("reps", "3"),
    ]);
    expect(Number(r.rows[0].n)).toBe(3);
  });

  it.each([
    ["an invented field", [{ field_key: "nope", value: "1", observation_source: "practitioner-entered" }], /has no field "nope"/i],
    ["a negative current", [ok("current", "-5")], /is a current and cannot be negative/i],
    ["a fractional count", [ok("reps", "2.5")], /is a count and must be a whole number/i],
    ["a NaN value", [ok("current", "NaN")], /not a number/i],
    ["precision beyond the machine", [ok("current", "1.25")], /decimal places; this machine displays/i],
    ["an unrecognised observation source", [{ field_key: "current", value: "5", observation_source: "telepathy" }], /not a recognised way of observing/i],
    ["both a value AND an absence", [{ field_key: "current", value: "5", absence_reason: "not-recorded", observation_source: "practitioner-entered" }], /either a value or a reason/i],
    ["neither a value nor an absence", [{ field_key: "current", observation_source: "practitioner-entered" }], /either a value or a reason/i],
  ])("refuses %s", async (_label, readings, pattern) => {
    await setup();
    await expect(
      recordAs(studio.userId, blockId, machineId, "forge", readings as Reading[]),
    ).rejects.toThrow(pattern as RegExp);
  });

  it("refuses a channel the model does not have", async () => {
    await setup();
    await expect(
      recordAs(studio.userId, blockId, machineId, "ch", [ok("current", "5")], [9]),
    ).rejects.toThrow(/not a channel of this machine \(it has 4\)/i);
  });

  it("refuses a channel named twice", async () => {
    await setup();
    await expect(
      recordAs(studio.userId, blockId, machineId, "ch2", [ok("current", "5")], [1, 1]),
    ).rejects.toThrow(/named more than once/i);
  });

  it("refuses a channel at all when the model offers none", async () => {
    const s = await seedStudio("forge-nochan");
    const b = (await seedSession(s)).blockId;
    await publish(21, { channelsMax: null });
    const m = await register(s, 21);
    await expect(
      recordAs(s.userId, b, m, "g", [ok("current", "5")], [1]),
    ).rejects.toThrow(/does not offer per-channel settings/i);
  });

  it("refuses a mode whose required option is not fitted to THIS unit", async () => {
    // The profile describes the model; the device records what is actually
    // fitted, and the device wins.
    const s = await seedStudio("forge-opt");
    const b = (await seedSession(s)).blockId;
    await publish(22, { requiresOption: "needs-widget" });
    const without = await register(s, 22, []);
    await expect(recordAs(s.userId, b, without, "g", [ok("current", "5")])).rejects.toThrow(
      /does not have the needs-widget option fitted/i,
    );
    // POSITIVE CONTROL: the same mode records fine on a unit that HAS it.
    const with_ = await register(s, 22, ["needs-widget"]);
    const r = await recordAs(s.userId, b, with_, "g2", [ok("current", "5")]);
    expect(Number(r.rows[0].n)).toBe(1);
  });

  it("FAILS CLOSED for a profile version with no published contract", async () => {
    const s = await seedStudio("forge-nocontract");
    const b = (await seedSession(s)).blockId;
    await publish(23);
    const m = await register(s, 23);
    // Registering at 23 worked; now forge a reading claiming a version whose
    // contract was never published, by pointing at a unit registered under it.
    await adminQuery(
      `update public.studio_machines set machine_profile_version = 999 where id = $1`,
      [m],
    );
    await expect(recordAs(s.userId, b, m, "g", [ok("current", "5")])).rejects.toThrow(
      /No field contract is published/i,
    );
  });

  it("DERIVES unit and precision, discarding what the caller claims", async () => {
    const s = await seedStudio("forge-derive");
    const b = (await seedSession(s)).blockId;
    await publish(24);
    const m = await register(s, 24);
    await recordAs(s.userId, b, m, "g", [
      {
        field_key: "current",
        value: "80",
        // Both lies, both discarded.
        native_unit: "MILLIAMPS",
        decimals: 6,
        observation_source: "practitioner-entered",
      },
    ]);
    const r = await adminQuery(
      `select native_unit, decimals from public.treatment_setup_readings
        where session_block_id = $1 and field_key = 'current'`,
      [b],
    );
    expect(r.rows[0].native_unit).toBe("µA");
    expect(r.rows[0].decimals).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("0223 · concurrent captures stay DISTINCT and COHERENT", () => {
  it("four simultaneous captures get consecutive revisions and never interleave", async () => {
    // THE RACE THE ADVISORY LOCK EXISTS FOR. Without it, concurrent callers
    // read the same max(revision) and either collide on the unique constraint
    // or share a number, which would make two different settings look like one
    // capture.
    //
    // Four, because the harness pool is max 4 - so these are genuinely
    // simultaneous rather than queued.
    const studio = await seedStudio("race");
    const { blockId } = await seedSession(studio);
    await publish(30);
    const machineId = await register(studio, 30);

    await Promise.all(
      ["10", "20", "30", "40"].map((v) =>
        recordAs(studio.userId, blockId, machineId, "g", [
          ok("current", v),
          ok("duration", "1.0"),
        ]),
      ),
    );

    const caps = await adminQuery(
      `select c.revision,
              (select count(*)::int from public.treatment_setup_readings r
                where r.capture_id = c.id) as fields,
              (select count(distinct r.revision)::int from public.treatment_setup_readings r
                where r.capture_id = c.id) as revisions
         from public.treatment_setup_captures c
        where c.session_block_id = $1 and c.group_key = 'g'
        order by c.revision`,
      [blockId],
    );

    expect(caps.rows.map((r: { revision: number }) => r.revision)).toEqual([1, 2, 3, 4]);
    // Each capture holds its OWN two fields, at ONE revision. A capture with
    // three fields, or two revisions, would mean two callers' readings mixed.
    for (const row of caps.rows as Array<{ fields: number; revisions: number }>) {
      expect(row.fields).toBe(2);
      expect(row.revisions).toBe(1);
    }

    // And each capture's current is one of the four submitted values, never a
    // blend.
    const vals = await adminQuery(
      `select r.capture_id, r.value_numeric::text as v
         from public.treatment_setup_readings r
         join public.treatment_setup_captures c on c.id = r.capture_id
        where c.session_block_id = $1 and r.field_key = 'current'
        order by v`,
      [blockId],
    );
    expect(vals.rows.map((r: { v: string }) => r.v)).toEqual(["10", "20", "30", "40"]);
  });
});

// ---------------------------------------------------------------------------
describe("0223 · retrieval returns ONE coherent capture, never a composite", () => {
  it("a later capture on a DIFFERENT machine and version does not mix with an earlier one", async () => {
    // The defect: per-field "latest" could pair a current recorded on one
    // machine under one contract version with a duration from another.
    const studio = await seedStudio("coherent");
    const { blockId } = await seedSession(studio);
    await publish(40);
    const first = await register(studio, 40);
    await recordAs(studio.userId, blockId, first, "g", [
      ok("current", "111"),
      ok("duration", "9.9"),
    ]);

    await publish(41, {
      fields: [
        { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
      ],
    });
    const second = await register(studio, 41);
    await recordAs(studio.userId, blockId, second, "g", [ok("current", "77")]);

    const guide = await asUser(studio.userId, (q) =>
      q(`select public.latest_setup_for_client($1,$2) as r`, [
        studio.studioId,
        studio.clientId,
      ]),
    );
    const rows = (guide.rows[0].r ?? []) as Array<{
      capture_id: string;
      machine_profile_version: number;
      field_key: string;
      value_numeric: string;
    }>;

    // ONE capture, ONE version, and ONLY the fields that capture recorded.
    expect(new Set(rows.map((r) => r.capture_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.machine_profile_version))).toEqual(new Set([41]));
    expect(rows.map((r) => `${r.field_key}=${r.value_numeric}`)).toEqual([
      "current=77",
    ]);

    // THE KEY NEGATIVE: duration was recorded earlier and is NOT carried
    // forward into the newer capture's guidance. Silently filling it would
    // invent a setting that was never used together with current=77.
    expect(rows.some((r) => r.field_key === "duration")).toBe(false);

    // ...while remaining in the record, because the observation happened.
    const kept = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_readings
        where session_block_id = $1 and field_key = 'duration'`,
      [blockId],
    );
    expect(kept.rows[0].n).toBe(1);
  });

  it("exposes the chronological history of a block, oldest first", async () => {
    // Append-only storage is not an exposed history. A superseded setting has
    // to be visible as a moment in the treatment.
    const studio = await seedStudio("history");
    const { blockId } = await seedSession(studio);
    await publish(50);
    const machineId = await register(studio, 50);
    await recordAs(studio.userId, blockId, machineId, "g", [ok("current", "100")]);
    await recordAs(studio.userId, blockId, machineId, "g", [ok("current", "150")]);

    const out = await asUser(studio.userId, (q) =>
      q(`select public.setup_capture_history_for_block($1) as r`, [blockId]),
    );
    const hist = (out.rows[0].r ?? []) as Array<{
      revision: number;
      field_count: number;
    }>;
    expect(hist.map((h) => h.revision)).toEqual([1, 2]);
    expect(hist.every((h) => h.field_count === 1)).toBe(true);
  });

  it("a NON-MEMBER gets neither guidance nor history", async () => {
    const target = await seedStudio("hist-target");
    const stranger = await seedStudio("hist-stranger");
    const { blockId } = await seedSession(target);
    await publish(51);
    const machineId = await register(target, 51);
    await recordAs(target.userId, blockId, machineId, "g", [ok("current", "100")]);

    const guide = await asUser(stranger.userId, (q) =>
      q(`select public.latest_setup_for_client($1,$2) as r`, [
        target.studioId,
        target.clientId,
      ]),
    );
    expect(guide.rows[0].r).toEqual([]);

    const hist = await asUser(stranger.userId, (q) =>
      q(`select public.setup_capture_history_for_block($1) as r`, [blockId]),
    );
    expect(hist.rows[0].r).toEqual([]);
  });
});
