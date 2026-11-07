import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";

// HON-44 (role / ownership / studio isolation): CATALOG guards over the real chain. These do not seed data; they read pg_catalog
// and fail when a NEW write surface appears without an identity or studio scope, or when a table that is owner-only by design
// gains a member-level write policy. Behavioural two-studio denials are in cross-studio-denial.db.test.ts.
//
// Deliberately not a pin of the whole policy matrix: a pin like that trips on every unrelated migration (CLAUDE.md §2).
// It pins only the properties that must stay true.
// THESE ARE GUARDS AGAINST A NEW UNSCOPED WRITE SURFACE, NOT A PROOF of any policy: they inspect policy text with regexes. The
// behavioural two-studio denials in cross-studio-denial.db.test.ts are the real gate. "Owner-only" below is production behaviour
// today (and the snapshot for existing studios); under the Roles program (R1/R3/R4) several of these tables become
// permission-gated, and these assertions are replaced by the permission-matrix test.

afterAll(async () => {
  await closePool();
});

type Pol = { tablename: string; policyname: string; cmd: string; roles: string; qual: string | null; with_check: string | null };

async function writePolicies(): Promise<Pol[]> {
  const r = await adminQuery(
    `select p.tablename, p.policyname, p.cmd, p.roles::text as roles, p.qual, p.with_check
       from pg_policies p
      where p.schemaname = 'public' and p.cmd in ('INSERT','UPDATE','DELETE','ALL')`,
  );
  return r.rows as Pol[];
}

// A policy expression is "scoped" when it ties the row to the caller's studio membership/ownership or to the caller's own
// identity. A bare `true`, or an expression with none of these, is an unscoped write.
// session_is_visible(session_id) is the studio-membership visibility predicate for session-child tables (see U2 in HON44-GAPS).
const SCOPED = /is_studio_member|is_studio_owner|can_use_client_legal_identity|member_owns_scoped_timed_block|session_is_visible|auth\.uid\(\)/i;
// `auth.uid() is not null` (any signed-in user) mentions auth.uid() but scopes nothing: strip it before the SCOPED test.
const scopedText = (p: Pol) =>
  `${p.qual ?? ""} ${p.with_check ?? ""}`.replace(/auth\.uid\(\)\s+is\s+not\s+null/gi, "").replace(/\(\s*select\s+auth\.uid\(\)\s*\)\s+is\s+not\s+null/gi, "");
// An owner-only policy is not owner-only if it also admits members: reject is_studio_member in the same expression.
const requiresOwnerOnly = (p: Pol) => {
  const t = `${p.qual ?? ""} ${p.with_check ?? ""}`;
  return /is_studio_owner|role\s*=\s*'owner'/i.test(t) && !/is_studio_member/i.test(t);
};

// Public marketing sign-up tables: no studio column, anonymous insert by design (landing page waitlist and demo requests).
const PUBLIC_SIGNUP_TABLES = new Set(["waitlist", "demo_requests"]);

describe("HON-44 catalog: every authenticated write policy is scoped to the caller's studio or identity", () => {
  it("no write policy on a tenant table is unscoped (true / no studio or identity term)", async () => {
    const all = await writePolicies();
    expect(all.length).toBeGreaterThan(20); // it examined the real catalog, not an empty list
    const offenders = all
      .filter((p) => !PUBLIC_SIGNUP_TABLES.has(p.tablename))
      .filter((p) => !SCOPED.test(scopedText(p)))
      .map((p) => `${p.tablename}.${p.policyname} (${p.cmd})`);
    expect(offenders).toEqual([]);
  });

  it("an anonymous-reachable write policy exists only on the two public sign-up tables, or can never match an anonymous caller", async () => {
    // A policy granted to `public` or `anon` is reachable without a login. It is safe only if its expression needs auth.uid()
    // (null for anon, so the row filter never matches), directly or through an identity-bound helper (proved by the definer-function guard below). Anything else must be a sign-up table.
    const anon = (await writePolicies()).filter((p) => /\banon\b|\{\}|public/.test(p.roles));
    const offenders = anon
      .filter((p) => !PUBLIC_SIGNUP_TABLES.has(p.tablename))
      .filter((p) => !/auth\.uid\(\)|is_studio_owner|is_studio_member|member_owns_scoped_timed_block/i.test(`${p.qual ?? ""} ${p.with_check ?? ""}`))
      .map((p) => `${p.tablename}.${p.policyname} (${p.cmd})`);
    expect(offenders).toEqual([]);
    const cols = await adminQuery(
      `select table_name from information_schema.columns
        where table_schema = 'public' and table_name = any($1) and column_name = 'studio_id'`,
      [[...PUBLIC_SIGNUP_TABLES]],
    );
    expect(cols.rows).toEqual([]);
  });
});

// Tables whose WRITES are owner-only by product design (staff and invitations, studio settings, prices, money, availability,
// imports, tracking). A non-owner practitioner reaching PostgREST directly must not be able to write them, whatever the app
// screen does. Every policy that grants INSERT/UPDATE/DELETE on these must therefore require ownership.
const OWNER_ONLY_WRITE_TABLES = [
  "studios",
  "client_pricing",
  "services",
  "pending_invitations",
  "studio_availability_default",
  "studio_availability_overrides",
  "studio_blockouts",
  "studio_onboarding",
  "studio_tracking_providers",
  "import_batches",
  "imported_treatment_memories",
];

// OPEN GAP (team/HON44-GAPS.md H2; H1 closed by 0302, services moved to OWNER_ONLY_WRITE_TABLES): member-level write policies exist today. They are recorded affirmatively below (the exact
// member policies); the test turns red when the gap is closed, which is the signal to move the table into OWNER_ONLY_WRITE_TABLES.
// The fix is held (unnumbered SQL). Owner-only is production behaviour today, superseded by the Roles permission core (R1/R3/R4).
const OPEN_OWNER_ONLY_GAPS: [string, string][] = [
  ["consent_form_templates", "H2"],
];

describe("HON-44 catalog: owner-only-by-design tables have no member-level write policy", () => {
  // Affirmative record of the gap as it is TODAY: the table has write policies and exactly these admit members. Invert (and move
  // the table into OWNER_ONLY_WRITE_TABLES) when the held fix lands. It fails loudly if the table is renamed or loses its policies.
  const OPEN_GAP_MEMBER_POLICIES: Record<string, string[]> = {
    consent_form_templates: ["consent_form_templates_studio_member_insert (INSERT)", "consent_form_templates_studio_member_update (UPDATE)"],
  };
  it.each(OPEN_OWNER_ONLY_GAPS)("%s: OPEN GAP %s, member-level write policies exist today", async (table) => {
    const pols = (await writePolicies()).filter((p) => p.tablename === table);
    expect(pols.length).toBeGreaterThan(0);
    const nonOwner = pols.filter((p) => !requiresOwnerOnly(p)).map((p) => `${p.policyname} (${p.cmd})`).sort();
    expect(nonOwner).toEqual(OPEN_GAP_MEMBER_POLICIES[table]);
  });

  it.each(OWNER_ONLY_WRITE_TABLES)("%s: has write policies and every one requires ownership", async (table) => {
    const exists = await adminQuery(`select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = $1`, [table]);
    expect(exists.rowCount).toBe(1);
    const pols = (await writePolicies()).filter((p) => p.tablename === table);
    expect(pols.length).toBeGreaterThan(0);
    const nonOwner = pols.filter((p) => !requiresOwnerOnly(p)).map((p) => `${p.policyname} (${p.cmd})`);
    expect(nonOwner).toEqual([]);
  });
});

describe("HON-44 catalog: exposed SECURITY DEFINER functions are bound to an identity", () => {
  it("every non-trigger definer function executable by anon or authenticated references auth.uid()/auth.jwt() directly or through a helper (two levels)", async () => {
    const r = await adminQuery(
      `with fn as (
         select p.oid, p.proname, p.prosrc, p.prosecdef, p.prorettype::regtype::text as ret, n.nspname,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname not in ('pg_catalog','information_schema','pg_toast') and p.prokind = 'f'),
       base as (select proname from fn where prosrc ~* 'auth\\.uid\\(\\)|auth\\.jwt\\(\\)|request\\.jwt'),
       h1 as (select distinct f.proname from fn f join base b on f.prosrc ~ ('\\m' || b.proname || '\\M')),
       h2 as (select distinct f.proname from fn f join (select proname from base union select proname from h1) b
                on f.prosrc ~ ('\\m' || b.proname || '\\M'))
       select f.proname from fn f
        where f.nspname = 'public' and f.prosecdef and f.ret <> 'trigger' and (f.anon or f.auth)
          and f.proname not in (select proname from base)
          and not exists (select 1 from h2 b where f.prosrc ~ ('\\m' || b.proname || '\\M'))
        order by 1`,
    );
    expect(r.rows.map((x: { proname: string }) => x.proname)).toEqual([]);
    // it examined a real set of exposed definer functions, not an empty one
    const total = await adminQuery(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef and p.prorettype::regtype::text <> 'trigger'
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`,
    );
    expect(total.rows[0].n).toBeGreaterThan(10);
  });

  it("anonymous callers can execute no definer function other than the pinned predicates", async () => {
    const r = await adminQuery(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef and p.prorettype::regtype::text <> 'trigger'
          and has_function_privilege('anon', p.oid, 'execute') order by 1`,
    );
    // is_studio_member / is_studio_owner: boolean predicates over auth.uid(); for an anonymous caller auth.uid() is null, so false.
    // session_is_visible: a read-only boolean for an id the caller already holds, so it discloses at most one bit.
    expect(r.rows.map((x: { proname: string }) => x.proname)).toEqual(["is_studio_member", "is_studio_owner", "session_is_visible"]);
  });
});
