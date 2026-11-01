import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0274 receptionist desk projection (held, stacked on 0258/0266). Proved on the
// real migrated database. Synthetic values only.

const LEGAL = "Zyxwq"; // appears only in a legal name
const DIR = "public.receptionist_client_directory(uuid,text,text[],text,integer,integer)";
const CAL2 = "public.receptionist_calendar_v2(uuid,timestamptz,timestamptz)";
const CAL1 = "public.receptionist_calendar(uuid,timestamptz,timestamptz)";

let a: SeededStudio;
let b: SeededStudio;
let aDesk: string;
let bDesk: string;
let aPrac: { userId: string; practitionerId: string };
const ids: Record<string, string> = {};

async function seedDesk(studio: SeededStudio, label: string): Promise<string> {
  const userId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [userId, `${label}-${userId.slice(0, 8)}@harness.local`]);
  await adminQuery("insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',true)", [studio.studioId, userId]);
  return userId;
}
async function addClient(studio: SeededStudio, key: string, name: string, preferred: string | null, phone: string | null, email: string | null): Promise<string> {
  const id = randomUUID();
  await adminQuery("insert into public.clients(id,studio_id,name,preferred_name,phone,email) values ($1,$2,$3,$4,$5,$6)", [id, studio.studioId, name, preferred, phone, email]);
  ids[key] = id;
  return id;
}
async function addAppt(studio: SeededStudio, clientId: string, status: string, startsAt: string): Promise<void> {
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 hour', 60, $5, encode(sha256(gen_random_uuid()::text::bytea), 'hex'))`,
    [studio.studioId, studio.practitionerId, clientId, startsAt, status],
  );
}
const dir = (uid: string, studio: string, q: string | null = null, filters: string[] | null = null, sort = "name", offset = 0, limit = 25) =>
  asUser(uid, (x) => x(`select * from public.receptionist_client_directory($1,$2,$3,$4,$5,$6)`, [studio, q, filters, sort, offset, limit]));

beforeAll(async () => {
  a = await seedStudio("desk-proj-a");
  b = await seedStudio("desk-proj-b");
  aPrac = await seedMember(a, "desk-proj-prac");
  aDesk = await seedDesk(a, "desk-a");
  bDesk = await seedDesk(b, "desk-b");
  await adminQuery("update public.clients set name='Margaret Stored', preferred_name='Maggie', phone='+1 555 0101', email='maggie@harness.local' where id=$1", [a.clientId]);
  ids.maggie = a.clientId;
  await adminQuery("insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_family_name, updated_by) values ($1,$2,'Marguerite',$3,$4)", [a.clientId, a.studioId, LEGAL, a.practitionerId]);
  await addClient(a, "plain", "Plain Person", null, "+1 555 0102", "plain@harness.local");
  const archived = await addClient(a, "archived", "Archived Person", null, null, null);
  await adminQuery("update public.clients set archived_at = now() where id=$1", [archived]);
  await addClient(b, "other", "Other Studio Person", null, null, null);
  await addAppt(a, ids.maggie, "confirmed", "2031-03-04T15:00:00Z");
  await addAppt(a, ids.plain, "completed", "2024-01-02T15:00:00Z");
  await addAppt(a, ids.plain, "cancelled", "2025-06-01T15:00:00Z");
  await addAppt(a, ids.plain, "confirmed", "2023-01-01T15:00:00Z"); // past, still confirmed: never a visit
});

afterAll(async () => {
  await closePool();
});

describe("who may call it", () => {
  it("anon, service_role, owner, practitioner and another studio's desk are refused", async () => {
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, (x) => x(`select * from public.receptionist_client_directory($1)`, [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    }
    await expect(dir(a.userId, a.studioId)).rejects.toMatchObject({ code: "42501" });
    await expect(dir(aPrac.userId, a.studioId)).rejects.toMatchObject({ code: "42501" });
    await expect(dir(bDesk, a.studioId)).rejects.toMatchObject({ code: "42501" });
  });
  it("a deactivated receptionist is refused", async () => {
    await adminQuery("update public.studio_receptionists set active=false, deactivated_at=now() where user_id=$1", [aDesk]);
    await expect(dir(aDesk, a.studioId)).rejects.toMatchObject({ code: "42501" });
    await adminQuery("update public.studio_receptionists set active=true, deactivated_at=null where user_id=$1", [aDesk]);
  });
});

describe("the payload", () => {
  it("returns exactly the allow-listed columns", async () => {
    const r = await dir(aDesk, a.studioId);
    expect(r.fields.map((f) => f.name)).toEqual([
      "client_id", "display_name", "name_on_file", "phone", "email",
      "next_appointment_at", "last_visit_on", "intake_state", "consent_signed", "total_count",
    ]);
  });
  it("shows the preferred name, labels the fallback, and never the stored name or legal name", async () => {
    const r = await dir(aDesk, a.studioId);
    const byId = new Map(r.rows.map((x) => [x.client_id, x]));
    expect(byId.get(ids.maggie)).toMatchObject({ display_name: "Maggie", name_on_file: false });
    expect(byId.get(ids.plain)).toMatchObject({ display_name: "Plain Person", name_on_file: true });
    expect(JSON.stringify(r.rows)).not.toContain("Margaret");
    expect(JSON.stringify(r.rows)).not.toContain(LEGAL);
    expect(byId.has(ids.archived)).toBe(false);
    expect(byId.has(ids.other)).toBe(false);
  });
  it("search matches the shown name, email and phone, never the stored name behind a preferred one; a legal-only term finds nothing (positive control)", async () => {
    const hit = async (q: string) => (await dir(aDesk, a.studioId, q)).rows.map((x) => x.client_id);
    expect(await hit("maggie")).toEqual([ids.maggie]);
    expect(await hit("harness.local")).toHaveLength(2);
    expect(await hit("555 0102")).toEqual([ids.plain]);
    expect(await hit("Margaret")).toEqual([]);
    expect(await hit(LEGAL)).toEqual([]);
    expect(await hit("100%")).toEqual([]);
  });
  it("total_count equals the searched and filtered set; next and last visit follow the definitions", async () => {
    const all = await dir(aDesk, a.studioId);
    expect(all.rows.every((x) => Number(x.total_count) === all.rows.length)).toBe(true);
    const byId = new Map(all.rows.map((x) => [x.client_id, x]));
    expect(new Date(byId.get(ids.maggie)!.next_appointment_at).toISOString()).toBe("2031-03-04T15:00:00.000Z");
    expect(byId.get(ids.plain)!.next_appointment_at).toBeNull();
    expect(String(byId.get(ids.plain)!.last_visit_on)).toContain("2024");
    expect(byId.get(ids.maggie)!.last_visit_on).toBeNull();
    const none = await dir(aDesk, a.studioId, null, ["no_upcoming"]);
    expect(none.rows.map((x) => x.client_id)).toEqual([ids.plain]);
    expect(Number(none.rows[0].total_count)).toBe(1);
  });
  it("intake is a closed enum and consent is a boolean for treatment_consent only", async () => {
    const states = new Set((await dir(aDesk, a.studioId)).rows.map((x) => x.intake_state));
    for (const s of states) expect(["not_submitted", "awaiting_review", "reviewed"]).toContain(s);
    const tpl = randomUUID();
    await adminQuery("insert into public.consent_form_templates (id, studio_id, title, body, form_type, version, status) values ($1,$2,'Photo consent','body','photo_consent',1,'active')", [tpl, a.studioId]);
    await adminQuery(
      `insert into public.client_consent_signatures (id, studio_id, client_id, template_id, template_title_snapshot, template_body_snapshot, template_version, template_hash, signature_name, response, response_label_snapshot)
       values (gen_random_uuid(), $1, $2, $3, 'Photo consent', 'body', 1, $4, 'Synthetic', 'accepted', 'I agree')`,
      [a.studioId, ids.maggie, tpl, "b".repeat(64)],
    );
    const m = (await dir(aDesk, a.studioId, "maggie")).rows[0];
    expect(m.consent_signed).toBe(false); // photo consent is not treatment consent
    const tpl2 = randomUUID();
    await adminQuery("insert into public.consent_form_templates (id, studio_id, title, body, form_type, version, status, is_live) values ($1,$2,'Treatment consent','body','treatment_consent',1,'active',true)", [tpl2, a.studioId]);
    await adminQuery(
      `insert into public.client_consent_signatures (id, studio_id, client_id, template_id, template_title_snapshot, template_body_snapshot, template_version, template_hash, signature_name, response, response_label_snapshot)
       values (gen_random_uuid(), $1, $2, $3, 'Treatment consent', 'body', 1, $4, 'Synthetic', 'accepted', 'I agree')`,
      [a.studioId, ids.maggie, tpl2, "c".repeat(64)],
    );
    expect((await dir(aDesk, a.studioId, "maggie")).rows[0].consent_signed).toBe(true);
  });
});

describe("Insurance D1-D3 (peer review of #1303)", () => {
  const sign = (client: string, tpl: string, version: number, response: string, at: string, hash: string) =>
    adminQuery(
      `insert into public.client_consent_signatures (id, studio_id, client_id, template_id, template_title_snapshot, template_body_snapshot, template_version, template_hash, signature_name, response, response_label_snapshot, signed_at)
       values (gen_random_uuid(), $1, $2, $3, 'Treatment consent', 'body', $4, $5, 'Synthetic', $6, 'label', $7)`,
      [a.studioId, client, tpl, version, hash.repeat(64).slice(0, 64), response, at],
    );
  const consentOf = async (q: string) => (await dir(aDesk, a.studioId, q)).rows[0].consent_signed;

  it("D1: a superseded version, a later denial, and a template that is no longer live never read as signed", async () => {
    const plain = "555 0102";
    // The earlier case left a live treatment_consent template signed only for another client;
    // this case tests one template at a time, so retire every earlier live one first.
    await adminQuery("update public.consent_form_templates set is_live = false where studio_id = $1 and form_type = 'treatment_consent'", [a.studioId]);
    const tpl = randomUUID();
    await adminQuery("insert into public.consent_form_templates (id, studio_id, title, body, form_type, version, status, is_live) values ($1,$2,'Treatment v1','body','treatment_consent',1,'active',true)", [tpl, a.studioId]);
    await sign(ids.plain, tpl, 1, "accepted", "2024-02-01T10:00:00Z", "d");
    expect(await consentOf(plain)).toBe(true);
    // The template moves to version 2: the v1 signature is out of date.
    await adminQuery("update public.consent_form_templates set version = 2 where id = $1", [tpl]);
    expect(await consentOf(plain)).toBe(false);
    await sign(ids.plain, tpl, 2, "accepted", "2024-03-01T10:00:00Z", "e");
    expect(await consentOf(plain)).toBe(true);
    // A later denial of the current version wins.
    await sign(ids.plain, tpl, 2, "denied", "2024-04-01T10:00:00Z", "f");
    expect(await consentOf(plain)).toBe(false);
    // Not live: nothing to be signed against.
    await adminQuery("update public.consent_form_templates set is_live = false where id = $1", [tpl]);
    expect(await consentOf(plain)).toBe(false);
  });

  it("D1: with two live treatment templates, a client signed on only one is NOT signed (the 'every' rule)", async () => {
    const plain = "555 0102";
    await adminQuery("update public.consent_form_templates set is_live = false where studio_id = $1 and form_type = 'treatment_consent'", [a.studioId]);
    const t1 = randomUUID();
    const t2 = randomUUID();
    for (const [id, title] of [[t1, "Modality one"], [t2, "Modality two"]]) {
      await adminQuery("insert into public.consent_form_templates (id, studio_id, title, body, form_type, version, status, is_live) values ($1,$2,$3,'body','treatment_consent',1,'active',true)", [id, a.studioId, title]);
    }
    await sign(ids.plain, t1, 1, "accepted", "2024-05-01T10:00:00Z", "1");
    expect(await consentOf(plain)).toBe(false);
    await sign(ids.plain, t2, 1, "accepted", "2024-05-02T10:00:00Z", "2");
    expect(await consentOf(plain)).toBe(true);
    await adminQuery("update public.consent_form_templates set is_live = false where id in ($1,$2)", [t1, t2]);
  });

  it("D2: last visit is the STUDIO-local date (a UTC-next-day visit does not show tomorrow)", async () => {
    const day = async () =>
      (await asUser(aDesk, (x) => x(`select to_char(last_visit_on,'YYYY-MM-DD') as d from public.receptionist_client_directory($1,'555 0102',null,'name',0,25)`, [a.studioId]))).rows[0].d;
    const original = (await adminQuery("select timezone from public.studios where id = $1", [a.studioId])).rows[0].timezone;
    try {
      await adminQuery("update public.studios set timezone = 'America/Toronto' where id = $1", [a.studioId]);
      expect(await day()).toBe("2024-01-02"); // 15:00Z = 10:00 local
      await adminQuery("update public.studios set timezone = 'Pacific/Auckland' where id = $1", [a.studioId]);
      expect(await day()).toBe("2024-01-03"); // 15:00Z = 04:00 next day local
    } finally {
      await adminQuery("update public.studios set timezone = $2 where id = $1", [a.studioId, original]);
    }
  });

  it("D3: a too-long term and a too-short term are refused with different messages", async () => {
    await expect(dir(aDesk, a.studioId, "x".repeat(81))).rejects.toMatchObject({ code: "22023", message: expect.stringContaining("query_too_long") });
    await expect(dir(aDesk, a.studioId, "x")).rejects.toMatchObject({ code: "22023", message: expect.stringContaining("query_too_short") });
    expect((await dir(aDesk, a.studioId, "x".repeat(80))).rowCount).toBe(0);
  });
});

describe("R2: no enumeration", () => {
  it("page 2 with an empty query is refused (control: page 1 works)", async () => {
    expect((await dir(aDesk, a.studioId)).rowCount).toBeGreaterThan(0);
    await expect(dir(aDesk, a.studioId, null, null, "name", 25, 25)).rejects.toMatchObject({ code: "22023" });
    await expect(dir(aDesk, a.studioId, "  ", null, "name", 1, 25)).rejects.toMatchObject({ code: "22023" });
  });
  it("a query shorter than 2 characters, an offset past the cap, and unknown sort or filter values are refused", async () => {
    await expect(dir(aDesk, a.studioId, "m")).rejects.toMatchObject({ code: "22023" });
    await expect(dir(aDesk, a.studioId, "ma", null, "name", 180, 50)).rejects.toMatchObject({ code: "22023" });
    await expect(dir(aDesk, a.studioId, null, null, "id")).rejects.toMatchObject({ code: "22023" });
    await expect(dir(aDesk, a.studioId, null, ["archived"])).rejects.toMatchObject({ code: "22023" });
    expect((await dir(aDesk, a.studioId, "ma", null, "name", 150, 50)).rowCount).toBe(0); // at the cap, allowed
  });
  it("a studio larger than the cap cannot be walked: the last reachable row is at most 200", async () => {
    for (let i = 0; i < 230; i += 1) {
      await adminQuery("insert into public.clients(id,studio_id,name) values (gen_random_uuid(),$1,$2)", [b.studioId, `Walk Client ${String(i).padStart(3, "0")}`]);
    }
    const seen = new Set<string>();
    for (let off = 0; off < 200; off += 50) {
      const r = await asUser(bDesk, (x) => x(`select client_id from public.receptionist_client_directory($1,'Walk',null,'name',$2,50)`, [b.studioId, off]));
      r.rows.forEach((x) => seen.add(x.client_id));
    }
    expect(seen.size).toBe(200);
    await expect(asUser(bDesk, (x) => x(`select client_id from public.receptionist_client_directory($1,'Walk',null,'name',200,50)`, [b.studioId]))).rejects.toMatchObject({ code: "22023" });
  });
});

describe("R1: the schedule", () => {
  const cal = (uid: string, studio: string) =>
    asUser(uid, (x) => x(`select * from public.receptionist_calendar_v2($1,'2031-03-01T00:00:00Z','2031-03-10T00:00:00Z')`, [studio]));
  it("v2 carries display_name and name_on_file and never the stored name; refuses other roles and studios", async () => {
    const r = await cal(aDesk, a.studioId);
    expect(r.rows.map((x) => [x.display_name, x.name_on_file])).toEqual([["Maggie", false]]);
    expect(JSON.stringify(r.rows)).not.toContain("Margaret");
    expect(r.fields.map((f) => f.name)).toEqual([
      "appointment_id", "starts_at", "ends_at", "status", "practitioner_id", "practitioner_display_name",
      "practitioner_color", "service_id", "service_name", "client_id", "display_name", "name_on_file",
    ]);
    await expect(cal(bDesk, a.studioId)).rejects.toMatchObject({ code: "42501" });
    await expect(cal(aPrac.userId, a.studioId)).rejects.toMatchObject({ code: "42501" });
  });
  it("v1 is closed to every role (privilege, not only a call), and v1 contacts stays closed", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await adminQuery("select has_function_privilege($1,$2,'EXECUTE') ok", [role, CAL1])).rows[0].ok).toBe(false);
    }
    await expect(asUser(aDesk, (x) => x(`select * from public.receptionist_calendar($1,'2031-03-01T00:00:00Z','2031-03-10T00:00:00Z')`, [a.studioId]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("Privacy C2 and Insurance L7 (reviews of 0274 at 236e34d6)", () => {
  const MARK = ["MARK-APPT-NOTE", "MARK-CANCEL-REASON", "MARK-ADDRESS", "MARK-DOB"];
  const cal = (uid: string, studio: string) =>
    asUser(uid, (x) => x(`select * from public.receptionist_calendar_v2($1,'2031-03-01T00:00:00Z','2031-03-10T00:00:00Z')`, [studio]));

  it("neither function returns a planted note, cancellation reason, address or date of birth (owner control: the staff path DOES read them)", async () => {
    await adminQuery("update public.appointments set notes = $2 where studio_id = $1 and client_id = $3 and status = 'confirmed' and starts_at > now()", [a.studioId, MARK[0], ids.maggie]);
    await addAppt(a, ids.maggie, "cancelled", "2031-03-05T15:00:00Z");
    await adminQuery("update public.appointments set cancellation_reason = $2 where studio_id = $1 and client_id = $3 and status = 'cancelled' and starts_at = '2031-03-05T15:00:00Z'", [a.studioId, MARK[1], ids.maggie]);
    await adminQuery("update public.clients set address = $2, date_of_birth = '1990-01-01' where id = $1", [ids.maggie, MARK[2]]);
    // positive control: a staff (owner) session reads the planted values, so the markers are really there.
    const staffNotes = await asUser(a.userId, (x) => x("select notes, cancellation_reason from public.appointments where studio_id = $1 and client_id = $2 order by starts_at", [a.studioId, ids.maggie]));
    expect(JSON.stringify(staffNotes.rows)).toContain(MARK[0]);
    expect(JSON.stringify(staffNotes.rows)).toContain(MARK[1]);
    const v2 = await cal(aDesk, a.studioId);
    const directory = await dir(aDesk, a.studioId);
    for (const m of MARK) {
      expect(JSON.stringify(v2.rows)).not.toContain(m);
      expect(JSON.stringify(directory.rows)).not.toContain(m);
    }
    expect(v2.rows.length).toBeGreaterThan(0);
    expect(directory.rows.length).toBeGreaterThan(0);
  });

  it("cross-studio, both directions, for both functions", async () => {
    await expect(dir(bDesk, a.studioId)).rejects.toMatchObject({ code: "42501" });
    await expect(dir(aDesk, b.studioId)).rejects.toMatchObject({ code: "42501" });
    await expect(cal(bDesk, a.studioId)).rejects.toMatchObject({ code: "42501" });
    await expect(cal(aDesk, b.studioId)).rejects.toMatchObject({ code: "42501" });
    // and each desk sees only its own studio's clients
    const bRows = (await dir(bDesk, b.studioId)).rows.map((x) => x.client_id);
    const aRows = (await dir(aDesk, a.studioId)).rows.map((x) => x.client_id);
    expect(bRows).toContain(ids.other);
    expect(aRows).toContain(ids.plain);
    expect(bRows).not.toContain(ids.plain);
    expect(aRows).not.toContain(ids.other);
  });

  it("an archived client is absent from the directory and from search (positive control: the same client is found when active)", async () => {
    expect((await dir(aDesk, a.studioId)).rows.map((x) => x.client_id)).not.toContain(ids.archived);
    expect((await dir(aDesk, a.studioId, "Archived")).rows).toHaveLength(0);
    await adminQuery("update public.clients set archived_at = null where id = $1", [ids.archived]);
    try {
      expect((await dir(aDesk, a.studioId, "Archived")).rows.map((x) => x.client_id)).toEqual([ids.archived]);
    } finally {
      await adminQuery("update public.clients set archived_at = now() where id = $1", [ids.archived]);
    }
  });

  it("L7: a client with ONLY a live session and no completed appointment reads an empty desk last visit (the narrowing, pinned)", async () => {
    const only = await addClient(a, "sessiononly", "Session Only", null, null, null);
    await adminQuery(
      `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality) values (gen_random_uuid(), $1, $2, $3, 'electrolysis')`,
      [a.studioId, only, a.practitionerId],
    );
    const sessions = await adminQuery("select count(*)::int n from public.sessions where studio_id = $1 and client_id = $2 and deleted_at is null", [a.studioId, only]);
    expect(sessions.rows[0].n).toBe(1); // the staff-side fact exists
    const row = (await dir(aDesk, a.studioId, "Session Only")).rows[0];
    expect(row.client_id).toBe(only);
    expect(row.last_visit_on).toBeNull();
    // control: a completed appointment is what makes the desk date appear
    await addAppt(a, only, "completed", "2024-03-03T15:00:00Z");
    expect((await dir(aDesk, a.studioId, "Session Only")).rows[0].last_visit_on).not.toBeNull();
  });
});

describe("grants", () => {
  it("the two new functions are executable by authenticated only", async () => {
    for (const fn of [DIR, CAL2]) {
      for (const role of ["anon", "service_role"]) expect((await adminQuery("select has_function_privilege($1,$2,'EXECUTE') ok", [role, fn])).rows[0].ok).toBe(false);
      expect((await adminQuery("select has_function_privilege('authenticated',$1,'EXECUTE') ok", [fn])).rows[0].ok).toBe(true);
      expect((await adminQuery("select count(*)::int n from pg_proc p, aclexplode(p.proacl) x where p.oid = to_regprocedure($1) and x.grantee = 0", [fn])).rows[0].n).toBe(0);
    }
  });
});
