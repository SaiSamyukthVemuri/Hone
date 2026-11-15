import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { adminQuery, asUser, closePool, resolveLocalDbUrl, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";
import { expectBlockedOn } from "./helpers/waitlist-concurrency";

// ===========================================================================
// THE IDENTITY FUNCTION ACCEPTS ONLY MODES THE PUBLISHED CONTRACT LISTS.
//
// The rule: the identity core function `apply_block_machine_identity` accepts only a mode that
// `machine_profile_mode_contract` lists for the unit's profile AND version, only an option that is fitted on the unit, and a
// unit-less identity only for the supported legacy machine. Behaviour is exercised through signed-in practitioner sessions.
// SYNTHETIC PROFILE IDS ONLY. Service-role writers are unaffected.
// ===========================================================================

const PROFILE = `fixture:mode-contract-${randomUUID().slice(0, 8)}`;
const XCELL = "dectro-apilus:xcell";
const OPTION = "opt-fitted";

afterAll(async () => {
  await closePool();
});

async function publish(): Promise<void> {
  const fields = JSON.stringify([{ field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true }]);
  await adminQuery(`select public.sync_machine_profile_contract($1,1,$2,4::smallint,null,$3::jsonb)`, [PROFILE, "galvanic", fields]);
  await adminQuery(`select public.sync_machine_profile_contract($1,1,$2,4::smallint,$3,$4::jsonb)`, [PROFILE, "gated", OPTION, fields]);
}

const register = (s: SeededStudio, options: string[]) =>
  asUser(s.userId, async (q) => {
    const r = await q(`select public.register_studio_machine($1,$2,1,$3,$4) as id`, [s.studioId, PROFILE, `Room ${randomUUID().slice(0, 4)}`, options]);
    return r.rows[0].id as string;
  });

type Reply = { updated_at: string; reused: boolean; machine_profile_id: string | null; studio_machine_id: string | null; machine_mode_key: string | null };
const stamp = (s: SeededStudio, sessionId: string, blockId: string, over: { profile?: string | null; machine?: string | null; mode?: string | null; key?: string | null }) =>
  asUser(s.userId, async (q) => {
    const r = await q(`select public.record_block_machine_identity($1,$2,$3,$4,$5,$6,$7,$8::timestamptz) as r`, [
      blockId, sessionId, s.clientId, over.profile ?? null, over.machine ?? null, over.mode ?? null, over.key ?? `k-${randomUUID()}`, null,
    ]);
    return r.rows[0].r as Reply;
  });

const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  return null;
};

const stored = async (blockId: string) =>
  (await adminQuery(`select machine_profile_id, studio_machine_id, machine_mode_key from public.session_blocks where id = $1`, [blockId])).rows[0];

describe("record_block_machine_identity validates the mode (real JWT)", () => {
  it("a mode the unit's contract publishes is accepted and stored", async () => {
    await publish();
    const s = await seedStudio("mc-ok");
    const machine = await register(s, []);
    const { sessionId, blockId } = await seedSession(s);
    const r = await stamp(s, sessionId, blockId, { machine, mode: "galvanic" });
    expect(r.machine_mode_key).toBe("galvanic");
    expect((await stored(blockId)).machine_mode_key).toBe("galvanic");
  });

  it("an unknown mode key is refused and nothing is stored", async () => {
    await publish();
    const s = await seedStudio("mc-unk");
    const machine = await register(s, []);
    const { sessionId, blockId } = await seedSession(s);
    for (const mode of ["totally-bogus-mode", "x".repeat(120)]) {
      const e = await refused(stamp(s, sessionId, blockId, { machine, mode }));
      expect(e?.code, mode.slice(0, 20)).toBe("23514");
      expect(e?.message).toMatch(/does not offer that mode/);
    }
    expect((await stored(blockId)).machine_mode_key).toBeNull();
  });

  it("an option-gated mode is refused on a unit without the option and accepted on one with it", async () => {
    await publish();
    const s = await seedStudio("mc-opt");
    const bare = await register(s, []);
    const fitted = await register(s, [OPTION]);
    const a = await seedSession(s);
    const e = await refused(stamp(s, a.sessionId, a.blockId, { machine: bare, mode: "gated" }));
    expect(e?.code).toBe("23514");
    expect((await stored(a.blockId)).machine_mode_key).toBeNull();
    const b = await seedSession(s);
    const r = await stamp(s, b.sessionId, b.blockId, { machine: fitted, mode: "gated" });
    expect(r.machine_mode_key).toBe("gated");
  });

  it("a mode published only for another version of the profile is refused for this unit's version", async () => {
    await publish();
    const fields = JSON.stringify([{ field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true }]);
    await adminQuery(`select public.sync_machine_profile_contract($1,2,$2,4::smallint,null,$3::jsonb)`, [PROFILE, "v2only", fields]);
    const s = await seedStudio("mc-ver");
    const machine = await register(s, []);
    const { sessionId, blockId } = await seedSession(s);
    const e = await refused(stamp(s, sessionId, blockId, { machine, mode: "v2only" }));
    expect(e?.code).toBe("23514");
    expect((await stored(blockId)).machine_mode_key).toBeNull();
  });

  it("a unitless identity is accepted for the legacy xCell and refused for any other profile", async () => {
    await publish();
    const s = await seedStudio("mc-unitless");
    const a = await seedSession(s);
    const ok = await stamp(s, a.sessionId, a.blockId, { profile: XCELL });
    expect(ok.machine_profile_id).toBe(XCELL);
    const b = await seedSession(s);
    const e = await refused(stamp(s, b.sessionId, b.blockId, { profile: PROFILE }));
    expect(e?.code).toBe("23514");
    expect(e?.message).toMatch(/xCell/);
    expect((await stored(b.blockId)).machine_profile_id).toBeNull();
  });

  it("a committed receipt replays its stored answer even if the unit has since lost the option", async () => {
    await publish();
    const s = await seedStudio("mc-replay");
    const machine = await register(s, [OPTION]);
    const { sessionId, blockId } = await seedSession(s);
    const key = `replay-${randomUUID()}`;
    const first = await stamp(s, sessionId, blockId, { machine, mode: "gated", key });
    await adminQuery(`update public.studio_machines set installed_options = '{}' where id = $1`, [machine]);
    const second = await stamp(s, sessionId, blockId, { machine, mode: "gated", key });
    expect(second.reused).toBe(true);
    expect(second.machine_mode_key).toBe(first.machine_mode_key);
    expect(second.updated_at).toBe(first.updated_at);
  });
});

describe("the other identity entrypoints go through the same validation", () => {
  it("record_setup_submission_with_identity and create_block_with_initial_setup_and_identity call apply_block_machine_identity", async () => {
    for (const fn of ["record_setup_submission_with_identity", "create_block_with_initial_setup_and_identity", "record_block_machine_identity"]) {
      const def = (await adminQuery(`select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn])).rows;
      expect(def.length, fn).toBe(1);
      expect(def[0].d, fn).toMatch(/apply_block_machine_identity/);
    }
  });

  it("a setup submission with an option-gated mode on a unit without the option is refused and records nothing", async () => {
    await publish();
    const s = await seedStudio("mc-sub");
    const bare = await register(s, []);
    const { sessionId, blockId } = await seedSession(s);
    const groups = [{ new_group_ref: "g1", channels: [1], readings: [{ field_key: "current", value: "9", observation_source: "practitioner-entered" }] }];
    const e = await refused(
      asUser(s.userId, (q) =>
        q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz)`, [
          blockId, bare, "gated", `sub-${randomUUID()}`, JSON.stringify(groups), sessionId, s.clientId, null,
        ]),
      ),
    );
    expect(e).not.toBeNull();
    expect((await stored(blockId)).machine_mode_key).toBeNull();
    const n = (await adminQuery(`select count(*)::int as n from public.treatment_setup_captures where session_block_id = $1`, [blockId])).rows[0].n;
    expect(n).toBe(0);
  });
});

// Builds the 31-argument call of create_block_with_initial_setup_and_identity: only the identity-bearing positions are named.
const CREATE_SQL = `select public.create_block_with_initial_setup_and_identity(
  $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,
  $15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
  $27,$28,$29,$30::jsonb,$31) as r`;

const create = (s: SeededStudio, sessionId: string, over: { machine?: string | null; mode?: string | null; key?: string | null; profile?: string | null; readings?: boolean }) =>
  asUser(s.userId, async (q) => {
    const args: unknown[] = new Array(31).fill(null);
    args[0] = sessionId;
    args[1] = s.clientId;
    args[2] = JSON.stringify({ block_name: "Mode", primary_area: "jaw" });
    args[3] = JSON.stringify({});
    args[4] = JSON.stringify([]);
    args[5] = false;
    args[26] = over.machine ?? null;
    args[27] = over.mode ?? null;
    args[28] = over.key ?? null;
    // Readings are off by default: with readings, 0223's own per-mode field contract refuses an unpublished mode first and the
    // identity check is never what refuses (observed on the 0301 definition), so an identity-only call is what isolates 0310.
    args[29] = over.readings === false || over.readings === undefined ? null : JSON.stringify([{ new_group_ref: "g1", channels: [1], readings: [{ field_key: "current", value: "9", observation_source: "practitioner-entered" }] }]);
    args[30] = over.profile ?? null;
    const r = await q(CREATE_SQL, args);
    return r.rows[0].r as { block_id: string; reused: boolean };
  });

describe("the create and setup-submission entrypoints refuse a mode the contract does not publish", () => {
  it("create_block_with_initial_setup_and_identity refuses an unknown mode and leaves no block behind", async () => {
    await publish();
    const s = await seedStudio("mc-create-unknown");
    const machine = await register(s, [OPTION]);
    const { sessionId } = await seedSession(s);
    const before = (await adminQuery(`select count(*)::int as n from public.session_blocks where session_id = $1`, [sessionId])).rows[0].n;
    const e = await refused(create(s, sessionId, { machine, mode: "not-published", key: `c-${randomUUID()}` }));
    expect(e?.code).toBe("23514");
    const after = (await adminQuery(`select count(*)::int as n from public.session_blocks where session_id = $1`, [sessionId])).rows[0].n;
    expect(after).toBe(before);
  });

  // NOT a 0310 discriminator: a submission always carries readings, and 0223's field contract refuses an unpublished mode before the
  // identity step runs (the case passes on the 0301 definition too). It pins that the end-to-end answer stays a refusal.
  it("record_setup_submission_with_identity refuses an unknown mode and records nothing", async () => {
    await publish();
    const s = await seedStudio("mc-sub-unknown");
    const machine = await register(s, [OPTION]);
    const { sessionId, blockId } = await seedSession(s);
    const groups = [{ new_group_ref: "g1", channels: [1], readings: [{ field_key: "current", value: "9", observation_source: "practitioner-entered" }] }];
    const e = await refused(
      asUser(s.userId, (q) =>
        q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz)`, [
          blockId, machine, "not-published", `sub-${randomUUID()}`, JSON.stringify(groups), sessionId, s.clientId, null,
        ]),
      ),
    );
    expect(e?.code).toBe("23514");
    expect((await stored(blockId)).machine_mode_key).toBeNull();
    const n = (await adminQuery(`select count(*)::int as n from public.treatment_setup_captures where session_block_id = $1`, [blockId])).rows[0].n;
    expect(n).toBe(0);
  });

  it("a committed create-kind receipt replays its stored answer after the unit loses the option", async () => {
    await publish();
    const s = await seedStudio("mc-create-replay");
    const machine = await register(s, [OPTION]);
    const { sessionId } = await seedSession(s);
    const key = `create-replay-${randomUUID()}`;
    const first = await create(s, sessionId, { machine, mode: "gated", key, readings: true });
    expect(first.reused).toBe(false);
    await adminQuery(`update public.studio_machines set installed_options = '{}' where id = $1`, [machine]);
    const second = await create(s, sessionId, { machine, mode: "gated", key, readings: true });
    expect(second.reused).toBe(true);
    expect(second.block_id).toBe(first.block_id);
    expect((await stored(first.block_id)).machine_mode_key).toBe("gated");
  });
});

describe("only apply_block_machine_identity writes machine_mode_key", () => {
  it("no other function in the public schema assigns the column", async () => {
    const rows = (
      await adminQuery(
        `select p.proname, pg_get_functiondef(p.oid) as d
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prokind = 'f' and p.proname <> 'apply_block_machine_identity'
            and pg_get_functiondef(p.oid) ~* 'machine_mode_key'`,
      )
    ).rows as { proname: string; d: string }[];
    // A write is an assignment target (`machine_mode_key =` after set/comma) or an insert column list entry on session_blocks.
    const writes = rows.filter((r) => {
      const body = r.d.replace(/--[^\n]*/g, "");
      return /(\bset|,)\s*machine_mode_key\s*=/i.test(body) || /insert\s+into\s+(public\.)?session_blocks\b[^;]*machine_mode_key/i.test(body);
    });
    // block_write_receipts keeps its own copy of the column; that insert is not a block write and is excluded above by the table name.
    expect(writes.map((w) => w.proname)).toEqual([]);
    const own = (await adminQuery(`select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'apply_block_machine_identity'`)).rows;
    expect(own).toHaveLength(1);
    expect(own[0].d).toMatch(/update\s+public\.session_blocks[\s\S]*machine_mode_key\s*=\s*v_mode/i);
  });
});

// ===========================================================================
// THE UNIT IS LOCKED BEFORE IT IS ACCEPTED (Codex 4487384239).
// retire_studio_machine serialises only through its UPDATE row lock, so an UNLOCKED read of `retired_at` in the core could see the unit
// live, lose the race to a committed retire, and then record a retired unit on the block. The core takes the unit FOR SHARE after the
// session and block locks, so a concurrent retire either goes first (the unit is refused) or waits.
// ===========================================================================
async function party(userId: string): Promise<{ c: Client; pid: number }> {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
  const pid = Number((await c.query("select pg_backend_pid() as pid")).rows[0].pid);
  return { c, pid };
}

type Settled = { ok: true } | { ok: false; code: string; message: string };
// The handler is attached at creation so a rejection that lands while the test is waiting is never an unhandled rejection.
const settle = (p: Promise<unknown>): Promise<Settled> =>
  p.then(
    () => ({ ok: true as const }),
    (e: { code?: string; message?: string }) => ({ ok: false as const, code: e.code ?? "?", message: e.message ?? String(e) }),
  );

const recordOn = (c: Client, s: SeededStudio, sessionId: string, blockId: string, machine: string) =>
  c.query(`select public.record_block_machine_identity($1,$2,$3,$4,$5,$6,$7,$8::timestamptz) as r`, [
    blockId, sessionId, s.clientId, null, machine, "galvanic", `race-${randomUUID()}`, null,
  ]);

describe("the unit is locked before it is accepted: a concurrent retire serialises with the identity write", () => {
  it("RETIRE the unit (uncommitted), then record: the write PARKS on the unit, then is REFUSED", async () => {
    await publish();
    const s = await seedStudio("mc-race-ret");
    const machine = await register(s, []);
    const { sessionId, blockId } = await seedSession(s);
    const ret = await party(s.userId);
    const rec = await party(s.userId);
    try {
      await ret.c.query(`select public.retire_studio_machine($1)`, [machine]);
      const recording = settle(recordOn(rec.c, s, sessionId, blockId, machine));
      const wait = await expectBlockedOn(rec.pid, "the identity write must park acquiring the unit lock the retirement holds");
      expect(wait).toMatch(/^Lock\//);
      await ret.c.query("commit");
      const out = await recording;
      expect(out.ok, "recording a unit that has just been retired must be refused").toBe(false);
      expect(!out.ok && out.message).toMatch(/That machine is not available in this studio/);
      expect(!out.ok && out.code, "a refusal, never a deadlock abort").not.toBe("40P01");
      await rec.c.query("rollback");
      expect((await stored(blockId)).studio_machine_id, "nothing was recorded").toBeNull();
    } finally {
      await ret.c.end();
      await rec.c.end();
    }
  });

  it("POSITIVE CONTROL: a retirement that ROLLS BACK does not refuse the write", async () => {
    await publish();
    const s = await seedStudio("mc-race-roll");
    const machine = await register(s, []);
    const { sessionId, blockId } = await seedSession(s);
    const ret = await party(s.userId);
    const rec = await party(s.userId);
    try {
      await ret.c.query(`select public.retire_studio_machine($1)`, [machine]);
      const recording = settle(recordOn(rec.c, s, sessionId, blockId, machine));
      await expectBlockedOn(rec.pid, "the identity write must park on the unit lock");
      await ret.c.query("rollback");
      const out = await recording;
      expect(out.ok, `the write must succeed: ${!out.ok && out.message}`).toBe(true);
      await rec.c.query("commit");
      expect((await stored(blockId)).studio_machine_id).toBe(machine);
    } finally {
      await ret.c.end();
      await rec.c.end();
    }
  });
});
