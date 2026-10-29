import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  resolveLocalDbUrl,
  routeFor,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// 0223 — A SETTINGS-GROUP IDENTITY IS ISSUED, NEVER CHOSEN
// (Codex, #860 4305780322)
// ===========================================================================
//
// THE DEFECT. The next group key was minted client-side as
// `highestOrdinal(recorded) + 1` over the snapshot a form had loaded. Two page
// loads that both added a group therefore both chose the SAME key, and
// `record_setup_group_in_scope` correctly took the second as the next REVISION
// of the first. Two distinct probe sets merged into one group's timeline and
// only the second one's values read as current - a silent loss of what the
// practitioner recorded first. Reachable three ways: a reload, a second tab,
// and a draft left open while another save landed.
//
// The application-side detection shipped first and refuses a stale REVISE.
// This file proves the structural fix underneath it: `mint_setup_group_keys`
// issues every new key under a block-wide advisory lock, so no two callers can
// obtain the same one, and a caller may name a key ONLY to revise a group that
// already exists.
//
// UNEXECUTED UNTIL IT IS RUN, and said so in the same breath as 0204's lesson:
// a command that writes to a column which does not exist applies clean, passes
// its source contract, and has never once succeeded. A source test cannot see
// inside a plpgsql body. Every count in this header is written only after the
// run that produced it.
//
// THE TWO-CONNECTION CASES NEED A REAL RACE. `asUser` opens its own
// transaction and commits at the end, so a lock taken inside it is gone before
// the next statement runs - useless for proving serialisation. Those cases
// drive raw clients so one transaction can be held OPEN while another runs,
// and they are built in the shape that the submission suite's self-deadlock
// taught: never await both halves while the commits are still ahead of the
// await.
// ===========================================================================

const PROFILE = "fixture:db-group-identity";
const VERSION = 1;

const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 6 });

afterAll(async () => {
  await pool.end();
  await closePool();
});

async function publishContract(): Promise<void> {
  await adminQuery(
    `select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      PROFILE,
      VERSION,
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
}

async function registerMachine(studio: SeededStudio): Promise<string> {
  await publishContract();
  return asUser(studio.userId, async (q) => {
    const r = await q(
      `select public.register_studio_machine($1,$2,$3,$4,$5) as id`,
      [studio.studioId, PROFILE, VERSION, "Room 1", []],
    );
    return r.rows[0].id as string;
  });
}

const reading = (value: string) => ({
  field_key: "current",
  value,
  observation_source: "practitioner-entered",
});

/** A group asking for a NEW identity, under the caller's own placeholder. */
const asNew = (ref: string, channels: number[], current: string) => ({
  new_group_ref: ref,
  channels,
  readings: [reading(current)],
});

/** A group REVISING the identity it names. */
const asRevision = (key: string, channels: number[], current: string) => ({
  group_key: key,
  channels,
  readings: [reading(current)],
});

type SaveResult = {
  submission_id: string;
  groups: number;
  readings: number;
  reused: boolean;
};

/**
 * Call the save command with EXACTLY the payload given.
 *
 * NO RESOLUTION HERE, unlike the submission suite's helper. Every case in this
 * file is about which vocabulary a caller used and what the command does with
 * it, so a helper that chose on the caller's behalf would be deciding the
 * thing under test.
 */
async function save(
  userId: string,
  blockId: string,
  machineId: string,
  key: string,
  groups: unknown[],
): Promise<SaveResult> {
  const route = await routeFor(blockId);
  return asUser(userId, async (q) => {
    const r = await q(
      `select public.record_treatment_setup_submission($1,$2,$3,$4,$5::jsonb,$6::uuid,$7::uuid) as r`,
      [
        blockId,
        machineId,
        "galvanic",
        key,
        JSON.stringify(groups),
        route.sessionId,
        route.clientId,
      ],
    );
    return r.rows[0].r as SaveResult;
  });
}

/** Captures of one block, ordered, with the values that read as current. */
async function capturesOf(blockId: string) {
  const r = await adminQuery(
    `select c.group_key, c.revision, r.value_numeric::text as value
       from public.treatment_setup_captures c
       join public.treatment_setup_readings r on r.capture_id = c.id
      where c.session_block_id = $1
      order by c.group_key, c.revision`,
    [blockId],
  );
  return r.rows as Array<{ group_key: string; revision: number; value: string }>;
}

describe("0223 · a new group is ISSUED an identity", () => {
  it("a first save gets a key it did not choose, and the reading is stored", async () => {
    const studio = await seedStudio("gid-first");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    const out = await save(studio.userId, blockId, machineId, "gid-key-0001", [
      asNew("local-1", [1], "120"),
    ]);

    expect(out.groups).toBe(1);
    expect(out.readings).toBe(1);
    const rows = await capturesOf(blockId);
    expect(rows).toHaveLength(1);
    // THE PLACEHOLDER IS NOT THE KEY. If it were, the caller would still be
    // choosing the identity and nothing would have changed.
    expect(rows[0]!.group_key).not.toBe("local-1");
    expect(rows[0]!.group_key).toMatch(/^g\d+$/);
    expect(rows[0]!.revision).toBe(1);
    expect(rows[0]!.value).toBe("120");
  });

  it("TWO TABS adding a group get DISTINCT keys, and both groups persist", async () => {
    // THE REPORTED CASE. Both drafts loaded the same snapshot, so both would
    // have minted the same key client-side and the second capture would have
    // become revision 2 of the first - one timeline, two probe sets, the first
    // one's values no longer current.
    const studio = await seedStudio("gid-tabs");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    // Tab one records a group, so both tabs' drafts now show exactly {g1}.
    await save(studio.userId, blockId, machineId, "gid-tabs-0001", [
      asNew("local-1", [1], "120"),
    ]);
    const seeded = await capturesOf(blockId);
    const firstKey = seeded[0]!.group_key;

    // Both tabs then add a group, each from that same snapshot, each sending
    // the placeholder its own `highestOrdinal` arithmetic produced - which is
    // the SAME string in both, because both counted from {g1}.
    await save(studio.userId, blockId, machineId, "gid-tabs-0002", [
      asNew("g2", [2], "80"),
    ]);
    await save(studio.userId, blockId, machineId, "gid-tabs-0003", [
      asNew("g2", [3], "60"),
    ]);

    const rows = await capturesOf(blockId);
    const keys = rows.map((r) => r.group_key);
    // THREE GROUPS, not two with a revision between them.
    expect(new Set(keys).size, `keys were ${keys.join(", ")}`).toBe(3);
    expect(rows.every((r) => r.revision === 1)).toBe(true);
    // AND NOTHING WAS LOST. All three values read as current, which is the
    // whole claim: the defect made the first tab's values unreachable.
    expect([...rows.map((r) => r.value)].sort()).toEqual(["120", "60", "80"]);
    expect(keys).toContain(firstKey);
  });

  it("SAM'S RULE: a deliberately IDENTICAL group becomes a NEW group", async () => {
    // Sam's hard rule is that a practitioner must NEVER have to change a
    // clinical value to get past duplicate suppression. She may genuinely run
    // a second probe at the same current; asking her to alter the number to
    // record it would be asking her to falsify the record.
    const studio = await seedStudio("gid-identical");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await save(studio.userId, blockId, machineId, "gid-same-0001", [
      asNew("local-1", [1], "120"),
    ]);
    // Same channel list would be refused by cross-group exclusivity, which is
    // a different rule; the VALUES are what must not have to differ.
    await save(studio.userId, blockId, machineId, "gid-same-0002", [
      asNew("local-1", [2], "120"),
    ]);

    const rows = await capturesOf(blockId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.group_key)).size).toBe(2);
    expect(rows.every((r) => r.revision === 1)).toBe(true);
    expect(rows.map((r) => r.value)).toEqual(["120", "120"]);
  });
});

describe("0223 · a caller may NAME a key only to revise", () => {
  it("naming a key that does not exist is REFUSED", async () => {
    const studio = await seedStudio("gid-unknown");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await expect(
      save(studio.userId, blockId, machineId, "gid-unknown-0001", [
        asRevision("g1", [1], "120"),
      ]),
    ).rejects.toThrow(/is not on this treatment/i);

    // AND NOTHING WAS WRITTEN. A refusal that still committed would be a
    // message rather than a guard.
    expect(await capturesOf(blockId)).toEqual([]);
  });

  it("naming an EXISTING key revises it, at the next revision", async () => {
    // The direction that must keep working. Append-only revisions are the
    // whole point of the table, and a rule about identity that broke them
    // would be worse than the defect.
    const studio = await seedStudio("gid-revise");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await save(studio.userId, blockId, machineId, "gid-revise-0001", [
      asNew("local-1", [1], "120"),
    ]);
    const issued = (await capturesOf(blockId))[0]!.group_key;

    const out = await save(studio.userId, blockId, machineId, "gid-revise-0002", [
      asRevision(issued, [1], "130"),
    ]);
    expect(out.groups).toBe(1);

    const rows = await capturesOf(blockId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.revision)).toEqual([1, 2]);
    expect(rows.map((r) => r.group_key)).toEqual([issued, issued]);
    // BOTH SURVIVE: the earlier observation is not overwritten.
    expect(rows.map((r) => r.value)).toEqual(["120", "130"]);
  });

  it("naming BOTH, or NEITHER, is refused", async () => {
    const studio = await seedStudio("gid-both");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await expect(
      save(studio.userId, blockId, machineId, "gid-both-0001", [
        { group_key: "g1", new_group_ref: "local-1", channels: [1], readings: [reading("120")] },
      ]),
    ).rejects.toThrow(/either name the existing group|and not both/i);

    await expect(
      save(studio.userId, blockId, machineId, "gid-neither-0001", [
        { channels: [1], readings: [reading("120")] },
      ]),
    ).rejects.toThrow(/either name the existing group|and not both/i);

    expect(await capturesOf(blockId)).toEqual([]);
  });

  it("a JSON NULL group_key counts as PRESENT, so it is refused too", async () => {
    // THE TRAP THE CLIENT HAS TO AVOID. The command's test is
    // `(value ? 'group_key') = (value ? 'new_group_ref')`, which asks whether
    // the KEY IS PRESENT - and a JSON null is present. So a client that sent
    // `{group_key: null, new_group_ref: "x"}` would be refused as naming
    // both. `recordSetupSubmission` spreads one or the other for exactly this
    // reason, and this is the case that proves the trap is real rather than
    // imagined.
    const studio = await seedStudio("gid-jsonnull");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await expect(
      save(studio.userId, blockId, machineId, "gid-null-0001", [
        { group_key: null, new_group_ref: "local-1", channels: [1], readings: [reading("120")] },
      ]),
    ).rejects.toThrow(/either name the existing group|and not both/i);
  });

  it("two new groups sharing ONE placeholder is refused", async () => {
    // The placeholder is how the retry digest tells one new group from
    // another, so two groups under one placeholder is the same
    // lost-track-of-which-is-which bug as two under one key.
    const studio = await seedStudio("gid-dupref");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await expect(
      save(studio.userId, blockId, machineId, "gid-dupref-0001", [
        asNew("local-1", [1], "120"),
        asNew("local-1", [2], "80"),
      ]),
    ).rejects.toThrow(/given more than once/i);

    expect(await capturesOf(blockId)).toEqual([]);
  });
});

describe("0223 · the retry key still absorbs a repeat, under the placeholder", () => {
  it("a retry with the SAME placeholders returns the ORIGINAL submission", async () => {
    // THE CONSEQUENCE I FLAGGED BEFORE WRITING ANY OF THIS. The digest is
    // taken over the payload AS SENT, so a new group is digested under the
    // caller's placeholder rather than the key the server is about to issue.
    // Digest over the ISSUED key instead and every retry would mint a fresh
    // one, digest differently, and append a DUPLICATE - the exact opposite of
    // what a retry key is for.
    const studio = await seedStudio("gid-retry");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const groups = [asNew("local-1", [1], "120")];

    const first = await save(studio.userId, blockId, machineId, "gid-retry-0001", groups);
    const retry = await save(studio.userId, blockId, machineId, "gid-retry-0001", groups);

    expect(retry.reused).toBe(true);
    expect(retry.submission_id).toBe(first.submission_id);
    expect(retry.groups).toBe(first.groups);
    expect(retry.readings).toBe(first.readings);
    // ONE CAPTURE, not two. The counts above come from the stored rows, so a
    // duplicate would have to show here.
    expect(await capturesOf(blockId)).toHaveLength(1);
  });

  it("the same key with a DIFFERENT placeholder is a different save, and refused", async () => {
    // The key is bound to its payload, and the placeholder is part of it. A
    // caller that reused a key for genuinely different settings must be
    // refused loudly rather than told its new values were stored.
    const studio = await seedStudio("gid-rebind");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await save(studio.userId, blockId, machineId, "gid-rebind-0001", [
      asNew("local-1", [1], "120"),
    ]);

    await expect(
      save(studio.userId, blockId, machineId, "gid-rebind-0001", [
        asNew("local-2", [1], "120"),
      ]),
      // THE COMMAND'S OWN SENTENCE. The first spelling of this expectation
      // was narrower than the message and reported a failure against
      // behaviour that was correct - "already used for a save with different
      // settings", which is exactly the proof that the PLACEHOLDER is inside
      // the digest.
    ).rejects.toThrow(/different settings|different save|already belongs/i);
  });

  it("a retry mints NOTHING, so the next issued key is unaffected", async () => {
    // The mint runs after the idempotency return. If an absorbed retry still
    // allocated, the key sequence would advance on every lost response and
    // the gaps would be invisible - harmless today, and exactly the sort of
    // invisible drift that makes a later bug unreadable.
    const studio = await seedStudio("gid-retry-mint");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const groups = [asNew("local-1", [1], "120")];

    await save(studio.userId, blockId, machineId, "gid-rm-0001", groups);
    await save(studio.userId, blockId, machineId, "gid-rm-0001", groups);
    await save(studio.userId, blockId, machineId, "gid-rm-0001", groups);

    const next = await save(studio.userId, blockId, machineId, "gid-rm-0002", [
      asNew("local-2", [2], "80"),
    ]);
    expect(next.groups).toBe(1);

    const rows = await capturesOf(blockId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.group_key)).toEqual(["g1", "g2"]);
  });
});

describe("0223 · the mint serialises, and is not a caller's to call", () => {
  it("two CONCURRENT saves of a new group get disjoint keys", async () => {
    // THE LOCK IS THE WHOLE GUARANTEE. The allocation reads a max and adds to
    // it; without a block-wide lock held across both, two transactions read
    // the same max and issue the same key - and the arithmetic looks right in
    // both.
    //
    // SHAPED TO AVOID THE HARNESS SELF-DEADLOCK the submission suite hit: A is
    // held open deliberately while B blocks, and A commits BEFORE anything
    // awaits B.
    const studio = await seedStudio("gid-concurrent");
    const { blockId } = await seedSession(studio);
    const machineId = await registerMachine(studio);
    const route = await routeFor(blockId);

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      for (const c of [a, b]) {
        await c.query("begin");
        await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
          studio.userId,
        ]);
        await c.query(`set local role authenticated`);
        await c.query(`set local lock_timeout = '10s'`);
      }

      const call = (key: string, ref: string) =>
        `select public.record_treatment_setup_submission(
           '${blockId}'::uuid, '${machineId}'::uuid, 'galvanic', '${key}',
           '${JSON.stringify([asNew(ref, [], "120")])}'::jsonb,
           '${route.sessionId}'::uuid, '${route.clientId}'::uuid) as r`;

      // A takes the mint lock and holds it.
      await a.query(call("gid-conc-0001", "local-a"));
      // B asks for the same thing and must WAIT rather than read A's max.
      const bRunning = b.query(call("gid-conc-0002", "local-b"));
      await a.query("commit");
      await bRunning;
      await b.query("commit");
    } finally {
      a.release();
      b.release();
    }

    const rows = await capturesOf(blockId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.group_key)).toEqual(["g1", "g2"]);
    expect(rows.every((r) => r.revision === 1)).toBe(true);
  });

  it("no runtime role may call the mint directly", async () => {
    // A caller that could issue its own keys could issue one that collides,
    // which is the defect restated. Revoked from all four by name, because
    // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
    // authenticated AND service_role at create time - 0129 missed `anon` and
    // 0164 missed `service_role`.
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await expect(
        asRole(role, async (q) =>
          q(`select public.mint_setup_group_keys($1, 1)`, [
            "00000000-0000-0000-0000-000000000000",
          ]),
        ),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("and the reader is granted to authenticated, not to anon", async () => {
    await expect(
      asRole("anon", async (q) =>
        q(`select public.setup_readings_for_block($1,$2)`, [
          "00000000-0000-0000-0000-000000000000",
          "00000000-0000-0000-0000-000000000000",
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("0223 · the single-statement reader", () => {
  it("returns a block's readings, and nothing from another session", async () => {
    // The lineage is a JOIN PREDICATE now, not a precheck: the read returns
    // nothing at all unless the block belongs to the session given
    // (Codex, #860 4298457378, 4305555264).
    const studio = await seedStudio("gid-reader");
    const mine = await seedSession(studio);
    const other = await seedSession(studio);
    const machineId = await registerMachine(studio);

    await save(studio.userId, mine.blockId, machineId, "gid-read-0001", [
      asNew("local-1", [1], "120"),
    ]);

    const own = await asUser(studio.userId, async (q) =>
      q(`select public.setup_readings_for_block($1,$2) as r`, [
        mine.blockId,
        mine.sessionId,
      ]),
    );
    expect(own.rows[0].r).toHaveLength(1);
    // A STRING, not a JSON number. numeric serialises to a string so a value
    // cannot lose precision in transit, and `toReading`'s Number() would
    // absorb either - so this assertion is the only thing standing between a
    // clinical reading and JSON doubles. It caught exactly that on the first
    // DB run.
    expect(own.rows[0].r[0].value_numeric).toBe("120");
    expect(own.rows[0].r[0].observation_source).toBe("practitioner-entered");

    // THE SAME BLOCK, THE WRONG SESSION: REFUSED, not answered with nothing.
    // The TypeScript read this replaces returned a refusal when the pair did
    // not match, and answering `[]` for everything would have quietly
    // reversed that - no leak, but a chart rendering "no settings recorded" to
    // someone with no business there.
    await expect(
      asUser(studio.userId, async (q) =>
        q(`select public.setup_readings_for_block($1,$2) as r`, [
          mine.blockId,
          other.sessionId,
        ]),
      ),
    ).rejects.toThrow(/unknown treatment block for this session/i);
  });

  it("a FOREIGN studio is refused, in the same words as a block that does not exist", async () => {
    // NON-DISCLOSURE IS THE POINT OF THE SAMENESS. RLS hides the block from
    // another studio, so it takes the same path as one that was never created
    // and gets the same sentence - there is nothing in the answer to tell the
    // two apart.
    const mine = await seedStudio("gid-reader-mine");
    const theirs = await seedStudio("gid-reader-theirs");
    const block = await seedSession(mine);
    const machineId = await registerMachine(mine);
    await save(mine.userId, block.blockId, machineId, "gid-foreign-0001", [
      asNew("local-1", [1], "120"),
    ]);

    const foreign = asUser(theirs.userId, async (q) =>
      q(`select public.setup_readings_for_block($1,$2) as r`, [
        block.blockId,
        block.sessionId,
      ]),
    );
    await expect(foreign).rejects.toThrow(
      /unknown treatment block for this session/i,
    );

    const invented = asUser(theirs.userId, async (q) =>
      q(`select public.setup_readings_for_block($1,$2) as r`, [
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-0000-0000-000000000001",
      ]),
    );
    await expect(invented).rejects.toThrow(
      /unknown treatment block for this session/i,
    );
  });

  it("CONTROL: a block with no readings is an empty list, not an error", async () => {
    const studio = await seedStudio("gid-reader-empty");
    const { blockId, sessionId } = await seedSession(studio);

    const out = await asUser(studio.userId, async (q) =>
      q(`select public.setup_readings_for_block($1,$2) as r`, [blockId, sessionId]),
    );
    expect(out.rows[0].r).toEqual([]);
  });
});
