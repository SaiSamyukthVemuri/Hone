import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  resolveLocalDbUrl,
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

/**
 * A SECOND POOL, for the ONE test that needs two connections at once.
 *
 * `asUser` opens its own transaction and commits at the end, which is right
 * for everything else and useless for a concurrency proof: a lock held inside
 * it is released before the next statement in the test runs. The concurrent
 * retry below drives raw clients so one transaction can be held OPEN while
 * another runs.
 */
const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 4 });

afterAll(async () => {
  await pool.end();
  await closePool();
});

/** A raw client, in a transaction, acting as one signed-in practitioner. */
async function beginAsUser(userId: string): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  // A BOUND, so a bug here fails the test instead of hanging the suite.
  // lock_timeout covers advisory lock waits as well as row locks.
  await c.query("set local lock_timeout = '8s'");
  return c;
}

/** Wait until `pid` is actually BLOCKED on a lock, or give up. */
async function waitUntilBlocked(pid: number): Promise<boolean> {
  // POLLED ON THE SERVER'S OWN VIEW, not slept. A fixed sleep is the classic
  // way a concurrency test passes without the race it claims to exercise ever
  // having happened.
  for (let i = 0; i < 200; i += 1) {
    const r = await adminQuery(
      `select count(*)::int as n from pg_stat_activity
        where pid = $1 and wait_event_type = 'Lock'`,
      [pid],
    );
    if ((r.rows[0].n as number) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

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
  /** Whether the AREA was created by this call, or answered from a claim. */
  reused: boolean;
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

/** The create claims of one session - the receipts, in order. */
async function claimsIn(sessionId: string) {
  const r = await adminQuery(
    `select idempotency_key, payload_digest, block_id, entry_id, submission_id
       from public.treatment_area_create_claims
      where session_id = $1
      order by claimed_at`,
    [sessionId],
  );
  return r.rows as Array<{
    idempotency_key: string;
    payload_digest: string;
    block_id: string;
    entry_id: string | null;
    submission_id: string | null;
  }>;
}

/**
 * Everything one session could have accumulated, for the no-writes claims.
 *
 * SCOPED TO THE SESSION rather than to the block, deliberately: a refused
 * retry that created a SECOND area would be invisible to any count scoped to
 * the first one.
 */
async function sessionTotals(sessionId: string) {
  const r = await adminQuery(
    `select
       (select count(*)::int from public.session_blocks
         where session_id = $1) as blocks,
       -- electrolysis_entries carries its own session_id, and its block
       -- column is block_id rather than session_block_id - the clinical
       -- tables below use the longer name and this one does not.
       (select count(*)::int from public.electrolysis_entries e
         where e.session_id = $1) as entries,
       (select count(*)::int from public.treatment_setup_submissions s
         join public.session_blocks b on b.id = s.session_block_id
        where b.session_id = $1) as submissions,
       (select count(*)::int from public.treatment_setup_captures c
         join public.session_blocks b on b.id = c.session_block_id
        where b.session_id = $1) as captures,
       (select count(*)::int from public.treatment_setup_readings g
         join public.session_blocks b on b.id = g.session_block_id
        where b.session_id = $1) as readings,
       (select count(*)::int from public.treatment_area_create_claims cl
         where cl.session_id = $1) as claims`,
    [sessionId],
  );
  return r.rows[0] as {
    blocks: number;
    entries: number;
    submissions: number;
    captures: number;
    readings: number;
    claims: number;
  };
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

describe("0223 · the initial save IS idempotent per (session, retry key)", () => {
  // THIS BLOCK ASSERTED THE OPPOSITE, and that measurement is why the claim
  // table exists. It read: "a repeated initial save creates a SECOND area and
  // a SECOND submission", and it was correct - `record_treatment_setup_
  // submission`'s key is unique per (BLOCK, key), the initial save creates the
  // block first, so the retry's key was scoped to a row that did not exist on
  // the first attempt. Nothing could collide and nothing was absorbed.
  //
  // IT ALSO PREDICTED THE WRONG FIX: "closing it properly needs an idempotency
  // key on the block create, which is a change to 0166's command". It does not.
  // A key needs an anchor that PRE-EXISTS what it protects, and the SESSION is
  // one - so the claim is unique per (session, key), 0166 is untouched, and the
  // UI can offer a retry instead of sending her to look at the chart.
  //
  // The old expectations are not deleted so much as inverted: every one of
  // them has a successor below asserting the opposite outcome.

  it("a repeated initial save is ABSORBED: one area, one submission", async () => {
    const studio = await seedStudio("init-retry");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const before = await blocksIn(sessionId);
    const payload = {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    };

    const first = await initialSave(studio, sessionId, payload);
    const retry = await initialSave(studio, sessionId, payload);

    // THE ORIGINAL IDS, so the caller can carry on rather than being told to
    // go and look at the chart.
    expect(retry.block_id, "the retry created a second area").toBe(first.block_id);
    expect(retry.entry_id).toBe(first.entry_id);
    expect(retry.setup!.submission_id).toBe(first.setup!.submission_id);
    // AND IT SAYS SO, on both levels: the area was not created by this call,
    // and neither was the submission.
    expect(first.reused, "the FIRST call cannot be a reuse").toBe(false);
    expect(retry.reused, "an absorbed retry must say so").toBe(true);
    expect(retry.setup!.reused).toBe(true);

    expect(await blocksIn(sessionId), "exactly one area exists").toBe(before + 1);
    const totals = await sessionTotals(sessionId);
    expect(totals.submissions, "one save, one submission").toBe(1);
    expect(totals.captures, "one group, one capture").toBe(1);
    expect(totals.readings).toBe(1);
    expect(totals.claims, "one key, one receipt").toBe(1);
  });

  it("the absorbed retry reports what is STORED, in a fresh save's shape", async () => {
    // A caller builds her confirmation from these numbers. Returning zeros, or
    // a different shape, would make an absorbed retry indistinguishable from a
    // save that recorded nothing.
    const studio = await seedStudio("init-retry-shape");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const payload = {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120"), group("g2", [2], "80")]),
    };

    const first = await initialSave(studio, sessionId, payload);
    const retry = await initialSave(studio, sessionId, payload);

    expect(first.setup!.groups).toBe(2);
    expect(first.setup!.readings).toBe(2);
    expect(retry.setup!.groups, "the retry under-reported the groups").toBe(2);
    expect(retry.setup!.readings).toBe(2);
    expect(Object.keys(retry.setup!).sort()).toEqual(
      Object.keys(first.setup!).sort(),
    );
  });

  it("the claim NAMES what the key produced", async () => {
    // A receipt that could not name its block would prove a repeat had
    // happened and still leave the caller unable to continue.
    const studio = await seedStudio("init-claim-row");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    const out = await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    });

    const claims = await claimsIn(sessionId);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.block_id).toBe(out.block_id);
    expect(claims[0]!.entry_id).toBe(out.entry_id);
    expect(claims[0]!.submission_id).toBe(out.setup!.submission_id);
    expect(claims[0]!.payload_digest).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses the same key with a DIFFERENT AREA, and writes nothing", async () => {
    // The digest covers the WHOLE payload, not only the settings: answering
    // this with the first save's ids would report a creation that never
    // happened, and the area she just typed would be silently discarded.
    const studio = await seedStudio("init-key-area");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    });
    const before = await sessionTotals(sessionId);

    await expect(
      initialSave(studio, sessionId, {
        machine: machineId,
        area: "lip",
        areasList: ["lip"],
        groups: JSON.stringify([group("g1", [1], "120")]),
      }),
    ).rejects.toThrow(/already used to create a different treatment area/i);

    // NO WRITES AT ALL, in any of the six places a save touches - and scoped
    // to the SESSION, because a refused retry that created a second area would
    // be invisible to any count scoped to the first one.
    expect(await sessionTotals(sessionId)).toEqual(before);
  });

  it("refuses the same key with DIFFERENT SETTINGS, and writes nothing", async () => {
    const studio = await seedStudio("init-key-settings");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    });
    const before = await sessionTotals(sessionId);

    await expect(
      initialSave(studio, sessionId, {
        machine: machineId,
        groups: JSON.stringify([group("g1", [1], "150")]),
      }),
    ).rejects.toThrow(/already used to create a different treatment area/i);
    expect(await sessionTotals(sessionId)).toEqual(before);
  });

  it("refuses the same key with a DIFFERENT CHARTING SCALAR too", async () => {
    // Every parameter the save records is bound, not just the obvious ones. A
    // changed minutes count is the same clinical act with a different fact in
    // it, and absorbing it would discard the correction.
    const studio = await seedStudio("init-key-scalar");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await initialSave(studio, sessionId, { machine: machineId });
    const before = await sessionTotals(sessionId);

    await expect(
      initialSave(studio, sessionId, { machine: machineId, minutes: 23 }),
    ).rejects.toThrow(/already used to create a different treatment area/i);
    expect(await sessionTotals(sessionId)).toEqual(before);
  });

  it("treats 120 and 120.0 as the SAME save", async () => {
    // They are the same number. A refusal over a scale difference would be a
    // definite refusal of a legitimate repeat, which is worse than the laxity
    // it avoids - hence trim_scale on every numeric in the digest.
    const studio = await seedStudio("init-key-scale");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    const first = await initialSave(studio, sessionId, {
      machine: machineId,
      lye: 88.5,
    });
    const retry = await initialSave(studio, sessionId, {
      machine: machineId,
      lye: "88.50",
    });
    expect(retry.block_id, "a trailing zero was read as a different save").toBe(
      first.block_id,
    );
    expect(retry.reused).toBe(true);
  });

  it("CONTROL: a DIFFERENT key creates a second area, deliberately", async () => {
    // Idempotence must not become an inability to chart two areas in one
    // session. A new key is a new save, which is what pressing Save a second
    // time on a second area IS.
    const studio = await seedStudio("init-second-area");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const before = await blocksIn(sessionId);

    const first = await initialSave(studio, sessionId, {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    });
    const second = await initialSave(studio, sessionId, {
      machine: machineId,
      key: "initial-save-key-0002",
      area: "lip",
      areasList: ["lip"],
      groups: JSON.stringify([group("g1", [1], "90")]),
    });

    expect(second.block_id).not.toBe(first.block_id);
    expect(second.reused).toBe(false);
    expect(await blocksIn(sessionId)).toBe(before + 2);
    expect(await claimsIn(sessionId)).toHaveLength(2);
  });

  it("CONTROL: with NO SETTINGS the claim still absorbs, and setup stays null", async () => {
    // An area saved with no machine settings is an ordinary save. The receipt
    // records that it had none, and a retry must not acquire some.
    const studio = await seedStudio("init-no-setup");
    const { sessionId } = await seedSession(studio);
    const before = await blocksIn(sessionId);

    const first = await initialSave(studio, sessionId, {});
    const retry = await initialSave(studio, sessionId, {});

    expect(first.setup, "nothing was entered").toBeNull();
    expect(retry.setup, "a retry must not invent settings").toBeNull();
    expect(retry.block_id).toBe(first.block_id);
    expect(retry.reused).toBe(true);
    expect(await blocksIn(sessionId)).toBe(before + 1);
    const claims = await claimsIn(sessionId);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.submission_id, "a save with no settings has no submission")
      .toBeNull();
  });

  it("CONTROL: with NO KEY nothing is claimed and the old behaviour stands", async () => {
    // DELIBERATELY PRESERVED, not an oversight. Idempotence requires a caller
    // that mints one key per save and REUSES it on a retry; a caller that
    // supplies none cannot be given it, and inventing a key here - hashing the
    // payload, say - would make two genuinely separate saves of identical
    // settings collapse into one.
    const studio = await seedStudio("init-no-key");
    const { sessionId } = await seedSession(studio);
    const before = await blocksIn(sessionId);

    const first = await initialSave(studio, sessionId, { key: null });
    const again = await initialSave(studio, sessionId, { key: null });

    expect(again.block_id).not.toBe(first.block_id);
    expect(again.reused).toBe(false);
    expect(await blocksIn(sessionId), "two areas, as before the claim").toBe(
      before + 2,
    );
    expect(await claimsIn(sessionId), "no key, no receipt").toHaveLength(0);
  });

  it("refuses a key too short to be unique, before touching anything", async () => {
    const studio = await seedStudio("init-key-short");
    const { sessionId } = await seedSession(studio);
    const before = await sessionTotals(sessionId);

    await expect(
      initialSave(studio, sessionId, { key: "short" }),
    ).rejects.toThrow(/at least 8 characters/i);
    expect(await sessionTotals(sessionId)).toEqual(before);
  });

  it("scopes the key to its SESSION, so two visits never collide", async () => {
    // The same client's next visit is a different session, and a key is only
    // ever reused within the save that minted it. A key accidentally shared
    // across sessions must not make the second visit answer with the first
    // visit's area.
    const studio = await seedStudio("init-key-session");
    const a = await seedSession(studio);
    const b = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const payload = {
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    };

    const first = await initialSave(studio, a.sessionId, payload);
    const other = await initialSave(studio, b.sessionId, payload);

    expect(other.block_id).not.toBe(first.block_id);
    expect(other.reused).toBe(false);
    expect(await claimsIn(a.sessionId)).toHaveLength(1);
    expect(await claimsIn(b.sessionId)).toHaveLength(1);
  });

  it("CONCURRENT retries: the second WAITS, then is absorbed", async () => {
    // THE RACE, which is what a lost response actually looks like: the browser
    // retries while the first attempt is still in flight. Without the advisory
    // lock both calls find no claim, BOTH create a treatment area, and the
    // second then dies on the unique constraint - after the duplicate area was
    // written and rolled back, reported to her as a failure.
    //
    // SEQUENCED SO IT CANNOT SELF-DEADLOCK: A runs to completion and keeps its
    // transaction open, B is launched and PROVED to be waiting, then A is
    // committed and B allowed to finish.
    const studio = await seedStudio("init-concurrent");
    const { sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const params = args({
      session: sessionId,
      client: studio.clientId,
      machine: machineId,
      groups: JSON.stringify([group("g1", [1], "120")]),
    });
    // OBSERVED, NOT ASSUMED, and the first run of this test is why: it
    // hard-coded `toBe(1)` and found TWO blocks, with the absorb assertions
    // above passing. `seedSession` inserts a session_blocks row of its own, so
    // the session starts with one - the delta is the claim, and the total never
    // was. Every other case in this file was already written as a delta; this
    // one was the exception and the run caught it.
    const before = await blocksIn(sessionId);

    const a = await beginAsUser(studio.userId);
    const b = await beginAsUser(studio.userId);
    try {
      const first = (await a.query(SQL, params)).rows[0].r as SaveOut;
      expect(first.reused).toBe(false);

      const bPid = (await b.query("select pg_backend_pid() as pid")).rows[0]
        .pid as number;
      const runB = b.query(SQL, params);

      // IT MUST BLOCK. If B sailed through, the two calls were never
      // concurrent and everything below would hold for two sequential saves -
      // the vacuity guard for this whole test.
      expect(
        await waitUntilBlocked(bPid),
        "the retry never waited, so the two calls were never concurrent",
      ).toBe(true);

      await a.query("commit");
      const [rb] = await Promise.allSettled([runB]);
      await b.query("commit").catch(() => undefined);

      if (rb.status === "rejected") {
        const message = String(rb.reason);
        // NAMED SEPARATELY, because each means something different: a 23505 is
        // the defect the lock prevents, a deadlock is a lock-ordering bug, a
        // timeout means B waited past the bound instead of being absorbed.
        expect(message, "the concurrent retry hit the unique constraint").not.toMatch(
          /duplicate key|create_claims_key_uniq|23505/i,
        );
        expect(message, "the concurrent retry DEADLOCKED").not.toMatch(/deadlock/i);
        expect(message, "the concurrent retry timed out").not.toMatch(
          /lock timeout|canceling statement/i,
        );
        throw new Error(`the concurrent retry failed unexpectedly: ${message}`);
      }

      const second = rb.value.rows[0].r as SaveOut;
      expect(second.block_id, "two areas were created").toBe(first.block_id);
      expect(second.reused).toBe(true);
      expect(
        await blocksIn(sessionId),
        "the concurrent retry created a second area",
      ).toBe(before + 1);
      expect(await claimsIn(sessionId)).toHaveLength(1);
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }
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
