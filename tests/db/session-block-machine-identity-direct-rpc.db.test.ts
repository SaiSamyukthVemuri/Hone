import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { adminQuery, asUser, closePool, resolveLocalDbUrl, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// ===========================================================================
// DIRECT-RPC REGRESSION for the mode contract (Vercel Security Review, Low): with 0310 removed, a signed-in practitioner can call
// the wrappers GRANTED TO authenticated straight through PostgREST and save a machine identity or mode the product never offers.
// The application check is not enough; the database function is the authority.
//
// Every wrapper granted to authenticated is called here as a real authenticated member (role + JWT claims), with unsupported
// identities and modes, and must refuse and store nothing. A NEGATIVE CONTROL installs the 0301 (pre-0310) body of the one
// shared core function inside a rolled-back transaction and shows the same calls are ACCEPTED, so the refusals above are
// 0310's and not an accident of the fixture. A RECEIPT-REPLAY section proves a replay can never write: it only returns what a
// committed attempt already stored, and a new key (or a changed payload) meets the contract or the digest check.
// SYNTHETIC PROFILE IDS ONLY.
// ===========================================================================

const PROFILE = `fixture:direct-rpc-${randomUUID().slice(0, 8)}`;
const OTHER = `fixture:not-a-supported-machine-${randomUUID().slice(0, 8)}`;
const XCELL = "dectro-apilus:xcell";
const OPTION = "opt-fitted";
const root = join(__dirname, "../..");

afterAll(async () => {
  await closePool();
});

/** The one `create or replace function public.apply_block_machine_identity(...) ... $$;` statement of a migration file. */
function coreFunctionSql(file: string): string {
  const sql = readFileSync(join(root, "supabase/migrations", file), "utf8");
  const start = sql.indexOf("create or replace function public.apply_block_machine_identity(");
  if (start < 0) throw new Error(`no core function in ${file}`);
  const end = sql.indexOf("\n$$;", start);
  if (end < 0) throw new Error(`unterminated core function in ${file}`);
  return sql.slice(start, end + "\n$$;".length);
}
const BODY_0301 = coreFunctionSql("0301_session_block_machine_identity.sql");
const BODY_0310 = coreFunctionSql("0310_block_machine_identity_mode_contract.sql");

async function publish(): Promise<void> {
  const fields = JSON.stringify([{ field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true }]);
  await adminQuery(`select public.sync_machine_profile_contract($1,1,$2,4::smallint,null,$3::jsonb)`, [PROFILE, "galvanic", fields]);
  await adminQuery(`select public.sync_machine_profile_contract($1,1,$2,4::smallint,$3,$4::jsonb)`, [PROFILE, "gated", OPTION, fields]);
  await adminQuery(`select public.sync_machine_profile_contract($1,2,$2,4::smallint,null,$3::jsonb)`, [PROFILE, "v2only", fields]);
}
const register = (s: SeededStudio, options: string[]) =>
  asUser(s.userId, async (q) => {
    const r = await q(`select public.register_studio_machine($1,$2,1,$3,$4) as id`, [s.studioId, PROFILE, `Room ${randomUUID().slice(0, 4)}`, options]);
    return r.rows[0].id as string;
  });

type Call = (q: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>, args: Args) => Promise<unknown>;
type Args = { s: SeededStudio; sessionId: string; blockId: string; machine: string | null; profile: string | null; mode: string | null; key: string };

const RECORD: Call = (q, a) =>
  q(`select public.record_block_machine_identity($1,$2,$3,$4,$5,$6,$7,null::timestamptz) as r`, [a.blockId, a.sessionId, a.s.clientId, a.profile, a.machine, a.mode, a.key]);

// The create wrapper has 31 positional arguments; only the identity-bearing positions are named. No readings: with readings,
// 0223's own per-mode field contract refuses an unpublished mode before the identity step, which would hide 0310.
const CREATE_SQL = `select public.create_block_with_initial_setup_and_identity(
  $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,
  $15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
  $27,$28,$29,$30::jsonb,$31) as r`;
const CREATE: Call = (q, a) => {
  const args: unknown[] = new Array(31).fill(null);
  args[0] = a.sessionId;
  args[1] = a.s.clientId;
  args[2] = JSON.stringify({ block_name: "Direct", primary_area: "jaw" });
  args[3] = JSON.stringify({});
  args[4] = JSON.stringify([]);
  args[5] = false;
  args[26] = a.machine;
  args[27] = a.mode;
  args[28] = a.key;
  args[29] = null;
  args[30] = a.profile;
  return q(CREATE_SQL, args);
};
const SUBMIT: Call = (q, a) => {
  const groups = [{ new_group_ref: "g1", channels: [1], readings: [{ field_key: "current", value: "9", observation_source: "practitioner-entered" }] }];
  return q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz)`, [
    a.blockId, a.machine, a.mode, a.key, JSON.stringify(groups), a.sessionId, a.s.clientId, null,
  ]);
};
const WRAPPERS: Array<{ name: string; call: Call; takesProfile: boolean }> = [
  { name: "record_block_machine_identity", call: RECORD, takesProfile: true },
  { name: "create_block_with_initial_setup_and_identity", call: CREATE, takesProfile: true },
  { name: "record_setup_submission_with_identity", call: SUBMIT, takesProfile: false },
];

const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  return null;
};
const storedFor = async (blockId: string) =>
  (await adminQuery(`select machine_profile_id, studio_machine_id, machine_mode_key, updated_at from public.session_blocks where id = $1`, [blockId])).rows[0];
const blockCount = async (sessionId: string) =>
  (await adminQuery(`select count(*)::int as n from public.session_blocks where session_id = $1 and deleted_at is null`, [sessionId])).rows[0].n as number;

/** Unsupported identities and modes. `unit` picks which registered unit (or none) the call carries. */
type Case = { name: string; unit: "bare" | "fitted" | "none"; profile: "unit" | "xcell" | "other" | "none"; mode: string | null; onlyWrappers?: string[] };
const CASES: Case[] = [
  { name: "an unknown mode on a registered unit", unit: "bare", profile: "unit", mode: "totally-bogus-mode" },
  { name: "a 120-character mode on a registered unit", unit: "bare", profile: "unit", mode: "x".repeat(120) },
  { name: "an option-gated mode on a unit without the option", unit: "bare", profile: "unit", mode: "gated" },
  { name: "a mode published only for another version of the profile", unit: "bare", profile: "unit", mode: "v2only" },
  { name: "no unit and a profile that is not the supported legacy machine", unit: "none", profile: "other", mode: null, onlyWrappers: ["record_block_machine_identity", "create_block_with_initial_setup_and_identity"] },
  { name: "no unit, the legacy machine, and a mode", unit: "none", profile: "xcell", mode: "galvanic", onlyWrappers: ["record_block_machine_identity", "create_block_with_initial_setup_and_identity"] },
];
// Cases the PRE-0310 body accepts (shape-only mode check, no unit-less profile check): the negative control must see them stored.
const ACCEPTED_BEFORE_0310 = new Set([
  "an unknown mode on a registered unit",
  "a 120-character mode on a registered unit",
  "an option-gated mode on a unit without the option",
  "a mode published only for another version of the profile",
  "no unit and a profile that is not the supported legacy machine",
]);

async function arrange(label: string) {
  await publish();
  const s = await seedStudio(label);
  const bare = await register(s, []);
  const fitted = await register(s, [OPTION]);
  return { s, bare, fitted };
}
const argsFor = (c: Case, s: SeededStudio, bare: string, fitted: string, sessionId: string, blockId: string): Args => ({
  s, sessionId, blockId,
  machine: c.unit === "bare" ? bare : c.unit === "fitted" ? fitted : null,
  profile: c.profile === "unit" ? null : c.profile === "xcell" ? XCELL : c.profile === "other" ? OTHER : null,
  mode: c.mode,
  key: `k-${randomUUID()}`,
});
const applicable = (w: { name: string }, c: Case) => !c.onlyWrappers || c.onlyWrappers.includes(w.name);

describe("every wrapper granted to authenticated refuses unsupported identities and modes (real JWT, direct RPC)", () => {
  it("the wrappers under test are exactly the ones granted EXECUTE to authenticated that reach the core function", async () => {
    const r = await adminQuery(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
          and pg_get_functiondef(p.oid) ilike '%apply_block_machine_identity(%'
        order by 1`,
    );
    expect(r.rows.map((x) => x.proname as string)).toEqual(WRAPPERS.map((w) => w.name).sort());
  });
  it("the core function itself is NOT executable by authenticated, anon or service_role", async () => {
    const r = await adminQuery(
      `select has_function_privilege('authenticated', p.oid, 'execute') a, has_function_privilege('anon', p.oid, 'execute') n,
              has_function_privilege('service_role', p.oid, 'execute') s
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'apply_block_machine_identity'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({ a: false, n: false, s: false });
  });
  for (const w of WRAPPERS) {
    for (const c of CASES.filter((x) => applicable(w, x))) {
      it(`${w.name}: ${c.name} is refused and nothing is stored`, async () => {
        const { s, bare, fitted } = await arrange(`dr-${w.name.slice(0, 6)}`);
        const { sessionId, blockId } = await seedSession(s);
        const before = await storedFor(blockId);
        const blocksBefore = await blockCount(sessionId);
        const e = await refused(asUser(s.userId, (q) => w.call(q, argsFor(c, s, bare, fitted, sessionId, blockId))));
        expect(e, "the database must refuse").not.toBeNull();
        expect(await storedFor(blockId)).toEqual(before);
        expect(await blockCount(sessionId), "no block is created by a refused create").toBe(blocksBefore);
      });
    }
  }
  it("CONTROL: a supported identity and a published mode are still accepted through the same wrappers", async () => {
    const { s, bare } = await arrange("dr-ok");
    const a = await seedSession(s);
    const r = await asUser(s.userId, (q) => RECORD(q, { s, sessionId: a.sessionId, blockId: a.blockId, machine: bare, profile: null, mode: "galvanic", key: `k-${randomUUID()}` }));
    expect(((r as { rows: Array<{ r: { machine_mode_key: string } }> }).rows[0].r).machine_mode_key).toBe("galvanic");
    const b = await seedSession(s);
    const x = await asUser(s.userId, (q) => RECORD(q, { s, sessionId: b.sessionId, blockId: b.blockId, machine: null, profile: XCELL, mode: null, key: `k-${randomUUID()}` }));
    expect(((x as { rows: Array<{ r: { machine_profile_id: string } }> }).rows[0].r).machine_profile_id).toBe(XCELL);
  });
});

/**
 * Runs `fn` as the authenticated member inside ONE transaction that is always ROLLED BACK, after first installing `installSql` (the
 * core function body) as the owner. Nothing it does, including the installed function, persists.
 */
async function rolledBackAs<T>(userId: string, installSql: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: resolveLocalDbUrl() });
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (installSql) await client.query(installSql);
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
}
const asOwner = async (c: PoolClient, sql: string) => {
  await c.query("reset role");
  await c.query(sql);
};
const asMember = async (c: PoolClient, userId: string) => {
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
};

describe("NEGATIVE CONTROL: the same direct calls are ACCEPTED on the pre-0310 (0301) core function", () => {
  for (const w of WRAPPERS.filter((x) => x.takesProfile)) {
    for (const c of CASES.filter((x) => applicable(w, x) && ACCEPTED_BEFORE_0310.has(x.name))) {
      it(`${w.name}: ${c.name} is stored when the 0301 body is installed (rolled back afterwards)`, async () => {
        const { s, bare, fitted } = await arrange(`nc-${w.name.slice(0, 6)}`);
        const { sessionId, blockId } = await seedSession(s);
        const accepted = await rolledBackAs(s.userId, BODY_0301, async (client) => {
          const args = argsFor(c, s, bare, fitted, sessionId, blockId);
          await w.call((t, p) => client.query(t, p) as never, args);
          await client.query("reset role");
          const row = await client.query(
            `select machine_profile_id, machine_mode_key from public.session_blocks where session_id = $1 and deleted_at is null order by created_at desc limit 1`,
            [sessionId],
          );
          return row.rows[0] as { machine_profile_id: string | null; machine_mode_key: string | null };
        });
        // The 0301 body stored the unsupported identity or mode (this is the live-in-production gap).
        expect(accepted.machine_mode_key !== null || accepted.machine_profile_id === OTHER).toBe(true);
        // and the real (0310) function refuses the same call afterwards, outside the rolled-back transaction
        const e = await refused(asUser(s.userId, (q) => w.call(q, argsFor(c, s, bare, fitted, sessionId, blockId))));
        expect(e).not.toBeNull();
      });
    }
  }
  it("the 0310 body used by the control is exactly what the database runs (not a stale copy)", async () => {
    const src = (await adminQuery(
      `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='apply_block_machine_identity'`,
    )).rows[0].prosrc as string;
    const inner = BODY_0310.slice(BODY_0310.indexOf("$$") + 2, BODY_0310.lastIndexOf("$$"));
    expect(src).toBe(inner);
  });
});

describe("receipt replay: a replay never writes, and a new payload always meets the contract", () => {
  const stamp = (c: PoolClient, s: SeededStudio, sessionId: string, blockId: string, over: { machine: string | null; profile: string | null; mode: string | null; key: string }) =>
    RECORD((t, p) => c.query(t, p) as never, { s, sessionId, blockId, ...over }) as Promise<{ rows: Array<{ r: { reused: boolean; updated_at: string; machine_mode_key: string | null } }> }>;

  it("a VALID committed save replays its original result (reused, same version) on 0310", async () => {
    const { s, bare } = await arrange("rp-valid");
    const { sessionId, blockId } = await seedSession(s);
    const key = `rp-${randomUUID()}`;
    const one = await asUser(s.userId, (q) => stamp({ query: q } as never, s, sessionId, blockId, { machine: bare, profile: null, mode: "galvanic", key }));
    const two = await asUser(s.userId, (q) => stamp({ query: q } as never, s, sessionId, blockId, { machine: bare, profile: null, mode: "galvanic", key }));
    expect(one.rows[0].r.reused).toBe(false);
    expect(two.rows[0].r.reused).toBe(true);
    expect(two.rows[0].r.updated_at).toBe(one.rows[0].r.updated_at);
    expect(two.rows[0].r.machine_mode_key).toBe("galvanic");
  });

  it("an off-contract save committed BEFORE 0310 (key K): after 0310 a replay of K returns the stored answer and writes NOTHING; a NEW key with the same payload is refused; K with a changed payload is refused", async () => {
    const { s, bare } = await arrange("rp-old");
    const { sessionId, blockId } = await seedSession(s);
    const key = `rp-old-${randomUUID()}`;
    await rolledBackAs(s.userId, BODY_0301, async (c) => {
      // 1. before 0310: the off-contract mode is accepted and a receipt is written
      const first = await stamp(c, s, sessionId, blockId, { machine: bare, profile: null, mode: "totally-bogus-mode", key });
      expect(first.rows[0].r.reused).toBe(false);
      await c.query("reset role");
      const afterFirst = (await c.query(`select machine_mode_key, updated_at from public.session_blocks where id = $1`, [blockId])).rows[0];
      expect(afterFirst.machine_mode_key).toBe("totally-bogus-mode");

      // 2. 0310 is applied (the function body is replaced; the receipt stays)
      await asOwner(c, BODY_0310);
      await asMember(c, s.userId);

      // 3. a SAME-KEY, SAME-PAYLOAD replay answers from the receipt and changes nothing
      const replay = await stamp(c, s, sessionId, blockId, { machine: bare, profile: null, mode: "totally-bogus-mode", key });
      expect(replay.rows[0].r.reused).toBe(true);
      expect(replay.rows[0].r.updated_at).toBe(first.rows[0].r.updated_at);
      await c.query("reset role");
      const afterReplay = (await c.query(`select machine_mode_key, updated_at from public.session_blocks where id = $1`, [blockId])).rows[0];
      expect(afterReplay).toEqual(afterFirst);
      await asMember(c, s.userId);

      // 4. the SAME invalid payload under a NEW key is a new write: refused, and the block is untouched. (A savepoint keeps the
      //    transaction usable after the refusal.)
      await c.query("savepoint sp1");
      const fresh = await refused(stamp(c, s, sessionId, blockId, { machine: bare, profile: null, mode: "totally-bogus-mode", key: `rp-new-${randomUUID()}` }));
      expect(fresh?.code).toBe("23514");
      await c.query("rollback to savepoint sp1");

      // 5. the same key with a DIFFERENT payload is refused by the digest check, never answered with the original
      await c.query("savepoint sp2");
      const changed = await refused(stamp(c, s, sessionId, blockId, { machine: bare, profile: null, mode: "galvanic", key }));
      expect(changed?.code).toBe("23505");
      await c.query("rollback to savepoint sp2");
    });
    // nothing persisted: the test ran inside a rolled-back transaction
    expect((await storedFor(blockId)).machine_mode_key).toBeNull();
  });

  it("a replay of an earlier VALID payload after the unit lost the option still returns the original (a committed attempt is never turned into an error)", async () => {
    const { s, fitted } = await arrange("rp-lost");
    const { sessionId, blockId } = await seedSession(s);
    const key = `rp-lost-${randomUUID()}`;
    const one = await asUser(s.userId, (q) => stamp({ query: q } as never, s, sessionId, blockId, { machine: fitted, profile: null, mode: "gated", key }));
    await adminQuery(`update public.studio_machines set installed_options = '{}' where id = $1`, [fitted]);
    const two = await asUser(s.userId, (q) => stamp({ query: q } as never, s, sessionId, blockId, { machine: fitted, profile: null, mode: "gated", key }));
    expect(two.rows[0].r.reused).toBe(true);
    expect(two.rows[0].r.updated_at).toBe(one.rows[0].r.updated_at);
  });
});
