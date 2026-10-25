import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  asRole,
  seedMember,
  seedSession,
  seedStudio,
  type SeededStudio,
  type UserQuery,
} from "./helpers/harness";

// LINT-TRIAGE: the Supabase security advisor's SECURITY DEFINER rows, proved
// against the REAL migrated chain. Two synthetic studios; an anonymous caller
// carries exactly what the anon key carries (role anon, no sub), so auth.uid()
// is NULL. Synthetic data only.

// The anon-executable SECURITY DEFINER set the migration chain produces (hosted
// max 0212). The 2026-10-25 advisor export lists seven of these plus
// rls_auto_enable (a platform event-trigger function with no migration) and
// omits snapshot_appointment_buffer (production carries out-of-band changes to
// it; see LINT-TRIAGE-END). A new entry here is a new unauthenticated surface:
// revoke it from anon, or add it with its own proof below.
const ANON_EXECUTABLE_DEFINERS = [
  "enforce_appointment_buffer()",
  "guard_scoped_recurring_rule_capacity()",
  "handle_new_user()",
  "is_studio_member(uuid)",
  "is_studio_owner(uuid)",
  "session_is_visible(uuid)",
  "snapshot_appointment_buffer()",
  "studios_admission_mode_guard()",
];
const ANON_TRIGGERS = ANON_EXECUTABLE_DEFINERS.filter((f) => f.endsWith("()"));

let a: SeededStudio;
let b: SeededStudio;
let aSession: string;
let bSession: string;
let aMember: { userId: string };

beforeAll(async () => {
  a = await seedStudio("lint-a");
  b = await seedStudio("lint-b");
  aSession = (await seedSession(a)).sessionId;
  bSession = (await seedSession(b)).sessionId;
  aMember = await seedMember(a, "lint-a-member");
});

afterAll(async () => {
  await closePool();
});

/** One rolled-back transaction as the anon key: role anon, no JWT claims, so auth.uid() is NULL. */
const asAnon = <T,>(fn: (q: UserQuery) => Promise<T>): Promise<T> => asRole("anon", fn);

async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-code";
  }
}

describe("catalog: anon-executable SECURITY DEFINER functions in public", () => {
  it("is exactly the chain's eight (platform functions excluded)", async () => {
    const { rows } = await adminQuery(
      `select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosecdef
          and has_function_privilege('anon', p.oid, 'EXECUTE')
          and p.proname <> 'rls_auto_enable'
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        `,
    );
    expect(rows.map((r) => r.sig as string).sort()).toEqual([...ANON_EXECUTABLE_DEFINERS].sort());
  });

  it("five are trigger functions; three are boolean SQL helpers keyed on auth.uid()", async () => {
    const { rows } = await adminQuery(
      `select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig,
              format_type(p.prorettype, null) as ret,
              l.lanname as lang
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
        where n.nspname = 'public'
          and p.proname = any($1)`,
      [ANON_EXECUTABLE_DEFINERS.map((f) => f.slice(0, f.indexOf("(")))],
    );
    const bySig = new Map(rows.map((r) => [r.sig, r]));
    for (const f of ANON_TRIGGERS) expect(bySig.get(f)?.ret, f).toBe("trigger");
    for (const f of ["is_studio_member(uuid)", "is_studio_owner(uuid)", "session_is_visible(uuid)"]) {
      expect(bySig.get(f)).toMatchObject({ ret: "boolean", lang: "sql" });
    }
  });
});

describe("anon: what an unauthenticated caller can learn or change", () => {
  it("the three helpers answer false for every studio and session, including real ones", async () => {
    const answers = await asAnon(async (q) => {
      const out: boolean[] = [];
      for (const s of [a, b]) {
        out.push((await q(`select public.is_studio_member($1) as v`, [s.studioId])).rows[0].v);
        out.push((await q(`select public.is_studio_owner($1) as v`, [s.studioId])).rows[0].v);
      }
      for (const id of [aSession, bSession]) {
        out.push((await q(`select public.session_is_visible($1) as v`, [id])).rows[0].v);
      }
      return out;
    });
    expect(answers).toEqual([false, false, false, false, false, false]);
  });

  it("positive control: the same helpers answer true for A's owner on A only (non-vacuous)", async () => {
    const answers = await asUser(a.userId, async (q) => [
      (await q(`select public.is_studio_member($1) as v`, [a.studioId])).rows[0].v,
      (await q(`select public.is_studio_owner($1) as v`, [a.studioId])).rows[0].v,
      (await q(`select public.session_is_visible($1) as v`, [aSession])).rows[0].v,
      (await q(`select public.is_studio_member($1) as v`, [b.studioId])).rows[0].v,
      (await q(`select public.session_is_visible($1) as v`, [bSession])).rows[0].v,
    ]);
    expect(answers).toEqual([true, true, true, false, false]);
  });

  it.each(ANON_TRIGGERS)("%s cannot be invoked directly (0A000), so it reads and writes nothing", async (f) => {
    expect(await sqlState(() => asAnon((q) => q(`select public.${f}`)))).toBe("0A000");
  });
});

// Financial: the owner-gated payment readers. The four 0032 readers had no
// DB test before this file; none is called by the application today.
const appointmentId = "00000000-0000-4000-8000-0000000000a1";
const PAYMENT_READERS: Array<[string, (studio: string) => [string, unknown[]]]> = [
  ["get_appointment_payment_display", (s) => [`select * from public.get_appointment_payment_display($1, $2)`, [appointmentId, s]]],
  ["get_disputes_for_studio", (s) => [`select * from public.get_disputes_for_studio($1)`, [s]]],
  ["get_refunds_for_appointment", (s) => [`select * from public.get_refunds_for_appointment($1, $2)`, [appointmentId, s]]],
  ["get_payment_audit_for_appointment", (s) => [`select * from public.get_payment_audit_for_appointment($1, $2)`, [appointmentId, s]]],
  ["get_studio_payment_settings_display", (s) => [`select * from public.get_studio_payment_settings_display($1, false)`, [s]]],
];

describe("financial readers: owner of the named studio only", () => {
  it.each(PAYMENT_READERS)("%s: anon holds no EXECUTE", async (_n, call) => {
    const [text, params] = call(a.studioId);
    expect(await sqlState(() => asAnon((q) => q(text, params)))).toBe("42501");
  });

  it.each(PAYMENT_READERS)("%s: A's owner naming studio B is refused (42501)", async (_n, call) => {
    const [text, params] = call(b.studioId);
    expect(await sqlState(() => asUser(a.userId, (q) => q(text, params)))).toBe("42501");
  });

  it.each(PAYMENT_READERS)("%s: a non-owner member of A naming A is refused (42501)", async (_n, call) => {
    const [text, params] = call(a.studioId);
    expect(await sqlState(() => asUser(aMember.userId, (q) => q(text, params)))).toBe("42501");
  });

  it.each(PAYMENT_READERS)("%s: positive control, A's owner naming A is answered", async (_n, call) => {
    const [text, params] = call(a.studioId);
    expect(await sqlState(() => asUser(a.userId, (q) => q(text, params)))).toBeNull();
  });
});
