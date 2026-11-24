import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0381: the two older receptionist commands that return a client's FULL phone and email are closed to every role. The ACCEPTANCE test, on a
// real migrated database by DIRECT calls (what a signed-in person can do outside the app): (1) the ACL is closed and the bodies are untouched,
// (2) every kind of caller is refused with 42501, (3) the SUPPORTED desk workflow still works: search the displayed name, phone digits or
// email through the masked finder, a masked hint in the results, full contact only through the visit-contact command for a visit of the
// receptionist's OWN studio, the name rule (preferred, then regular, then 'Name on file' only when both are blank), and the legal
// identity never returned or searchable. Synthetic fixtures only; every assertion on a name is a boolean.
// FILE ORDER: this file runs on a database where the files that reopen the privilege for their own purposes have already closed it again.

const DIRECTORY = "public.receptionist_client_directory(uuid, text, text[], text, integer, integer)";
const CONTACTS_V2 = "public.receptionist_client_contacts_v2(uuid, text, integer)";
const BODY_MD5: Record<string, string> = {
  [DIRECTORY]: "9356d1ca1f30005b09b5f6ba1765d59f",
  [CONTACTS_V2]: "2c398e896eede58c9a09a11213b122a0",
};
const DIR = "select * from public.receptionist_client_directory($1::uuid, null, null, 'name', 0, 25)";
const CON = "select * from public.receptionist_client_contacts_v2($1::uuid, null, 50)";
const FIND = "select * from public.receptionist_booking_clients_v3($1::uuid, $2::text, 11)";
const CAL3 = "select * from public.receptionist_calendar_v3($1::uuid, now() - interval '1 day', now() + interval '40 days')";
const VISIT = "select * from public.receptionist_appointment_contact($1::uuid, $2::uuid)";

const LEGAL = ["Zzlegalpref", "Zzlegalreg"];
const HIDDEN = "Hiddenreg";
const MARK = "Name on file";

let A: SeededStudio;
let B: SeededStudio;
const who = {} as Record<"receptionist" | "otherDesk" | "inactive" | "practitioner" | "stranger", string>;
const c = {} as Record<"pref" | "reg" | "blank", string>;
const appt = {} as Record<"pref" | "reg" | "blank" | "foreign", string>;
const PHONE = { pref: "+14165550111", reg: "+14165550222", blank: "+14165550333" };
const EMAIL = { pref: "pref-fixture@example.test", reg: "reg-fixture@example.test", blank: "blank-fixture@example.test" };

async function authUser(label: string): Promise<string> {
  const id = randomUUID();
  await adminQuery("insert into auth.users (id, email) values ($1, $2)", [id, `${label}-${id.slice(0, 8)}@harness.local`]);
  return id;
}
async function seedVisit(studio: SeededStudio, clientId: string, days: number): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values ($1,$2,$3,$4, now() + ($5 || ' days')::interval, now() + ($5 || ' days')::interval + interval '1 hour', 60, 'confirmed', encode(sha256(gen_random_uuid()::text::bytea), 'hex'))`,
    [id, studio.studioId, studio.practitionerId, clientId, String(days)],
  );
  return id;
}
type Outcome = { rows: Record<string, unknown>[]; fields: string[] } | { code: string };
const call = async (uid: string | "anon" | "service_role", sql: string, params: unknown[]): Promise<Outcome> => {
  const run = uid === "anon" || uid === "service_role" ? asRole(uid, (q) => q(sql, params)) : asUser(uid, (q) => q(sql, params));
  return run.then(
    (r) => ({ rows: r.rows as Record<string, unknown>[], fields: r.fields.map((f) => f.name) }),
    (e: { code?: string }) => ({ code: e.code ?? "unknown" }),
  );
};
const rowsOf = (o: Outcome) => ("rows" in o ? o.rows : []);

beforeAll(async () => {
  A = await seedStudio("older-closed-a");
  B = await seedStudio("older-closed-b");
  who.practitioner = (await seedMember(A, "older-closed-prac")).userId;
  who.stranger = await authUser("older-closed-stranger");
  who.receptionist = await authUser("older-closed-desk");
  who.inactive = await authUser("older-closed-inactive");
  who.otherDesk = await authUser("older-closed-other");
  await adminQuery("insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1,$2,'Synthetic Front Desk',true)", [A.studioId, who.receptionist]);
  await adminQuery("insert into public.studio_receptionists (studio_id, user_id, display_name, active, deactivated_at) values ($1,$2,'Synthetic Front Desk',false, now())", [A.studioId, who.inactive]);
  await adminQuery("insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1,$2,'Synthetic Front Desk',true)", [B.studioId, who.otherDesk]);
  // pref: a preferred name AND a different regular name; reg: a regular name only; blank: both blank (a legacy row the guard now refuses).
  c.pref = A.clientId;
  await adminQuery("update public.clients set name = $2, preferred_name = 'Bean', phone = $3, email = $4 where id = $1", [c.pref, `${HIDDEN} Surnamea`, PHONE.pref, EMAIL.pref]);
  c.reg = randomUUID();
  await adminQuery("insert into public.clients (id, studio_id, name, preferred_name, phone, email) values ($1,$2,'Regonly Cardwell',null,$3,$4)", [c.reg, A.studioId, PHONE.reg, EMAIL.reg]);
  c.blank = randomUUID();
  await adminQuery(
    `alter table public.clients disable trigger clients_identity_guard;
     insert into public.clients (id, studio_id, name, preferred_name, phone, email) values ('${c.blank}', '${A.studioId}', '   ', null, '${PHONE.blank}', '${EMAIL.blank}');
     alter table public.clients enable trigger clients_identity_guard;`,
  );
  for (const [id, g] of [[c.pref, LEGAL[0]], [c.reg, LEGAL[1]]] as const) {
    await adminQuery("insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_family_name, legal_single_name, source) values ($1,$2,$3,$3,false,'staff_entry')", [id, A.studioId, g]);
  }
  appt.pref = await seedVisit(A, c.pref, 3);
  appt.reg = await seedVisit(A, c.reg, 4);
  appt.blank = await seedVisit(A, c.blank, 5);
  appt.foreign = await seedVisit(B, B.clientId, 3);
});
afterAll(closePool);

describe("the two older commands are closed to every role, and nothing else about them changed", () => {
  it.each([DIRECTORY, CONTACTS_V2])("%s: no role can execute it, no grantee but its owner, no grant option", async (fn) => {
    const { rows } = await adminQuery(
      `select has_function_privilege('public', $1::regprocedure, 'execute') as pub,
              has_function_privilege('anon', $1::regprocedure, 'execute') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'execute') as auth,
              has_function_privilege('service_role', $1::regprocedure, 'execute') as svc,
              (select count(*)::int from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = $1::regprocedure and a.grantee <> p.proowner) as other_grantees,
              (select count(*)::int from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = $1::regprocedure and a.is_grantable) as grantable,
              (select md5(prosrc) from pg_proc where oid = $1::regprocedure) as body_md5`,
      [fn],
    );
    expect(rows[0]).toMatchObject({ pub: false, anon: false, auth: false, svc: false, other_grantees: 0, grantable: 0, body_md5: BODY_MD5[fn] });
  });

  it("the comment on each says CLOSED", async () => {
    for (const fn of [DIRECTORY, CONTACTS_V2]) {
      const { rows } = await adminQuery("select obj_description($1::regprocedure, 'pg_proc') as d", [fn]);
      expect(String(rows[0].d)).toMatch(/^0381 CLOSED\./);
    }
  });

  it("receptionist_calendar_v2 is NOT closed (v3 reads it) and still executes for authenticated only", async () => {
    const { rows } = await adminQuery(
      `select has_function_privilege('authenticated', 'public.receptionist_calendar_v2(uuid, timestamptz, timestamptz)'::regprocedure, 'execute') as auth,
              has_function_privilege('anon', 'public.receptionist_calendar_v2(uuid, timestamptz, timestamptz)'::regprocedure, 'execute') as anon`,
    );
    expect(rows[0]).toMatchObject({ auth: true, anon: false });
  });
});

describe("every caller is refused with 42501, including an active receptionist of the same studio", () => {
  it.each([
    ["this studio's ACTIVE receptionist", () => who.receptionist],
    ["another studio's receptionist", () => who.otherDesk],
    ["an inactive receptionist", () => who.inactive],
    ["a practitioner", () => who.practitioner],
    ["a stranger", () => who.stranger],
    ["anon", () => "anon" as const],
    ["service_role", () => "service_role" as const],
  ])("%s", async (_n, actor) => {
    const dir = await call(actor(), DIR, [A.studioId]);
    const con = await call(actor(), CON, [A.studioId]);
    expect("code" in dir && dir.code, "directory").toBe("42501");
    expect("code" in con && con.code, "contacts_v2").toBe("42501");
  });
});

describe("the supported desk workflow still works with 0374, 0380, 0381 and 0376-0379", () => {
  it("the schedule shows preferred, then regular, then Name on file only when both are blank; no phone or email column", async () => {
    const o = await call(who.receptionist, CAL3, [A.studioId]);
    expect("rows" in o).toBe(true);
    const byClient = new Map(rowsOf(o).map((r) => [String(r.client_id), r]));
    expect(byClient.get(c.pref)).toMatchObject({ display_name: "Bean" });
    expect(byClient.get(c.reg)).toMatchObject({ display_name: "Regonly Cardwell" });
    expect(byClient.get(c.blank)).toMatchObject({ display_name: MARK });
    const fields = "fields" in o ? o.fields : [];
    expect(fields.filter((f) => /phone|email/i.test(f))).toEqual([]);
    const text = JSON.stringify(o);
    expect(text.includes(HIDDEN), "the regular name behind a preferred name").toBe(false);
    expect(LEGAL.some((l) => text.includes(l)), "legal identity").toBe(false);
  });

  it("the finder searches the displayed name (first name or surname), the email and the phone digits", async () => {
    for (const [term, id] of [
      ["bean", c.pref], ["Regonly", c.reg], ["cardwell", c.reg],
      [EMAIL.pref, c.pref], ["REG-FIXTURE@", c.reg], ["blank-fixture", c.blank],
      ["4165550111", c.pref], ["555 0222", c.reg], ["5550333", c.blank],
    ] as const) {
      const o = await call(who.receptionist, FIND, [A.studioId, term]);
      expect(rowsOf(o).map((r) => r.client_id), term).toEqual([id]);
    }
  });

  it("the finder never finds a hidden regular name, a legal name or the fixed words", async () => {
    for (const term of [HIDDEN, "Surnamea", `${HIDDEN} Surnamea`, ...LEGAL, "Zzlegal", MARK, "on file"]) {
      const o = await call(who.receptionist, FIND, [A.studioId, term]);
      expect(rowsOf(o).length, term.length + " chars").toBe(0);
    }
  });

  it("finder results carry a MASKED hint only: never the full email or phone, and the legal identity never appears", async () => {
    const all = [] as Record<string, unknown>[];
    for (const term of ["bean", "regonly", "blank-fixture"]) all.push(...rowsOf(await call(who.receptionist, FIND, [A.studioId, term])));
    expect(all.length).toBe(3);
    const o = await call(who.receptionist, FIND, [A.studioId, "bean"]);
    expect("fields" in o && o.fields).toEqual(["client_id", "display_name", "contact_hint"]);
    const text = JSON.stringify(all);
    for (const full of [...Object.values(EMAIL), ...Object.values(PHONE), "5550111", "5550222", "5550333"]) expect(text.includes(full), "full contact value").toBe(false);
    expect(LEGAL.some((l) => text.includes(l)) || text.includes(HIDDEN)).toBe(false);
    expect(all.find((r) => r.client_id === c.blank)).toMatchObject({ display_name: MARK });
    expect(all.every((r) => typeof r.contact_hint === "string" && String(r.contact_hint).includes("•••"))).toBe(true);
  });

  it("full contact comes ONLY from the visit-contact command, for a visit of the receptionist's own studio", async () => {
    const own = await call(who.receptionist, VISIT, [A.studioId, appt.pref]);
    expect("fields" in own && own.fields).toEqual(["phone", "email"]);
    expect(rowsOf(own)).toEqual([{ phone: PHONE.pref, email: EMAIL.pref }]);
    expect(rowsOf(await call(who.receptionist, VISIT, [A.studioId, appt.blank]))).toEqual([{ phone: PHONE.blank, email: EMAIL.blank }]);
    // another studio's visit id, asked through this studio, returns nothing; another studio's id is refused
    expect(rowsOf(await call(who.receptionist, VISIT, [A.studioId, appt.foreign]))).toEqual([]);
    const refused = await call(who.receptionist, VISIT, [B.studioId, appt.foreign]);
    expect("code" in refused && refused.code).toBe("42501");
    const otherAsksA = await call(who.otherDesk, VISIT, [A.studioId, appt.pref]);
    expect("code" in otherAsksA && otherAsksA.code).toBe("42501");
    expect(JSON.stringify(own).includes(HIDDEN) || LEGAL.some((l) => JSON.stringify(own).includes(l))).toBe(false);
  });

  it("another studio's receptionist gets nothing from the finder or the schedule of this studio", async () => {
    for (const o of [await call(who.otherDesk, FIND, [A.studioId, "bean"]), await call(who.otherDesk, CAL3, [A.studioId])]) {
      expect("code" in o && o.code).toBe("42501");
    }
  });
});
