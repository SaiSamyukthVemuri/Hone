import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedHistoricalAppointmentAudit, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// HON-58 Q1 (0266, provisional number): receptionist access to client legal
// names is an owner switch, OFF by default. Proved on the real migrated
// database, per surface, with the switch OFF, then ON, then OFF again.

const TOKEN = "Zyxwq"; // appears ONLY in a legal name, never in a stored or preferred name

let a: SeededStudio;
let b: SeededStudio;
let aPractitioner: { userId: string; practitionerId: string };
let aDesk: string;
let bDesk: string;
let aDeskRowId: string;

async function seedDesk(studio: SeededStudio, label: string): Promise<{ userId: string; rowId: string }> {
  const userId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [userId, `${label}-${userId.slice(0, 8)}@harness.local`]);
  const r = await adminQuery(
    "insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',true) returning id",
    [studio.studioId, userId],
  );
  return { userId, rowId: r.rows[0].id as string };
}

const setSwitch = (userId: string, studio: string, on: boolean) =>
  asUser(userId, async (q) => (await q("select public.set_receptionist_legal_name_access($1,$2) as changed", [studio, on])).rows[0].changed as boolean);

const deskRead = (userId: string, studio: string) =>
  asUser(userId, (q) => q("select client_id, legal_given_name, legal_family_name from public.client_legal_identities where studio_id = $1", [studio]));

const deskLegalSearch = (userId: string, studio: string) =>
  asUser(userId, (q) => q("select client_id from public.client_legal_identities where studio_id = $1 and legal_family_name ilike $2", [studio, `%${TOKEN}%`]));

beforeAll(async () => {
  a = await seedStudio("legal-access-a");
  b = await seedStudio("legal-access-b");
  aPractitioner = await seedMember(a, "legal-access-a-prac");
  const d1 = await seedDesk(a, "desk-a");
  aDesk = d1.userId;
  aDeskRowId = d1.rowId;
  bDesk = (await seedDesk(b, "desk-b")).userId;
  await adminQuery("update public.clients set name = 'Margaret Stored' where id = $1", [a.clientId]);
  await adminQuery("update public.clients set preferred_name = 'Maggie' where id = $1", [a.clientId]);
  for (const s of [a, b]) {
    await adminQuery(
      "insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_family_name, updated_by) values ($1,$2,'Marguerite',$3,$4)",
      [s.clientId, s.studioId, `${TOKEN}-${s === a ? "A" : "B"}`, s.practitionerId],
    );
  }
});

afterAll(async () => {
  await closePool();
});

describe("OFF by default: every surface a receptionist can reach refuses the legal name", () => {
  it("no setting row exists and the predicate is false for the desk, true for owner and practitioner", async () => {
    expect((await adminQuery("select count(*)::int n from public.studio_legal_name_access where studio_id = $1", [a.studioId])).rows[0].n).toBe(0);
    const pred = (uid: string, studio: string) => asUser(uid, async (q) => (await q("select public.can_read_client_legal_identity($1) as ok", [studio])).rows[0].ok as boolean);
    expect(await pred(aDesk, a.studioId)).toBe(false);
    expect(await pred(a.userId, a.studioId)).toBe(true);
    expect(await pred(aPractitioner.userId, a.studioId)).toBe(true);
  });

  it("payload: the table returns NO row, so no legal-name field is sent (not merely hidden)", async () => {
    const r = await deskRead(aDesk, a.studioId);
    expect(r.rowCount).toBe(0);
    expect(r.fields.map((f) => f.name)).toEqual(["client_id", "legal_given_name", "legal_family_name"]);
    expect(JSON.stringify(r.rows)).not.toContain(TOKEN);
  });

  it("search: matching on legal-name text finds nothing", async () => {
    expect((await deskLegalSearch(aDesk, a.studioId)).rowCount).toBe(0);
  });

  it("the receptionist finder returns the display identity only and never matches legal or stored-behind-preferred text", async () => {
    const find = (q: string) => asUser(aDesk, (x) => x("select * from public.receptionist_client_contacts_v2($1,$2)", [a.studioId, q]));
    const byPreferred = await find("Maggie");
    expect(byPreferred.rows.map((r) => r.display_name)).toEqual(["Maggie"]);
    expect(Object.keys(byPreferred.rows[0]).sort()).toEqual(["client_id", "display_name", "email", "name_on_file", "phone"]);
    expect((await find(TOKEN)).rowCount).toBe(0); // legal text
    expect((await find("Marguerite")).rowCount).toBe(0); // legal given name
    expect((await find("Stored")).rowCount).toBe(0); // the stored name behind a preferred one
  });

  it("fallback: a client with no preferred name is found and shown by the stored name", async () => {
    const c = randomUUID();
    await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Plain Fallback')", [c, a.studioId]);
    const r = await asUser(aDesk, (x) => x("select display_name from public.receptionist_client_contacts_v2($1,'Fallback')", [a.studioId]));
    expect(r.rows.map((x) => x.display_name)).toEqual(["Plain Fallback"]);
  });

  it("writes stay owner/practitioner: a receptionist cannot insert or update even when the switch is ON", async () => {
    await setSwitch(a.userId, a.studioId, true);
    const c = randomUUID();
    await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Desk Client')", [c, a.studioId]);
    await expect(asUser(aDesk, (q) => q("insert into public.client_legal_identities (client_id, studio_id, legal_given_name) values ($1,$2,'Desk')", [c, a.studioId]))).rejects.toMatchObject({ code: "42501" });
    const upd = await asUser(aDesk, (q) => q("update public.client_legal_identities set legal_given_name = 'Hacked' where client_id = $1", [a.clientId]));
    expect(upd.rowCount).toBe(0);
    await setSwitch(a.userId, a.studioId, false);
  });
});

describe("ON, then OFF: revocation on the next request", () => {
  it("ON lets this studio's desk read and search legal names; the very next statement after OFF sees none", async () => {
    expect(await setSwitch(a.userId, a.studioId, true)).toBe(true);
    const on = await deskRead(aDesk, a.studioId);
    expect(on.rows.map((r) => r.legal_family_name)).toEqual([`${TOKEN}-A`]);
    expect((await deskLegalSearch(aDesk, a.studioId)).rowCount).toBe(1);

    expect(await setSwitch(a.userId, a.studioId, false)).toBe(true);
    expect((await deskRead(aDesk, a.studioId)).rowCount).toBe(0);
    expect((await deskLegalSearch(aDesk, a.studioId)).rowCount).toBe(0);
  });

  it("deactivating the receptionist is a second revocation path while ON", async () => {
    await setSwitch(a.userId, a.studioId, true);
    expect((await deskRead(aDesk, a.studioId)).rowCount).toBe(1);
    await adminQuery("update public.studio_receptionists set active = false, deactivated_at = now() where id = $1", [aDeskRowId]);
    expect((await deskRead(aDesk, a.studioId)).rowCount).toBe(0);
    await adminQuery("update public.studio_receptionists set active = true, deactivated_at = null where id = $1", [aDeskRowId]);
    await setSwitch(a.userId, a.studioId, false);
  });
});

describe("tenant isolation", () => {
  it("studio A ON gives A's desk nothing in studio B, and B's desk nothing in A", async () => {
    await setSwitch(a.userId, a.studioId, true);
    expect((await deskRead(aDesk, b.studioId)).rowCount).toBe(0);
    expect((await deskRead(bDesk, a.studioId)).rowCount).toBe(0);
    expect((await deskRead(bDesk, b.studioId)).rowCount).toBe(0); // B is still OFF
    await setSwitch(a.userId, a.studioId, false);
  });

  it("another studio's owner cannot flip this studio's switch", async () => {
    await expect(setSwitch(b.userId, a.studioId, true)).rejects.toMatchObject({ code: "42501" });
    expect((await adminQuery("select count(*)::int n from public.studio_legal_name_access where studio_id = $1 and receptionist_access", [a.studioId])).rows[0].n).toBe(0);
  });
});

describe("the owner-only command and its audit", () => {
  it("only an owner may change it: practitioner, receptionist, anon and service_role are refused", async () => {
    await expect(setSwitch(aPractitioner.userId, a.studioId, true)).rejects.toMatchObject({ code: "42501" });
    await expect(setSwitch(aDesk, a.studioId, true)).rejects.toMatchObject({ code: "42501" });
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, (q) => q("select public.set_receptionist_legal_name_access($1,true)", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("writes one audit row per real change (who, when, old -> new) and none for a no-op", async () => {
    const s = await seedStudio("legal-access-audit");
    expect(await setSwitch(s.userId, s.studioId, false)).toBe(false); // default OFF -> OFF: no change
    expect(await setSwitch(s.userId, s.studioId, true)).toBe(true);
    expect(await setSwitch(s.userId, s.studioId, true)).toBe(false);
    expect(await setSwitch(s.userId, s.studioId, false)).toBe(true);
    const rows = (await adminQuery("select old_value, new_value, changed_by, changed_by_user, changed_at from public.client_legal_name_access_audit where studio_id = $1 order by id", [s.studioId])).rows;
    expect(rows.map((r) => [r.old_value, r.new_value])).toEqual([[false, true], [true, false]]);
    for (const r of rows) {
      expect(r.changed_by).toBe(s.practitionerId);
      expect(r.changed_by_user).toBe(s.userId);
      expect(r.changed_at).toBeInstanceOf(Date);
    }
  });

  it("the audit is append-only and visible to the studio owner only", async () => {
    const s = await seedStudio("legal-access-audit-ro");
    const m = await seedMember(s, "legal-access-audit-ro-prac");
    await setSwitch(s.userId, s.studioId, true);
    await expect(adminQuery("update public.client_legal_name_access_audit set new_value = false where studio_id = $1", [s.studioId])).rejects.toMatchObject({ code: "23514" });
    await expect(adminQuery("delete from public.client_legal_name_access_audit where studio_id = $1", [s.studioId])).rejects.toMatchObject({ code: "23514" });
    await expect(adminQuery("truncate public.client_legal_name_access_audit")).rejects.toMatchObject({ code: "23514" });
    expect((await asUser(s.userId, (q) => q("select id from public.client_legal_name_access_audit where studio_id = $1", [s.studioId]))).rowCount).toBe(1);
    expect((await asUser(m.userId, (q) => q("select id from public.client_legal_name_access_audit where studio_id = $1", [s.studioId]))).rowCount).toBe(0);
    await expect(asUser(s.userId, (q) => q("insert into public.client_legal_name_access_audit (studio_id, old_value, new_value) values ($1,false,true)", [s.studioId]))).rejects.toMatchObject({ code: "42501" });
  });

  it("the setting table cannot be written directly by any API role, and the desk cannot read it", async () => {
    await expect(asUser(a.userId, (q) => q("insert into public.studio_legal_name_access (studio_id, receptionist_access) values ($1,true)", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    await setSwitch(a.userId, a.studioId, true);
    await expect(asUser(a.userId, (q) => q("update public.studio_legal_name_access set receptionist_access = false where studio_id = $1", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    expect((await asUser(aDesk, (q) => q("select * from public.studio_legal_name_access"))).rowCount).toBe(0);
    await setSwitch(a.userId, a.studioId, false);
  });
});

describe("containment: the switch opens legal identity and nothing else", () => {
  it("no policy except the legal-identity SELECT uses the new read predicate", async () => {
    const r = await adminQuery(
      "select tablename, policyname, cmd from pg_policies where schemaname = 'public' and (coalesce(qual,'') ilike '%can_read_client_legal_identity%' or coalesce(with_check,'') ilike '%can_read_client_legal_identity%')",
    );
    expect(r.rows).toEqual([{ tablename: "client_legal_identities", policyname: "client_legal_identities_select", cmd: "SELECT" }]);
  });

  it("with the switch ON the desk still cannot read intake forms (which carry a 'Full legal name' answer) or clients directly", async () => {
    await setSwitch(a.userId, a.studioId, true);
    expect((await asUser(aDesk, (q) => q("select id from public.client_intake_forms"))).rowCount).toBe(0);
    expect((await asUser(aDesk, (q) => q("select id from public.clients"))).rowCount).toBe(0);
    await setSwitch(a.userId, a.studioId, false);
  });

  it("the new functions are not executable by anon or service_role", async () => {
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, (q) => q("select public.can_read_client_legal_identity($1)", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
      await expect(asRole(role, (q) => q("select * from public.receptionist_client_contacts_v2($1,null)", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    }
  });
});

// Sam, 28 Oct: a name hidden behind a preferred name must not be retrievable or
// searchable by the desk through ANY database path, and the stored name stays
// shown (labelled "Name on file") when there is no preferred name.
describe("closing the older receptionist paths to clients.name", () => {
  const V1 = "public.receptionist_client_contacts(uuid,text,integer)";
  const CAL = "public.receptionist_calendar(uuid,timestamptz,timestamptz)";
  const hasPriv = async (role: string, fn: string) =>
    (await adminQuery("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, fn])).rows[0].ok as boolean;
  let apptId: string;

  beforeAll(async () => {
    const r = await adminQuery(
      `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
       values (gen_random_uuid(), $1, $2, $3, '2031-03-04T15:00:00Z', '2031-03-04T16:00:00Z', 60, 'confirmed', encode(sha256(gen_random_uuid()::text::bytea), 'hex')) returning id`,
      [a.studioId, a.practitionerId, a.clientId],
    );
    apptId = r.rows[0].id as string;
  });

  it("v1 is executable by no role at all (privilege check, not only a call)", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) expect(await hasPriv(role, V1)).toBe(false);
    expect((await adminQuery("select count(*)::int n from pg_proc p, aclexplode(p.proacl) x where p.oid = to_regprocedure($1) and x.grantee = 0", [V1])).rows[0].n).toBe(0);
  });

  it("the desk cannot call v1 with a search that names a stored name behind a preferred one, nor list without a query", async () => {
    for (const args of [[a.studioId, "Stored"], [a.studioId, null], [a.studioId, "Margaret"]]) {
      await expect(asUser(aDesk, (q) => q("select * from public.receptionist_client_contacts($1,$2)", args))).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("v1 stays closed for the owner and practitioner too (nobody calls it; held desk branches use v2)", async () => {
    await expect(asUser(a.userId, (q) => q("select * from public.receptionist_client_contacts($1)", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
  });

  it("v1 still exists with its reviewed source (the 0243 pin is about its source, not its grants)", async () => {
    expect((await adminQuery("select to_regprocedure($1) is not null as present", [V1])).rows[0].present).toBe(true);
  });

  it("the desk calendar shows the preferred name, and the stored name only where there is none", async () => {
    const cal = () => asUser(aDesk, (q) => q("select client_id, client_display_name from public.receptionist_calendar($1,'2031-03-01T00:00:00Z','2031-03-10T00:00:00Z')", [a.studioId]));
    let rows = (await cal()).rows;
    expect(rows.map((r) => r.client_display_name)).toEqual(["Maggie"]);
    expect(JSON.stringify(rows)).not.toContain("Margaret");
    await adminQuery("update public.clients set preferred_name = null where id = $1", [a.clientId]);
    rows = (await cal()).rows;
    expect(rows.map((r) => r.client_display_name)).toEqual(["Margaret Stored"]);
    await adminQuery("update public.clients set preferred_name = 'Maggie' where id = $1", [a.clientId]);
  });

  it("v2 labels the fallback: name_on_file is true only when the stored name is what is shown", async () => {
    const found = await asUser(aDesk, (q) => q("select display_name, name_on_file from public.receptionist_client_contacts_v2($1,'Maggie')", [a.studioId]));
    expect(found.rows).toEqual([{ display_name: "Maggie", name_on_file: false }]);
    const c = randomUUID();
    await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Label Fallback')", [c, a.studioId]);
    const fb = await asUser(aDesk, (q) => q("select display_name, name_on_file from public.receptionist_client_contacts_v2($1,'Label Fallback')", [a.studioId]));
    expect(fb.rows).toEqual([{ display_name: "Label Fallback", name_on_file: true }]);
  });

  it("tenant isolation: the other studio's desk is refused on the finder and the calendar, and sees none of A's names", async () => {
    await expect(asUser(bDesk, (q) => q("select * from public.receptionist_client_contacts_v2($1,'Maggie')", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(bDesk, (q) => q("select * from public.receptionist_calendar($1,'2031-03-01T00:00:00Z','2031-03-10T00:00:00Z')", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    const own = await asUser(bDesk, (q) => q("select display_name from public.receptionist_client_contacts_v2($1,'Stored')", [b.studioId]));
    expect(own.rowCount).toBe(0);
  });

  it("revocation: a deactivated receptionist is refused by the finder and the calendar on the next call", async () => {
    await adminQuery("update public.studio_receptionists set active = false, deactivated_at = now() where id = $1", [aDeskRowId]);
    await expect(asUser(aDesk, (q) => q("select * from public.receptionist_client_contacts_v2($1,'Maggie')", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(aDesk, (q) => q("select * from public.receptionist_calendar($1,'2031-03-01T00:00:00Z','2031-03-10T00:00:00Z')", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    await adminQuery("update public.studio_receptionists set active = true, deactivated_at = null where id = $1", [aDeskRowId]);
  });

  it("direct table access: the desk cannot read clients.name at all (the projections are the only route)", async () => {
    const r = await asUser(aDesk, (q) => q("select name, preferred_name from public.clients where studio_id = $1", [a.studioId]));
    expect(r.rowCount).toBe(0);
  });

  it("privacy request: the display identity is updated deliberately; the legal record and every audit/history row survive untouched", async () => {
    await setSwitch(a.userId, a.studioId, true);
    await setSwitch(a.userId, a.studioId, false); // two access-audit rows
    await seedHistoricalAppointmentAudit({ appointmentId: apptId, actorType: "practitioner", actorId: a.practitionerId, action: "privacy_fixture", createdAtSql: "now()" });
    const snapshot = async () => ({
      legal: (await adminQuery("select legal_given_name, legal_family_name, updated_at, updated_by from public.client_legal_identities where client_id = $1", [a.clientId])).rows,
      access: (await adminQuery("select count(*)::int n, max(changed_at) m from public.client_legal_name_access_audit where studio_id = $1", [a.studioId])).rows,
      appt: (await adminQuery("select count(*)::int n from public.appointment_audit where appointment_id = $1", [apptId])).rows,
      appointments: (await adminQuery("select count(*)::int n from public.appointments where client_id = $1", [a.clientId])).rows,
    });
    const before = await snapshot();
    expect(before.access[0].n).toBeGreaterThanOrEqual(2);
    expect(before.appt[0].n).toBeGreaterThanOrEqual(1);
    // the owner changes the stored name to the name the client goes by, as a normal staff edit
    await asUser(a.userId, (q) => q("update public.clients set name = 'Maggie Q', preferred_name = 'Maggie' where id = $1 and studio_id = $2", [a.clientId, a.studioId]));
    const after = await snapshot();
    expect(after).toEqual(before);
    // the desk (switch OFF) now finds the new display identity and nothing of the old stored name or the legal name
    const find = (t: string) => asUser(aDesk, (q) => q("select display_name from public.receptionist_client_contacts_v2($1,$2)", [a.studioId, t]));
    expect((await find("Maggie")).rowCount).toBe(1);
    expect((await find("Margaret")).rowCount).toBe(0);
    expect((await find(TOKEN)).rowCount).toBe(0);
    await adminQuery("update public.clients set name = 'Margaret Stored' where id = $1", [a.clientId]);
  });
});
