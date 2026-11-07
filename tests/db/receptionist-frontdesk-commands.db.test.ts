import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// 0307 front-desk commands (Roles brief C.4): IG-2 mark no-show, IG-3 create client and change contact.
// Proved on the real migrated database with real receptionist JWTs. Synthetic values only.

let a: SeededStudio;
let b: SeededStudio;
let desk: string;
let deskB: string;
let deactivated: string;

async function seedDesk(studio: SeededStudio, active = true): Promise<string> {
  const userId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [userId, `fd-${userId.slice(0, 8)}@harness.local`]);
  await adminQuery(
    "insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',$3)",
    [studio.studioId, userId, active],
  );
  return userId;
}

let slot = 0;
async function appt(studio: SeededStudio, status: string, past: boolean): Promise<string> {
  const id = randomUUID();
  const n = slot++;
  const start = past ? `now() - make_interval(days => ${40 + n})` : `now() + make_interval(days => ${40 + n})`;
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values ($1, $2, $3, $4, ${start}, ${start} + interval '1 hour', 60, $5, encode(sha256(gen_random_uuid()::text::bytea), 'hex'))`,
    [id, studio.studioId, studio.practitionerId, studio.clientId, status],
  );
  return id;
}
const statusOf = async (id: string) => (await adminQuery("select status from public.appointments where id=$1", [id])).rows[0].status as string;

beforeAll(async () => {
  a = await seedStudio("fd-cmd-a");
  b = await seedStudio("fd-cmd-b");
  desk = await seedDesk(a);
  deskB = await seedDesk(b);
  deactivated = await seedDesk(a, false);
});
afterAll(async () => {
  await closePool();
});

const noShow = (uid: string, studio: string, id: string) =>
  asUser(uid, (x) => x("select public.receptionist_mark_no_show($1,$2) as r", [studio, id]));

describe("IG-2 receptionist_mark_no_show", () => {
  it("marks a confirmed, ended appointment and writes one receptionist audit row", async () => {
    const id = await appt(a, "confirmed", true);
    expect((await noShow(desk, a.studioId, id)).rows[0].r).toBe("marked");
    expect(await statusOf(id)).toBe("no_show");
    const audit = await adminQuery(
      "select actor_type, actor_receptionist_id, action, details->>'source' as source from public.appointment_audit where appointment_id=$1",
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_type: "receptionist", action: "marked_no_show", source: "receptionist_action" });
    expect(audit.rows[0].actor_receptionist_id).not.toBeNull();
    // a second mark finds it no longer confirmed
    expect((await noShow(desk, a.studioId, id)).rows[0].r).toBe("wrong_status");
  });
  it("refuses an appointment that has not ended, one that is not confirmed, and another studio's appointment", async () => {
    const future = await appt(a, "confirmed", false);
    expect((await noShow(desk, a.studioId, future)).rows[0].r).toBe("too_early");
    expect(await statusOf(future)).toBe("confirmed");
    const cancelled = await appt(a, "cancelled", true);
    expect((await noShow(desk, a.studioId, cancelled)).rows[0].r).toBe("wrong_status");
    const other = await appt(b, "confirmed", true);
    expect((await noShow(desk, a.studioId, other)).rows[0].r).toBe("wrong_status");
    expect(await statusOf(other)).toBe("confirmed");
  });
  it("is refused with 42501 for an owner, another studio's desk, a deactivated desk, anon and service_role", async () => {
    const id = await appt(a, "confirmed", true);
    for (const uid of [a.userId, deskB, deactivated]) {
      await expect(noShow(uid, a.studioId, id)).rejects.toMatchObject({ code: "42501" });
    }
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, (x) => x("select public.receptionist_mark_no_show($1,$2)", [a.studioId, id]))).rejects.toMatchObject({ code: "42501" });
    }
    expect(await statusOf(id)).toBe("confirmed");
    // control: the real desk can mark it
    expect((await noShow(desk, a.studioId, id)).rows[0].r).toBe("marked");
  });
});

const create = (uid: string, studio: string, name: string, pref: string | null = null, phone: string | null = null, email: string | null = null) =>
  asUser(uid, (x) => x("select * from public.receptionist_create_client($1,$2,$3,$4,$5)", [studio, name, pref, phone, email]));
const clientCount = async (studio: SeededStudio) => (await adminQuery("select count(*)::int n from public.clients where studio_id=$1", [studio.studioId])).rows[0].n as number;

describe("IG-3 receptionist_create_client", () => {
  it("creates a client with trimmed values, blank optional fields as NULL, and one audit row of field names only", async () => {
    const r = await create(desk, a.studioId, "  Create One  ", "  ", " +1 555 0401 ", "Create.One@Harness.Local");
    expect(r.rows[0].outcome).toBe("created");
    const id = r.rows[0].client_id as string;
    const row = (await adminQuery("select name, preferred_name, phone, email, studio_id from public.clients where id=$1", [id])).rows[0];
    expect(row).toMatchObject({ name: "Create One", preferred_name: null, phone: "+1 555 0401", email: "Create.One@Harness.Local", studio_id: a.studioId });
    const audit = (await adminQuery("select receptionist_id, action, fields from public.receptionist_client_audit where client_id=$1", [id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "created", fields: ["name", "phone", "email"] });
    expect(audit[0].receptionist_id).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain("Create");
  });
  it("refuses invalid input without writing anything", async () => {
    const before = await clientCount(a);
    expect((await create(desk, a.studioId, "   ")).rows[0]).toMatchObject({ outcome: "invalid_name", client_id: null });
    expect((await create(desk, a.studioId, "x".repeat(201))).rows[0].outcome).toBe("invalid_name");
    expect((await create(desk, a.studioId, "Ok Name", "p".repeat(201))).rows[0].outcome).toBe("invalid_preferred_name");
    expect((await create(desk, a.studioId, "Ok Name", null, "9".repeat(41))).rows[0].outcome).toBe("invalid_phone");
    for (const bad of ["no-at-sign", "@leading", "trailing@", "has space@x.test"]) {
      expect((await create(desk, a.studioId, "Ok Name", null, null, bad)).rows[0].outcome).toBe("invalid_email");
    }
    expect(await clientCount(a)).toBe(before);
    // controls: the longest allowed values do create
    expect((await create(desk, a.studioId, "n".repeat(200), "p".repeat(200), "9".repeat(40))).rows[0].outcome).toBe("created");
  });
  it("a duplicate email in the studio is reported without naming anyone; the same email in another studio is fine", async () => {
    expect((await create(desk, a.studioId, "Dup One", null, null, "dup@harness.local")).rows[0].outcome).toBe("created");
    const before = await clientCount(a);
    const dup = await create(desk, a.studioId, "Dup Two", null, null, "DUP@harness.local");
    expect(dup.rows[0]).toMatchObject({ outcome: "duplicate_email", client_id: null });
    expect(await clientCount(a)).toBe(before);
    expect((await create(deskB, b.studioId, "Dup Elsewhere", null, null, "dup@harness.local")).rows[0].outcome).toBe("created");
  });
  it("is refused with 42501 for a desk of another studio, an owner, a deactivated desk, anon and service_role", async () => {
    for (const uid of [deskB, a.userId, deactivated]) {
      await expect(create(uid, a.studioId, "Refused")).rejects.toMatchObject({ code: "42501" });
    }
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, (x) => x("select * from public.receptionist_create_client($1,'Refused',null,null,null)", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    }
    expect((await adminQuery("select count(*)::int n from public.clients where name='Refused'")).rows[0].n).toBe(0);
  });
});

const update = (uid: string, studio: string, client: string, patch: object, expected: object) =>
  asUser(uid, (x) => x("select public.receptionist_update_client_contact($1,$2,$3::jsonb,$4::jsonb) as r", [studio, client, JSON.stringify(patch), JSON.stringify(expected)]));
const row = async (id: string) => (await adminQuery("select * from public.clients where id=$1", [id])).rows[0];

describe("IG-3 receptionist_update_client_contact", () => {
  let id: string;
  beforeAll(async () => {
    id = randomUUID();
    await adminQuery(
      `insert into public.clients(id,studio_id,name,preferred_name,phone,email,address,date_of_birth,allergies,emergency_contact_name)
       values ($1,$2,'Stored Legalish','Sam','+1 555 0501','upd@harness.local','1 Synthetic Way','1990-01-02','Synthetic allergy','Synthetic Contact')`,
      [id, a.studioId],
    );
  });

  it("changes only the patched contact fields, never another column, and audits field names only", async () => {
    const before = await row(id);
    const r = await update(desk, a.studioId, id, { phone: "+1 555 0599", preferred_name: "Sammy" }, { phone: "+1 555 0501", preferred_name: "Sam" });
    expect(r.rows[0].r).toBe("updated");
    const after = await row(id);
    expect(after).toMatchObject({ phone: "+1 555 0599", preferred_name: "Sammy", email: "upd@harness.local" });
    for (const col of ["name", "address", "date_of_birth", "allergies", "emergency_contact_name", "studio_id", "archived_at"]) {
      expect(after[col]).toEqual(before[col]);
    }
    const audit = (await adminQuery("select action, fields, receptionist_id from public.receptionist_client_audit where client_id=$1 and action='contact_updated'", [id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].fields.sort()).toEqual(["phone", "preferred_name"]);
    expect(audit[0].receptionist_id).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain("0599");
  });
  it("is stale when the expected value no longer matches, and changes nothing", async () => {
    const before = await row(id);
    const r = await update(desk, a.studioId, id, { phone: "+1 555 0600" }, { phone: "+1 555 0501" });
    expect(r.rows[0].r).toBe("stale");
    expect((await row(id)).phone).toBe(before.phone);
  });
  it("clears a field with an empty string, and reports no_change when nothing differs", async () => {
    expect((await update(desk, a.studioId, id, { phone: "  " }, { phone: "+1 555 0599" })).rows[0].r).toBe("updated");
    expect((await row(id)).phone).toBeNull();
    expect((await update(desk, a.studioId, id, { phone: "" }, { phone: null })).rows[0].r).toBe("no_change");
  });
  it("refuses any key outside preferred_name, phone and email with 22023 and changes nothing", async () => {
    const before = await row(id);
    for (const key of ["name", "address", "date_of_birth", "allergies", "studio_id", "archived_at"]) {
      await expect(update(desk, a.studioId, id, { [key]: "x" }, { [key]: null })).rejects.toMatchObject({ code: "22023" });
    }
    await expect(update(desk, a.studioId, id, { phone: "1" }, {})).rejects.toMatchObject({ code: "22023" });
    await expect(update(desk, a.studioId, id, { phone: "1" }, { phone: null, name: "x" })).rejects.toMatchObject({ code: "22023" });
    await expect(update(desk, a.studioId, id, {}, {})).rejects.toMatchObject({ code: "22023" });
    expect(await row(id)).toEqual(before);
  });
  it("validates values and reports a duplicate email without naming anyone", async () => {
    const cur = await row(id);
    expect((await update(desk, a.studioId, id, { email: "no-at-sign" }, { email: cur.email })).rows[0].r).toBe("invalid_email");
    expect((await update(desk, a.studioId, id, { phone: "9".repeat(41) }, { phone: cur.phone })).rows[0].r).toBe("invalid_phone");
    expect((await update(desk, a.studioId, id, { preferred_name: "p".repeat(201) }, { preferred_name: cur.preferred_name })).rows[0].r).toBe("invalid_preferred_name");
    // dup@harness.local belongs to another client of this studio (created above)
    expect((await update(desk, a.studioId, id, { email: "DUP@harness.local" }, { email: cur.email })).rows[0].r).toBe("duplicate_email");
    expect((await row(id)).email).toBe(cur.email);
  });
  it("does not find an archived client or another studio's client", async () => {
    const archived = randomUUID();
    await adminQuery("insert into public.clients(id,studio_id,name,phone,archived_at) values ($1,$2,'Archived Synthetic','1',now())", [archived, a.studioId]);
    expect((await update(desk, a.studioId, archived, { phone: "2" }, { phone: "1" })).rows[0].r).toBe("not_found");
    expect((await update(desk, a.studioId, b.clientId, { phone: "2" }, { phone: null })).rows[0].r).toBe("not_found");
    expect((await row(archived)).phone).toBe("1");
  });
  it("is refused with 42501 for another studio's desk, an owner, a deactivated desk, anon and service_role", async () => {
    for (const uid of [deskB, a.userId, deactivated]) {
      await expect(update(uid, a.studioId, id, { phone: "3" }, { phone: null })).rejects.toMatchObject({ code: "42501" });
    }
    for (const role of ["anon", "service_role"] as const) {
      await expect(
        asRole(role, (x) => x("select public.receptionist_update_client_contact($1,$2,'{\"phone\":\"3\"}'::jsonb,'{\"phone\":null}'::jsonb)", [a.studioId, id])),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("privileges", () => {
  it("the three commands are authenticated-only and the audit table is closed to every API role", async () => {
    const fns = [
      "public.receptionist_mark_no_show(uuid,uuid)",
      "public.receptionist_create_client(uuid,text,text,text,text)",
      "public.receptionist_update_client_contact(uuid,uuid,jsonb,jsonb)",
    ];
    for (const fn of fns) {
      const acl = async (role: string) => (await adminQuery("select has_function_privilege($1,$2,'EXECUTE') ok", [role, fn])).rows[0].ok;
      expect(await acl("authenticated")).toBe(true);
      for (const role of ["anon", "service_role"]) expect(await acl(role)).toBe(false);
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect((await adminQuery("select has_table_privilege($1,'public.receptionist_client_audit',$2) ok", [role, priv])).rows[0].ok).toBe(false);
      }
    }
    // a receptionist cannot read the audit through a real JWT either
    await expect(asUser(desk, (x) => x("select * from public.receptionist_client_audit"))).rejects.toMatchObject({ code: "42501" });
  });
});
