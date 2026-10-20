import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  RECORD_GROUP_SQL,
  asUser,
  closePool,
  seedMember,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// 0223 — machine inventory, the remembered selection, and setup readings.
//
// WHAT THIS FILE IS FOR. A source-contract test cannot see inside a plpgsql
// body, and a clean apply proves only that the SQL parsed. Every command added
// by 0223 is therefore CALLED here against a real database: that is the lesson
// 0204 taught, where a command wrote to a column that did not exist, applied
// clean, passed its source test, and had never once succeeded.
//
// SYNTHETIC PROFILE IDS THROUGHOUT. The curated catalogue offers zero profiles
// because no exact model's evidence is complete, and 0223 deliberately does not
// constrain `machine_profile_id` to a known set - activation is a reviewed
// evidence decision, not applied SQL. So these fixtures use obviously
// synthetic ids. Nothing here activates a real model or implies one is ready.
// ===========================================================================

const PROFILE = "fixture:db-multineedle";
const VERSION = 2;

afterAll(async () => {
  await closePool();
});

/** Register one synthetic machine as the studio's owner. */
/**
 * Publish a contract as DEPLOYMENT AUTHORITY (adminQuery = postgres), not as a
 * practitioner: EXECUTE is revoked from `authenticated` because the contract is
 * a global product fact. Idempotent for identical content.
 */
async function publishContract(
  profile: string,
  version: number,
  opts: { channelsMax?: number | null; requiresOption?: string | null } = {},
): Promise<void> {
  await adminQuery(
    `select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      profile,
      version,
      "galvanic",
      // The fixture profile offers four channels; tests that record a
      // per-probe group name one, and the contract has to permit it.
      opts.channelsMax === undefined ? 4 : opts.channelsMax,
      opts.requiresOption ?? null,
      // Every field these tests legitimately record. "invented" is
      // DELIBERATELY absent - the unknown-field refusal test needs it to be.
      JSON.stringify([
        { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true },
        { field_key: "duration", native_unit: "s", decimals: 1, quantity: "duration", optional: true },
        { field_key: "repeat", native_unit: "count", decimals: 0, quantity: "count", optional: true },
        { field_key: "nothing", native_unit: "µA", decimals: 0, quantity: "current", optional: true },
      ]),
    ],
  );
}

async function registerMachine(
  studio: SeededStudio,
  displayName: string,
  opts: { profile?: string; version?: number; options?: string[] } = {},
): Promise<string> {
  await publishContract(opts.profile ?? PROFILE, opts.version ?? VERSION);
  return asUser(studio.userId, async (q) => {
    const r = await q(
      `select public.register_studio_machine($1, $2, $3, $4, $5) as id`,
      [
        studio.studioId,
        opts.profile ?? PROFILE,
        opts.version ?? VERSION,
        displayName,
        opts.options ?? [],
      ],
    );
    return r.rows[0].id as string;
  });
}

const READINGS = [
  {
    field_key: "current",
    value: "120",
    native_unit: "µA",
    decimals: 0,
    observation_source: "practitioner-entered",
  },
  {
    field_key: "duration",
    value: "300.5",
    native_unit: "s",
    decimals: 1,
    observation_source: "practitioner-entered",
  },
];

// ---------------------------------------------------------------------------
// Part 1 — inventory ownership
// ---------------------------------------------------------------------------

describe("0223 · the studio's machine inventory is owner-written", () => {
  it("an owner registers a machine and every member can read it", async () => {
    const studio = await seedStudio("mpx-own");
    const member = await seedMember(studio, "mpx-member");
    const id = await registerMachine(studio, "Room 1");
    expect(id).toBeTruthy();

    // A plain practitioner reads it through RLS.
    const seen = await asUser(member.userId, (q) =>
      q(`select display_name, machine_profile_version from public.studio_machines where id = $1`, [
        id,
      ]),
    );
    expect(seen.rows).toHaveLength(1);
    expect(seen.rows[0].display_name).toBe("Room 1");
    expect(seen.rows[0].machine_profile_version).toBe(VERSION);
  });

  it("a NON-OWNER member cannot register one", async () => {
    const studio = await seedStudio("mpx-nonowner");
    const member = await seedMember(studio, "mpx-plain");
    await expect(
      asUser(member.userId, (q) =>
        q(`select public.register_studio_machine($1, $2, $3, $4, $5)`, [
          studio.studioId,
          PROFILE,
          VERSION,
          "Smuggled",
          [],
        ]),
      ),
    ).rejects.toThrow(/only the studio owner/i);
  });

  it("an owner of ANOTHER studio cannot register into this one", async () => {
    // The studio id is a filter, never an authorization claim.
    const mine = await seedStudio("mpx-mine");
    const theirs = await seedStudio("mpx-theirs");
    await expect(
      asUser(theirs.userId, (q) =>
        q(`select public.register_studio_machine($1, $2, $3, $4, $5)`, [
          mine.studioId,
          PROFILE,
          VERSION,
          "Cross studio",
          [],
        ]),
      ),
    ).rejects.toThrow(/only the studio owner/i);
  });

  it("direct INSERT is refused for an authenticated member", async () => {
    // The commands are the only write path; table DML is revoked.
    const studio = await seedStudio("mpx-direct");
    await expect(
      asUser(studio.userId, (q) =>
        q(
          `insert into public.studio_machines
             (studio_id, machine_profile_id, machine_profile_version, display_name)
           values ($1, $2, $3, 'Forged')`,
          [studio.studioId, PROFILE, VERSION],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("a member of another studio cannot SEE this studio's machines", async () => {
    const mine = await seedStudio("mpx-vis-a");
    const other = await seedStudio("mpx-vis-b");
    const id = await registerMachine(mine, "Private room");
    const seen = await asUser(other.userId, (q) =>
      q(`select id from public.studio_machines where id = $1`, [id]),
    );
    expect(seen.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the remembered selection
// ---------------------------------------------------------------------------

describe("0223 · the remembered machine is per practitioner per studio", () => {
  it("PERSISTS to the database and survives a fresh connection (reload)", async () => {
    const studio = await seedStudio("mpx-remember");
    const id = await registerMachine(studio, "Room 1");

    await asUser(studio.userId, (q) =>
      q(`select public.set_own_default_machine($1, $2, $3)`, [
        studio.studioId,
        id,
        "galvanic",
      ]),
    );

    // A SEPARATE connection and transaction - this is the reload proof. The
    // value came out of Postgres, not out of a test double.
    const reloaded = await asUser(studio.userId, (q) =>
      q(
        `select default_machine_id, default_machine_mode
           from public.practitioners where id = $1`,
        [studio.practitionerId],
      ),
    );
    expect(reloaded.rows[0].default_machine_id).toBe(id);
    expect(reloaded.rows[0].default_machine_mode).toBe("galvanic");
  });

  it("ISOLATES two practitioners in one studio", async () => {
    const studio = await seedStudio("mpx-iso-one");
    const member = await seedMember(studio, "mpx-iso-member");
    const a = await registerMachine(studio, "Room A");
    const b = await registerMachine(studio, "Room B");

    await asUser(studio.userId, (q) =>
      q(`select public.set_own_default_machine($1, $2, $3)`, [studio.studioId, a, "m1"]),
    );
    await asUser(member.userId, (q) =>
      q(`select public.set_own_default_machine($1, $2, $3)`, [studio.studioId, b, "m2"]),
    );

    const rows = await adminQuery(
      `select id, default_machine_id from public.practitioners
        where id in ($1, $2)`,
      [studio.practitionerId, member.practitionerId],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.default_machine_id]));
    expect(byId.get(studio.practitionerId)).toBe(a);
    expect(byId.get(member.practitionerId)).toBe(b);
  });

  it("ISOLATES one person across two studios", async () => {
    // One auth user, two studios, two practitioner rows. The remembered
    // machine belongs to the (studio, practitioner) pair.
    const first = await seedStudio("mpx-two-a");
    const secondStudioId = (
      await adminQuery(
        `insert into public.studios (id, name, owner_email)
         values (gen_random_uuid(), 'Harness mpx-two-b', 'mpx-two-b@harness.local')
         returning id`,
      )
    ).rows[0].id as string;
    const secondPractId = (
      await adminQuery(
        `insert into public.practitioners
           (id, studio_id, user_id, display_name, email, role, active)
         values (gen_random_uuid(), $1, $2, 'Same person', 'mpx-two-b@harness.local', 'owner', true)
         returning id`,
        [secondStudioId, first.userId],
      )
    ).rows[0].id as string;

    const inFirst = await registerMachine(first, "First studio unit");
    const inSecond = await asUser(first.userId, async (q) => {
      const r = await q(`select public.register_studio_machine($1, $2, $3, $4, $5) as id`, [
        secondStudioId,
        PROFILE,
        VERSION,
        "Second studio unit",
        [],
      ]);
      return r.rows[0].id as string;
    });

    await asUser(first.userId, (q) =>
      q(`select public.set_own_default_machine($1, $2, $3)`, [
        first.studioId,
        inFirst,
        "m",
      ]),
    );
    await asUser(first.userId, (q) =>
      q(`select public.set_own_default_machine($1, $2, $3)`, [
        secondStudioId,
        inSecond,
        "m",
      ]),
    );

    const rows = await adminQuery(
      `select id, default_machine_id from public.practitioners where id in ($1, $2)`,
      [first.practitionerId, secondPractId],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.default_machine_id]));
    expect(byId.get(first.practitionerId)).toBe(inFirst);
    expect(byId.get(secondPractId)).toBe(inSecond);
  });

  it("REFUSES a machine from another studio", async () => {
    const mine = await seedStudio("mpx-xs-a");
    const theirs = await seedStudio("mpx-xs-b");
    const theirMachine = await registerMachine(theirs, "Their room");
    await expect(
      asUser(mine.userId, (q) =>
        q(`select public.set_own_default_machine($1, $2, $3)`, [
          mine.studioId,
          theirMachine,
          "m",
        ]),
      ),
    ).rejects.toThrow(/belongs to another studio/i);
  });

  it("returns NULL for a caller with no membership in that studio", async () => {
    const mine = await seedStudio("mpx-nomem-a");
    const theirs = await seedStudio("mpx-nomem-b");
    const r = await asUser(mine.userId, (q) =>
      q(`select public.set_own_default_machine($1, null, null) as pract`, [
        theirs.studioId,
      ]),
    );
    expect(r.rows[0].pract).toBeNull();
  });

  it("writes only the CALLER's own row, never another practitioner's", async () => {
    const studio = await seedStudio("mpx-ownrow");
    const member = await seedMember(studio, "mpx-ownrow-member");
    const id = await registerMachine(studio, "Room 1");
    await asUser(member.userId, (q) =>
      q(`select public.set_own_default_machine($1, $2, $3)`, [studio.studioId, id, "m"]),
    );
    // The owner's own row is untouched: the command accepts no practitioner id.
    const owner = await adminQuery(
      `select default_machine_id from public.practitioners where id = $1`,
      [studio.practitionerId],
    );
    expect(owner.rows[0].default_machine_id).toBeNull();
  });

  it("retiring a machine clears it from every practitioner default", async () => {
    const studio = await seedStudio("mpx-retire");
    const id = await registerMachine(studio, "Doomed room");
    await asUser(studio.userId, (q) =>
      q(`select public.set_own_default_machine($1, $2, $3)`, [studio.studioId, id, "m"]),
    );
    const retired = await asUser(studio.userId, (q) =>
      q(`select public.retire_studio_machine($1) as done`, [id]),
    );
    expect(retired.rows[0].done).toBe(true);

    const after = await adminQuery(
      `select default_machine_id from public.practitioners where id = $1`,
      [studio.practitionerId],
    );
    expect(after.rows[0].default_machine_id).toBeNull();

    // And it cannot be chosen again.
    await expect(
      asUser(studio.userId, (q) =>
        q(`select public.set_own_default_machine($1, $2, $3)`, [studio.studioId, id, "m"]),
      ),
    ).rejects.toThrow(/out of service/i);
  });

  it("a clearing write leaves the mode cleared too", async () => {
    const studio = await seedStudio("mpx-clear");
    const id = await registerMachine(studio, "Room 1");
    await asUser(studio.userId, (q) =>
      q(`select public.set_own_default_machine($1, $2, $3)`, [studio.studioId, id, "galvanic"]),
    );
    await asUser(studio.userId, (q) =>
      q(`select public.set_own_default_machine($1, null, 'ignored')`, [studio.studioId]),
    );
    const after = await adminQuery(
      `select default_machine_id, default_machine_mode
         from public.practitioners where id = $1`,
      [studio.practitionerId],
    );
    expect(after.rows[0].default_machine_id).toBeNull();
    expect(after.rows[0].default_machine_mode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 3 — readings
// ---------------------------------------------------------------------------

describe("0223 · native readings persist, and cannot be rewritten", () => {
  it("PERSISTS a group with native units and precision intact", async () => {
    const studio = await seedStudio("mpx-read");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");

    const wrote = await asUser(studio.userId, (q) =>
      q(
        RECORD_GROUP_SQL,
        [
          blockId,
          machineId,
          "galvanic",
          "g1",
          [1, 2],
          JSON.stringify(READINGS),
          sessionId,
          studio.clientId,
        ],
      ),
    );
    expect(wrote.rows[0].n).toBe(2);

    // Reload through RLS on a fresh connection.
    const back = await asUser(studio.userId, (q) =>
      q(
        `select field_key, value_numeric::text as v, native_unit, decimals,
                machine_profile_id, machine_profile_version, channels,
                observation_source, recorded_by_practitioner_id
           from public.treatment_setup_readings
          where session_block_id = $1
          order by field_key`,
        [blockId],
      ),
    );
    expect(back.rows.map((r) => r.field_key)).toEqual(["current", "duration"]);
    expect(back.rows[0].native_unit).toBe("µA");
    expect(back.rows[0].v).toBe("120");
    // Native precision survives the round trip: 300.5 is not truncated to 300.
    expect(back.rows[1].v).toBe("300.5");
    expect(back.rows[1].decimals).toBe(1);
    // The profile identity was copied from the unit at record time.
    expect(back.rows[0].machine_profile_id).toBe(PROFILE);
    expect(back.rows[0].machine_profile_version).toBe(VERSION);
    expect(back.rows[0].channels).toEqual([1, 2]);
    expect(back.rows[0].recorded_by_practitioner_id).toBe(studio.practitionerId);
  });

  it("keeps a recorded ZERO as a value, and an absence as a reason", async () => {
    const studio = await seedStudio("mpx-zero");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        blockId,
        machineId,
        "galvanic",
        "g1",
        [],
        JSON.stringify([
          {
            field_key: "repeat",
            value: "0",
            native_unit: "count",
            decimals: 0,
            observation_source: "practitioner-entered",
          },
          {
            field_key: "duration",
            absence_reason: "not-recorded",
            native_unit: "s",
            decimals: 0,
            observation_source: "practitioner-entered",
          },
        ]),
        sessionId,
        studio.clientId,
      ]),
    );
    const back = await adminQuery(
      `select field_key, value_numeric::text as v, absence_reason
         from public.treatment_setup_readings
        where session_block_id = $1 order by field_key`,
      [blockId],
    );
    const byField = new Map(back.rows.map((r) => [r.field_key, r]));
    // A zero is a VALUE, not an absence.
    expect(byField.get("repeat").v).toBe("0");
    expect(byField.get("repeat").absence_reason).toBeNull();
    // An absence carries its reason and no number.
    expect(byField.get("duration").v).toBeNull();
    expect(byField.get("duration").absence_reason).toBe("not-recorded");
  });

  it("refuses a row that is neither a value nor a reasoned absence", async () => {
    const studio = await seedStudio("mpx-xor");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");
    await expect(
      asUser(studio.userId, (q) =>
        q(RECORD_GROUP_SQL, [
          blockId,
          machineId,
          "galvanic",
          "g1",
          [],
          JSON.stringify([
            {
              field_key: "nothing",
              native_unit: "s",
              decimals: 0,
              observation_source: "practitioner-entered",
            },
          ]),
          sessionId,
          studio.clientId,
        ]),
      ),
      // The command now refuses this itself, with a sentence naming the
      // field, BEFORE the column's XOR constraint is reached. The constraint
      // is still there as a backstop; what changed is that a forged direct
      // call gets an explanation rather than a constraint name.
    ).rejects.toMatchObject({
      code: "23514",
      message: 'Field "nothing" needs exactly one number, text or reasoned absence.',
    });
  });

  it("preserves TWO settings groups when probes differ", async () => {
    const studio = await seedStudio("mpx-groups");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");
    for (const [group, channels, current] of [
      ["g1", [1, 2], "120"],
      ["g2", [3], "90"],
    ] as const) {
      await asUser(studio.userId, (q) =>
        q(RECORD_GROUP_SQL, [
          blockId,
          machineId,
          "galvanic",
          group,
          channels,
          JSON.stringify([
            {
              field_key: "current",
              value: current,
              native_unit: "µA",
              decimals: 0,
              observation_source: "practitioner-entered",
            },
          ]),
          sessionId,
          studio.clientId,
        ]),
      );
    }
    const back = await adminQuery(
      `select group_key, value_numeric::text as v, channels
         from public.treatment_setup_readings
        where session_block_id = $1 order by group_key`,
      [blockId],
    );
    expect(back.rows).toHaveLength(2);
    expect(back.rows[0].v).toBe("120");
    expect(back.rows[1].v).toBe("90");
    // Sixteen rows were never required: two groups, one reading each.
    expect(back.rows[0].channels).toEqual([1, 2]);
    expect(back.rows[1].channels).toEqual([3]);
  });

  it("IS IMMUTABLE — an update is refused even with admin rights", async () => {
    const studio = await seedStudio("mpx-immutable");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        blockId,
        machineId,
        "galvanic",
        "g1",
        [],
        JSON.stringify(READINGS),
        sessionId,
        studio.clientId,
      ]),
    );
    // Not an RLS refusal: the trigger protects the observation from EVERY
    // path, including a future application bug running as service_role.
    await expect(
      adminQuery(
        `update public.treatment_setup_readings set value_numeric = 999
          where session_block_id = $1`,
        [blockId],
      ),
    ).rejects.toThrow(/immutable/i);

    const unchanged = await adminQuery(
      `select value_numeric::text as v from public.treatment_setup_readings
        where session_block_id = $1 and field_key = 'current'`,
      [blockId],
    );
    expect(unchanged.rows[0].v).toBe("120");
  });

  it("APPENDS a revision when a setting changes, preserving the earlier one", async () => {
    // THIS ASSERTION IS INVERTED FROM ITS FIRST VERSION, deliberately.
    //
    // It used to assert that a second reading for the same field was REFUSED
    // with a duplicate-key error, which was faithful to the schema as written
    // but contradicted the table's own comment ("a material setup change is a
    // new reading rather than an edit") and meant a setting changed
    // mid-treatment could not be recorded at all. Codex raised it twice; the
    // operator approved append-only revisions. So the law is now: appending is
    // correct, and the earlier observation must survive.
    const studio = await seedStudio("mpx-rev");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");
    const record = (readings: unknown) =>
      asUser(studio.userId, (q) =>
        q(RECORD_GROUP_SQL, [
          blockId,
          machineId,
          "galvanic",
          "g1",
          [],
          JSON.stringify(readings),
          sessionId,
          studio.clientId,
        ]),
      );

    await record(READINGS);
    // The practitioner turns the current up mid-treatment.
    await record([
      {
        field_key: "current",
        value: "180",
        observation_source: "practitioner-entered",
      },
    ]);

    const rows = await adminQuery(
      `select field_key, value_numeric::text as v, revision
         from public.treatment_setup_readings
        where session_block_id = $1 and field_key = 'current'
        order by revision`,
      [blockId],
    );
    // BOTH observations, in order, neither overwritten.
    expect(rows.rows.map((r: { v: string; revision: number }) => [r.revision, r.v])).toEqual([
      [1, "120"],
      [2, "180"],
    ]);

    // And the untouched field did not gain a revision it never had.
    const duration = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_readings
        where session_block_id = $1 and field_key = 'duration'`,
      [blockId],
    );
    expect(duration.rows[0].n).toBe(1);
  });

  it("still refuses a DUPLICATE FIELD within one capture", async () => {
    // Rewritten for the capture model. The unique key moved from the field
    // coordinates plus a per-field revision to (capture_id, stage, field),
    // because allocating a revision per FIELD was what let one block's fields
    // sit at different revisions and a per-field "latest" assemble a composite
    // that was never a real setting.
    //
    // The revision is now allocated per CAPTURE by the command, so a caller
    // cannot aim a write at an existing one. This index is the backstop against
    // a future caller trying, so it is worth proving it still bites.
    const studio = await seedStudio("mpx-dupfield");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        blockId, machineId, "galvanic", "g1", [], JSON.stringify(READINGS),
        sessionId,
        studio.clientId,
      ]),
    );

    // Copy an existing reading back onto its OWN capture, same field.
    await expect(
      adminQuery(
        `insert into public.treatment_setup_readings
           (capture_id, studio_id, session_block_id, machine_profile_id,
            machine_profile_version, mode_key, group_key, field_key,
            value_numeric, native_unit, decimals, observation_source, revision,
            studio_machine_id)
         -- studio_machine_id is carried over too: it is NOT NULL, so
         -- omitting it refuses on the not-null constraint before the unique
         -- index under test is ever reached.
         select capture_id, studio_id, session_block_id, machine_profile_id,
                machine_profile_version, mode_key, group_key, field_key,
                999, native_unit, decimals, observation_source, revision,
                studio_machine_id
           from public.treatment_setup_readings
          where session_block_id = $1 and field_key = 'current'`,
        [blockId],
      ),
    ).rejects.toThrow(
      /treatment_setup_readings_capture_field_uniq|duplicate key/i,
    );
  });

  it("gives every field of ONE capture the SAME capture and revision", async () => {
    // The coherence property the capture model exists for: a call records one
    // atomic capture, so its fields cannot drift apart.
    const studio = await seedStudio("mpx-coherent");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        blockId, machineId, "galvanic", "g1", [], JSON.stringify(READINGS),
        sessionId,
        studio.clientId,
      ]),
    );
    const rows = await adminQuery(
      `select distinct capture_id, revision from public.treatment_setup_readings
        where session_block_id = $1`,
      [blockId],
    );
    expect(
      rows.rows.length,
      "one capture must yield exactly one (capture_id, revision) pair",
    ).toBe(1);
    expect(rows.rows[0].revision).toBe(1);

    // A SECOND call is a second capture, with its own identity.
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        blockId, machineId, "galvanic", "g1", [],
        JSON.stringify([
          {
            field_key: "current",
            value: "180",
            observation_source: "practitioner-entered",
          },
        ]),
        sessionId,
        studio.clientId,
      ]),
    );
    const captures = await adminQuery(
      `select revision, (select count(*)::int from public.treatment_setup_readings r
                          where r.capture_id = c.id) as fields
         from public.treatment_setup_captures c
        where c.session_block_id = $1 order by revision`,
      [blockId],
    );
    expect(
      captures.rows.map((r: { revision: number; fields: number }) => [
        r.revision,
        r.fields,
      ]),
    ).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  it("FAILS CLOSED when no field contract is published for the version", async () => {
    // The whole point of putting the contract in the database: an
    // authenticated member calling the command directly cannot record against
    // a profile version nobody has published a contract for.
    const studio = await seedStudio("mpx-nocontract");
    const { blockId, sessionId } = await seedSession(studio);

    // TWO LAYERS NOW, and this test is about the SECOND one.
    //
    // Registration itself refuses an unpublished version since the review
    // finding about consume-only authority, so a machine can no longer BE
    // registered against one directly - that refusal is proved in
    // machine-contract-authority.db.test.ts. To still exercise the RECORDING
    // guard, register legitimately and then repoint the unit at a version
    // nobody published, which is the state a stale row or a later contract
    // change could produce.
    const machineId = await registerMachine(studio, "Repointed");
    await adminQuery(
      `update public.studio_machines set machine_profile_version = 97 where id = $1`,
      [machineId],
    );

    await expect(
      asUser(studio.userId, (q) =>
        q(RECORD_GROUP_SQL, [
          blockId, machineId, "galvanic", "g1", [], JSON.stringify(READINGS),
          sessionId,
          studio.clientId,
        ]),
      ),
    ).rejects.toThrow(/No field contract is published/i);
  });

  it("DERIVES the unit and precision, ignoring what the caller claims", async () => {
    // The P1 this closes: the caller's metadata was cast straight into an
    // immutable clinical row. Now the contract decides.
    const studio = await seedStudio("mpx-derive");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        blockId, machineId, "galvanic", "g1", [],
        JSON.stringify([
          {
            field_key: "current",
            value: "80",
            // Both of these are LIES and both must be discarded.
            native_unit: "MILLIAMPS",
            decimals: 6,
            observation_source: "practitioner-entered",
          },
        ]),
        sessionId,
        studio.clientId,
      ]),
    );
    const row = await adminQuery(
      `select native_unit, decimals from public.treatment_setup_readings
        where session_block_id = $1 and field_key = 'current'`,
      [blockId],
    );
    expect(row.rows[0].native_unit).toBe("µA");
    expect(row.rows[0].decimals).toBe(0);
  });

  it("refuses a field the published contract does not contain", async () => {
    const studio = await seedStudio("mpx-unknownfield");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");
    await expect(
      asUser(studio.userId, (q) =>
        q(RECORD_GROUP_SQL, [
          blockId, machineId, "galvanic", "g1", [],
          JSON.stringify([
            { field_key: "invented", value: "1", observation_source: "practitioner-entered" },
          ]),
          sessionId,
          studio.clientId,
        ]),
      ),
    ).rejects.toThrow(/has no field "invented"/i);
  });

  it("NEITHER a practitioner NOR an owner may publish a contract", async () => {
    // THIS TEST'S LAW CHANGED. It used to assert that a practitioner was
    // refused and an owner allowed. That WAS the defect: the contract is a
    // GLOBAL product fact, so letting any studio owner publish it meant one
    // tenant's owner could change the units and precision every other tenant
    // records against, and rewrite the meaning of a version under which
    // readings had already been captured.
    //
    // Publication is now deployment authority: EXECUTE is granted to
    // service_role and revoked from `authenticated`. So BOTH roles are
    // refused, and the owner case is the one that matters.
    const studio = await seedStudio("mpx-contract-acl");
    const member = await seedMember(studio, "practitioner");
    const publish = (userId: string) =>
      asUser(userId, (q) =>
        q(`select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`, [
          PROFILE, 4242, "galvanic", 4, null,
          JSON.stringify([
            { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true },
          ]),
        ]),
      );
    await expect(publish(member.userId)).rejects.toThrow(/permission denied/i);
    await expect(
      publish(studio.userId),
      "a studio OWNER must not be able to author a global contract",
    ).rejects.toThrow(/permission denied/i);

    // And nothing was published by either attempt.
    const rows = await adminQuery(
      `select count(*)::int as n from public.machine_profile_mode_contract
        where machine_profile_version = 4242`,
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

describe("0223 · cross-studio refusal on the reading path", () => {
  it("refuses a block belonging to another studio", async () => {
    const mine = await seedStudio("mpx-blk-a");
    const theirs = await seedStudio("mpx-blk-b");
    const { blockId: theirBlock, sessionId: theirBlockSession } = await seedSession(theirs);
    const myMachine = await registerMachine(mine, "My room");
    await expect(
      asUser(mine.userId, (q) =>
        q(RECORD_GROUP_SQL, [
          theirBlock,
          myMachine,
          "galvanic",
          "g1",
          [],
          JSON.stringify(READINGS),
          theirBlockSession,
          theirs.clientId,
        ]),
      ),
    ).rejects.toThrow(/not an active member of this studio/i);
  });

  it("refuses a machine belonging to another studio", async () => {
    const mine = await seedStudio("mpx-mach-a");
    const theirs = await seedStudio("mpx-mach-b");
    const { blockId: myBlock, sessionId: myBlockSession } = await seedSession(mine);
    const theirMachine = await registerMachine(theirs, "Their room");
    await expect(
      asUser(mine.userId, (q) =>
        q(RECORD_GROUP_SQL, [
          myBlock,
          theirMachine,
          "galvanic",
          "g1",
          [],
          JSON.stringify(READINGS),
          myBlockSession,
          mine.clientId,
        ]),
      ),
    ).rejects.toThrow(/belongs to another studio/i);
  });

  it("requires a machine: no machine, no reading", async () => {
    const studio = await seedStudio("mpx-nomach");
    const { blockId, sessionId } = await seedSession(studio);
    await expect(
      asUser(studio.userId, (q) =>
        q(`select public.record_treatment_setup_group($1, null, $2, $3, $4, $5::jsonb,$6::uuid,$7::uuid)`, [
          blockId,
          "galvanic",
          "g1",
          [],
          JSON.stringify(READINGS),
          sessionId,
          studio.clientId,
        ]),
      ),
    ).rejects.toThrow(/choose the machine/i);
  });

  it("a member of another studio cannot READ these readings", async () => {
    const mine = await seedStudio("mpx-vis-r-a");
    const other = await seedStudio("mpx-vis-r-b");
    const { blockId, sessionId } = await seedSession(mine);
    const machineId = await registerMachine(mine, "Room 1");
    await asUser(mine.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        blockId,
        machineId,
        "galvanic",
        "g1",
        [],
        JSON.stringify(READINGS),
        sessionId,
        mine.clientId,
      ]),
    );
    const seen = await asUser(other.userId, (q) =>
      q(`select id from public.treatment_setup_readings where session_block_id = $1`, [
        blockId,
      ]),
    );
    expect(seen.rows).toEqual([]);
  });

  it("direct INSERT into readings is refused for an authenticated member", async () => {
    const studio = await seedStudio("mpx-read-direct");
    const { blockId } = await seedSession(studio);
    await expect(
      asUser(studio.userId, (q) =>
        q(
          `insert into public.treatment_setup_readings
             (studio_id, session_block_id, machine_profile_id, machine_profile_version,
              mode_key, group_key, field_key, value_numeric, native_unit, decimals,
              observation_source)
           values ($1, $2, 'forged', 1, 'm', 'g1', 'f', 1, 's', 0, 'practitioner-entered')`,
          [studio.studioId, blockId],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// Next visit
// ---------------------------------------------------------------------------

describe("0223 · next-visit retrieval returns the prior setup accurately", () => {
  it("gives back the most recent block's readings for the client, with provenance", async () => {
    const studio = await seedStudio("mpx-next");
    const machineId = await registerMachine(studio, "Room 1");

    // Two visits. The earlier one is backdated so ordering is unambiguous.
    const first = await seedSession(studio);
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        first.blockId,
        machineId,
        "galvanic",
        "g1",
        [],
        JSON.stringify([
          {
            field_key: "current",
            value: "80",
            native_unit: "µA",
            decimals: 0,
            observation_source: "practitioner-entered",
          },
        ]),
        first.sessionId,
        studio.clientId,
      ]),
    );
    // Backdating is IMPOSSIBLE by design, and trying to is a second proof of
    // immutability: a recorded_at cannot be moved any more than a value can.
    // Ordering therefore rests on the real insert instants, which differ
    // because each command runs in its own transaction.
    await expect(
      adminQuery(
        `update public.treatment_setup_readings
            set recorded_at = now() - interval '28 days'
          where session_block_id = $1`,
        [first.blockId],
      ),
    ).rejects.toThrow(/immutable/i);

    const second = await seedSession(studio);
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        second.blockId,
        machineId,
        "galvanic",
        "g1",
        [],
        JSON.stringify([
          {
            field_key: "current",
            value: "135",
            native_unit: "µA",
            decimals: 0,
            observation_source: "practitioner-entered",
          },
        ]),
        second.sessionId,
        studio.clientId,
      ]),
    );

    // The clinical question: what was she set to most recently?
    const latest = await asUser(studio.userId, (q) =>
      q(
        `select r.value_numeric::text as v, r.native_unit, r.mode_key,
                r.machine_profile_id, r.machine_profile_version,
                r.session_block_id, r.recorded_at
           from public.treatment_setup_readings r
          where r.studio_id = $1 and r.field_key = 'current'
          order by r.recorded_at desc
          limit 1`,
        [studio.studioId],
      ),
    );
    expect(latest.rows[0].v).toBe("135");
    expect(latest.rows[0].native_unit).toBe("µA");
    expect(latest.rows[0].session_block_id).toBe(second.blockId);
    // Model identity and the version it was captured under come back with it,
    // so a historical renderer can use the RECORDED contract.
    expect(latest.rows[0].machine_profile_id).toBe(PROFILE);
    expect(latest.rows[0].machine_profile_version).toBe(VERSION);
  });

  it("the earlier visit's value is still there, unchanged", async () => {
    // Recording a new visit adds; it never edits what the last one said.
    const studio = await seedStudio("mpx-hist");
    const machineId = await registerMachine(studio, "Room 1");
    const first = await seedSession(studio);
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        first.blockId,
        machineId,
        "galvanic",
        "g1",
        [],
        JSON.stringify([
          {
            field_key: "current",
            value: "80",
            native_unit: "µA",
            decimals: 0,
            observation_source: "practitioner-entered",
          },
        ]),
        first.sessionId,
        studio.clientId,
      ]),
    );
    const second = await seedSession(studio);
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        second.blockId,
        machineId,
        "galvanic",
        "g1",
        [],
        JSON.stringify([
          {
            field_key: "current",
            value: "135",
            native_unit: "µA",
            decimals: 0,
            observation_source: "practitioner-entered",
          },
        ]),
        second.sessionId,
        studio.clientId,
      ]),
    );
    const firstStill = await adminQuery(
      `select value_numeric::text as v from public.treatment_setup_readings
        where session_block_id = $1 and field_key = 'current'`,
      [first.blockId],
    );
    expect(firstStill.rows[0].v).toBe("80");
  });

  it("a reading outlives the unit being retired", async () => {
    // Retiring a machine must not erase what it recorded.
    const studio = await seedStudio("mpx-outlive");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        blockId,
        machineId,
        "galvanic",
        "g1",
        [],
        JSON.stringify(READINGS),
        sessionId,
        studio.clientId,
      ]),
    );
    await asUser(studio.userId, (q) =>
      q(`select public.retire_studio_machine($1)`, [machineId]),
    );
    const still = await adminQuery(
      `select value_numeric::text as v, machine_profile_id, studio_machine_id
         from public.treatment_setup_readings
        where session_block_id = $1 and field_key = 'current'`,
      [blockId],
    );
    expect(still.rows[0].v).toBe("120");
    expect(still.rows[0].machine_profile_id).toBe(PROFILE);
    expect(still.rows[0].studio_machine_id).toBe(machineId);
  });
});

// ---------------------------------------------------------------------------
// Existing values are not disturbed
// ---------------------------------------------------------------------------

describe("0223 · existing historical values are untouched", () => {
  it("adds its columns as NULL and alters no existing block value", async () => {
    const studio = await seedStudio("mpx-legacy");
    const { blockId, sessionId } = await seedSession(studio);
    await adminQuery(
      `update public.session_blocks
          set apilus_modality = 'Multiplex', energy_level = 7.25,
              machine_frequency = '13.56 MHz'
        where id = $1`,
      [blockId],
    );
    const machineId = await registerMachine(studio, "Room 1");
    await asUser(studio.userId, (q) =>
      q(RECORD_GROUP_SQL, [
        blockId,
        machineId,
        "galvanic",
        "g1",
        [],
        JSON.stringify(READINGS),
        sessionId,
        studio.clientId,
      ]),
    );
    const block = await adminQuery(
      `select apilus_modality, energy_level::text as e, machine_frequency
         from public.session_blocks where id = $1`,
      [blockId],
    );
    // The legacy columns are exactly as they were. 0223 reads none of them and
    // reinterprets none of them.
    expect(block.rows[0].apilus_modality).toBe("Multiplex");
    expect(block.rows[0].e).toBe("7.25");
    expect(block.rows[0].machine_frequency).toBe("13.56 MHz");
  });

  it("a practitioner who never chose a machine has NULL defaults", async () => {
    const studio = await seedStudio("mpx-nullcols");
    const row = await adminQuery(
      `select default_machine_id, default_machine_mode
         from public.practitioners where id = $1`,
      [studio.practitionerId],
    );
    expect(row.rows[0].default_machine_id).toBeNull();
    expect(row.rows[0].default_machine_mode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 0223 · THE SETUP WRITE IS BOUND TO THE ROUTE
//
// Studio membership is not authorization to write to any chart in the studio.
// `assert_setup_scope` derived the block's studio and checked membership, and
// stopped there - so a practitioner sending ANOTHER CLIENT'S block id, with a
// machine of their own studio, appended IMMUTABLE readings to the wrong
// client's treatment (Codex, #860 4297032712).
//
// The readings cannot be amended or deleted by design, so this is not a
// recoverable mistake: the wrong client's permanent record gains a setup that
// was never used on them, and the right client's loses it.
// ---------------------------------------------------------------------------
describe("0223 · setup writes are bound to the authorized route", () => {
  it("REFUSES another client's block in the same studio", async () => {
    const studio = await seedStudio("route-bind");
    const ana = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");

    // A SECOND client of the SAME studio. Membership is satisfied for both,
    // which is exactly why membership could not catch this.
    const beaClientId = randomUUID();
    const beaSessionId = randomUUID();
    const beaBlockId = randomUUID();
    await adminQuery(
      `insert into public.clients (id, studio_id, name) values ($1,$2,$3)`,
      [beaClientId, studio.studioId, "Client Bea"],
    );
    await adminQuery(
      `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
       values ($1,$2,$3,$4,'electrolysis')`,
      [beaSessionId, studio.studioId, beaClientId, studio.practitionerId],
    );
    await adminQuery(
      `insert into public.session_blocks (id, studio_id, session_id) values ($1,$2,$3)`,
      [beaBlockId, studio.studioId, beaSessionId],
    );

    // The practitioner is charting ANA, and sends BEA's block id.
    await expect(
      asUser(studio.userId, (q) =>
        q(
          RECORD_GROUP_SQL,
          [
            beaBlockId,
            machineId,
            "galvanic",
            "g1",
            [],
            JSON.stringify(READINGS),
            ana.sessionId,
            studio.clientId,
          ],
        ),
      ),
    ).rejects.toThrow(/unknown treatment block/i);

    // AND NOTHING WAS WRITTEN to either chart.
    const wrote = await adminQuery(
      `select count(*)::text as n from public.treatment_setup_readings
        where session_block_id in ($1, $2)`,
      [beaBlockId, ana.blockId],
    );
    expect((wrote.rows[0] as { n: string }).n).toBe("0");
  });

  it("REFUSES the right block under another client's id", async () => {
    // The mirror image: the block is the one open on screen, but the client
    // named does not own it. Both halves of the lineage are checked, so
    // neither id alone is enough.
    const studio = await seedStudio("route-bind-mirror");
    const ana = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");
    const strangerClientId = randomUUID();
    await adminQuery(
      `insert into public.clients (id, studio_id, name) values ($1,$2,$3)`,
      [strangerClientId, studio.studioId, "Client Stranger"],
    );

    await expect(
      asUser(studio.userId, (q) =>
        q(
          RECORD_GROUP_SQL,
          [
            ana.blockId,
            machineId,
            "galvanic",
            "g1",
            [],
            JSON.stringify(READINGS),
            ana.sessionId,
            strangerClientId,
          ],
        ),
      ),
    ).rejects.toThrow(/unknown treatment block/i);
  });

  it("REFUSES a block from another SESSION of the same client", async () => {
    // Same person, wrong visit. Clinically this is still a misfiled capture:
    // the settings land on a treatment that did not happen that day.
    const studio = await seedStudio("route-bind-visit");
    const first = await seedSession(studio);
    const second = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");

    await expect(
      asUser(studio.userId, (q) =>
        q(
          RECORD_GROUP_SQL,
          [
            first.blockId,
            machineId,
            "galvanic",
            "g1",
            [],
            JSON.stringify(READINGS),
            second.sessionId,
            studio.clientId,
          ],
        ),
      ),
    ).rejects.toThrow(/unknown treatment block/i);
  });

  it("REFUSES a null route rather than treating it as unscoped", async () => {
    // The parameters are required, so a caller that omits them is refused
    // rather than silently getting the old behaviour back.
    const studio = await seedStudio("route-bind-null");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");

    await expect(
      asUser(studio.userId, (q) =>
        q(
          `select public.record_treatment_setup_group($1,$2,$3,$4,$5,$6::jsonb,null::uuid,null::uuid)`,
          [blockId, machineId, "galvanic", "g1", [], JSON.stringify(READINGS)],
        ),
      ),
    ).rejects.toThrow(/must name their session and client/i);
  });

  it("CONTROL: the correct route still records normally", async () => {
    // Without this the four refusals above are satisfied by a command that
    // refuses everything.
    const studio = await seedStudio("route-bind-ok");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");

    const wrote = await asUser(studio.userId, (q) =>
      q(
        RECORD_GROUP_SQL,
        [
          blockId,
          machineId,
          "galvanic",
          "g1",
          [],
          JSON.stringify(READINGS),
          sessionId,
          studio.clientId,
        ],
      ),
    );
    expect(Number((wrote.rows[0] as { n: number }).n)).toBeGreaterThan(0);
  });

  it("the SUBMISSION command is bound the same way", async () => {
    // Both write paths, because a binding on one of them is a binding on
    // neither: the form uses the submission command, and the per-group
    // command remains exported.
    const studio = await seedStudio("route-bind-sub");
    const ana = await seedSession(studio);
    const other = await seedSession(studio);
    const machineId = await registerMachine(studio, "Room 1");

    await expect(
      asUser(studio.userId, (q) =>
        q(
          `select public.record_treatment_setup_submission($1,$2,$3,$4,$5::jsonb,$6::uuid,$7::uuid) as r`,
          [
            ana.blockId,
            machineId,
            "galvanic",
            "route-key-0001",
            JSON.stringify([
              // NEW BY REF: identities are issued, not chosen
              // (Codex, #860 4305780322).
              { new_group_ref: "g1", channels: [], readings: READINGS },
            ]),
            other.sessionId,
            studio.clientId,
          ],
        ),
      ),
    ).rejects.toThrow(/unknown treatment block/i);
  });
});

// ---------------------------------------------------------------------------
// 0223 · A CAPTURE CARRIES EVERY REQUIRED FIELD OF ITS MODE
//
// The recording command validated the readings it was GIVEN, which is a
// different claim from "this capture is complete". A forged action or RPC
// call naming one of several required fields committed a capture that
// next-visit guidance then presented as a complete setup
// (Codex, #860 4299434251). Captures are immutable, so the incomplete one
// stays and reads as what she actually used.
//
// The UI's `groupReadiness` already refuses a partial group — but a check in
// the browser is a courtesy to the practitioner, not a property of the
// record. The contract is the only place that knows which fields a mode
// requires, which is why requiredness had to be published there first.
// ---------------------------------------------------------------------------
describe("0223 · a capture must carry every required field", () => {
  const REQ = "fixture:required-fields";

  async function publishRequired(version: number): Promise<void> {
    await adminQuery(
      `select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        REQ,
        version,
        "galvanic",
        4,
        null,
        // `current` and `duration` REQUIRED, `note` optional. The mix is the
        // point: a rule that refused every partial capture would also refuse
        // a legitimate one that omits an optional field.
        JSON.stringify([
          { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
          { field_key: "duration", native_unit: "s", decimals: 1, quantity: "duration" },
          {
            field_key: "note",
            native_unit: "count",
            decimals: 0,
            quantity: "count",
            optional: true,
          },
        ]),
      ],
    );
  }

  async function machineFor(studio: SeededStudio, version: number): Promise<string> {
    await publishRequired(version);
    const r = await adminQuery(
      `insert into public.studio_machines
         (studio_id, machine_profile_id, machine_profile_version, display_name)
       values ($1,$2,$3,'Required-fields unit') returning id`,
      [studio.studioId, REQ, version],
    );
    return (r.rows[0] as { id: string }).id;
  }

  const reading = (field: string, value: string, unit: string, dp: number) => ({
    field_key: field,
    value,
    native_unit: unit,
    decimals: dp,
    observation_source: "practitioner-entered",
  });

  it("REFUSES a capture that omits a required field", async () => {
    const studio = await seedStudio("req-omit");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await machineFor(studio, 61);

    await expect(
      asUser(studio.userId, (q) =>
        q(
          RECORD_GROUP_SQL,
          [
            blockId,
            machineId,
            "galvanic",
            "g1",
            [],
            JSON.stringify([reading("current", "120", "µA", 0)]),
            sessionId,
            studio.clientId,
          ],
        ),
      ),
    ).rejects.toThrow(/missing a required field/i);

    // AND NOTHING WAS WRITTEN. The check runs after the inserts, inside the
    // same transaction, so the raise has to roll the capture back with it.
    const left = await adminQuery(
      `select
         (select count(*)::int from public.treatment_setup_captures
           where session_block_id = $1) as caps,
         (select count(*)::int from public.treatment_setup_readings
           where session_block_id = $1) as reads`,
      [blockId],
    );
    expect(left.rows[0]).toMatchObject({ caps: 0, reads: 0 });
  });

  it("ACCEPTS a capture that omits only an OPTIONAL field", async () => {
    // Without this the rule above is satisfied by refusing everything.
    const studio = await seedStudio("req-optional");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await machineFor(studio, 62);

    const wrote = await asUser(studio.userId, (q) =>
      q(
        RECORD_GROUP_SQL,
        [
          blockId,
          machineId,
          "galvanic",
          "g1",
          [],
          JSON.stringify([
            reading("current", "120", "µA", 0),
            reading("duration", "300.5", "s", 1),
          ]),
          sessionId,
          studio.clientId,
        ],
      ),
    );
    expect(Number((wrote.rows[0] as { n: number }).n)).toBe(2);
  });

  it("an ABSENCE satisfies the requirement — it IS an observation", async () => {
    // "not legible" is a recorded fact about that field, which is the whole
    // reason `absence_reason` exists. What the rule refuses is a field
    // nobody addressed at all.
    const studio = await seedStudio("req-absent");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await machineFor(studio, 63);

    const wrote = await asUser(studio.userId, (q) =>
      q(
        RECORD_GROUP_SQL,
        [
          blockId,
          machineId,
          "galvanic",
          "g1",
          [],
          JSON.stringify([
            reading("current", "120", "µA", 0),
            {
              field_key: "duration",
              absence_reason: "not-legible",
              native_unit: "s",
              decimals: 1,
              observation_source: "practitioner-entered",
            },
          ]),
          sessionId,
          studio.clientId,
        ],
      ),
    );
    expect(Number((wrote.rows[0] as { n: number }).n)).toBe(2);
  });

  it("the SUBMISSION command enforces it too, and rolls back every group", async () => {
    // Atomicity and completeness together: one incomplete group must not
    // leave the other groups of the same save behind.
    const studio = await seedStudio("req-submission");
    const { blockId, sessionId } = await seedSession(studio);
    const machineId = await machineFor(studio, 64);

    await expect(
      asUser(studio.userId, (q) =>
        q(
          `select public.record_treatment_setup_submission($1,$2,$3,$4,$5::jsonb,$6::uuid,$7::uuid) as r`,
          [
            blockId,
            machineId,
            "galvanic",
            "req-key-0001",
            JSON.stringify([
              {
                new_group_ref: "g1",
                channels: [],
                readings: [
                  reading("current", "120", "µA", 0),
                  reading("duration", "300.5", "s", 1),
                ],
              },
              // INCOMPLETE, and second: the first group has already been
              // written when this one is refused.
              { new_group_ref: "g2", channels: [], readings: [reading("current", "80", "µA", 0)] },
            ]),
            sessionId,
            studio.clientId,
          ],
        ),
      ),
    ).rejects.toThrow(/missing a required field/i);

    const left = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_captures
        where session_block_id = $1`,
      [blockId],
    );
    expect(
      (left.rows[0] as { n: number }).n,
      "the COMPLETE group survived a refusal of the incomplete one",
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 0223 · THE REVISION SEQUENCE BELONGS TO A SETUP IDENTITY
//
// Keyed on block + group alone, a machine or mode switch continued the
// previous unit's sequence: the newly mounted collector starts again at `g1`,
// so Room 2's FIRST capture became revision 2 and the history rendered it as
// "capture 2" — asserting an earlier capture in a setting history that has
// none, and implying a mid-treatment change that was never made
// (Codex, #860 4299434260).
//
// `groupsFromRecorded` restores identities within (device, profile, version,
// mode) and `changesWithin` pairs readings within it. Revision allocation is
// the third place that scope has to hold, and was the one still counting
// across units.
// ---------------------------------------------------------------------------
describe("0223 · revisions are scoped to the setup identity", () => {
  const SCOPED = "fixture:revision-scope";

  async function unit(studio: SeededStudio, name: string): Promise<string> {
    await adminQuery(
      `select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        SCOPED,
        1,
        "galvanic",
        4,
        null,
        JSON.stringify([
          {
            field_key: "current",
            native_unit: "µA",
            decimals: 0,
            quantity: "current",
            optional: true,
          },
        ]),
      ],
    );
    const r = await adminQuery(
      `insert into public.studio_machines
         (studio_id, machine_profile_id, machine_profile_version, display_name)
       values ($1,$2,1,$3) returning id`,
      [studio.studioId, SCOPED, name],
    );
    return (r.rows[0] as { id: string }).id;
  }

  const one = (value: string) =>
    JSON.stringify([
      {
        field_key: "current",
        value,
        native_unit: "µA",
        decimals: 0,
        observation_source: "practitioner-entered",
      },
    ]);

  it("a different MACHINE starts its own sequence at 1", async () => {
    const studio = await seedStudio("rev-scope-machine");
    const { blockId, sessionId } = await seedSession(studio);
    const roomOne = await unit(studio, "Room 1");
    const roomTwo = await unit(studio, "Room 2");

    for (const [machineId, value] of [
      [roomOne, "120"],
      [roomTwo, "80"],
    ] as const) {
      await asUser(studio.userId, (q) =>
        q(
          RECORD_GROUP_SQL,
          [blockId, machineId, "galvanic", "g1", [], one(value), sessionId, studio.clientId],
        ),
      );
    }

    const rows = await adminQuery(
      `select studio_machine_id, revision
         from public.treatment_setup_captures
        where session_block_id = $1 order by recorded_at`,
      [blockId],
    );
    const byUnit = new Map(
      (rows.rows as Array<{ studio_machine_id: string; revision: number }>).map((r) => [
        r.studio_machine_id,
        r.revision,
      ]),
    );
    expect(byUnit.get(roomOne), "Room 1's first capture").toBe(1);
    expect(
      byUnit.get(roomTwo),
      "Room 2's FIRST capture was numbered as though it followed Room 1's",
    ).toBe(1);
  });

  it("the same machine's second capture IS revision 2", async () => {
    const studio = await seedStudio("rev-scope-same");
    const { blockId, sessionId } = await seedSession(studio);
    const roomOne = await unit(studio, "Room 1");

    for (const value of ["120", "150"]) {
      await asUser(studio.userId, (q) =>
        q(
          RECORD_GROUP_SQL,
          [blockId, roomOne, "galvanic", "g1", [], one(value), sessionId, studio.clientId],
        ),
      );
    }

    const rows = await adminQuery(
      `select revision from public.treatment_setup_captures
        where session_block_id = $1 order by revision`,
      [blockId],
    );
    expect((rows.rows as Array<{ revision: number }>).map((r) => r.revision)).toEqual([
      1, 2,
    ]);
  });
});
