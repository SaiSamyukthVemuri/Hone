import { afterAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { Client } from "pg";

import {
  adminQuery,
  asUser,
  closePool,
  resolveLocalDbUrl,
  seedMember,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
// The real blocking observation, borrowed rather than re-invented. It lives in
// the waitlist helpers because WAIT-03 needed it first; it reads
// pg_stat_activity and is not waitlist-specific. A `sleep(200)` in its place
// would pass whether or not the second transaction ever parked on a lock,
// which is the whole claim these tests make.
import { expectBlockedOn } from "./helpers/waitlist-concurrency";

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

// UNIQUE PER RUN, which is what makes this suite re-runnable.
//
// A published contract is immutable per (profile, version) and GLOBAL - not
// studio-scoped - so with a FIXED profile id two tests failed on any second
// run against the same database: re-publishing a version with different
// fields is correctly REFUSED, and that refusal reads exactly like a defect.
// Measured: run 1 on a fresh chain 129/129, run 2 on the same database 2
// failed, both in the publication and immutability sections.
//
// It cost two misread boards in this lane and was about to cost a third in the
// hosted composition, where re-running after a code-only change is otherwise
// perfectly reasonable. A fresh namespace per run removes the hazard instead
// of documenting it forever. Every other section was already re-runnable
// because each test seeds its own studio.
const PROFILE = `synthetic:authority-proof-${randomUUID().slice(0, 8)}`;

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

// ---------------------------------------------------------------------------
// CONCURRENCY HELPERS, at module scope because three describe blocks use
// them: the session/block race, the machine race, and machine agreement.
// ---------------------------------------------------------------------------
/** An authenticated connection of its own, inside an open transaction. */
async function party(userId: string): Promise<{ c: Client; pid: number }> {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  const pid = Number((await c.query("select pg_backend_pid() as pid")).rows[0].pid);
  return { c, pid };
}

const recordOn = (c: Client, blockId: string, machineId: string, value: string) =>
  c.query(
    `select public.record_treatment_setup_group($1,$2,'galvanic','g','{}'::smallint[],$3::jsonb) as n`,
    [blockId, machineId, JSON.stringify([ok("current", value)])],
  );

type Settled =
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; code: string; message: string };

/**
 * Attach the handler AT CREATION, not at the await.
 *
 * A deferred query that rejects while the test is doing something else -
 * waiting on `expectBlockedOn`, losing a deadlock, closing a connection - is
 * an orphaned rejection, which Vitest reports as an Unhandled Rejection and
 * warns can make tests falsely pass. Converting to a settled shape
 * immediately removes the window rather than policing it.
 */
/**
 * A deferred query that may never settle, bounded.
 *
 * Every failure mode in this section is a WAIT, not an error: a lock that is
 * never released, a cycle that never forms, a transaction whose release the
 * test is itself blocking. Unbounded, each one stalls to the runner's
 * timeout and reports "Test timed out", which says nothing about which lock
 * was held by whom. The fallback carries the diagnosis instead.
 */
const bounded = (p: Promise<Settled>, why: string, ms = 6000): Promise<Settled> =>
  Promise.race([
    p,
    new Promise<Settled>((resolve) =>
      setTimeout(() => resolve({ ok: false, code: "TEST_TIMEOUT", message: why }), ms),
    ),
  ]);

const settle = (p: Promise<{ rows: unknown[] }>): Promise<Settled> =>
  p.then(
    (r) => ({ ok: true as const, rows: r.rows as Array<Record<string, unknown>> }),
    (e: { code?: string; message?: string }) => ({
      ok: false as const,
      code: e.code ?? "?",
      message: e.message ?? String(e),
    }),
  );

const captureCount = async (blockId: string): Promise<number> => {
  const r = await adminQuery(
    `select count(*)::int as c from public.treatment_setup_captures
      where session_block_id = $1`,
    [blockId],
  );
  return r.rows[0].c as number;
};

async function scene(label: string, version: number) {
  const studio = await seedStudio(label);
  const { sessionId, blockId } = await seedSession(studio);
  await publish(version);
  const machineId = await register(studio, version);
  return { studio, sessionId, blockId, machineId };
}

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
describe("0223 · RETIREMENT of a parent session, not just a block", () => {
  // soft_delete_session_block (0166) retires an area; soft_delete_session
  // (0167) retires a whole session and leaves its child blocks alone. Checking
  // only the BLOCK was the gap: a removed session kept live-looking blocks, so
  // its captures stayed both writable and offerable.
  it("REFUSES a capture against a block whose SESSION is retired", async () => {
    const studio = await seedStudio("retire-write");
    const { sessionId, blockId } = await seedSession(studio);
    await publish(60);
    const machineId = await register(studio, 60);

    // POSITIVE CONTROL first: while the session is live, recording works.
    const before = await recordAs(studio.userId, blockId, machineId, "g", [
      ok("current", "100"),
    ]);
    expect(Number(before.rows[0].n)).toBe(1);

    // Retire the SESSION only. The block is untouched and still looks live.
    await adminQuery(`update public.sessions set deleted_at = now() where id = $1`, [
      sessionId,
    ]);
    const stillLive = await adminQuery(
      `select deleted_at is null as live from public.session_blocks where id = $1`,
      [blockId],
    );
    expect(
      stillLive.rows[0].live,
      "the block must still look live, or this test proves nothing",
    ).toBe(true);

    await expect(
      recordAs(studio.userId, blockId, machineId, "g", [ok("current", "150")]),
    ).rejects.toThrow(/Unknown treatment block/i);
  });

  it("does NOT offer a retired SESSION's capture as guidance", async () => {
    const studio = await seedStudio("retire-guide");
    await publish(61);
    const machineId = await register(studio, 61);

    // An earlier capture in a session that STAYS live.
    const kept = await seedSession(studio);
    await recordAs(studio.userId, kept.blockId, machineId, "g", [ok("current", "60")]);

    // A later capture in a session that is then retired.
    const removed = await seedSession(studio);
    await recordAs(studio.userId, removed.blockId, machineId, "g", [
      ok("current", "999"),
    ]);
    await adminQuery(`update public.sessions set deleted_at = now() where id = $1`, [
      removed.sessionId,
    ]);

    const guide = await asUser(studio.userId, (q) =>
      q(`select public.latest_setup_for_client($1,$2) as r`, [
        studio.studioId,
        studio.clientId,
      ]),
    );
    const rows = (guide.rows[0].r ?? []) as Array<{ value_numeric: string }>;
    expect(
      rows.map((r) => r.value_numeric),
      "a retired session's capture was offered as guidance",
    ).toEqual(["60"]);

    // ...and the retired session's readings REMAIN in the record.
    const kept2 = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_readings
        where session_block_id = $1`,
      [removed.blockId],
    );
    expect(kept2.rows[0].n).toBe(1);
  });

  it("does NOT include a retired SESSION's captures in history", async () => {
    const studio = await seedStudio("retire-hist");
    const { sessionId, blockId } = await seedSession(studio);
    await publish(62);
    const machineId = await register(studio, 62);
    await recordAs(studio.userId, blockId, machineId, "g", [ok("current", "100")]);

    const before = await asUser(studio.userId, (q) =>
      q(`select public.setup_capture_history_for_block($1) as r`, [blockId]),
    );
    expect((before.rows[0].r ?? []).length).toBe(1);

    await adminQuery(`update public.sessions set deleted_at = now() where id = $1`, [
      sessionId,
    ]);
    const after = await asUser(studio.userId, (q) =>
      q(`select public.setup_capture_history_for_block($1) as r`, [blockId]),
    );
    expect(after.rows[0].r).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("0223 · an EMPTY capture cannot erase prior guidance", () => {
  it("refuses an empty readings array instead of allocating a blank capture", async () => {
    // The dangerous part was not the empty row. `latest_setup_for_client`
    // picks the NEWEST capture and then aggregates ITS readings, so a blank
    // capture became the newest and made valid guidance vanish as [] - a
    // direct authenticated call could erase a client's next-visit setup
    // without deleting anything.
    const studio = await seedStudio("empty-cap");
    const { blockId } = await seedSession(studio);
    await publish(70);
    const machineId = await register(studio, 70);
    await recordAs(studio.userId, blockId, machineId, "g", [ok("current", "120")]);

    await expect(
      recordAs(studio.userId, blockId, machineId, "g", []),
    ).rejects.toThrow(/At least one reading is required/i);

    // No blank capture exists...
    const blanks = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_captures c
        where c.session_block_id = $1
          and not exists (select 1 from public.treatment_setup_readings r
                           where r.capture_id = c.id)`,
      [blockId],
    );
    expect(blanks.rows[0].n).toBe(0);

    // ...and the guidance still stands.
    const guide = await asUser(studio.userId, (q) =>
      q(`select public.latest_setup_for_client($1,$2) as r`, [
        studio.studioId,
        studio.clientId,
      ]),
    );
    const rows = (guide.rows[0].r ?? []) as Array<{ value_numeric: string }>;
    expect(rows.map((r) => r.value_numeric)).toEqual(["120"]);
  });
});

// ---------------------------------------------------------------------------
describe("0223 · registration refuses an unpublished version ITSELF", () => {
  it("the RPC refuses, not only the server action", async () => {
    // An owner can call this RPC directly - it is granted to `authenticated`
    // because it must resolve her own ownership - so a check that lives only
    // in the server action would leave a PERMANENT inventory row whose
    // settings can never be recorded.
    const studio = await seedStudio("reg-nocontract");
    await expect(
      asUser(studio.userId, (q) =>
        q(`select public.register_studio_machine($1,$2,$3,$4,$5)`, [
          studio.studioId,
          PROFILE,
          8888, // never published
          "Unpublishable",
          [],
        ]),
      ),
    ).rejects.toThrow(/No field contract is published/i);

    // And nothing was left behind.
    const rows = await adminQuery(
      `select count(*)::int as n from public.studio_machines
        where studio_id = $1 and machine_profile_version = 8888`,
      [studio.studioId],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("POSITIVE CONTROL: it registers once the contract is published", async () => {
    const studio = await seedStudio("reg-withcontract");
    await publish(80);
    const id = await register(studio, 80);
    expect(id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe("0223 · republish compares field IDENTITIES, not counts", () => {
  it("a DUPLICATE element cannot hide an omitted field", async () => {
    // THE HOLE THIS CLOSES, and it is worth stating precisely because the old
    // check looked thorough. It counted matches and compared counts both
    // ways. Against published {A, B}, an incoming [A, A] gives matches = 2,
    // incoming = 2 and published = 2 - so dropping B passed as an idempotent
    // no-op. Counting is not comparing.
    await publish(90, {
      fields: [
        { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
        { field_key: "duration", native_unit: "s", decimals: 1, quantity: "duration" },
      ],
    });
    await expect(
      publish(90, {
        fields: [
          { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
          { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
        ],
      }),
    ).rejects.toThrow(/listed more than once/i);

    // Both published fields survive untouched.
    const rows = await adminQuery(
      `select field_key from public.machine_profile_field_contract
        where machine_profile_id = $1 and machine_profile_version = 90
        order by field_key`,
      [PROFILE],
    );
    expect(rows.rows.map((r: { field_key: string }) => r.field_key)).toEqual([
      "current",
      "duration",
    ]);
  });

  it("a duplicate is refused even on a FIRST publication", async () => {
    await expect(
      publish(91, {
        fields: [
          { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
          { field_key: "current", native_unit: "mA", decimals: 3, quantity: "current" },
        ],
      }),
    ).rejects.toThrow(/listed more than once/i);
    const rows = await adminQuery(
      `select count(*)::int as n from public.machine_profile_mode_contract
        where machine_profile_version = 91`,
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("an ADDED field is still refused, and the set check is symmetric", async () => {
    await publish(92, {
      fields: [
        { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
      ],
    });
    await expect(
      publish(92, {
        fields: [
          { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
          { field_key: "duration", native_unit: "s", decimals: 1, quantity: "duration" },
        ],
      }),
    ).rejects.toThrow(/already published with different fields/i);
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
describe("0223 · a reading cannot be an ORPHAN or disagree with its capture", () => {
  // These run as `postgres` through adminQuery, which is the point: nothing
  // reachable from the application can do either of these, because
  // `authenticated` and `service_role` hold SELECT only on this table. What
  // is being tested is the SCHEMA's guarantee, not a privilege - an invariant
  // the schema does not enforce is one the next migration can quietly break.
  //
  // The orphan case was found by a gate-open browser run, not by this suite:
  // a stale spec step inserted a reading with no capture_id and it was
  // ACCEPTED, because the column was nullable. That row sat outside every
  // capture's revision AND outside the (capture_id, stage, field) uniqueness,
  // escaping both halves of the coherence design at once.
  let studio: SeededStudio;
  let blockId: string;
  let captureId: string;
  // NAMED, because `studio_machine_id` is NOT NULL: an insert that omits it is
  // refused by the not-null constraint BEFORE reaching the foreign key under
  // test, and a refusal test that passes on the wrong constraint proves
  // nothing. That is the same trap the `duration`-not-`current` comment below
  // records, one column over.
  let machineId: string;

  const setup = async () => {
    if (studio) return;
    studio = await seedStudio("orphan");
    blockId = (await seedSession(studio)).blockId;
    await publish(100);
    machineId = await register(studio, 100);
    await recordAs(studio.userId, blockId, machineId, "g", [ok("current", "100")]);
    const r = await adminQuery(
      `select id from public.treatment_setup_captures where session_block_id = $1`,
      [blockId],
    );
    captureId = r.rows[0].id;
  };

  it("refuses a reading with NO capture", async () => {
    await setup();
    await expect(
      adminQuery(
        `insert into public.treatment_setup_readings
           (studio_id, session_block_id, machine_profile_id, machine_profile_version,
            mode_key, group_key, field_key, value_numeric, native_unit, decimals,
            observation_source, revision)
         values ($1, $2, 'x', 1, 'galvanic', 'g', 'current', 999, 'µA', 0,
                 'practitioner-entered', 1)`,
        [studio.studioId, blockId],
      ),
    ).rejects.toThrow(/null value in column "capture_id"|not-null/i);
  });

  it("refuses a reading whose BLOCK disagrees with its capture", async () => {
    // The deeper risk of denormalising studio_id, session_block_id and
    // revision onto readings is not orphanhood but DISAGREEMENT: a row
    // claiming a different block from its own capture would make "one
    // coherent capture" false while every row looked individually valid.
    await setup();
    const other = await seedSession(studio);
    await expect(
      adminQuery(
        `insert into public.treatment_setup_readings
           (capture_id, studio_id, session_block_id, machine_profile_id,
            machine_profile_version, mode_key, group_key, field_key,
            value_numeric, native_unit, decimals, observation_source, revision,
            studio_machine_id)
         values ($1, $2, $3, 'x', 1, 'galvanic', 'g', 'duration', 1, 's', 1,
                 'practitioner-entered', 1, $4)`,
        // `duration` rather than `current`: the capture already holds a
        // `current`, so reusing it trips the (capture_id, stage, field) unique
        // index FIRST and the test would pass on the wrong constraint. A
        // refusal test that does not name its constraint proves nothing.
        [captureId, studio.studioId, other.blockId, machineId],
      ),
    ).rejects.toThrow(/treatment_setup_readings_capture_fk|foreign key/i);
  });

  it("refuses a reading whose REVISION disagrees with its capture", async () => {
    await setup();
    await expect(
      adminQuery(
        `insert into public.treatment_setup_readings
           (capture_id, studio_id, session_block_id, machine_profile_id,
            machine_profile_version, mode_key, group_key, field_key,
            value_numeric, native_unit, decimals, observation_source, revision,
            studio_machine_id)
         values ($1, $2, $3, 'x', 1, 'galvanic', 'g', 'duration',
                 1, 's', 1, 'practitioner-entered', 7, $4)`,
        [captureId, studio.studioId, blockId, machineId],
      ),
    ).rejects.toThrow(/treatment_setup_readings_capture_fk|foreign key/i);
  });

  it("refuses a reading whose STUDIO disagrees with its capture", async () => {
    await setup();
    const elsewhere = await seedStudio("orphan-other");
    await expect(
      adminQuery(
        `insert into public.treatment_setup_readings
           (capture_id, studio_id, session_block_id, machine_profile_id,
            machine_profile_version, mode_key, group_key, field_key,
            value_numeric, native_unit, decimals, observation_source, revision,
            studio_machine_id)
         values ($1, $2, $3, 'x', 1, 'galvanic', 'g', 'duration',
                 1, 's', 1, 'practitioner-entered', 1, $4)`,
        [captureId, elsewhere.studioId, blockId, machineId],
      ),
    ).rejects.toThrow(/treatment_setup_readings_capture_fk|foreign key/i);
  });

  it("POSITIVE CONTROL: a reading that AGREES with its capture is accepted", async () => {
    // Without this, every case above could be passing because the insert is
    // malformed in some way unrelated to the constraint under test.
    await setup();
    // IDENTITY COPIED FROM THE CAPTURE, not invented.
    //
    // This control used to insert profile 'x' and PASSED, which is how finding
    // 4259962078 was found: the FK covered only four columns, so a reading
    // could name a different machine, profile version, mode or channels from
    // its own capture. The positive control was demonstrating the hole it was
    // supposed to be a control for.
    await adminQuery(
      `insert into public.treatment_setup_readings
         (capture_id, studio_id, session_block_id, machine_profile_id,
          machine_profile_version, mode_key, group_key, channels, field_key,
          value_numeric, native_unit, decimals, observation_source, revision,
          studio_machine_id)
       select c.id, c.studio_id, c.session_block_id, c.machine_profile_id,
              c.machine_profile_version, c.mode_key, c.group_key, c.channels,
              'duration', 1, 's', 1, 'practitioner-entered', c.revision,
              c.studio_machine_id
         from public.treatment_setup_captures c where c.id = $1`,
      [captureId],
    );
    const rows = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_readings
        where capture_id = $1`,
      [captureId],
    );
    expect(rows.rows[0].n).toBe(2);
  });

  it("refuses a reading whose MACHINE IDENTITY disagrees with its capture", async () => {
    // The columns the first FK left free: machine_profile_id,
    // machine_profile_version, mode_key, group_key and channels. With those
    // unconstrained, `latest_setup_for_client` (which emits identity from the
    // READING) and `setup_capture_history_for_block` (which emits it from the
    // CAPTURE) could describe one capture as two different machine setups.
    await setup();
    await expect(
      adminQuery(
        `insert into public.treatment_setup_readings
           (capture_id, studio_id, session_block_id, machine_profile_id,
            machine_profile_version, mode_key, group_key, channels, field_key,
            value_numeric, native_unit, decimals, observation_source, revision,
            studio_machine_id)
         select c.id, c.studio_id, c.session_block_id,
                'a-different-machine',  -- the only change
                c.machine_profile_version, c.mode_key, c.group_key, c.channels,
                'reps', 1, 'count', 0, 'practitioner-entered', c.revision,
                c.studio_machine_id
           from public.treatment_setup_captures c where c.id = $1`,
        [captureId],
      ),
    ).rejects.toThrow(/treatment_setup_readings_capture_fk|foreign key/i);
  });

  it("refuses a reading whose MODE disagrees with its capture", async () => {
    await setup();
    await expect(
      adminQuery(
        `insert into public.treatment_setup_readings
           (capture_id, studio_id, session_block_id, machine_profile_id,
            machine_profile_version, mode_key, group_key, channels, field_key,
            value_numeric, native_unit, decimals, observation_source, revision,
            studio_machine_id)
         select c.id, c.studio_id, c.session_block_id, c.machine_profile_id,
                c.machine_profile_version,
                'a-different-mode',     -- the only change
                c.group_key, c.channels,
                'reps', 1, 'count', 0, 'practitioner-entered', c.revision,
                c.studio_machine_id
           from public.treatment_setup_captures c where c.id = $1`,
        [captureId],
      ),
    ).rejects.toThrow(/treatment_setup_readings_capture_fk|foreign key/i);
  });

  it("no orphan exists anywhere after this suite", async () => {
    const rows = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_readings
        where capture_id is null`,
    );
    expect(rows.rows[0].n).toBe(0);
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

// ---------------------------------------------------------------------------
// THE CAPTURE/RETIREMENT RACE, PROVED IN BOTH ORDERS.
//
// Review asked for a consistent lock order, a liveness RE-CHECK after the
// locks are held, no deadlock against the existing retirement commands, and
// both race orders proved with real concurrent transactions. The first three
// are claims about the migration; only the fourth can falsify them, so these
// tests drive two genuine connections and verify, through pg_stat_activity,
// that the second one really parked on a lock. A test that merely sleeps
// passes identically whether or not any serialisation exists.
//
// WHAT THE COMMAND DOES, and why each part is observable here:
//   - resolves the block's session id,
//   - locks `sessions` FOR SHARE, then `session_blocks` FOR SHARE - parent
//     before child, the order 0166's `assert_block_in_session` already states,
//   - and only then re-checks that both are live, in its own statement.
//
// FOR SHARE and not FOR KEY SHARE, which is the part most easily got wrong:
// retirement stamps `deleted_at`, a non-key UPDATE taking FOR NO KEY UPDATE.
// FOR KEY SHARE does NOT conflict with that, so it would let retirement run
// underneath the capture - a lock that reads as protection without being one.
// Every block observed below is that conflict; under FOR KEY SHARE nothing
// would park and `expectBlockedOn` would fail.
// ---------------------------------------------------------------------------
describe("0223 - recording and RETIREMENT serialise, in both race orders", () => {
  it("RECORD first: the retirement PARKS on the capture's lock, and the capture stands", async () => {
    const { studio, sessionId, blockId, machineId } = await scene("race-rec-first", 110);
    const rec = await party(studio.userId);
    const ret = await party(studio.userId);
    try {
      // Taken while both parents are live, and held UNCOMMITTED.
      const n = await recordOn(rec.c, blockId, machineId, "120");
      expect(Number(n.rows[0].n)).toBe(1);

      // Retirement fires now. Its UPDATE needs FOR NO KEY UPDATE on the very
      // session row the capture holds FOR SHARE, so it must park.
      const retiring = settle(
        ret.c.query(`select public.soft_delete_session($1,$2,$3) as id`, [
          sessionId,
          studio.clientId,
          "race proof: retire while a capture is in flight",
        ]),
      );
      const wait = await expectBlockedOn(
        ret.pid,
        "the retirement must park on the recording transaction's session lock",
      );
      expect(wait).toMatch(/^Lock\//);

      await rec.c.query("commit"); // release; the retirement may now proceed
      const retired = await retiring;
      expect(retired.ok, `the retirement must succeed once released`).toBe(true);
      expect(retired.ok && retired.rows[0]!.id).toBe(sessionId);
      await ret.c.query("commit");

      // The capture was taken while the record was live, so it stands. The
      // invariant is that no capture is created against an ALREADY-retired
      // record - not that retirement erases a capture that preceded it.
      expect(await captureCount(blockId)).toBe(1);
      const after = await adminQuery(
        `select deleted_at is not null as gone from public.sessions where id = $1`,
        [sessionId],
      );
      expect(after.rows[0].gone).toBe(true);
    } finally {
      await rec.c.end();
      await ret.c.end();
    }
  });

  it("RETIRE first: the capture PARKS, then REFUSES once the retirement commits", async () => {
    const { studio, sessionId, blockId, machineId } = await scene("race-ret-first", 111);
    const ret = await party(studio.userId);
    const rec = await party(studio.userId);
    try {
      // The retirement holds the session row, UNCOMMITTED and so invisible to
      // the recorder's first read.
      await ret.c.query(`select public.soft_delete_session($1,$2,$3)`, [
        sessionId,
        studio.clientId,
        "race proof: retire before a capture arrives",
      ]);

      // The capture reads the block, then parks acquiring the session lock.
      const recording = settle(recordOn(rec.c, blockId, machineId, "130"));
      const wait = await expectBlockedOn(
        rec.pid,
        "the capture must park acquiring the session lock the retirement holds",
      );
      expect(wait).toMatch(/^Lock\//);

      await ret.c.query("commit"); // the retirement is now a committed fact

      // THE POINT OF THE RE-CHECK. The capture's first read saw a live
      // session; by the time it holds the lock that is no longer true, and the
      // re-check - a separate statement on a new snapshot - sees it.
      const out = await recording;
      expect(out.ok).toBe(false);
      expect(!out.ok && out.message).toMatch(/Unknown treatment block/i);
      expect(!out.ok && out.code, "a refusal, never a deadlock abort").not.toBe("40P01");
      expect(await captureCount(blockId)).toBe(0);
      await rec.c.query("rollback");
    } finally {
      await ret.c.end();
      await rec.c.end();
    }
  });

  it("POSITIVE CONTROL: a retirement that ROLLS BACK does not refuse the capture", async () => {
    // Without this, the previous test is satisfied by a command that refuses
    // whenever it had to wait, which is a different and wrong behaviour.
    const { studio, sessionId, blockId, machineId } = await scene("race-rollback", 112);
    const ret = await party(studio.userId);
    const rec = await party(studio.userId);
    try {
      await ret.c.query(`select public.soft_delete_session($1,$2,$3)`, [
        sessionId,
        studio.clientId,
        "race proof: this retirement is abandoned",
      ]);
      const recording = settle(recordOn(rec.c, blockId, machineId, "140"));
      await expectBlockedOn(rec.pid, "the capture must park on the held session lock");

      await ret.c.query("rollback"); // abandoned - the session was never retired

      const n = await recording;
      expect(n.ok, `the capture must succeed: ${!n.ok && n.message}`).toBe(true);
      expect(n.ok && Number(n.rows[0]!.n)).toBe(1);
      await rec.c.query("commit");
      expect(await captureCount(blockId)).toBe(1);
    } finally {
      await ret.c.end();
      await rec.c.end();
    }
  });

  it("RETIRE THE BLOCK first: the same refusal, through the child's own liveness", async () => {
    // soft_delete_session_block touches only `session_blocks`, so this parks on
    // the SECOND of the two locks. Both parents are therefore proved, and the
    // block case shows the order is actually traversed rather than the session
    // lock alone doing all the work.
    const { studio, sessionId, blockId, machineId } = await scene("race-block-first", 113);
    const ret = await party(studio.userId);
    const rec = await party(studio.userId);
    try {
      await ret.c.query(`select public.soft_delete_session_block($1,$2,$3,$4)`, [
        sessionId,
        studio.clientId,
        blockId,
        "race proof: retire the area before a capture arrives",
      ]);
      const recording = settle(recordOn(rec.c, blockId, machineId, "150"));
      const wait = await expectBlockedOn(
        rec.pid,
        "the capture must park acquiring the block lock the retirement holds",
      );
      expect(wait).toMatch(/^Lock\//);

      await ret.c.query("commit");
      const out = await recording;
      expect(out.ok).toBe(false);
      expect(!out.ok && out.message).toMatch(/Unknown treatment block/i);
      expect(!out.ok && out.code, "a refusal, never a deadlock abort").not.toBe("40P01");
      expect(await captureCount(blockId)).toBe(0);
      await rec.c.query("rollback");
    } finally {
      await ret.c.end();
      await rec.c.end();
    }
  });

  it("neither retirement command deadlocks a capture: the refusals are 40P01-free", async () => {
    // The four tests above each ran one retirement command against a capture
    // and observed a real lock wait. This states the property they establish
    // as its own assertion, because "it refused" and "it deadlocked" are both
    // rejections and only one of them is correct behaviour. A 40P01 abort is
    // never an acceptable outcome: it is indistinguishable to the caller from
    // the data being wrong, and no retry makes it right.
    for (const [label, retire, version] of [
      ["session", "soft_delete_session", 114],
      ["block", "soft_delete_session_block", 115],
    ] as const) {
      const { studio, sessionId, blockId, machineId } = await scene(
        `race-code-${label}`,
        version,
      );
      const ret = await party(studio.userId);
      const rec = await party(studio.userId);
      try {
        await ret.c.query(
          retire === "soft_delete_session"
            ? `select public.soft_delete_session($1,$2,$3)`
            : `select public.soft_delete_session_block($1,$2,$4,$3)`,
          retire === "soft_delete_session"
            ? [sessionId, studio.clientId, `code proof: ${label}`]
            : [sessionId, studio.clientId, `code proof: ${label}`, blockId],
        );
        const recording = settle(recordOn(rec.c, blockId, machineId, "160"));
        await expectBlockedOn(rec.pid, `${label}: the capture must park on a lock`);
        await ret.c.query("commit");

        const out = await recording;
        expect(out.ok, `${label}: the capture must be refused`).toBe(false);
        expect(
          !out.ok && out.code,
          `${label}: a deadlock abort is not a refusal - ${!out.ok && out.message}`,
        ).not.toBe("40P01");
        expect(!out.ok && out.message).toMatch(/Unknown treatment block/i);
        await rec.c.query("rollback");
      } finally {
        await ret.c.end();
        await rec.c.end();
      }
    }
  });

  it("THE LOCK ORDER IS LOAD-BEARING: child-first deadlocks where parent-first does not", async () => {
    // WHY THIS TEST EXISTS, and why it is not a bug report.
    //
    // No command in the repository locks both `sessions` and `session_blocks`,
    // so today nothing can form a cycle with the capture - the four tests
    // above show that. The fixed order is for the command that eventually
    // does, and a comment asserting "this order prevents deadlocks" is exactly
    // the kind of claim that goes unchecked until it is wrong.
    //
    // So both compositions are built here out of the real retirement commands
    // and run against a real capture. CHILD-FIRST genuinely deadlocks;
    // PARENT-FIRST - the order 0166 states and this migration follows - does
    // not. That is the whole justification for the order, demonstrated rather
    // than asserted.
    const CHILD_FIRST_VERSION = 116;
    const PARENT_FIRST_VERSION = 117;

    // --- CHILD FIRST: a cycle, and Postgres breaks it with 40P01. ---
    {
      const { studio, sessionId, blockId, machineId } = await scene(
        "race-order-child",
        CHILD_FIRST_VERSION,
      );
      const x = await party(studio.userId); // retires block, THEN session
      const y = await party(studio.userId); // the capture
      try {
        // X takes the CHILD.
        await x.c.query(`select public.soft_delete_session_block($1,$2,$3,$4)`, [
          sessionId,
          studio.clientId,
          blockId,
          "order proof: child first",
        ]);
        // Y takes the PARENT (free), then parks wanting the child X holds.
        const recording = settle(recordOn(y.c, blockId, machineId, "170"));
        await expectBlockedOn(y.pid, "the capture must park on the child lock");
        // X now wants the parent Y holds. Cycle.
        const retiringParent = settle(
          x.c.query(`select public.soft_delete_session($1,$2,$3)`, [
            sessionId,
            studio.clientId,
            "order proof: child first, parent second",
          ]),
        );

        // BOUNDED. If no cycle forms, the capture simply keeps waiting for a
        // lock X never releases inside this branch, and the honest report is
        // "child-first did not deadlock" - which is the finding, not a stall.
        const settled = await Promise.all([
          bounded(
            recording,
            "the capture never settled: child-first formed no cycle, so it is still waiting for the child lock",
          ),
          bounded(
            retiringParent,
            "the parent retirement never settled: it is waiting for the parent lock the capture holds",
          ),
        ]);
        const codes = settled.map((r) => (r.ok ? "ok" : r.code));
        expect(
          codes.filter((c) => c === "40P01"),
          `child-first must deadlock, or this test proves nothing about the order. Saw ${JSON.stringify(codes)}`,
        ).toHaveLength(1);
      } finally {
        await x.c.query("rollback").catch(() => undefined);
        await y.c.query("rollback").catch(() => undefined);
        await x.c.end();
        await y.c.end();
      }
    }

    // --- PARENT FIRST: the same two commands, the stated order, no cycle. ---
    {
      const { studio, sessionId, blockId, machineId } = await scene(
        "race-order-parent",
        PARENT_FIRST_VERSION,
      );
      const x = await party(studio.userId); // retires session, THEN block
      const y = await party(studio.userId); // the capture
      try {
        // X takes the PARENT first.
        await x.c.query(`select public.soft_delete_session($1,$2,$3)`, [
          sessionId,
          studio.clientId,
          "order proof: parent first",
        ]);
        // Y parks on the parent immediately, holding NOTHING. That is the
        // property the order buys: a waiter that holds nothing cannot be half
        // of a cycle.
        const recording = settle(recordOn(y.c, blockId, machineId, "180"));
        await expectBlockedOn(y.pid, "the capture must park on the parent lock");
        // X proceeds to the child unobstructed - that is the claim.
        //
        // BOUNDED, because the failure mode here is a HANG, not an error. If
        // the capture held the child (the wrong order), X would wait for a
        // lock that Y only releases after this line returns, and the test
        // would sit until the runner's timeout - a 20-second stall that says
        // nothing about why. The timeout branch names the cause instead.
        const retiredBlock = await bounded(
          settle(
            x.c.query(`select public.soft_delete_session_block($1,$2,$3,$4) as id`, [
              sessionId,
              studio.clientId,
              blockId,
              "order proof: parent first, child second",
            ]),
          ),
          "the child retirement never completed: the capture is holding the child lock while waiting for the parent, which is exactly what locking parent-first prevents",
        );
        expect(
          retiredBlock.ok,
          retiredBlock.ok ? "" : retiredBlock.message,
        ).toBe(true);
        expect(retiredBlock.ok && retiredBlock.rows[0]!.id).toBe(blockId);
        await x.c.query("commit");

        const out = await bounded(
          recording,
          "the capture never settled after the retirement committed",
        );
        expect(out.ok).toBe(false);
        expect(
          !out.ok && out.code,
          `parent-first must NOT deadlock - ${!out.ok && out.message}`,
        ).not.toBe("40P01");
        expect(!out.ok && out.message).toMatch(/Unknown treatment block/i);
        await y.c.query("rollback");
      } finally {
        await x.c.end();
        await y.c.end();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// THE MACHINE IS THE THIRD ROW THAT WAS VALIDATED WITHOUT BEING HELD.
//
// The first repair of the capture/retirement race locked the session and the
// block and stopped there. The same hole was one table over the whole time:
// `record_treatment_setup_group` read the machine's `retired_at` without
// holding the row, and `set_own_default_machine` did the same - so
// `retire_studio_machine` could commit in between. The capture is IMMUTABLE,
// so the first case permanently records a setup against a unit that was out
// of service; the second quietly UNDOES the retirement's own cleanup, because
// retirement clears the machine from every practitioner default and this
// command then writes it back (Codex, 87c88017 and 1a39a51f).
//
// THE TOTAL ORDER these tests hold the migration to:
//     sessions -> session_blocks -> studio_machines -> practitioners
// ---------------------------------------------------------------------------
describe("0223 - the MACHINE serialises with its own retirement", () => {
  it("RETIRE the machine, then record: the capture PARKS, then REFUSES", async () => {
    const { studio, blockId, machineId } = await scene("race-machine-ret", 118);
    const ret = await party(studio.userId);
    const rec = await party(studio.userId);
    try {
      // The owner retires the unit, uncommitted and so invisible to the
      // recorder's first read.
      await ret.c.query(`select public.retire_studio_machine($1)`, [machineId]);

      const recording = settle(recordOn(rec.c, blockId, machineId, "190"));
      const wait = await expectBlockedOn(
        rec.pid,
        "the capture must park acquiring the machine lock the retirement holds",
      );
      expect(wait).toMatch(/^Lock\//);

      await ret.c.query("commit");

      const out = await recording;
      expect(out.ok, "a capture against a retired unit must be refused").toBe(false);
      expect(!out.ok && out.message).toMatch(/out of service/i);
      expect(!out.ok && out.code, "a refusal, never a deadlock abort").not.toBe("40P01");
      expect(await captureCount(blockId)).toBe(0);
      await rec.c.query("rollback");
    } finally {
      await ret.c.end();
      await rec.c.end();
    }
  });

  it("POSITIVE CONTROL: a retirement that ROLLS BACK does not refuse the capture", async () => {
    const { studio, blockId, machineId } = await scene("race-machine-roll", 119);
    const ret = await party(studio.userId);
    const rec = await party(studio.userId);
    try {
      await ret.c.query(`select public.retire_studio_machine($1)`, [machineId]);
      const recording = settle(recordOn(rec.c, blockId, machineId, "200"));
      await expectBlockedOn(rec.pid, "the capture must park on the machine lock");
      await ret.c.query("rollback");
      const out = await recording;
      expect(out.ok, `the capture must succeed: ${!out.ok && out.message}`).toBe(true);
      await rec.c.query("commit");
      expect(await captureCount(blockId)).toBe(1);
    } finally {
      await ret.c.end();
      await rec.c.end();
    }
  });

  it("RETIRE, then REMEMBER: the retirement's cleanup is not undone", async () => {
    // The sharper of the two. `retire_studio_machine` stamps `retired_at` AND
    // clears the machine from every practitioner default. Unlocked, this
    // command observes the unit live, waits, and then writes it back as a
    // default - so the unit is out of service and still remembered, with the
    // retirement's own cleanup silently reversed.
    const { studio, machineId } = await scene("race-default-ret", 120);

    // Remember it first, so there is a default for retirement to clear.
    await asUser(studio.userId, (q) =>
      q(`select public.set_own_default_machine($1,$2,null)`, [
        studio.studioId,
        machineId,
      ]),
    );
    const before = await adminQuery(
      `select default_machine_id from public.practitioners where id = $1`,
      [studio.practitionerId],
    );
    expect(before.rows[0].default_machine_id, "the default must be set first").toBe(
      machineId,
    );

    const ret = await party(studio.userId);
    const set = await party(studio.userId);
    try {
      await ret.c.query(`select public.retire_studio_machine($1)`, [machineId]);

      const remembering = settle(
        set.c.query(`select public.set_own_default_machine($1,$2,null) as id`, [
          studio.studioId,
          machineId,
        ]),
      );
      const wait = await expectBlockedOn(
        set.pid,
        "remembering must park acquiring the machine lock the retirement holds",
      );
      expect(wait).toMatch(/^Lock\//);

      await ret.c.query("commit");

      const out = await remembering;
      expect(out.ok, "remembering a retired machine must be refused").toBe(false);
      expect(!out.ok && out.message).toMatch(/out of service/i);
      expect(!out.ok && out.code).not.toBe("40P01");
      await set.c.query("rollback");

      // THE CLEANUP STANDS. This is the assertion the defect broke.
      const after = await adminQuery(
        `select default_machine_id from public.practitioners where id = $1`,
        [studio.practitionerId],
      );
      expect(
        after.rows[0].default_machine_id,
        "the retirement cleared this default; nothing may write it back",
      ).toBeNull();
    } finally {
      await ret.c.end();
      await set.c.end();
    }
  });

  it("REMEMBER, then retire: the retirement PARKS, then clears what was just set", async () => {
    // `retire_studio_machine` and `set_own_default_machine` are the one pair in
    // this migration that touch BOTH studio_machines and practitioners, so they
    // are the pair that could genuinely cycle. Both take the machine first, so
    // the waiter holds nothing and no cycle can form - this drives them into
    // that contention on purpose and requires a clean outcome.
    //
    // NOT fired as two unawaited promises. An earlier version of this test did
    // that and timed out on itself: both transactions stayed open until the
    // join resolved, so the retirement sat on a lock the test was holding.
    // That is a property of the harness, not of the commands.
    const { studio, machineId } = await scene("race-default-order", 121);
    const set = await party(studio.userId);
    const ret = await party(studio.userId);
    try {
      // The remember takes the machine FOR SHARE and updates practitioners.
      const stored = await set.c.query(
        `select public.set_own_default_machine($1,$2,null) as id`,
        [studio.studioId, machineId],
      );
      expect(stored.rows[0].id).toBe(studio.practitionerId);

      // Retirement wants the machine FOR NO KEY UPDATE, so it must park.
      const retiring = settle(
        ret.c.query(`select public.retire_studio_machine($1) as ok`, [machineId]),
      );
      const wait = await expectBlockedOn(
        ret.pid,
        "the retirement must park on the machine lock the remember holds",
      );
      expect(wait).toMatch(/^Lock\//);

      await set.c.query("commit"); // release

      const out = await bounded(retiring, "the retirement never settled");
      expect(out.ok, `the retirement must succeed: ${!out.ok && out.message}`).toBe(true);
      if (!out.ok) expect(out.code).not.toBe("40P01");
      await ret.c.query("commit");

      // The retirement ran SECOND, so its cleanup is the final word: the
      // default it found is cleared, and the unit is out of service.
      const after = await adminQuery(
        `select p.default_machine_id, m.retired_at is not null as retired
           from public.practitioners p
           join public.studio_machines m on m.id = $2
          where p.id = $1`,
        [studio.practitionerId, machineId],
      );
      expect(after.rows[0].default_machine_id).toBeNull();
      expect(after.rows[0].retired).toBe(true);
    } finally {
      await set.c.end();
      await ret.c.end();
    }
  });
});

// ---------------------------------------------------------------------------
describe("0223 - a reading's PHYSICAL MACHINE must agree with its capture", () => {
  // The last duplicated setup-identity column. The nine-column FK left it
  // free, so a reading could name a different physical unit from its own
  // capture - and the two read paths disagree about which they report
  // (`latest_setup_for_client` from the READING,
  // `setup_capture_history_for_block` from the CAPTURE), which is exactly the
  // contradiction that FK exists to prevent (Codex, 87c88017).
  //
  // IT IS A SECOND CONSTRAINT, not a wider first one, and these tests are why.
  // `studio_machine_id` is nullable with ON DELETE SET NULL; a composite FK is
  // MATCH SIMPLE, so the ENTIRE check is skipped whenever any referencing
  // column is NULL. Widening the nine-column constraint would have let a null
  // machine id switch off enforcement of all ten.
  let studio: SeededStudio;
  let blockId: string;
  let captureId: string;
  let machineA: string;
  let machineB: string;

  const setup = async () => {
    if (studio) return;
    studio = await seedStudio("machine-agree");
    blockId = (await seedSession(studio)).blockId;
    await publish(122);
    machineA = await register(studio, 122);
    machineB = await register(studio, 122);
    await recordAs(studio.userId, blockId, machineA, "g", [ok("current", "100")]);
    const r = await adminQuery(
      `select id from public.treatment_setup_captures where session_block_id = $1`,
      [blockId],
    );
    captureId = r.rows[0].id;
  };

  it("refuses a reading naming a DIFFERENT physical unit from its capture", async () => {
    await setup();
    await expect(
      adminQuery(
        `insert into public.treatment_setup_readings
           (capture_id, studio_id, session_block_id, machine_profile_id,
            machine_profile_version, mode_key, group_key, channels, field_key,
            value_numeric, native_unit, decimals, observation_source, revision,
            studio_machine_id)
         select c.id, c.studio_id, c.session_block_id, c.machine_profile_id,
                c.machine_profile_version, c.mode_key, c.group_key, c.channels,
                'duration', 1, 's', 1, 'practitioner-entered', c.revision,
                $2
           from public.treatment_setup_captures c where c.id = $1`,
        [captureId, machineB],
      ),
    ).rejects.toThrow(/capture_machine_fk|foreign key/i);
  });

  it("POSITIVE CONTROL: the SAME unit as its capture is accepted", async () => {
    await setup();
    await adminQuery(
      `insert into public.treatment_setup_readings
         (capture_id, studio_id, session_block_id, machine_profile_id,
          machine_profile_version, mode_key, group_key, channels, field_key,
          value_numeric, native_unit, decimals, observation_source, revision,
          studio_machine_id)
       select c.id, c.studio_id, c.session_block_id, c.machine_profile_id,
              c.machine_profile_version, c.mode_key, c.group_key, c.channels,
              'reps', 3, 'count', 0, 'practitioner-entered', c.revision,
              c.studio_machine_id
         from public.treatment_setup_captures c where c.id = $1`,
      [captureId],
    );
    const n = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_readings
        where capture_id = $1 and field_key = 'reps'`,
      [captureId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("refuses a reading with NO physical unit at all", async () => {
    // The column is NOT NULL now, which is what lets the composite FK be a
    // single constraint: a MATCH SIMPLE composite key skips its ENTIRE check
    // when any referencing column is NULL, so a nullable machine id would have
    // switched off enforcement of all ten columns.
    await setup();
    await expect(
      adminQuery(
        `insert into public.treatment_setup_readings
           (capture_id, studio_id, session_block_id, machine_profile_id,
            machine_profile_version, mode_key, group_key, channels, field_key,
            value_numeric, native_unit, decimals, observation_source, revision,
            studio_machine_id)
         select c.id, c.studio_id, c.session_block_id, c.machine_profile_id,
                c.machine_profile_version, c.mode_key, c.group_key, c.channels,
                'duration', 1, 's', 1, 'practitioner-entered', c.revision,
                null
           from public.treatment_setup_captures c where c.id = $1`,
        [captureId],
      ),
    ).rejects.toThrow(/null value in column "studio_machine_id"|not-null/i);
  });

  it("A CITED UNIT CANNOT BE ERASED: the delete is refused, not silently broken", async () => {
    // THIS TEST FOUND A REAL DEFECT, which is why it reads the way it does.
    //
    // The column was nullable with ON DELETE SET NULL, the stated reason being
    // that hard-deleting a retired unit must not orphan a clinical reading.
    // That could never happen: the append-only trigger refuses EVERY update to
    // a reading, including the system-driven one a SET NULL performs, so the
    // delete failed with "A recorded treatment setup reading is immutable" -
    // two guarantees written against each other, with the nullability buying
    // nothing.
    //
    // RESTRICT states the rule the clinical record actually wants: a unit named
    // by a reading is part of that record and is retired, never erased.
    const own = await seedStudio("machine-delete");
    const b = (await seedSession(own)).blockId;
    await publish(123);
    const m = await register(own, 123);
    await recordAs(own.userId, b, m, "g", [ok("current", "77")]);

    const before = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_readings
        where session_block_id = $1 and studio_machine_id = $2`,
      [b, m],
    );
    expect(before.rows[0].n, "the reading must name the unit first").toBe(1);

    await expect(
      adminQuery(`delete from public.studio_machines where id = $1`, [m]),
    ).rejects.toThrow(/violates foreign key|still referenced/i);

    // And the record is intact - the refusal protected it rather than
    // half-applying.
    const after = await adminQuery(
      `select r.studio_machine_id as m, r.value_numeric as v
         from public.treatment_setup_readings r where r.session_block_id = $1`,
      [b],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].m).toBe(m);
    expect(Number(after.rows[0].v)).toBe(77);
  });

  it("RETIREMENT is the supported path, and it still works", async () => {
    // The counterpart to the refusal above: taking a cited unit out of service
    // is always available, so RESTRICT blocks nothing anyone needs to do.
    await setup();
    const r = await asUser(studio.userId, (q) =>
      q(`select public.retire_studio_machine($1) as ok`, [machineA]),
    );
    expect(r.rows[0].ok).toBe(true);
    const still = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_readings
        where studio_machine_id = $1`,
      [machineA],
    );
    expect(still.rows[0].n, "retiring never touches the record").toBeGreaterThan(0);
  });

  it("POSITIVE CONTROL: an UNCITED unit can still be deleted", async () => {
    // RESTRICT must protect the record without freezing the inventory: a unit
    // registered by mistake, with nothing recorded against it, is still
    // deletable. Without this the refusal above could be passing because the
    // FK forbids every delete.
    const own = await seedStudio("machine-mistake");
    await publish(124);
    const m = await register(own, 124);
    await adminQuery(`delete from public.studio_machines where id = $1`, [m]);
    const gone = await adminQuery(
      `select count(*)::int as n from public.studio_machines where id = $1`,
      [m],
    );
    expect(gone.rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RETIREMENT'S OWN IDEMPOTENCE, which was the fourth instance of this class.
//
// `retire_studio_machine` documents itself as idempotent: it returns false if
// the unit was already out of service. It read `retired_at` with a plain
// select and then updated by id, so two overlapping requests could both
// observe NULL, both run their update, and the second would OVERWRITE the
// first's recorded retirement instant while also returning true - a stamped
// time belonging to neither request (Codex, d3e8b17b).
//
// The repair is the predicate, not another lock: the UPDATE is conditional on
// `retired_at is null`, its own row lock is the serialisation point, and the
// return value is derived from the row actually affected.
// ---------------------------------------------------------------------------
describe("0223 - retirement is idempotent under real concurrency", () => {
  it("the SECOND of two overlapping retirements returns false and changes nothing", async () => {
    const { studio, machineId } = await scene("retire-idem", 125);
    const first = await party(studio.userId);
    const second = await party(studio.userId);
    try {
      const won = await first.c.query(
        `select public.retire_studio_machine($1) as ok`,
        [machineId],
      );
      expect(won.rows[0].ok, "the first request must retire it").toBe(true);

      // The second request's conditional UPDATE must park on the first's row
      // lock rather than reading a stale NULL and proceeding.
      const racing = settle(
        second.c.query(`select public.retire_studio_machine($1) as ok`, [machineId]),
      );
      const wait = await expectBlockedOn(
        second.pid,
        "the second retirement must park on the first's row lock",
      );
      expect(wait).toMatch(/^Lock\//);

      await first.c.query("commit");
      const stamped = await adminQuery(
        `select retired_at from public.studio_machines where id = $1`,
        [machineId],
      );
      const instant = stamped.rows[0].retired_at;
      expect(instant, "the first request's instant must be recorded").not.toBeNull();

      const out = await bounded(racing, "the second retirement never settled");
      expect(out.ok, `it must complete, not error: ${!out.ok && out.message}`).toBe(true);
      expect(
        out.ok && out.rows[0]!.ok,
        "the second request did no work, so it must report false",
      ).toBe(false);
      await second.c.query("commit");

      // AND THE INSTANT IS THE FIRST REQUEST'S, not overwritten by the second.
      const after = await adminQuery(
        `select retired_at from public.studio_machines where id = $1`,
        [machineId],
      );
      expect(
        after.rows[0].retired_at,
        "the recorded retirement instant must belong to the request that did it",
      ).toEqual(instant);
    } finally {
      await first.c.end();
      await second.c.end();
    }
  });

  it("POSITIVE CONTROL: a single retirement returns true, and a later one false", async () => {
    // Sequentially, with no contention at all - so the test above is proving
    // something about concurrency rather than about the return value in
    // general.
    const { studio, machineId } = await scene("retire-seq", 126);
    const a = await asUser(studio.userId, (q) =>
      q(`select public.retire_studio_machine($1) as ok`, [machineId]),
    );
    expect(a.rows[0].ok).toBe(true);
    const b = await asUser(studio.userId, (q) =>
      q(`select public.retire_studio_machine($1) as ok`, [machineId]),
    );
    expect(b.rows[0].ok).toBe(false);
  });

  it("a second retirement does NOT re-run the default cleanup", async () => {
    // The cleanup clears this machine from every practitioner default. Running
    // it again on the no-op path would be harmless today, but the guard is
    // deliberate: by then the practitioner may have chosen ANOTHER machine,
    // and a blind re-run keyed on the old id must not disturb it.
    const { studio, machineId } = await scene("retire-cleanup", 127);
    const replacement = await register(studio, 127);

    await asUser(studio.userId, (q) =>
      q(`select public.set_own_default_machine($1,$2,null)`, [
        studio.studioId,
        machineId,
      ]),
    );
    await asUser(studio.userId, (q) =>
      q(`select public.retire_studio_machine($1) as ok`, [machineId]),
    );
    // The practitioner picks a different unit afterwards.
    await asUser(studio.userId, (q) =>
      q(`select public.set_own_default_machine($1,$2,null)`, [
        studio.studioId,
        replacement,
      ]),
    );
    // A repeat retirement of the FIRST machine must leave that choice alone.
    const again = await asUser(studio.userId, (q) =>
      q(`select public.retire_studio_machine($1) as ok`, [machineId]),
    );
    expect(again.rows[0].ok).toBe(false);

    const after = await adminQuery(
      `select default_machine_id from public.practitioners where id = $1`,
      [studio.practitionerId],
    );
    expect(after.rows[0].default_machine_id).toBe(replacement);
  });
});

// ---------------------------------------------------------------------------
// DISTINCT SETTING GROUPS, against the real command.
//
// The entry surface hard-coded one group with no channels while the schema,
// the command and both read paths had always supported several groups with
// channel associations - so a practitioner running probes at different
// settings could store only one apparently global setup (Codex, 15cc6c99).
//
// WHAT THIS SECTION IS FOR. The UI slice is only safe if the AUTHORITY already
// represents it, so these tests use `record_treatment_setup_group` exactly as
// the form now does - one call per group - and check that the groups stay
// separate, keep their own channels, keep their own revision sequences, and
// that every invalid combination is refused by the database rather than by the
// form.
// ---------------------------------------------------------------------------
describe("0223 - two setting groups in one block stay distinct", () => {
  const recordGroup = (
    userId: string,
    blockId: string,
    machineId: string,
    group: string,
    channels: number[],
    value: string,
  ) =>
    asUser(userId, (q) =>
      q(`select public.record_treatment_setup_group($1,$2,$3,$4,$5,$6::jsonb) as n`, [
        blockId,
        machineId,
        "galvanic",
        group,
        channels,
        JSON.stringify([ok("current", value)]),
      ]),
    );

  it("records two groups with DIFFERENT channels and values, and reads both back", async () => {
    const { studio, blockId, machineId } = await scene("groups-two", 130);

    await recordGroup(studio.userId, blockId, machineId, "g1", [1, 2], "120");
    await recordGroup(studio.userId, blockId, machineId, "g2", [3, 4], "80");

    const rows = await adminQuery(
      `select c.group_key, c.channels, c.revision, r.value_numeric as v
         from public.treatment_setup_captures c
         join public.treatment_setup_readings r on r.capture_id = c.id
        where c.session_block_id = $1 and r.field_key = 'current'
        order by c.group_key`,
      [blockId],
    );
    expect(rows.rows).toHaveLength(2);

    const [g1, g2] = rows.rows as Array<{
      group_key: string;
      channels: number[];
      revision: number;
      v: string;
    }>;
    expect(g1!.group_key).toBe("g1");
    expect(g1!.channels, "g1 kept its own probes").toEqual([1, 2]);
    expect(Number(g1!.v), "and its own value").toBe(120);
    expect(g2!.group_key).toBe("g2");
    expect(g2!.channels, "g2 kept its own probes").toEqual([3, 4]);
    expect(Number(g2!.v), "and its own value").toBe(80);

    // EACH GROUP HAS ITS OWN REVISION SEQUENCE. Both are the first capture of
    // their own group, so both are revision 1 - they are not two revisions of
    // one thing.
    expect(g1!.revision).toBe(1);
    expect(g2!.revision).toBe(1);
  });

  it("appends a revision WITHIN one group without touching the other", async () => {
    // The capture/revision boundary, which the UI slice must not blur: a
    // changed setting on probes 1-2 is revision 2 of g1 and leaves g2 alone.
    const { studio, blockId, machineId } = await scene("groups-rev", 131);
    await recordGroup(studio.userId, blockId, machineId, "g1", [1], "120");
    await recordGroup(studio.userId, blockId, machineId, "g2", [2], "80");
    await recordGroup(studio.userId, blockId, machineId, "g1", [1], "135");

    const rows = await adminQuery(
      `select group_key, revision, channels
         from public.treatment_setup_captures
        where session_block_id = $1
        order by group_key, revision`,
      [blockId],
    );
    expect(
      rows.rows.map((r: { group_key: string; revision: number }) => [
        r.group_key,
        r.revision,
      ]),
    ).toEqual([
      ["g1", 1],
      ["g1", 2],
      ["g2", 1],
    ]);
  });

  it("the HISTORY read returns each group's exact recorded channels", async () => {
    // What next-visit guidance and the block history are read from. If this
    // flattened the associations, the whole slice would be pointless.
    const { studio, blockId, machineId } = await scene("groups-history", 132);
    await recordGroup(studio.userId, blockId, machineId, "g1", [1, 2], "120");
    await recordGroup(studio.userId, blockId, machineId, "g2", [4], "80");

    const hist = await asUser(studio.userId, (q) =>
      q(`select public.setup_capture_history_for_block($1) as r`, [blockId]),
    );
    const captures = hist.rows[0].r as Array<{
      group_key: string;
      channels: number[];
    }>;
    const byGroup = new Map(captures.map((c) => [c.group_key, c.channels]));
    expect(byGroup.get("g1")).toEqual([1, 2]);
    expect(byGroup.get("g2")).toEqual([4]);
  });

  it("an UNASSOCIATED group records no channels, and is not widened to all", async () => {
    // `associationRequired` is false by a recorded practitioner ruling, so a
    // group without named probes is legal. It must stay EMPTY: turning it into
    // every channel would assert a clinical fact nobody entered.
    const { studio, blockId, machineId } = await scene("groups-none", 133);
    await recordGroup(studio.userId, blockId, machineId, "g1", [], "120");

    const rows = await adminQuery(
      `select channels from public.treatment_setup_captures
        where session_block_id = $1`,
      [blockId],
    );
    expect(rows.rows[0].channels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("0223 - invalid channel and group combinations are refused BY THE DATABASE", () => {
  const tryGroup = (
    userId: string,
    blockId: string,
    machineId: string,
    group: string,
    channels: number[],
  ) =>
    asUser(userId, (q) =>
      q(`select public.record_treatment_setup_group($1,$2,$3,$4,$5,$6::jsonb) as n`, [
        blockId,
        machineId,
        "galvanic",
        group,
        channels,
        JSON.stringify([ok("current", "120")]),
      ]),
    );

  it("refuses a channel above the published maximum", async () => {
    const { studio, blockId, machineId } = await scene("groups-bad-high", 134);
    await expect(
      tryGroup(studio.userId, blockId, machineId, "g1", [9]),
    ).rejects.toThrow(/channel/i);
  });

  it("refuses a channel named twice in one group", async () => {
    const { studio, blockId, machineId } = await scene("groups-bad-dup", 135);
    await expect(
      tryGroup(studio.userId, blockId, machineId, "g1", [2, 2]),
    ).rejects.toThrow(/channel/i);
  });

  it("refuses an EMPTY group key, which no stable identity can be", async () => {
    const { studio, blockId, machineId } = await scene("groups-bad-key", 136);
    await expect(
      tryGroup(studio.userId, blockId, machineId, "   ", [1]),
    ).rejects.toThrow(/mode and a settings group are required/i);
  });

  it("refuses ANOTHER TENANT's member recording into this block", async () => {
    // Group identity is per block, and a block belongs to a studio. A group
    // key is not a capability: naming one in another tenant's block must fail
    // on membership, not on the key.
    const { blockId, machineId } = await scene("groups-tenant", 137);
    const stranger = await seedStudio("groups-stranger");
    await expect(
      tryGroup(stranger.userId, blockId, machineId, "g1", [1]),
    ).rejects.toThrow(/Unknown treatment block|not an active member/i);
  });

  it("POSITIVE CONTROL: the same call with valid channels succeeds", async () => {
    // Without this, every refusal above could be passing for an unrelated
    // reason - the machine unregistered, the contract unpublished, the block
    // retired.
    const { studio, blockId, machineId } = await scene("groups-good", 138);
    const out = await tryGroup(studio.userId, blockId, machineId, "g1", [1, 4]);
    expect(Number(out.rows[0].n)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// NEXT-VISIT GUIDANCE RETURNS EVERY GROUP OF THE LATEST SETUP.
//
// `latest_setup_for_client` selected ONE capture - `order by recorded_at desc,
// revision desc limit 1` - which was right while one setup meant one group and
// wrong the moment the entry surface could record several. Both groups' rows
// persisted and guidance showed only the last one, SILENTLY OMITTING the other
// probes' settings (Codex, f175e732).
//
// THE NO-COMPOSITE INVARIANT IS THE REASON THE FIX IS SHAPED THIS WAY. The
// original danger was a setup that never existed - a current from one capture
// beside a duration from another. So the anchor pins one identity (block,
// unit, profile version, mode) and takes each group's LATEST revision within
// it. These tests hold both halves: nothing is hidden, and nothing is mixed.
// ---------------------------------------------------------------------------
describe("0223 - the latest setup includes every group, coherently", () => {
  const recordGroup = (
    userId: string,
    blockId: string,
    machineId: string,
    group: string,
    channels: number[],
    value: string,
  ) =>
    asUser(userId, (q) =>
      q(`select public.record_treatment_setup_group($1,$2,$3,$4,$5,$6::jsonb) as n`, [
        blockId,
        machineId,
        "galvanic",
        group,
        channels,
        JSON.stringify([ok("current", value)]),
      ]),
    );

  type Row = {
    group_key: string;
    channels: number[];
    revision: number;
    value_numeric: string;
    field_key: string;
  };

  const guidance = async (studio: SeededStudio): Promise<Row[]> => {
    const r = await asUser(studio.userId, (q) =>
      q(`select public.latest_setup_for_client($1,$2) as g`, [
        studio.studioId,
        studio.clientId,
      ]),
    );
    return (r.rows[0].g as Row[]) ?? [];
  };

  it("returns BOTH groups, each with its own channels and value", () => {
    // Deliberately written as the defect's inverse: before the fix this
    // returned only g2 and the g1 assertion below failed.
    return (async () => {
      const { studio, blockId, machineId } = await scene("latest-two", 140);
      await recordGroup(studio.userId, blockId, machineId, "g1", [1, 2], "120");
      await recordGroup(studio.userId, blockId, machineId, "g2", [3, 4], "80");

      const rows = await guidance(studio);
      const byGroup = new Map(rows.map((r) => [r.group_key, r]));
      expect(
        [...byGroup.keys()].sort(),
        "a group recorded in this setup must not be hidden from guidance",
      ).toEqual(["g1", "g2"]);
      expect(byGroup.get("g1")!.channels).toEqual([1, 2]);
      expect(byGroup.get("g2")!.channels).toEqual([3, 4]);
      expect(Number(byGroup.get("g1")!.value_numeric)).toBe(120);
      expect(Number(byGroup.get("g2")!.value_numeric)).toBe(80);
    })();
  });

  it("returns each group's LATEST revision, never a superseded one", async () => {
    const { studio, blockId, machineId } = await scene("latest-rev", 141);
    await recordGroup(studio.userId, blockId, machineId, "g1", [1], "120");
    await recordGroup(studio.userId, blockId, machineId, "g2", [2], "80");
    await recordGroup(studio.userId, blockId, machineId, "g1", [1], "135");

    const rows = await guidance(studio);
    const byGroup = new Map(rows.map((r) => [r.group_key, r]));
    expect(byGroup.get("g1")!.revision, "g1's newer capture").toBe(2);
    expect(Number(byGroup.get("g1")!.value_numeric)).toBe(135);
    expect(byGroup.get("g2")!.revision, "g2 was not re-recorded").toBe(1);
    expect(Number(byGroup.get("g2")!.value_numeric)).toBe(80);
    // AND THE SUPERSEDED VALUE IS ABSENT. This is the assertion that would
    // catch the fix over-reaching into "every revision of every group".
    expect(
      rows.map((r) => Number(r.value_numeric)).sort((a, b) => a - b),
      "120 was superseded by 135 and must not be offered back",
    ).toEqual([80, 135]);
  });

  it("does NOT mix an EARLIER setup's groups into the latest one", async () => {
    // The composite the old `limit 1` was protecting against, restated for
    // groups: a previous visit's capture must not appear beside this one's
    // just because it shares a group key.
    const studio = await seedStudio("latest-earlier");
    await publish(142);
    const machineId = await register(studio, 142);
    const first = await seedSession(studio);
    const second = await seedSession(studio);

    await recordGroup(studio.userId, first.blockId, machineId, "g1", [1], "100");
    await recordGroup(studio.userId, second.blockId, machineId, "g1", [2], "200");

    const rows = await guidance(studio);
    expect(rows, "one block's setup only").toHaveLength(1);
    expect(Number(rows[0]!.value_numeric), "the newer block's").toBe(200);
    expect(rows[0]!.channels).toEqual([2]);
  });

  it("does NOT mix groups recorded on a DIFFERENT machine", async () => {
    // Two units in one block is unusual but representable, and "the setup she
    // was last working at" cannot span two machines - that would be a setup
    // that never existed.
    const studio = await seedStudio("latest-two-machines");
    const { blockId } = await seedSession(studio);
    await publish(143);
    const a = await register(studio, 143);
    const b = await register(studio, 143);

    await recordGroup(studio.userId, blockId, a, "g1", [1], "100");
    await recordGroup(studio.userId, blockId, b, "g2", [2], "200");

    const rows = await guidance(studio);
    expect(rows, "only the newest machine's setup").toHaveLength(1);
    expect(rows[0]!.group_key).toBe("g2");
    expect(Number(rows[0]!.value_numeric)).toBe(200);
  });

  it("a single-group setup is unchanged, which is the ordinary case", async () => {
    // The regression guard: most machines have no channels and record one
    // group, and that path must look exactly as it did.
    const { studio, blockId, machineId } = await scene("latest-one", 144);
    await recordGroup(studio.userId, blockId, machineId, "g1", [], "120");
    const rows = await guidance(studio);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.group_key).toBe("g1");
    expect(rows[0]!.channels).toEqual([]);
  });

  it("a retired SESSION is still excluded from guidance", async () => {
    // The pre-existing rule the rewrite had to carry forward: the anchor
    // filters retired blocks and sessions, and widening the read must not have
    // dropped that.
    const { studio, sessionId, blockId, machineId } = await scene("latest-retired", 145);
    await recordGroup(studio.userId, blockId, machineId, "g1", [1], "120");
    await recordGroup(studio.userId, blockId, machineId, "g2", [2], "80");
    expect(await guidance(studio), "present before retirement").toHaveLength(2);

    await adminQuery(`update public.sessions set deleted_at = now() where id = $1`, [
      sessionId,
    ]);
    expect(
      await guidance(studio),
      "a retired session's setup is not guidance, however many groups it had",
    ).toEqual([]);
  });
});
