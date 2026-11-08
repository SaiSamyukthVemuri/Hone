import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// HON-58 receptionist name privacy (0280 proof gaps F2). A receptionist sees the preferred name or the label
// "Name on file"; the stored name (which may be a legal name) must change NOTHING she can observe: not a hit,
// a count, a sort position, a page boundary, a payload, or an error message. The strongest form of that claim is
// tested directly: rewrite every stored name, then require the receptionist-visible output to be byte-identical.
// Real receptionist JWTs on the real migrated database. Synthetic values only.
// The behavioural tests prove the two callable functions; the census at the end is a source scan that only keeps the list from growing unseen.
// Cancel-reason cap (0280 item 4): covered in receptionist-name-rule.db.test.ts, not repeated here.
// Other name-holding tables (waitlist entries, intake, messages) are outside 0280 and outside this file.

const LABEL = "Name on file";
const STORED_TERMS = ["Omegastored", "Alphastored", "Legalname", "Betastored"];
const LEGAL_TERMS = ["Legalgiven", "Legalfamily", "Rewrittengiven", "Rewrittenfamily"];

let a: SeededStudio;
let b: SeededStudio;
let deskA: string;
let deskB: string;
const ids: Record<string, string> = {};

async function seedDesk(studio: SeededStudio, tag: string): Promise<string> {
  const userId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [userId, `privacy-${tag}-${userId.slice(0, 8)}@harness.local`]);
  await adminQuery("insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',true)", [studio.studioId, userId]);
  return userId;
}
async function addClient(studio: SeededStudio, key: string, name: string, preferred: string | null, phone: string): Promise<void> {
  const id = randomUUID();
  await adminQuery("insert into public.clients(id,studio_id,name,preferred_name,phone) values ($1,$2,$3,$4,$5)", [id, studio.studioId, name, preferred, phone]);
  ids[key] = id;
}
const dir = (desk: string, studio: SeededStudio, q: string | null, sort = "name", offset = 0, limit = 25) =>
  asUser(desk, (x) => x(`select * from public.receptionist_client_directory($1,$2,null,$3,$4,$5)`, [studio.studioId, q, sort, offset, limit]));
const cal = (desk: string, studio: SeededStudio) =>
  asUser(desk, (x) => x(`select * from public.receptionist_calendar_v2($1,'2031-03-01T00:00:00Z','2031-03-10T00:00:00Z')`, [studio.studioId]));

// Everything a receptionist can observe about the directory and the schedule, as one comparable value.
async function observe(): Promise<unknown> {
  const out: Record<string, unknown> = {};
  out.browse = (await dir(deskA, a, null)).rows;
  out.browseNext = (await dir(deskA, a, null, "next")).rows;
  out.byPhone = (await dir(deskA, a, "555")).rows;
  out.byPhoneNext = (await dir(deskA, a, "555", "next")).rows;
  out.pages = [];
  for (let off = 0; off < 4; off++) (out.pages as unknown[]).push((await dir(deskA, a, "555", "name", off, 1)).rows);
  // Keyed by position: a term-named key would put the searched word into the serialized value itself.
  const terms = [...STORED_TERMS, ...LEGAL_TERMS, "Caz", "Dee", "Name on", "Abe", "Zed"];
  for (let i = 0; i < terms.length; i++) out[`term${i}`] = (await dir(deskA, a, terms[i])).rows;
  out.calendar = (await cal(deskA, a)).rows;
  return out;
}

beforeAll(async () => {
  a = await seedStudio("priv-a");
  b = await seedStudio("priv-b");
  deskA = await seedDesk(a, "a");
  deskB = await seedDesk(b, "b");
  await adminQuery("update public.clients set archived_at = now() where id = any($1)", [[a.clientId, b.clientId]]);
  // Stored-name order is Abe < Beta < Zed; the shown values are a label, a label, a label and two preferred names.
  await addClient(a, "zed", "Zed Omegastored", null, "+1 555 0301");
  await addClient(a, "abe", "Abe Alphastored", null, "+1 555 0302");
  await addClient(a, "beta", "Beta Betastored", null, "+1 555 0305");
  await addClient(a, "carol", "Carol Legalname", "Caz", "+1 555 0303");
  await addClient(a, "dee", "Dee Legalname", "Dee P", "+1 555 0304");
  // A second studio with its own clients (tenant isolation).
  await addClient(b, "bx", "Xavier Otherstudio", "Xav", "+1 555 0399");
  const appt = (studio: SeededStudio, key: string, at: string) =>
    adminQuery(
      `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
       values (gen_random_uuid(), $1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 hour', 60, 'confirmed', encode(sha256(gen_random_uuid()::text::bytea), 'hex'))`,
      [studio.studioId, studio.practitionerId, ids[key], at],
    );
  await appt(a, "zed", "2031-03-04T15:00:00Z");
  await appt(a, "abe", "2031-03-04T17:00:00Z");
  await appt(a, "carol", "2031-03-05T15:00:00Z");
  await appt(b, "bx", "2031-03-04T15:00:00Z");
  // A legal-identity row for one client, so the "receptionist reads none of it" checks have something to miss.
  for (const key of ["carol", "abe", "zed"]) {
    await adminQuery(`insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_family_name) values ($1,$2,'Legalgiven','Legalfamily')`, [ids[key], a.studioId]);
  }
});

afterAll(async () => {
  await closePool();
});

const ALL_FORBIDDEN = [...STORED_TERMS, "Zzzfirst", "Zzz Lastname", "Legalgiven", "Legalfamily", "Rewrittengiven", "Rewrittenfamily", "Otherstudio"];
let snapshot = "";

async function refusalTexts(): Promise<Array<[string, string]>> {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["too short", () => dir(deskA, a, "x")],
    ["too long", () => dir(deskA, a, "Omegastored".repeat(10))],
    ["bad sort", () => dir(deskA, a, "555", "legalname")],
    ["page out of range", () => dir(deskA, a, "555", "name", 190, 50)],
    ["query required", () => dir(deskA, a, null, "name", 5, 5)],
    ["foreign studio", () => dir(deskB, a, "555")],
    ["foreign calendar", () => cal(deskB, a)],
  ];
  const out: Array<[string, string]> = [];
  for (const [label, call] of calls) {
    const err = await call().then(() => null, (e: Error & { code?: string; detail?: string; hint?: string }) => e);
    expect(err, label).not.toBeNull();
    out.push([label, `${err?.message} ${err?.detail ?? ""} ${err?.hint ?? ""}`]);
  }
  return out;
}

// Runs FIRST, while every stored and legal name still holds its original value, so an absence check here is about names that exist.
describe("before any rewrite: the names exist and none of them is observable", () => {
  it("the stored and legal names are really in the tables (controls), and the observation is non-empty", async () => {
    const stored = await adminQuery("select count(*)::int n from public.clients where studio_id=$1 and name ~ '(Omegastored|Alphastored|Betastored|Legalname)'", [a.studioId]);
    expect(stored.rows[0].n).toBe(5);
    const legal = await adminQuery("select count(*)::int n from public.client_legal_identities where studio_id=$1 and legal_given_name='Legalgiven'", [a.studioId]);
    expect(legal.rows[0].n).toBe(3);
    snapshot = JSON.stringify(await observe());
    expect((await dir(deskA, a, null)).rows).toHaveLength(5);
    expect((await cal(deskA, a)).rows).toHaveLength(3);
    expect(snapshot.length).toBeGreaterThan(1000);
  });
  it("no stored name, legal name or other studio's name appears in any observed value", () => {
    for (const t of ALL_FORBIDDEN) expect(snapshot, t).not.toContain(t);
  });
  it("every refusal path names no stored name and no legal name", async () => {
    for (const [label, text] of await refusalTexts()) for (const t of ALL_FORBIDDEN) expect(text, `${label}: ${t}`).not.toContain(t);
    const long = await dir(deskA, a, "Omegastored".repeat(10)).then(() => "", (e: Error) => e.message);
    expect(long).not.toContain("Omegastored");
  });
});

describe("rewriting the stored AND legal names changes nothing a receptionist can observe", () => {
  it("browse, sort, search, count, pages and schedule are byte-identical (control: the rewrite really happened)", async () => {
    // Reverse the stored order, make two stored names equal to another client's SHOWN value and to a phone-like string (the probes an
    // attacker would try), and change the legal identity rows too.
    await adminQuery("update public.clients set name = 'Aaa Zzzfirst' where id = $1", [ids.zed]);
    await adminQuery("update public.clients set name = 'Caz' where id = $1", [ids.abe]);
    await adminQuery("update public.clients set name = '555 0303' where id = $1", [ids.beta]);
    await adminQuery("update public.clients set name = 'Dee P Legalname' where id = $1", [ids.carol]);
    await adminQuery("update public.clients set name = 'Zzz Lastname' where id = $1", [ids.dee]);
    await adminQuery("update public.client_legal_identities set legal_given_name = 'Rewrittengiven', legal_family_name = 'Rewrittenfamily' where client_id = any($1)", [[ids.carol, ids.abe]]);
    await adminQuery("update public.client_legal_identities set legal_given_name = 'Caz', legal_family_name = 'Dee P' where client_id = $1", [ids.zed]);
    const after = JSON.stringify(await observe());
    expect(snapshot.length).toBeGreaterThan(1000);
    expect(after).toBe(snapshot);
    const changed = await adminQuery("select count(*)::int n from public.clients where id = any($1) and name in ('Aaa Zzzfirst','Caz','555 0303','Dee P Legalname','Zzz Lastname')", [[ids.zed, ids.abe, ids.beta, ids.carol, ids.dee]]);
    expect(changed.rows[0].n).toBe(5);
    const legal = await adminQuery("select count(*)::int n from public.client_legal_identities where studio_id=$1 and legal_given_name in ('Rewrittengiven','Caz')", [a.studioId]);
    expect(legal.rows[0].n).toBe(3);
  });
  it("after the rewrite the new values are observable nowhere either", async () => {
    const all = JSON.stringify(await observe());
    for (const t of ALL_FORBIDDEN) expect(all, t).not.toContain(t);
    for (const [label, text] of await refusalTexts()) for (const t of ALL_FORBIDDEN) expect(text, `${label}: ${t}`).not.toContain(t);
  });
});

describe("search, count and page boundary", () => {
  it("a stored name never matches, even when it equals another client's shown value; the shown value and phone do", async () => {
    // Abe's stored name is now exactly "Caz", Carol's shown value. Only Carol may answer.
    expect((await dir(deskA, a, "Caz")).rows.map((r) => r.client_id)).toEqual([ids.carol]);
    // Beta's stored name is now a phone-like string equal to Carol's number; the phone search still finds Carol only.
    expect((await dir(deskA, a, "555 0303")).rows.map((r) => r.client_id)).toEqual([ids.carol]);
    expect((await dir(deskA, a, "Dee P")).rows.map((r) => r.client_id)).toEqual([ids.dee]);
    // The label is not a search key (it would list every unlabelled client).
    expect((await dir(deskA, a, "Name on")).rows).toEqual([]);
    expect((await dir(deskA, a, "on file")).rows).toEqual([]);
  });
  it("paging with a one-row page reproduces the full order with no skip or repeat, and every page carries the same count", async () => {
    const full = (await dir(deskA, a, "555", "name", 0, 50)).rows.map((r) => r.client_id);
    expect(full).toHaveLength(5);
    const walked: string[] = [];
    for (let off = 0; off < 5; off++) {
      const p = await dir(deskA, a, "555", "name", off, 1);
      expect(p.rows).toHaveLength(1);
      expect(Number(p.rows[0].total_count)).toBe(5);
      walked.push(p.rows[0].client_id as string);
    }
    expect(walked).toEqual(full);
    expect(new Set(walked).size).toBe(5);
    expect((await dir(deskA, a, "555", "name", 5, 1)).rows).toEqual([]);
  });
  it("the unlabelled clients order by id, not by stored name (shown value ties on the label)", async () => {
    const r = (await dir(deskA, a, "555", "name", 0, 50)).rows;
    const unlabelled = r.filter((x) => x.name_on_file).map((x) => x.client_id as string);
    expect(unlabelled).toHaveLength(3);
    expect(unlabelled).toEqual([...unlabelled].sort());
    // preferred names first: 'caz' < 'dee p' < 'name on file'
    expect(r.slice(0, 2).map((x) => x.display_name)).toEqual(["Caz", "Dee P"]);
  });
});

describe("tenant isolation", () => {
  it("another studio's receptionist is refused A, and sees only B, in directory and schedule", async () => {
    await expect(dir(deskB, a, null)).rejects.toMatchObject({ code: "42501" });
    await expect(cal(deskB, a)).rejects.toMatchObject({ code: "42501" });
    const own = (await dir(deskB, b, null)).rows;
    expect(own.map((r) => r.display_name)).toEqual(["Xav"]);
    // A's phone numbers and preferred names do not exist in B.
    expect((await dir(deskB, b, "555 0303")).rows).toEqual([]);
    expect((await dir(deskB, b, "Caz")).rows).toEqual([]);
    expect((await cal(deskB, b)).rows.map((r) => r.display_name)).toEqual(["Xav"]);
  });
});

describe("schedule projection", () => {
  it("receptionist_calendar_v2 returns exactly the display columns, only the studio's appointments in the window, and nothing outside it", async () => {
    const r = await cal(deskA, a);
    const cols = r.fields.map((f) => f.name);
    for (const banned of ["name", "client_name", "preferred_name", "legal_given_name", "legal_family_name", "notes"]) expect(cols).not.toContain(banned);
    expect(cols).toEqual(expect.arrayContaining(["display_name", "name_on_file"]));
    expect(r.rows).toHaveLength(3);
    const shown = r.rows.map((x) => [x.display_name, x.name_on_file]).sort();
    expect(shown).toEqual([[LABEL, true], [LABEL, true], ["Caz", false]].sort());
    const empty = await asUser(deskA, (x) => x(`select * from public.receptionist_calendar_v2($1,'2040-01-01T00:00:00Z','2040-01-02T00:00:00Z')`, [a.studioId]));
    expect(empty.rows).toEqual([]);
  });
});

describe("direct reads by the receptionist reach no name", () => {
  it("clients and the legal identity table return no row (control: the owner reads them)", async () => {
    for (const sql of [
      "select name, preferred_name from public.clients where studio_id = $1",
      "select legal_given_name, legal_family_name from public.client_legal_identities where studio_id = $1",
    ]) {
      expect((await asUser(deskA, (x) => x(sql, [a.studioId]))).rows, sql).toEqual([]);
    }
    expect((await asUser(a.userId, (x) => x("select name from public.clients where studio_id = $1", [a.studioId]))).rows.length).toBeGreaterThan(0);
    expect((await asUser(a.userId, (x) => x("select legal_given_name from public.client_legal_identities where studio_id = $1", [a.studioId]))).rows.length).toBe(3);
  });
  it("the access-switch table returns no row to her even when the switch is ON (control: the owner reads it)", async () => {
    await adminQuery("insert into public.studio_legal_name_access(studio_id, receptionist_access) values ($1, true) on conflict (studio_id) do update set receptionist_access = true", [a.studioId]);
    expect((await asUser(deskA, (x) => x("select receptionist_access from public.studio_legal_name_access where studio_id = $1", [a.studioId]))).rows).toEqual([]);
    expect((await asUser(a.userId, (x) => x("select receptionist_access from public.studio_legal_name_access where studio_id = $1", [a.studioId]))).rows).toHaveLength(1);
  });
  it("the older name-bearing finders are closed to her (privilege layer)", async () => {
    await expect(asUser(deskA, (x) => x("select * from public.receptionist_client_contacts_v2($1,null,25)", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(deskA, (x) => x("select * from public.receptionist_client_contacts($1,null,25)", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(deskA, (x) => x("select * from public.receptionist_calendar($1,'2031-03-01T00:00:00Z','2031-03-10T00:00:00Z')", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
  });
});

// B: a CENSUS (a source scan, not a proof). The behavioural tests above are what prove the two listed functions; this only keeps the set from
// growing unseen. It flags any function a role can execute that is receptionist-related (its name or source says "receptionist", directly or
// through a function it calls) AND reads clients or client_legal_identities (any spelling: c.name, cl.name, c.*, to_jsonb(c), select name from
// clients, legal_* columns), directly, through a function it calls, or through a view. Anything not on the allowlist fails until someone
// has decided how it shows a name.
// A receptionist signs in as `authenticated` (and an anonymous caller is `anon`). `service_role` is the server's own key and is not reachable with a
// receptionist session, so functions executable ONLY by service_role (the public-booking commands, some of which return the booking client's own
// submitted name to the server) are outside this census; the closed-finder test below still checks all three roles.
const CENSUS_ROLES = ["anon", "authenticated"];
const READS_NAMES = /\b(clients|client_legal_identities)\b|\blegal_(given|middle|family)_name\b/i;
const ALLOWED_READERS: Record<string, string> = {
  receptionist_calendar_v2: "display identity only (preferred name else the label); proved by the equality tests above",
  receptionist_client_directory: "display identity only; proved by the equality tests above",
  receptionist_create_appointment: "reads clients only to validate the target and returns (result, appointment_id, starts_at, ends_at): no name column; its raise texts contain no client value (read in the 8 Nov slot)",
};

async function unexpectedReaders(): Promise<string[]> {
  const fns = (await adminQuery(
    `select p.proname, p.prosrc, (select bool_or(has_function_privilege(r, p.oid, 'EXECUTE')) from unnest($1::text[]) r) as callable
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f'`,
    [CENSUS_ROLES],
  )).rows as Array<{ proname: string; prosrc: string; callable: boolean }>;
  const views = (await adminQuery(`select viewname, definition from pg_views where schemaname = 'public'`)).rows as Array<{ viewname: string; definition: string }>;
  const mentions = (src: string, name: string) => new RegExp(`\\b${name}\\b`, "i").test(src);
  // Fixed point: a function reads names if its source does, or if it calls a function or selects from a view that does.
  const reads = new Set<string>();
  const readingViews = new Set(views.filter((v) => READS_NAMES.test(v.definition)).map((v) => v.viewname));
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of fns) {
      if (reads.has(f.proname)) continue;
      const hit = READS_NAMES.test(f.prosrc) || [...readingViews].some((v) => mentions(f.prosrc, v)) || [...reads].some((g) => g !== f.proname && new RegExp(`\\b${g}\\s*\\(`, "i").test(f.prosrc));
      if (hit) { reads.add(f.proname); changed = true; }
    }
  }
  const receptionist = new Set(fns.filter((f) => /receptionist/i.test(f.proname) || /receptionist/i.test(f.prosrc)).map((f) => f.proname));
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of fns) {
      if (receptionist.has(f.proname)) continue;
      if ([...receptionist].some((g) => new RegExp(`\\b${g}\\s*\\(`, "i").test(f.prosrc))) { receptionist.add(f.proname); changed = true; }
    }
  }
  return fns.filter((f) => f.callable && receptionist.has(f.proname) && reads.has(f.proname) && !(f.proname in ALLOWED_READERS)).map((f) => f.proname).sort();
}

describe("census: receptionist-related callable functions that read client names", () => {
  it("none outside the allowlist, and the allowed ones are present and callable", async () => {
    expect(await unexpectedReaders()).toEqual([]);
    const r = await adminQuery(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1) and has_function_privilege('authenticated', p.oid, 'EXECUTE')`, [Object.keys(ALLOWED_READERS)]);
    expect(r.rows.map((x) => x.proname).sort()).toEqual(Object.keys(ALLOWED_READERS).sort());
  });
  it("the three older name-bearing finders are closed to every role", async () => {
    const r = await adminQuery(
      `select p.proname, bool_or(has_function_privilege(role, p.oid, 'EXECUTE')) as callable
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join unnest($1::text[]) role
        where n.nspname = 'public' and p.proname = any($2) group by p.proname order by 1`,
      [["anon", "authenticated", "service_role"], ["receptionist_calendar", "receptionist_client_contacts", "receptionist_client_contacts_v2"]],
    );
    expect(r.rows.map((x) => [x.proname, x.callable])).toEqual([["receptionist_calendar", false], ["receptionist_client_contacts", false], ["receptionist_client_contacts_v2", false]]);
  });
  it("NEGATIVE CONTROL: planted functions that read the name turn the census red (direct, indirect, c.*, legal column, and a view)", async () => {
    const planted = ["zz_receptionist_direct", "zz_receptionist_star", "zz_receptionist_legal", "zz_receptionist_via_fn", "zz_receptionist_via_view"];
    try {
      await adminQuery(`create function public.zz_receptionist_direct(p uuid) returns text language sql security definer set search_path = pg_catalog, pg_temp as $$ select name from public.clients where id = p $$`);
      await adminQuery(`create function public.zz_receptionist_star(p uuid) returns jsonb language sql security definer set search_path = pg_catalog, pg_temp as $$ select to_jsonb(c) from public.clients c where c.id = p $$`);
      await adminQuery(`create function public.zz_receptionist_legal(p uuid) returns text language sql security definer set search_path = pg_catalog, pg_temp as $$ select legal_family_name from public.client_legal_identities where client_id = p $$`);
      await adminQuery(`create function public.zz_helper_reads(p uuid) returns text language sql security definer set search_path = pg_catalog, pg_temp as $$ select name from public.clients where id = p $$`);
      await adminQuery(`create function public.zz_receptionist_via_fn(p uuid) returns text language sql security definer set search_path = pg_catalog, pg_temp as $$ select public.zz_helper_reads(p) $$`);
      await adminQuery(`create view public.zz_names_view as select id, name from public.clients`);
      await adminQuery(`create function public.zz_receptionist_via_view(p uuid) returns text language sql security definer set search_path = pg_catalog, pg_temp as $$ select name from public.zz_names_view where id = p $$`);
      for (const f of [...planted, "zz_helper_reads"]) await adminQuery(`grant execute on function public.${f}(uuid) to authenticated`);
      const flagged = await unexpectedReaders();
      for (const f of planted) expect(flagged, f).toContain(f);
    } finally {
      for (const f of [...planted, "zz_helper_reads"]) await adminQuery(`drop function if exists public.${f}(uuid)`);
      await adminQuery(`drop view if exists public.zz_names_view`);
    }
    expect(await unexpectedReaders()).toEqual([]);
  });
});
