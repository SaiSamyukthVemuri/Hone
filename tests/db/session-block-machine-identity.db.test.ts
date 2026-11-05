import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import {
  adminQuery,
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
  over: { machine?: string | null; mode?: string | null; key?: string | null; groups?: unknown; profile?: string | null; userId?: string } = {},
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
    ]);
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
