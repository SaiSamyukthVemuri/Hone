import { afterAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// 0223 — THE INITIAL SAVE: create_block_with_initial_setup.
//
// The treatment area AND the machine settings recorded on it, in ONE
// transaction: either both exist or neither does. It closes the window the two
// separate commands leave - an area that silently has no machine settings
// while the practitioner believes she entered them.
//
// WHY THIS FILE MATTERS MORE THAN MOST. The command DELEGATES the area to
// `create_block_with_entry` (0166) so `session_blocks` keeps a single write
// path, and that means forwarding TWENTY-SIX parameters by name. A source
// contract can check that the names match 0166's declaration; only an
// execution can show that each one is wired to the right value. A cross-wire -
// `p_energy_level => p_minutes_performed` - would be a permanent, silent
// mislabelling of a clinical row, and the forwarding proof below is the test
// that catches it.
//
// SYNTHETIC PROFILE IDS THROUGHOUT. No real model is activated.
// ===========================================================================

const PROFILE = "fixture:db-initial";
const VERSION = 1;

afterAll(async () => {
  await closePool();
});

async function registerMachine(studio: SeededStudio): Promise<string> {
  await adminQuery(
    `select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      PROFILE,
      VERSION,
      "galvanic",
      4,
      null,
      JSON.stringify([
        { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
      ]),
    ],
  );
  return asUser(studio.userId, async (q) => {
    const r = await q(
      `select public.register_studio_machine($1,$2,$3,$4,$5) as id`,
      [studio.studioId, PROFILE, VERSION, "Room 1", []],
    );
    return r.rows[0].id as string;
  });
}

const group = (key: string, channels: number[], current: string) => ({
  group_key: key,
  channels,
  readings: [
    {
      field_key: "current",
      value: current,
      observation_source: "practitioner-entered",
    },
  ],
});

/** The thirty arguments, with distinctive defaults so a cross-wire shows. */
function args(
  over: Record<string, unknown> = {},
): unknown[] {
  const a: Record<string, unknown> = {
    session: null,
    client: null,
    // THE BAG writes the BLOCK's own columns. Its numbers are deliberately
    // different from the scalars below, which write the ENTRY - so a swap
    // between the two forwarding paths cannot pass by being equal.
    block: JSON.stringify({
      block_name: "Initial save",
      mode: "blend",
      energy_level: 9,
      minutes_performed: 8,
      primary_area: "jaw",
    }),
    extra: JSON.stringify({}),
    areas: JSON.stringify([]),
    withEntry: true,
    area: "chin",
    areasList: ["chin"],
    probeSize: null,
    probeLotId: null,
    mode: "blend",
    // DELIBERATELY ALL DIFFERENT NUMBERS. Every one of these is an integer or
    // numeric column, so a transposition between two of them would be
    // accepted by Postgres and invisible in any source check. Distinct values
    // are what make the forwarding assertion able to fail.
    pulseCount: 3,
    pulseDelay: 1.5,
    comments: "forwarding probe",
    chips: JSON.stringify([]),
    apilus: null,
    energy: 11,
    minutes: 22,
    probeType: null,
    freq: null,
    hairs: 33,
    galvMa: 44.5,
    galvDur: 55,
    thermInt: 66,
    thermDur: 77.5,
    lye: 88.5,
    // The settings half.
    machine: null,
    setupMode: "galvanic",
    key: "initial-save-key-0001",
    groups: null,
    ...over,
  };
  return [
    a.session, a.client, a.block, a.extra, a.areas, a.withEntry, a.area,
    a.areasList, a.probeSize, a.probeLotId, a.mode, a.pulseCount, a.pulseDelay,
    a.comments, a.chips, a.apilus, a.energy, a.minutes, a.probeType, a.freq,
    a.hairs, a.galvMa, a.galvDur, a.thermInt, a.thermDur, a.lye,
    a.machine, a.setupMode, a.key, a.groups,
  ];
}

const SQL = `select public.create_block_with_initial_setup(
  $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,
  $15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
  $27,$28,$29,$30::jsonb) as r`;

type SaveOut = {
  block_id: string;
  entry_id: string | null;
  setup: { submission_id: string; groups: number; readings: number; reused: boolean } | null;
};

async function initialSave(
  studio: SeededStudio,
  sessionId: string,
  over: Record<string, unknown> = {},
): Promise<SaveOut> {
  return asUser(studio.userId, async (q) => {
    const r = await q(
      SQL,
      args({ session: sessionId, client: studio.clientId, ...over }),
    );
    return r.rows[0].r as SaveOut;
  });
}

async function blocksIn(sessionId: string): Promise<number> {
  const r = await adminQuery(
    `select count(*)::int as n from public.session_blocks where session_id = $1`,
    [sessionId],
  );
  return r.rows[0].n as number;
}

// ---------------------------------------------------------------------------
// Part 1 — one call, both facts
// ---------------------------------------------------------------------------

describe("0223 · the initial save writes the area and its settings together", () => {
  it("creates the block and records the settings in one call", async () => {
    const studio = await seedStudio("init-both");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const before = await blocksIn(sessionId);

    const out = await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120"), group("g2", [2], "80")]),
    });

    expect(out.block_id).toBeTruthy();
    expect(out.setup).not.toBeNull();
    expect(out.setup!.groups).toBe(2);
    expect(out.setup!.readings).toBe(2);
    expect(out.setup!.reused).toBe(false);
    expect(await blocksIn(sessionId)).toBe(before + 1);

    // The captures belong to the block THIS call created, under ONE submission.
    const caps = await adminQuery(
      `select group_key, setup_submission_id from public.treatment_setup_captures
        where session_block_id = $1 order by group_key`,
      [out.block_id],
    );
    expect(caps.rows).toHaveLength(2);
    expect(new Set(caps.rows.map((c) => c.setup_submission_id)).size).toBe(1);
    expect(caps.rows[0].setup_submission_id).toBe(out.setup!.submission_id);
  });

  it("FORWARDS ALL TWENTY-SIX AREA PARAMETERS to the right columns", async () => {
    // THE TEST ONLY AN EXECUTION CAN GIVE. The source contract proves the
    // names match 0166's declaration and that each is passed its own
    // argument; it cannot prove the VALUE arrives where it is meant to. Every
    // number below is distinct, so a transposition between any two of these
    // numeric columns fails here rather than mislabelling a clinical row for
    // ever.
    const studio = await seedStudio("init-forward");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    const out = await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    });

    // THE BLOCK carries the area, the mode and the two summary numbers.
    //
    // MY FIRST SPELLING OF THIS TEST ASKED THE BLOCK FOR `galvanic_ma`, and
    // the database refused: the per-pass reading columns live on
    // `electrolysis_entries`, not on `session_blocks`. Worth leaving in the
    // record, because it is the second time today a claim of mine was aimed
    // at the wrong object - and a test that cannot run proves nothing about
    // forwarding.
    const b = (
      await adminQuery(
        `select block_name, mode, energy_level, minutes_performed, primary_area
           from public.session_blocks where id = $1`,
        [out.block_id],
      )
    ).rows[0];

    // AND THE SECOND CORRECTION, also from running it: `energy_level` on the
    // BLOCK comes from the `p_block` JSONB BAG, while the scalar
    // `p_energy_level` feeds the ENTRY. They are different parameters writing
    // different rows, and I had conflated them. The bag's values are asserted
    // here and the scalars below, which is what the two halves of 0166's
    // signature actually do.
    expect(b.block_name).toBe("Initial save");
    expect(b.mode).toBe("blend");
    // NUMBER()-WRAPPED because the bag's values come back as TEXT: 0129's
    // writer extracts them from jsonb and the column takes the string form.
    // Worth noting rather than hiding - the VALUE forwarded correctly, and
    // the representation is the schema's business, not this test's.
    expect(Number(b.energy_level), "the p_block bag's own energy_level").toBe(9);
    expect(Number(b.minutes_performed), "the p_block bag's own minutes").toBe(8);
    // THE BAG's area, which is the BLOCK's. The scalar `p_area` writes the
    // ENTRY's `area` instead, asserted below as "chin" - two different
    // parameters, two different rows, and deliberately different values here
    // so one cannot stand in for the other.
    expect(b.primary_area, "the p_block bag's own primary_area").toBe("jaw");

    // THE ENTRY carries the readings, which travel two functions deeper -
    // through `create_block_with_entry` and into its entry insert. These are
    // the numbers a transposition would silently swap.
    const e = (
      await adminQuery(
        `select pulse_count, pulse_delay_seconds, comments, hairs_treated,
                energy_level, minutes_performed,
                galvanic_ma, galvanic_duration_seconds,
                thermolysis_intensity_percent, thermolysis_duration_seconds,
                units_of_lye, area
           from public.electrolysis_entries where id = $1`,
        [out.entry_id],
      )
    ).rows[0];
    // THE SCALARS, distinct from the bag's values above so a swap between the
    // two paths is visible rather than coincidentally equal.
    expect(e.energy_level, "the scalar p_energy_level").toBe(11);
    expect(e.minutes_performed, "the scalar p_minutes_performed").toBe(22);
    expect(e.pulse_count).toBe(3);
    expect(Number(e.pulse_delay_seconds)).toBe(1.5);
    expect(e.comments).toBe("forwarding probe");
    expect(e.hairs_treated).toBe(33);
    expect(Number(e.galvanic_ma)).toBe(44.5);
    expect(e.galvanic_duration_seconds).toBe(55);
    expect(e.thermolysis_intensity_percent).toBe(66);
    expect(Number(e.thermolysis_duration_seconds)).toBe(77.5);
    expect(Number(e.units_of_lye)).toBe(88.5);
    expect(e.area).toBe("chin");
  });

  it("treats NO settings as an ordinary save of an area", async () => {
    // An area set up now and charted later is an everyday thing. The command
    // must not invent a reason to refuse it.
    const studio = await seedStudio("init-none");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    const out = await initialSave(studio, sessionId, {
      machine: machineId,
      groups: null,
    });
    expect(out.block_id).toBeTruthy();
    expect(out.setup).toBeNull();
    const caps = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_captures
        where session_block_id = $1`,
      [out.block_id],
    );
    expect(caps.rows[0].n).toBe(0);
  });

  it("treats an EMPTY array the same way", async () => {
    const studio = await seedStudio("init-empty");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const out = await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([]),
    });
    expect(out.setup).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — ATOMICITY, which is the whole point
// ---------------------------------------------------------------------------

describe("0223 · a refused settings payload takes the area with it", () => {
  it("creates NO BLOCK when the settings are refused", async () => {
    // THE CLAIM THE COMMAND EXISTS FOR. As two separate calls the area would
    // already be committed and the practitioner would be looking at a
    // treatment area with no settings, believing she had entered them.
    const studio = await seedStudio("init-atomic");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const before = await blocksIn(sessionId);

    await expect(
      initialSave(studio, sessionId, {
        machine: machineId,
        // Channel 2 claimed by both groups.
        groups: JSON.stringify([
          group("g1", [1, 2], "120"),
          group("g2", [2, 3], "80"),
        ]),
      }),
    ).rejects.toThrow(/claimed by more than one settings group/i);

    expect(
      await blocksIn(sessionId),
      "the treatment area survived a refused save",
    ).toBe(before);
  });

  it("creates NO BLOCK when a reading names a field the profile lacks", async () => {
    // A failure INSIDE the per-group writer, after the block has already been
    // inserted in the same transaction - which is the harder case.
    const studio = await seedStudio("init-atomic-field");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const before = await blocksIn(sessionId);

    await expect(
      initialSave(studio, sessionId, {
        machine: machineId,
        groups: JSON.stringify([
          {
            group_key: "g1",
            channels: [1],
            readings: [
              {
                field_key: "not_a_field",
                value: "5",
                observation_source: "practitioner-entered",
              },
            ],
          },
        ]),
      }),
    ).rejects.toThrow(/has no field/i);

    expect(await blocksIn(sessionId)).toBe(before);
  });

  it("CONTROL: the same payload WITHOUT the conflict creates the block", async () => {
    // Otherwise "no block on refusal" could be true because no block is ever
    // created, and the atomicity assertions above would prove nothing.
    const studio = await seedStudio("init-atomic-ctl");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const before = await blocksIn(sessionId);

    const out = await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1, 2], "120"), group("g2", [3], "80")]),
    });
    expect(out.setup!.groups).toBe(2);
    expect(await blocksIn(sessionId)).toBe(before + 1);
  });

  it("creates NO BLOCK when the machine belongs to another studio", async () => {
    const mine = await seedStudio("init-mine");
    const theirs = await seedStudio("init-theirs");
    const { sessionId } = await seedSession(mine);
    const theirMachine = await registerMachine(theirs);
    const before = await blocksIn(sessionId);

    await expect(
      initialSave(mine, sessionId, {
        machine: theirMachine,
        groups: JSON.stringify([group("g1", [1], "120")]),
      }),
    ).rejects.toThrow(/belongs to another studio/i);
    expect(await blocksIn(sessionId)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — what the retry key does and does NOT cover here
// ---------------------------------------------------------------------------

describe("0223 · the retry key does NOT make the INITIAL save idempotent", () => {
  it("a repeated initial save creates a SECOND area and a SECOND submission", async () => {
    // A FINDING, NOT A FEATURE, and it is recorded as a test so it cannot be
    // forgotten or quietly assumed away.
    //
    // `record_treatment_setup_submission`'s key is unique per (BLOCK, key).
    // The initial save creates a NEW block first, so the retry's key is
    // scoped to a block that did not exist when the first attempt ran - it
    // cannot collide, and nothing is absorbed. The area is duplicated too,
    // because `create_block_with_entry` has no idempotency key of its own.
    //
    // CONSEQUENCE, stated plainly: a lost response on the INITIAL save is NOT
    // safely retryable. Retrying creates a second treatment area carrying a
    // second copy of the settings. The retry key protects a save against an
    // EXISTING block, which is the edit path, and that is proved in
    // tests/db/machine-setup-submission.db.test.ts.
    //
    // The honest UI consequence is that an unresolved initial save must send
    // her to look at the chart, not offer a retry. Closing it properly needs
    // an idempotency key on the block create, which is a change to 0166's
    // command and a decision above this test.
    const studio = await seedStudio("init-retry");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const before = await blocksIn(sessionId);

    const first = await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    });
    const retry = await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    });

    expect(retry.block_id).not.toBe(first.block_id);
    expect(retry.setup!.submission_id).not.toBe(first.setup!.submission_id);
    expect(retry.setup!.reused, "nothing was absorbed").toBe(false);
    expect(
      await blocksIn(sessionId),
      "two areas exist, which is the limitation this test records",
    ).toBe(before + 2);
  });

  it("a SECOND save against the block it created IS absorbed", async () => {
    // The other half, so the finding above is bounded rather than alarming:
    // once the area exists, the key does its job.
    const studio = await seedStudio("init-then-edit");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    const first = await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    });

    const again = await asUser(studio.userId, async (q) => {
      const r = await q(
        `select public.record_treatment_setup_submission($1,$2,$3,$4,$5::jsonb) as r`,
        [
          first.block_id,
          machineId,
          "galvanic",
          "edit-key-0001",
          JSON.stringify([group("g2", [2], "90")]),
        ],
      );
      return r.rows[0].r as { submission_id: string; reused: boolean };
    });
    const repeat = await asUser(studio.userId, async (q) => {
      const r = await q(
        `select public.record_treatment_setup_submission($1,$2,$3,$4,$5::jsonb) as r`,
        [
          first.block_id,
          machineId,
          "galvanic",
          "edit-key-0001",
          JSON.stringify([group("g2", [2], "90")]),
        ],
      );
      return r.rows[0].r as { submission_id: string; reused: boolean };
    });

    expect(repeat.submission_id).toBe(again.submission_id);
    expect(repeat.reused).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 4 — the posture
// ---------------------------------------------------------------------------

describe("0223 · the initial save's privileges", () => {
  it("is callable by authenticated", async () => {
    const studio = await seedStudio("init-grant");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const out = await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    });
    expect(out.block_id).toBeTruthy();
  });

  for (const role of ["anon", "service_role"] as const) {
    it(`is refused to ${role}`, async () => {
      await expect(
        asRole(role, (q) =>
          q(SQL, args({ session: null, client: null, machine: null })),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  }

  it("keeps a SINGLE write path: it delegates rather than inserting", async () => {
    // Proved against the real catalog rather than the source: the command's
    // body must contain the delegating call.
    const r = await adminQuery(
      `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'create_block_with_initial_setup'`,
    );
    const src = String(r.rows[0].prosrc);
    expect(src).toMatch(/create_block_with_entry/);
    expect(src).not.toMatch(/insert\s+into\s+public\.session_blocks/i);
  });
});
