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
// 0223 — ONE SAVE of machine settings: record_treatment_setup_submission.
//
// *** UNEXECUTED AT THE TIME OF WRITING. *** This file was authored against
// 2839d9a0 with NO database available. Nothing below has been run. Until it
// has, it is a specification of the command's behaviour and not evidence of
// it — and the distinction is the whole reason this file exists at all:
// 0204 shipped a command writing to a column that did not exist, applied
// clean, passed its source test, and had never once succeeded. A source
// contract cannot see inside a plpgsql body.
//
// WHAT THE COMMAND IS FOR. `record_treatment_setup_group` records ONE group
// per call. Once the entry surface could record several, a Save became
// several independent calls and three invariants became unreachable
// (Codex, #860 6157725545):
//
//   ATOMICITY — two calls can half-succeed, leaving one group of a two-group
//   setup with no record that a second was ever intended;
//   CROSS-GROUP CHANNEL EXCLUSIVITY — each call carries its own
//   duplicate-free channel array, so two calls claiming probe 2 are two
//   individually VALID calls the database cannot see as related;
//   IDEMPOTENCY — with no identity for the Save, a retry after a lost
//   response is indistinguishable from a deliberate second capture.
//
// SYNTHETIC PROFILE IDS THROUGHOUT, as in every other 0223 DB file: the
// curated catalogue activates no real model, and 0223 deliberately does not
// constrain `machine_profile_id` to a known set.
// ===========================================================================

const PROFILE = "fixture:db-submission";
const VERSION = 1;

/**
 * A SECOND POOL, for the two tests that genuinely need two connections at
 * once.
 *
 * `asUser` opens its own transaction and commits at the end, which is right
 * for everything else and useless for a concurrency proof: a lock held inside
 * it is released before the next statement in the test runs. These two tests
 * drive raw clients so one transaction can be held OPEN while another runs.
 */
const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 6 });

afterAll(async () => {
  await pool.end();
  await closePool();
});

async function publishContract(channelsMax: number | null = 4): Promise<void> {
  await adminQuery(
    `select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      PROFILE,
      VERSION,
      "galvanic",
      channelsMax,
      null,
      JSON.stringify([
        { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
        { field_key: "duration", native_unit: "s", decimals: 1, quantity: "duration" },
      ]),
    ],
  );
}

async function registerMachine(
  studio: SeededStudio,
  displayName = "Room 1",
): Promise<string> {
  await publishContract();
  return asUser(studio.userId, async (q) => {
    const r = await q(
      `select public.register_studio_machine($1,$2,$3,$4,$5) as id`,
      [studio.studioId, PROFILE, VERSION, displayName, []],
    );
    return r.rows[0].id as string;
  });
}

const reading = (field: string, value: string) => ({
  field_key: field,
  value,
  observation_source: "practitioner-entered",
});

type Group = {
  group_key: string;
  channels: number[];
  readings: Array<ReturnType<typeof reading>>;
};

const group = (key: string, channels: number[], current: string): Group => ({
  group_key: key,
  channels,
  readings: [reading("current", current)],
});

type SaveResult = {
  submission_id: string;
  groups: number;
  readings: number;
  reused: boolean;
};

/** Call the command as a signed-in practitioner. */
async function save(
  userId: string,
  blockId: string,
  machineId: string,
  key: string,
  groups: Group[],
): Promise<SaveResult> {
  return asUser(userId, async (q) => {
    const r = await q(
      `select public.record_treatment_setup_submission($1,$2,$3,$4,$5::jsonb) as r`,
      [blockId, machineId, "galvanic", key, JSON.stringify(groups)],
    );
    return r.rows[0].r as SaveResult;
  });
}

/** Captures of one block, newest last, with their submission link. */
async function capturesOf(blockId: string) {
  const r = await adminQuery(
    `select group_key, revision, setup_submission_id, channels
       from public.treatment_setup_captures
      where session_block_id = $1
      order by group_key, revision`,
    [blockId],
  );
  return r.rows as Array<{
    group_key: string;
    revision: number;
    setup_submission_id: string | null;
    channels: number[];
  }>;
}

async function readingCount(blockId: string): Promise<number> {
  const r = await adminQuery(
    `select count(*)::int as n from public.treatment_setup_readings
      where session_block_id = $1`,
    [blockId],
  );
  return r.rows[0].n as number;
}

// ---------------------------------------------------------------------------
// Part 1 — a save is ONE fact
// ---------------------------------------------------------------------------

describe("0223 · one Save records every group as one submission", () => {
  it("records two groups under a single submission, each at its own revision", async () => {
    const studio = await seedStudio("sub-two");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    const out = await save(studio.userId, blockId, machineId, "save-key-aaaa1", [
      group("g1", [1, 2], "120"),
      group("g2", [3], "80"),
    ]);

    expect(out.submission_id).toBeTruthy();
    expect(out.groups).toBe(2);
    expect(out.readings).toBe(2);
    expect(out.reused).toBe(false);

    const caps = await capturesOf(blockId);
    expect(caps).toHaveLength(2);
    // ONE submission, both captures. This is the fact that did not exist
    // before: two groups saved together are now visibly one act.
    expect(new Set(caps.map((c) => c.setup_submission_id)).size).toBe(1);
    expect(caps[0]!.setup_submission_id).toBe(out.submission_id);
    // Each group keeps its OWN revision sequence within the block.
    expect(caps.map((c) => c.revision)).toEqual([1, 1]);
    // And its own channels, unsorted and unmerged.
    expect(caps.find((c) => c.group_key === "g1")!.channels).toEqual([1, 2]);
    expect(caps.find((c) => c.group_key === "g2")!.channels).toEqual([3]);
  });

  it("records the setup identity the save was made under", async () => {
    // A save under a different machine or mode cannot join this submission,
    // which is what stops a stale group reappearing when a practitioner
    // returns to a machine she had left.
    const studio = await seedStudio("sub-identity");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    const out = await save(studio.userId, blockId, machineId, "save-key-aaaa2", [
      group("g1", [1], "120"),
    ]);
    const r = await adminQuery(
      `select studio_machine_id, machine_profile_id, machine_profile_version,
              mode_key, recorded_by_practitioner_id
         from public.treatment_setup_submissions where id = $1`,
      [out.submission_id],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].studio_machine_id).toBe(machineId);
    expect(r.rows[0].machine_profile_id).toBe(PROFILE);
    expect(r.rows[0].machine_profile_version).toBe(VERSION);
    expect(r.rows[0].mode_key).toBe("galvanic");
    expect(r.rows[0].recorded_by_practitioner_id).toBe(studio.practitionerId);
  });

  it("leaves a SINGLE-GROUP capture recorded the old way with a NULL submission", async () => {
    // THE NULL IS MEANINGFUL and must never be backfilled. A capture written
    // by `record_treatment_setup_group` was recorded on its own, which is a
    // fact about how it was recorded rather than missing data. Making the
    // per-group command a thin wrapper over this one would have stamped every
    // such capture with a synthetic one-group submission and destroyed the
    // distinction.
    const studio = await seedStudio("sub-null");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await asUser(studio.userId, (q) =>
      q(
        `select public.record_treatment_setup_group($1,$2,$3,$4,$5::smallint[],$6::jsonb)`,
        [blockId, machineId, "galvanic", "g1", [1], JSON.stringify([reading("current", "120")])],
      ),
    );

    const caps = await capturesOf(blockId);
    expect(caps).toHaveLength(1);
    expect(caps[0]!.setup_submission_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — idempotency, which is what makes a retry safe
// ---------------------------------------------------------------------------

describe("0223 · a retry of the same save is absorbed, not appended", () => {
  it("returns the ORIGINAL submission and writes no second capture", async () => {
    const studio = await seedStudio("sub-retry");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const key = "save-key-retry01";
    const groups = [group("g1", [1], "120"), group("g2", [2], "80")];

    const first = await save(studio.userId, blockId, machineId, key, groups);
    const retry = await save(studio.userId, blockId, machineId, key, groups);

    expect(retry.submission_id).toBe(first.submission_id);
    expect(retry.reused).toBe(true);
    // IT REPORTS WHAT THE ORIGINAL RECORDED, not what this call sent. On a
    // lost response the caller never learned those numbers, so this is the
    // only true answer it can be given.
    expect(retry.groups).toBe(2);
    expect(retry.readings).toBe(2);

    // AND THE RECORD IS UNCHANGED, which is the claim that matters. Captures
    // are append-only, so a second write here would be permanent.
    expect(await capturesOf(blockId)).toHaveLength(2);
    expect(await readingCount(blockId)).toBe(2);
  });

  it("CONTROL: a DIFFERENT key records a second capture", async () => {
    // Without this, "the retry was absorbed" could be true because nothing
    // ever records twice - which would make the test above vacuous.
    const studio = await seedStudio("sub-newkey");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    const first = await save(studio.userId, blockId, machineId, "save-key-new001", [
      group("g1", [1], "120"),
    ]);
    const second = await save(studio.userId, blockId, machineId, "save-key-new002", [
      group("g1", [1], "130"),
    ]);

    expect(second.submission_id).not.toBe(first.submission_id);
    expect(second.reused).toBe(false);
    const caps = await capturesOf(blockId);
    expect(caps).toHaveLength(2);
    // A second capture of the SAME group is its next revision.
    expect(caps.map((c) => c.revision)).toEqual([1, 2]);
  });

  it("refuses a key reused for a DIFFERENT save", async () => {
    // Returning the old submission here would tell the caller its new groups
    // were stored when nothing was written. A re-registered machine lands
    // here too, and correctly: the save being retried is no longer the save
    // that was made.
    const studio = await seedStudio("sub-keyclash");
    const { blockId } = await seedSession(studio);
    const a = await registerMachine(studio, "Room 1");
    const b = await registerMachine(studio, "Room 2");
    const key = "save-key-clash01";

    await save(studio.userId, blockId, a, key, [group("g1", [1], "120")]);
    await expect(
      save(studio.userId, blockId, b, key, [group("g1", [1], "120")]),
    ).rejects.toThrow(/different save/i);
  });

  it("refuses a retry key that is too short to be unique", async () => {
    const studio = await seedStudio("sub-shortkey");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    await expect(
      save(studio.userId, blockId, machineId, "short", [group("g1", [1], "120")]),
    ).rejects.toThrow(/retry key/i);
  });

  it("scopes the key to its BLOCK, so two treatments never collide", async () => {
    const studio = await seedStudio("sub-keyscope");
    const one = await seedSession(studio);
    const two = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const key = "save-key-scope01";

    const first = await save(studio.userId, one.blockId, machineId, key, [
      group("g1", [1], "120"),
    ]);
    const other = await save(studio.userId, two.blockId, machineId, key, [
      group("g1", [1], "120"),
    ]);
    expect(other.submission_id).not.toBe(first.submission_id);
    expect(other.reused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — cross-group exclusivity, and atomicity
// ---------------------------------------------------------------------------

describe("0223 · a probe cannot be on two settings at once", () => {
  it("refuses a channel claimed by two groups, and writes NOTHING", async () => {
    // THE INVARIANT ONLY A WHOLE-SAVE COMMAND CAN SEE. As two separate calls
    // these were two individually valid, duplicate-free payloads.
    const studio = await seedStudio("sub-overlap");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await expect(
      save(studio.userId, blockId, machineId, "save-key-overlap1", [
        group("g1", [1, 2], "120"),
        group("g2", [2, 3], "80"),
      ]),
    ).rejects.toThrow(/claimed by more than one settings group/i);

    // ATOMIC: not the first group, not the submission row, nothing.
    expect(await capturesOf(blockId)).toHaveLength(0);
    expect(await readingCount(blockId)).toBe(0);
    const subs = await adminQuery(
      `select count(*)::int as n from public.treatment_setup_submissions
        where session_block_id = $1`,
      [blockId],
    );
    expect(subs.rows[0].n).toBe(0);
  });

  it("CONTROL: the same two groups on DISJOINT channels are recorded", async () => {
    // Otherwise "overlap is refused" could be true because every two-group
    // save is refused.
    const studio = await seedStudio("sub-disjoint");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    const out = await save(studio.userId, blockId, machineId, "save-key-disjoint", [
      group("g1", [1, 2], "120"),
      group("g2", [3, 4], "80"),
    ]);
    expect(out.groups).toBe(2);
    expect(await capturesOf(blockId)).toHaveLength(2);
  });

  it("refuses the same group key twice in one save", async () => {
    // Two groups under one key are not two groups; each would silently become
    // a revision of the other.
    const studio = await seedStudio("sub-dupgroup");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    await expect(
      save(studio.userId, blockId, machineId, "save-key-dupgroup", [
        group("g1", [1], "120"),
        group("g1", [2], "80"),
      ]),
    ).rejects.toThrow(/more than once in this save/i);
    expect(await capturesOf(blockId)).toHaveLength(0);
  });

  it("rolls the WHOLE save back when a later group is invalid", async () => {
    // The atomicity claim, proved on a failure that happens INSIDE the loop
    // rather than in the pre-checks: the first group is valid and is written
    // before the second is rejected.
    const studio = await seedStudio("sub-rollback");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await expect(
      save(studio.userId, blockId, machineId, "save-key-rollback", [
        { ...group("g1", [1], "120") },
        {
          group_key: "g2",
          channels: [2],
          // Not a field of this profile's contract, so the shared writer
          // refuses it - after g1's capture has already been inserted.
          readings: [reading("not_a_field", "5")],
        },
      ]),
    ).rejects.toThrow(/has no field/i);

    expect(await capturesOf(blockId)).toHaveLength(0);
    expect(await readingCount(blockId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Part 4 — concurrency
// ---------------------------------------------------------------------------

/** Begin a transaction on a raw client, as a signed-in practitioner. */
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
  // way a concurrency test passes without the race it claims to exercise
  // ever having happened.
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

describe("0223 · two concurrent saves of the same groups do not deadlock", () => {
  it("queues instead, whichever order the groups are given in", async () => {
    // THE HAZARD THE SORT FIXES. The shared writer takes
    // pg_advisory_xact_lock per (block, group) to allocate a revision. Given
    // the groups in opposite order, two saves would each hold the lock the
    // other wants - a real deadlock, aborted by Postgres as 40P01, surfacing
    // to a practitioner as a failed save with no cause she could act on.
    // The command writes groups in sorted key order, so both take g1 first.
    const studio = await seedStudio("sub-deadlock");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    const a = await beginAsUser(studio.userId);
    const b = await beginAsUser(studio.userId);
    try {
      const runA = a.query(
        `select public.record_treatment_setup_submission($1,$2,$3,$4,$5::jsonb) as r`,
        [
          blockId,
          machineId,
          "galvanic",
          "save-key-concur-a",
          JSON.stringify([group("g1", [1], "120"), group("g2", [2], "80")]),
        ],
      );
      const runB = b.query(
        `select public.record_treatment_setup_submission($1,$2,$3,$4,$5::jsonb) as r`,
        [
          blockId,
          machineId,
          "galvanic",
          "save-key-concur-b",
          // THE OPPOSITE ORDER, which is the whole point of the test.
          JSON.stringify([group("g2", [3], "90"), group("g1", [4], "70")]),
        ],
      );
      // BOTH SETTLED BEFORE ANYTHING IS ASSERTED. An unsettled query is an
      // unhandled rejection, and Vitest warns that one can make a test pass
      // for the wrong reason.
      const [ra, rb] = await Promise.allSettled([runA, runB]);
      await a.query("commit");
      await b.query("commit");

      for (const [name, result] of [
        ["A", ra],
        ["B", rb],
      ] as const) {
        if (result.status === "rejected") {
          const message = String(result.reason);
          expect(message, `save ${name} DEADLOCKED`).not.toMatch(/deadlock/i);
          expect(message, `save ${name} timed out waiting`).not.toMatch(
            /lock timeout|canceling statement/i,
          );
          throw new Error(`save ${name} failed unexpectedly: ${message}`);
        }
      }

      // Both committed, and each group now has two revisions.
      const caps = await capturesOf(blockId);
      expect(caps).toHaveLength(4);
      expect(caps.filter((c) => c.group_key === "g1").map((c) => c.revision)).toEqual([
        1, 2,
      ]);
      expect(caps.filter((c) => c.group_key === "g2").map((c) => c.revision)).toEqual([
        1, 2,
      ]);
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }
  });

  it("VACUITY CONTROL: this harness CAN observe a deadlock", async () => {
    // The test above asserts an absence, so it would pass just as happily if
    // two transactions here could never conflict at all. This takes the same
    // kind of advisory locks by hand, in opposite order, and requires
    // Postgres to abort one of them.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      await b.query("begin");
      await a.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        "negctl:lock:one",
      ]);
      await b.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        "negctl:lock:two",
      ]);
      const crossA = a.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["negctl:lock:two"],
      );
      const crossB = b.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["negctl:lock:one"],
      );
      const settled = await Promise.allSettled([crossA, crossB]);
      const messages = settled
        .filter((r) => r.status === "rejected")
        .map((r) => String((r as PromiseRejectedResult).reason));
      expect(
        messages.some((m) => /deadlock/i.test(m)),
        "the harness never observed a deadlock, so the test above proves nothing",
      ).toBe(true);
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }
  });
});

describe("0223 · a session retired MID-SAVE records nothing", () => {
  it("re-checks liveness after taking the lock, and refuses", async () => {
    // THE RACE THE LOCKS EXIST FOR. Reading that a session is live is not the
    // same as holding it that way: a plain lookup can observe it live and
    // have the retirement commit before the capture inserts, leaving an
    // IMMUTABLE capture attached to a record that had been removed. Small
    // window, permanent consequence.
    const studio = await seedStudio("sub-retired");
    const { sessionId, blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    // The retirement holds the sessions row, uncommitted.
    const retire = await pool.connect();
    const saver = await beginAsUser(studio.userId);
    try {
      await retire.query("begin");
      await retire.query(
        `update public.sessions set deleted_at = now() where id = $1`,
        [sessionId],
      );

      const pid = (await saver.query("select pg_backend_pid() as pid")).rows[0]
        .pid as number;
      const run = saver.query(
        `select public.record_treatment_setup_submission($1,$2,$3,$4,$5::jsonb) as r`,
        [
          blockId,
          machineId,
          "galvanic",
          "save-key-retired1",
          JSON.stringify([group("g1", [1], "120")]),
        ],
      );

      // IT MUST ACTUALLY BLOCK. If it does not, the `for share` is not doing
      // its job and the rest of this test would pass for the wrong reason.
      const blocked = await waitUntilBlocked(pid);
      expect(blocked, "the save never waited for the sessions lock").toBe(true);

      await retire.query("commit");

      // Unblocked, it re-reads liveness and refuses.
      await expect(run).rejects.toThrow(/Unknown treatment block/i);
    } finally {
      await retire.query("rollback").catch(() => undefined);
      await saver.query("rollback").catch(() => undefined);
      retire.release();
      saver.release();
    }

    expect(await capturesOf(blockId)).toHaveLength(0);
    expect(await readingCount(blockId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Part 5 — the building blocks are not entry points
// ---------------------------------------------------------------------------

describe("0223 · the shared internals cannot be called directly", () => {
  // `record_setup_group_in_scope` TRUSTS the studio and practitioner it is
  // handed, because its callers have just proved them. A role that could call
  // it would write a capture into any studio it named.
  for (const role of ["anon", "authenticated", "service_role"] as const) {
    it(`refuses EXECUTE on record_setup_group_in_scope to ${role}`, async () => {
      await expect(
        asRole(role, (q) =>
          q(
            `select public.record_setup_group_in_scope(
               $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::text[],$8,$9,
               $10::smallint[],$11::jsonb,null)`,
            [
              "00000000-0000-0000-0000-000000000001",
              "00000000-0000-0000-0000-000000000002",
              "00000000-0000-0000-0000-000000000003",
              "00000000-0000-0000-0000-000000000004",
              PROFILE,
              VERSION,
              [],
              "galvanic",
              "g1",
              [1],
              JSON.stringify([reading("current", "120")]),
            ],
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it(`refuses EXECUTE on assert_setup_scope to ${role}`, async () => {
      await expect(
        asRole(role, (q) =>
          q(`select public.assert_setup_scope($1::uuid,$2::uuid)`, [
            "00000000-0000-0000-0000-000000000001",
            "00000000-0000-0000-0000-000000000002",
          ]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  }

  it("CONTROL: the SAVE command itself IS callable by authenticated", async () => {
    // Otherwise every refusal above could be a typo in a signature rather
    // than a privilege decision.
    const studio = await seedStudio("sub-grant");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const out = await save(studio.userId, blockId, machineId, "save-key-grant01", [
      group("g1", [1], "120"),
    ]);
    expect(out.groups).toBe(1);
  });

  it("refuses direct DML on the submissions table", async () => {
    const studio = await seedStudio("sub-dml");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    await expect(
      asUser(studio.userId, (q) =>
        q(
          `insert into public.treatment_setup_submissions
             (studio_id, session_block_id, studio_machine_id,
              machine_profile_id, machine_profile_version, mode_key,
              idempotency_key)
           values ($1,$2,$3,$4,$5,'galvanic','forged-key-0001')`,
          [studio.studioId, blockId, machineId, PROFILE, VERSION],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("a member can READ the submissions of their own studio, and no other", async () => {
    const mine = await seedStudio("sub-rls-mine");
    const theirs = await seedStudio("sub-rls-theirs");
    const { blockId } = await seedSession(mine);
    const machineId = await registerMachine(mine);
    const out = await save(mine.userId, blockId, machineId, "save-key-rls0001", [
      group("g1", [1], "120"),
    ]);

    const own = await asUser(mine.userId, (q) =>
      q(`select id from public.treatment_setup_submissions where id = $1`, [
        out.submission_id,
      ]),
    );
    expect(own.rows).toHaveLength(1);

    const other = await asUser(theirs.userId, (q) =>
      q(`select id from public.treatment_setup_submissions where id = $1`, [
        out.submission_id,
      ]),
    );
    expect(other.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Part 6 — what next-visit guidance makes of it
// ---------------------------------------------------------------------------

describe("0223 · guidance returns every group of the latest save", () => {
  it("shows both groups, each at its own revision, with its own instant", async () => {
    // The read contract returns the latest-observed GROUPS of one setup
    // identity. Two groups of one save are genuinely recorded at different
    // instants - she sets one probe, then the next - and nothing collapses
    // them to a single moment.
    const studio = await seedStudio("sub-guidance");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await save(studio.userId, blockId, machineId, "save-key-guide001", [
      group("g1", [1, 2], "120"),
      group("g2", [3, 4], "80"),
    ]);

    const r = await asUser(studio.userId, (q) =>
      q(`select public.latest_setup_for_client($1,$2) as r`, [
        studio.studioId,
        studio.clientId,
      ]),
    );
    const rows = r.rows[0].r as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((x) => x.group_key))).toEqual(new Set(["g1", "g2"]));
    // Each row carries its OWN timestamp, which is what lets a consumer
    // present the save honestly rather than as one instant.
    for (const row of rows) {
      expect(row.recorded_at).toBeTruthy();
    }
  });
});
