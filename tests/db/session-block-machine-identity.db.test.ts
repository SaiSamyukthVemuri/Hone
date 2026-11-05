import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  adminTx,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// 0301: THE TREATMENT AREA'S SAVED MACHINE IDENTITY.
//
// The refresh defect: a machine and mode chosen with no value entered were
// stored nowhere, so reopening the area could not restore them. These cases
// prove the identity is saved WITH the area (one transaction), that NULL still
// means "not recorded", that existing xCell Pur (legacy) rows are untouched,
// and that the commands refuse another studio's or a retired unit.
//
// SYNTHETIC PROFILE IDS THROUGHOUT. No real model is activated.
// ===========================================================================

const PROFILE = "fixture:db-identity";
const XCELL = "dectro-apilus:xcell";
const VERSION = 1;

afterAll(async () => {
  await closePool();
});

async function publish(): Promise<void> {
  await adminQuery(
    `select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      PROFILE,
      VERSION,
      "galvanic",
      4,
      null,
      JSON.stringify([
        { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true },
      ]),
    ],
  );
}

async function register(studio: SeededStudio): Promise<string> {
  await publish();
  return asUser(studio.userId, async (q) => {
    const r = await q(`select public.register_studio_machine($1,$2,$3,$4,$5) as id`, [
      studio.studioId,
      PROFILE,
      VERSION,
      "Room 1",
      [],
    ]);
    return r.rows[0].id as string;
  });
}

const groups = (value: string) => [
  {
    new_group_ref: "g1",
    channels: [1],
    readings: [{ field_key: "current", value, observation_source: "practitioner-entered" }],
  },
];

const SQL = `select public.create_block_with_initial_setup_and_identity(
  $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,
  $15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
  $27,$28,$29,$30::jsonb,$31) as r`;

async function save(
  studio: SeededStudio,
  sessionId: string,
  over: { legacyEntry?: boolean; thermolysisIntensity?: number; machine?: string | null; mode?: string | null; key?: string | null; groups?: unknown; profile?: string | null; userId?: string } = {},
) {
  return asUser(over.userId ?? studio.userId, async (q) => {
    const r = await q(SQL, [
      sessionId,
      studio.clientId,
      JSON.stringify({ block_name: "Identity", primary_area: "jaw" }),
      JSON.stringify({}),
      JSON.stringify([]),
      false,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      over.machine ?? null,
      over.mode ?? null,
      over.key ?? null,
      over.groups === undefined ? null : JSON.stringify(over.groups),
      over.profile ?? null,
    ].map((v, i) => {
      // A legacy-style entry (an area with a mode, plus a thermolysis reading when given) rides the same call.
      if (over.legacyEntry) {
        if (i === 5) return true;
        if (i === 6) return "Upper lip";
        if (i === 10) return "thermo";
        if (i === 11) return 1;
      }
      return i === 23 && over.thermolysisIntensity != null ? over.thermolysisIntensity : v;
    }));
    return r.rows[0].r as { block_id: string; reused: boolean; setup: unknown };
  });
}

async function identity(blockId: string) {
  const r = await adminQuery(
    `select machine_profile_id, studio_machine_id, machine_mode_key
       from public.session_blocks where id = $1`,
    [blockId],
  );
  return r.rows[0] as {
    machine_profile_id: string | null;
    studio_machine_id: string | null;
    machine_mode_key: string | null;
  };
}

async function readings(blockId: string): Promise<number> {
  const r = await adminQuery(
    `select count(*)::int as n from public.treatment_setup_readings where session_block_id = $1`,
    [blockId],
  );
  return r.rows[0].n as number;
}

describe("0301: the identity is saved with the area", () => {
  it("REFRESH DEFECT: a machine and mode chosen with NO value are still saved and read back", async () => {
    const studio = await seedStudio("identity-novalue");
    const { sessionId } = await seedSession(studio);
    const machine = await register(studio);
    const out = await save(studio, sessionId, { machine, mode: "galvanic" });
    expect(await readings(out.block_id)).toBe(0);
    expect(await identity(out.block_id)).toEqual({
      machine_profile_id: PROFILE,
      studio_machine_id: machine,
      machine_mode_key: "galvanic",
    });
  });

  it("machine, mode, values and area are saved TOGETHER", async () => {
    const studio = await seedStudio("identity-together");
    const { sessionId } = await seedSession(studio);
    const machine = await register(studio);
    const out = await save(studio, sessionId, {
      machine,
      mode: "galvanic",
      key: "identity-key-0001",
      groups: groups("42"),
    });
    expect(await readings(out.block_id)).toBeGreaterThan(0);
    const b = await adminQuery(`select primary_area from public.session_blocks where id=$1`, [out.block_id]);
    expect(b.rows[0].primary_area).toBe("jaw");
    expect((await identity(out.block_id)).studio_machine_id).toBe(machine);
  });

  it("a failed settings payload leaves NO area and NO identity (one transaction)", async () => {
    const studio = await seedStudio("identity-atomic");
    const { sessionId } = await seedSession(studio);
    const machine = await register(studio);
    const before = await adminQuery(`select count(*)::int n from public.session_blocks where session_id=$1`, [sessionId]);
    await expect(
      save(studio, sessionId, { machine, mode: "galvanic", groups: { not: "a list" } }),
    ).rejects.toThrow(/list of groups/);
    const after = await adminQuery(`select count(*)::int n from public.session_blocks where session_id=$1`, [sessionId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("an xCell Pur choice (no registered unit) records the model only, never a mode", async () => {
    const studio = await seedStudio("identity-xcell");
    const { sessionId } = await seedSession(studio);
    const out = await save(studio, sessionId, { profile: XCELL });
    expect(await identity(out.block_id)).toEqual({
      machine_profile_id: XCELL,
      studio_machine_id: null,
      machine_mode_key: null,
    });
    await expect(save(studio, sessionId, { profile: XCELL, mode: "galvanic" })).rejects.toThrow(/needs a registered machine/);
  });

  it("no identity supplied means NULL: nothing is inferred", async () => {
    const studio = await seedStudio("identity-null");
    const { sessionId } = await seedSession(studio);
    const out = await save(studio, sessionId, {});
    expect(await identity(out.block_id)).toEqual({
      machine_profile_id: null,
      studio_machine_id: null,
      machine_mode_key: null,
    });
  });

  it("a replay of the same key is answered with the original and rewrites nothing", async () => {
    const studio = await seedStudio("identity-replay");
    const { sessionId } = await seedSession(studio);
    const machine = await register(studio);
    const first = await save(studio, sessionId, { machine, mode: "galvanic", key: "identity-key-0002", groups: groups("7") });
    const again = await save(studio, sessionId, { machine, mode: "galvanic", key: "identity-key-0002", groups: groups("7") });
    expect(again.reused).toBe(true);
    expect(again.block_id).toBe(first.block_id);
    expect((await identity(first.block_id)).studio_machine_id).toBe(machine);
  });
});

describe("0301: refusals", () => {
  it("another studio's unit is refused", async () => {
    const mine = await seedStudio("identity-mine");
    const theirs = await seedStudio("identity-theirs");
    const { sessionId } = await seedSession(mine);
    const foreign = await register(theirs);
    await expect(save(mine, sessionId, { machine: foreign, mode: "galvanic" })).rejects.toThrow(/not available in this studio/);
  });

  it("a retired unit is refused for a new save", async () => {
    const studio = await seedStudio("identity-retired");
    const { sessionId } = await seedSession(studio);
    const machine = await register(studio);
    await adminQuery(`update public.studio_machines set retired_at = now() where id = $1`, [machine]);
    await expect(save(studio, sessionId, { machine, mode: "galvanic" })).rejects.toThrow(/not available in this studio/);
  });

  it("a caller cannot name a profile that disagrees with the unit", async () => {
    const studio = await seedStudio("identity-mismatch");
    const { sessionId } = await seedSession(studio);
    const machine = await register(studio);
    await expect(save(studio, sessionId, { machine, mode: "galvanic", profile: XCELL })).rejects.toThrow(/does not match the selected model/);
  });

  it("anon and service_role cannot execute the commands or the internal writer", async () => {
    for (const fn of [
      "apply_block_machine_identity",
      "record_block_machine_identity",
      "create_block_with_initial_setup_and_identity",
      "record_setup_submission_with_identity",
    ]) {
      const r = await adminQuery(
        `select has_function_privilege('anon', p.oid, 'execute') a,
                has_function_privilege('service_role', p.oid, 'execute') s,
                has_function_privilege('authenticated', p.oid, 'execute') u
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [fn],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].a, fn).toBe(false);
      expect(r.rows[0].s, fn).toBe(false);
      expect(r.rows[0].u, fn).toBe(fn !== "apply_block_machine_identity");
    }
  });
});

describe("0301: an existing area", () => {
  it("record_block_machine_identity changes the identity and nothing else on the block", async () => {
    const studio = await seedStudio("identity-existing");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    const cols = `mode, apilus_modality, energy_level, minutes_performed, machine_frequency, primary_area, side, probe_key, tolerance_rating`;
    const before = await adminQuery(`select ${cols} from public.session_blocks where id=$1`, [blockId]);
    await asUser(studio.userId, (q) =>
      q(`select public.record_block_machine_identity($1,$2,$3,$4,$5,$6)`, [blockId, sessionId, studio.clientId, null, machine, "galvanic"]),
    );
    expect(await identity(blockId)).toEqual({ machine_profile_id: PROFILE, studio_machine_id: machine, machine_mode_key: "galvanic" });
    const after = await adminQuery(`select ${cols} from public.session_blocks where id=$1`, [blockId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("another studio's practitioner cannot stamp the identity", async () => {
    const owner = await seedStudio("identity-own");
    const other = await seedStudio("identity-other");
    const { sessionId, blockId } = await seedSession(owner);
    const machine = await register(other);
    await expect(
      asUser(other.userId, (q) =>
        q(`select public.record_block_machine_identity($1,$2,$3,$4,$5,$6)`, [blockId, sessionId, owner.clientId, null, machine, "galvanic"]),
      ),
    ).rejects.toThrow();
    expect((await identity(blockId)).machine_profile_id).toBeNull();
  });

  it("record_setup_submission_with_identity records the readings and the identity together", async () => {
    const studio = await seedStudio("identity-submit");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await asUser(studio.userId, (q) =>
      q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7)`, [
        blockId, machine, "galvanic", "identity-submit-0001", JSON.stringify(groups("9")), sessionId, studio.clientId,
      ]),
    );
    expect(await readings(blockId)).toBeGreaterThan(0);
    expect((await identity(blockId)).machine_mode_key).toBe("galvanic");
  });

  it("a LATE REPLAY of an earlier submission does not put the earlier unit back (Privacy F-2)", async () => {
    const studio = await seedStudio("identity-replay");
    const { sessionId, blockId } = await seedSession(studio);
    const first = await register(studio);
    const second = await asUser(studio.userId, async (q) => {
      const r = await q(`select public.register_studio_machine($1,$2,$3,$4,$5) as id`, [
        studio.studioId, PROFILE, VERSION, "Room 2", [],
      ]);
      return r.rows[0].id as string;
    });
    const submit = (machine: string) =>
      asUser(studio.userId, (q) =>
        q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7) as r`, [
          blockId, machine, "galvanic", "identity-replay-0001", JSON.stringify(groups("9")), sessionId, studio.clientId,
        ]),
      );
    await submit(first);
    await asUser(studio.userId, (q) =>
      q(`select public.record_block_machine_identity($1,$2,$3,$4,$5,$6)`, [blockId, sessionId, studio.clientId, null, second, "galvanic"]),
    );
    expect((await identity(blockId)).studio_machine_id).toBe(second);
    const replay = await submit(first);
    expect(replay.rows[0].r.reused).toBe(true);
    expect((await identity(blockId)).studio_machine_id).toBe(second);
  });
});

// ===========================================================================
// THE HELD VERSION IS CHECKED, AND THE NEW ONE RETURNED, INSIDE THE WRITE'S OWN
// TRANSACTION (Codex #1369 4476240827). A read taken around the write could be
// overtaken by a second tab; the command's own `UPDATE ... RETURNING` cannot.
// ===========================================================================
describe("0301: the block version token is checked and returned in the write transaction", () => {
  const version = async (blockId: string) =>
    (await adminQuery(`select updated_at::text as t from public.session_blocks where id = $1`, [blockId])).rows[0].t as string;
  const stamp = (studio: SeededStudio, sessionId: string, blockId: string, machine: string, held: string | null) =>
    asUser(studio.userId, async (q) => {
      const r = await q(
        `select public.record_block_machine_identity($1,$2,$3,$4,$5,$6,$7::timestamptz)::text as t`,
        [blockId, sessionId, studio.clientId, null, machine, "galvanic", held],
      );
      return r.rows[0].t as string;
    });
  const submit = (studio: SeededStudio, sessionId: string, blockId: string, machine: string, key: string, held: string | null) =>
    asUser(studio.userId, async (q) => {
      const r = await q(
        `select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz) as r`,
        [blockId, machine, "galvanic", key, JSON.stringify(groups("9")), sessionId, studio.clientId, held],
      );
      return r.rows[0].r as { reused: boolean; block_updated_at?: string };
    });

  it("returns the very version the UPDATE left on the row", async () => {
    const studio = await seedStudio("token-return");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    const held = await version(blockId);
    const returned = await stamp(studio, sessionId, blockId, machine, held);
    expect(returned).toBe(await version(blockId));
    expect(returned).not.toBe(held);
  });

  it("NEGATIVE CONTROL: a held version that no longer matches is refused as stale_block_version and nothing is written", async () => {
    const studio = await seedStudio("token-stale");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    const before = await version(blockId);
    await expect(stamp(studio, sessionId, blockId, machine, "2001-01-01 00:00:00+00")).rejects.toThrow(/stale_block_version/);
    expect(await version(blockId)).toBe(before);
    expect((await identity(blockId)).studio_machine_id).toBeNull();
  });

  it("NEGATIVE CONTROL: a second tab's write BETWEEN two calls is detected by the second call", async () => {
    const studio = await seedStudio("token-second-tab");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    const t1 = await stamp(studio, sessionId, blockId, machine, await version(blockId));
    await adminQuery(`update public.session_blocks set block_notes = 'edited in another tab' where id = $1`, [blockId]);
    expect(await version(blockId)).not.toBe(t1);
    await expect(stamp(studio, sessionId, blockId, machine, t1)).rejects.toThrow(/stale_block_version/);
    // POSITIVE CONTROL: with the version the other tab left, the same write goes through.
    const t2 = await stamp(studio, sessionId, blockId, machine, await version(blockId));
    expect(t2).toBe(await version(blockId));
  });

  it("no held version keeps the older behaviour: the write is not checked", async () => {
    const studio = await seedStudio("token-none");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await stamp(studio, sessionId, blockId, machine, null);
    expect((await identity(blockId)).machine_mode_key).toBe("galvanic");
  });

  it("a submission returns the new version", async () => {
    const studio = await seedStudio("token-submit");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    const ok = await submit(studio, sessionId, blockId, machine, "token-submit-0001", await version(blockId));
    expect(ok.reused).toBe(false);
    expect(ok.block_updated_at).toBeDefined();
    expect(new Date(ok.block_updated_at as string).getTime()).toBe(new Date(await version(blockId)).getTime());
  });

  it("NEGATIVE CONTROL: a stale held version refuses the submission and rolls its readings back too", async () => {
    const studio = await seedStudio("token-submit-stale");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await expect(
      submit(studio, sessionId, blockId, machine, "token-submit-0002", "2001-01-01 00:00:00+00"),
    ).rejects.toThrow(/stale_block_version/);
    expect(await readings(blockId)).toBe(0);
    expect((await identity(blockId)).studio_machine_id).toBeNull();
  });

  it("a same-key replay returns NO version and checks nothing (Insurance N-8)", async () => {
    const studio = await seedStudio("token-replay");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await submit(studio, sessionId, blockId, machine, "token-replay-0001", await version(blockId));
    const replay = await submit(studio, sessionId, blockId, machine, "token-replay-0001", "2001-01-01 00:00:00+00");
    expect(replay.reused).toBe(true);
    expect(replay.block_updated_at).toBeUndefined();
  });
});

// Insurance Z-1: record_treatment_setup_submission takes FOR SHARE on the block and the identity write takes
// FOR UPDATE later in the same transaction, so two concurrent submissions on one block could each hold SHARE
// and wait on the other's upgrade (deadlock 40P01). The wrapper now takes FOR UPDATE first.
describe("0301: two concurrent submissions on one block do not deadlock (Insurance Z-1)", () => {
  const ROUNDS = 12;
  it("both submissions commit, in either order, round after round", async () => {
    const studio = await seedStudio("concurrent-submit");
    const machine = await register(studio);
    const withChannel = (channel: number) => [
      {
        new_group_ref: `g${channel}`,
        channels: [channel],
        readings: [{ field_key: "current", value: String(channel), observation_source: "practitioner-entered" }],
      },
    ];
    for (let round = 0; round < ROUNDS; round++) {
      const { sessionId, blockId } = await seedSession(studio);
      const go = (channel: number) =>
        asUser(studio.userId, (q) =>
          q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7) as r`, [
            blockId, machine, "galvanic", `concurrent-${round}-${channel}`, JSON.stringify(withChannel(channel)), sessionId, studio.clientId,
          ]),
        );
      const settled = await Promise.allSettled([go(1), go(2)]);
      const failed = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(failed.map((f) => String(f.reason?.message ?? f.reason)), `round ${round}`).toEqual([]);
      expect(await readings(blockId)).toBe(2);
    }
  }, 120_000);

  it("the wrapper takes the block lock before the inner command (source order)", () => {
    const sql = readFileSync("supabase/migrations/0301_session_block_machine_identity.sql", "utf8");
    const body = sql.slice(sql.indexOf("function public.record_setup_submission_with_identity"));
    expect(body.indexOf("for update;")).toBeGreaterThan(-1);
    expect(body.indexOf("for update;")).toBeLessThan(body.indexOf("public.record_treatment_setup_submission("));
  });
});

describe("0301: no direct write path to the new columns (Privacy EH-3)", () => {
  const COLS = ["machine_profile_id", "studio_machine_id", "machine_mode_key"];

  it("authenticated and anon hold no UPDATE or INSERT privilege on them, by table or by column", async () => {
    for (const role of ["authenticated", "anon"]) {
      for (const col of COLS) {
        for (const priv of ["UPDATE", "INSERT"]) {
          const r = await adminQuery(
            `select has_column_privilege($1, 'public.session_blocks', $2, $3) as ok`,
            [role, col, priv],
          );
          expect(r.rows[0].ok, `${role} ${priv} ${col}`).toBe(false);
        }
      }
    }
  });

  it("a practitioner's direct UPDATE of the identity is refused and changes nothing", async () => {
    const studio = await seedStudio("identity-direct");
    const { blockId } = await seedSession(studio);
    const machine = await register(studio);
    await expect(
      asUser(studio.userId, (q) =>
        q(`update public.session_blocks set studio_machine_id = $1, machine_profile_id = $2 where id = $3`, [machine, PROFILE, blockId]),
      ),
    ).rejects.toThrow(/permission denied/i);
    expect(await identity(blockId)).toEqual({ machine_profile_id: null, studio_machine_id: null, machine_mode_key: null });
  });
});

describe("0301: legacy rows", () => {
  it("existing xCell Pur rows have all three columns NULL and still carry no readings", async () => {
    const studio = await seedStudio("identity-legacy");
    const { blockId } = await seedSession(studio);
    expect(await identity(blockId)).toEqual({ machine_profile_id: null, studio_machine_id: null, machine_mode_key: null });
    expect(await readings(blockId)).toBe(0);
  });
});

// ===========================================================================
// An area that already holds xCell Pur readings never gets a NATIVE identity
// (Codex, #1369 4471593271; decided by OPS). The refusal is in the one writer, so every command reaches it.
// ===========================================================================
describe("0301: a saved area with xCell Pur readings takes no native machine", () => {
  const REFUSED = /already holds xCell Pur readings/;
  const record = (studio: SeededStudio, sessionId: string, blockId: string, profile: string | null, machine: string | null, mode: string | null) =>
    asUser(studio.userId, (q) =>
      q(`select public.record_block_machine_identity($1,$2,$3,$4,$5,$6)`, [blockId, sessionId, studio.clientId, profile, machine, mode]),
    );
  // The legacy columns are written by the older block commands, and a direct UPDATE needs an authenticated practitioner with column
  // rights this fixture does not need to reproduce: set the value as the owner, in one transaction, with the row triggers off.
  const setBlock = (_studio: SeededStudio, blockId: string, sets: string, params: unknown[] = []) =>
    adminTx(async (q) => {
      await q("set local session_replication_role = replica");
      await q(`update public.session_blocks set ${sets} where id = $1`, [blockId, ...params]);
    });
  const blockColumns: Array<[string, string, unknown]> = [
    ["mode", "mode", "thermo"],
    ["apilus_modality", "apilus_modality", "blend"],
    ["energy_level", "energy_level", 3],
    ["machine_frequency", "machine_frequency", "13.56 MHz"],
  ];
  const entryColumns: Array<[string, unknown]> = [
    ["thermolysis_intensity_percent", 40],
    ["thermolysis_duration_seconds", "0.7"],
    ["galvanic_ma", "0.8"],
    ["galvanic_duration_seconds", 90],
    ["units_of_lye", "2.5"],
  ];
  const addEntry = async (studio: SeededStudio, sessionId: string, blockId: string, col: string | null, value: unknown) =>
    adminQuery(
      col
        ? `insert into public.electrolysis_entries (session_id, block_id, area, pulse_count, ${col}) values ($1, $2, 'Upper lip', 1, $3)`
        : `insert into public.electrolysis_entries (session_id, block_id, area, pulse_count) values ($1, $2, 'Upper lip', 1)`,
      col ? [sessionId, blockId, value] : [sessionId, blockId],
    );

  it.each(blockColumns)("a block-level legacy reading (%s) refuses a native unit and writes nothing", async (_n, col, value) => {
    const studio = await seedStudio("identity-lock-block");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await setBlock(studio, blockId, `${col} = $2`, [value]);
    await expect(record(studio, sessionId, blockId, null, machine, "galvanic")).rejects.toThrow(REFUSED);
    expect(await identity(blockId)).toEqual({ machine_profile_id: null, studio_machine_id: null, machine_mode_key: null });
  });

  it.each(entryColumns)("an entry-level legacy reading (%s) refuses a native unit and writes nothing", async (col, value) => {
    const studio = await seedStudio("identity-lock-entry");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await addEntry(studio, sessionId, blockId, col, value);
    await expect(record(studio, sessionId, blockId, null, machine, "galvanic")).rejects.toThrow(REFUSED);
    expect(await identity(blockId)).toEqual({ machine_profile_id: null, studio_machine_id: null, machine_mode_key: null });
  });

  it("a NATIVE-profile call without a unit is refused the same way (the profile is what is native)", async () => {
    const studio = await seedStudio("identity-lock-profile");
    const { sessionId, blockId } = await seedSession(studio);
    await setBlock(studio, blockId, `energy_level = 3`);
    await expect(record(studio, sessionId, blockId, PROFILE, null, null)).rejects.toThrow(REFUSED);
    expect((await identity(blockId)).machine_profile_id).toBeNull();
  });

  it("record_setup_submission_with_identity refuses too, and its readings roll back with it", async () => {
    const studio = await seedStudio("identity-lock-submission");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await setBlock(studio, blockId, `energy_level = 3`);
    await expect(
      asUser(studio.userId, (q) =>
        q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7)`, [
          blockId, machine, "galvanic", "lock-submission-1", JSON.stringify(groups("25")), sessionId, studio.clientId,
        ]),
      ),
    ).rejects.toThrow(REFUSED);
    expect(await readings(blockId)).toBe(0);
    expect((await identity(blockId)).studio_machine_id).toBeNull();
  });

  it("NEGATIVE CONTROL: the legacy xCell Pur machine itself is still recorded on a legacy-readings area", async () => {
    const studio = await seedStudio("identity-lock-allow-legacy");
    const { sessionId, blockId } = await seedSession(studio);
    await setBlock(studio, blockId, `energy_level = 3, mode = 'thermo'`);
    await addEntry(studio, sessionId, blockId, "galvanic_ma", "0.8");
    await record(studio, sessionId, blockId, XCELL, null, null);
    expect(await identity(blockId)).toEqual({ machine_profile_id: XCELL, studio_machine_id: null, machine_mode_key: null });
  });

  it("NEGATIVE CONTROL: an area with no legacy readings (even with an empty entry row) still takes a native unit", async () => {
    const studio = await seedStudio("identity-lock-allow-native");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await addEntry(studio, sessionId, blockId, null, null);
    await record(studio, sessionId, blockId, null, machine, "galvanic");
    expect(await identity(blockId)).toEqual({ machine_profile_id: PROFILE, studio_machine_id: machine, machine_mode_key: "galvanic" });
  });

  it("NEGATIVE CONTROL: a blank-string legacy column is not a reading", async () => {
    const studio = await seedStudio("identity-lock-blank");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await setBlock(studio, blockId, `machine_frequency = '  '`);
    await record(studio, sessionId, blockId, null, machine, "galvanic");
    expect((await identity(blockId)).studio_machine_id).toBe(machine);
  });

  it("NEGATIVE CONTROL: a SOFT-DELETED legacy entry is not a reading (OPS decision on Insurance LK-1)", async () => {
    const studio = await seedStudio("identity-lock-deleted-entry");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await addEntry(studio, sessionId, blockId, "galvanic_ma", "0.8");
    await adminTx(async (q) => {
      await q("set local session_replication_role = replica");
      await q(`update public.electrolysis_entries set deleted_at = now() where block_id = $1`, [blockId]);
    });
    await record(studio, sessionId, blockId, null, machine, "galvanic");
    expect((await identity(blockId)).studio_machine_id).toBe(machine);
  });

  it("the create wrapper with a native unit AND one legacy parameter refuses and creates NO block (Insurance LK-2)", async () => {
    const studio = await seedStudio("identity-lock-wrapper");
    const { sessionId } = await seedSession(studio);
    const machine = await register(studio);
    const count = async () =>
      (await adminQuery(`select count(*)::int as n from public.session_blocks where session_id = $1`, [sessionId])).rows[0].n as number;
    const before = await count();
    await expect(save(studio, sessionId, { machine, mode: "galvanic", key: "lk2-refused-1", legacyEntry: true, thermolysisIntensity: 40 })).rejects.toThrow(REFUSED);
    expect(await count(), "the whole save rolled back, the area included").toBe(before);
  });

  it("NEGATIVE CONTROL: the same wrapper call with the native unit and NO legacy parameter succeeds", async () => {
    const studio = await seedStudio("identity-lock-wrapper-ok");
    const { sessionId } = await seedSession(studio);
    const machine = await register(studio);
    const out = await save(studio, sessionId, { machine, mode: "galvanic", key: "lk2-ok-key-1" });
    expect(await identity(out.block_id)).toEqual({ machine_profile_id: PROFILE, studio_machine_id: machine, machine_mode_key: "galvanic" });
  });
});

// Codex 4486745915: assert_session_writable (0166, frozen) never looks at sessions.deleted_at, and soft_delete_session leaves the
// blocks alone, so a direct call could change the identity of a block in a REMOVED session. Every identity command now refuses.
describe("0301: a soft-deleted session takes no identity (Codex 4486745915)", () => {
  const GONE = /Session not found or not writable/;
  async function retire(sessionId: string) {
    await adminTx(async (q) => {
      await q("set local session_replication_role = replica");
      await q(`update public.sessions set deleted_at = now() where id = $1`, [sessionId]);
    });
  }
  const identityCall = (studio: SeededStudio, sessionId: string, blockId: string, machine: string) =>
    asUser(studio.userId, (q) =>
      q(`select public.record_block_machine_identity($1,$2,$3,$4,$5,$6)`, [blockId, sessionId, studio.clientId, null, machine, "galvanic"]),
    );

  it("record_block_machine_identity refuses a deleted session and changes nothing", async () => {
    const studio = await seedStudio("identity-gone-record");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await retire(sessionId);
    await expect(identityCall(studio, sessionId, blockId, machine)).rejects.toThrow(GONE);
    expect((await identity(blockId)).machine_profile_id).toBeNull();
  });

  it("NEGATIVE CONTROL: the same call on a LIVE session is allowed", async () => {
    const studio = await seedStudio("identity-live-record");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await identityCall(studio, sessionId, blockId, machine);
    expect((await identity(blockId)).studio_machine_id).toBe(machine);
  });

  it("record_setup_submission_with_identity refuses a deleted session and writes no readings", async () => {
    const studio = await seedStudio("identity-gone-submit");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await retire(sessionId);
    await expect(
      asUser(studio.userId, (q) =>
        q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7)`, [
          blockId, machine, "galvanic", "identity-gone-0001", JSON.stringify(groups("9")), sessionId, studio.clientId,
        ]),
      ),
    ).rejects.toThrow(GONE);
    expect(await readings(blockId)).toBe(0);
    expect((await identity(blockId)).machine_profile_id).toBeNull();
  });

  it("the create wrapper with an identity refuses a deleted session and creates NO block", async () => {
    const studio = await seedStudio("identity-gone-create");
    const { sessionId } = await seedSession(studio);
    const machine = await register(studio);
    const count = async () =>
      (await adminQuery(`select count(*)::int as n from public.session_blocks where session_id = $1`, [sessionId])).rows[0].n as number;
    const before = await count();
    await retire(sessionId);
    await expect(save(studio, sessionId, { machine, mode: "galvanic", key: "gone-create-01" })).rejects.toThrow(GONE);
    expect(await count()).toBe(before);
  });

  it("the internal writer refuses a block whose session is deleted even when reached directly (postgres role)", async () => {
    const studio = await seedStudio("identity-gone-internal");
    const { sessionId, blockId } = await seedSession(studio);
    const machine = await register(studio);
    await retire(sessionId);
    await expect(
      adminQuery(`select public.apply_block_machine_identity($1,$2,$3,$4,$5)`, [blockId, studio.studioId, null, machine, "galvanic"]),
    ).rejects.toThrow(GONE);
    expect((await identity(blockId)).machine_profile_id).toBeNull();
  });

  it("source order: every command takes the LIVE session lock before the block lock", () => {
    const sql = readFileSync("supabase/migrations/0301_session_block_machine_identity.sql", "utf8");
    const fn = (name: string) => {
      const i = sql.indexOf(`create or replace function public.${name}(`);
      const j = sql.indexOf("create or replace function", i + 10);
      return sql.slice(i, j === -1 ? undefined : j);
    };
    for (const name of ["apply_block_machine_identity", "record_block_machine_identity", "record_setup_submission_with_identity", "create_block_with_initial_setup_and_identity"]) {
      const body = fn(name).replace(/--[^\n]*/g, "");
      const session = body.search(/s\.deleted_at is null\s+for share/);
      expect(session, `${name} locks a live session`).toBeGreaterThan(-1);
      const block = body.search(/assert_block_in_session|\bfor update\b|create_block_with_initial_setup\(/);
      expect(block, `${name} touches the block`).toBeGreaterThan(-1);
      expect(session, `${name}: session before block`).toBeLessThan(block);
    }
  });
});
