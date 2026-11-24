import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

const read = "select * from public.receptionist_appointment_contact($1, $2)";
let studio: SeededStudio, other: SeededStudio;
const desk = randomUUID();
let appointment: string, foreignAppointment: string;
const email = "sample-client@example.test", phone = "+14165550188";

async function seedVisit(owner: SeededStudio) {
  const id = randomUUID();
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values ($1,$2,$3,$4, now()+interval '30 days', now()+interval '30 days 30 minutes', 30, 'confirmed', encode(sha256(gen_random_uuid()::text::bytea),'hex'))`,
    [id, owner.studioId, owner.practitionerId, owner.clientId],
  );
  return id;
}

beforeAll(async () => {
  studio = await seedStudio("desk-visit");
  other = await seedStudio("other-visit");
  await adminQuery("insert into auth.users (id,email) values ($1,$2)", [desk, desk + "@harness.local"]);
  await adminQuery("insert into public.studio_receptionists (studio_id,user_id,display_name,active) values ($1,$2,'Front desk',true)", [studio.studioId, desk]);
  await adminQuery("update public.clients set email=$2,phone=$3 where id=$1", [studio.clientId, email, phone]);
  await adminQuery("update public.clients set name='Casey Rowan',preferred_name=null where id=$1", [studio.clientId]);
  await adminQuery("update public.clients set name='Foreign Surname' where id=$1", [other.clientId]);
  await adminQuery("insert into public.client_legal_identities(client_id, studio_id, legal_given_name, legal_family_name, updated_by) values ($1,$2,'Private','Quillfeather',$3)", [studio.clientId, studio.studioId, studio.practitionerId]);
  appointment = await seedVisit(studio);
  foreignAppointment = await seedVisit(other);
});
afterAll(closePool);

describe("desk appointment contact", () => {
  it("returns the selected client's two contact fields only", async () => {
    const visit = await asUser(desk, q => q(read, [studio.studioId, appointment]));
    expect(visit.fields.map(field => field.name)).toEqual(["phone", "email"]);
    expect(visit.rows).toEqual([{ phone, email }]);
  });

  it("requires active desk membership in the requested studio", async () => {
    await expect(asUser(desk, q => q(read, [other.studioId, appointment]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(studio.userId, q => q(read, [studio.studioId, appointment]))).rejects.toMatchObject({ code: "42501" });
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, q => q(read, [studio.studioId, appointment]))).rejects.toMatchObject({ code: "42501" });
    }
    await adminQuery("update public.studio_receptionists set active=false,deactivated_at=now() where user_id=$1", [desk]);
    try {
      await expect(asUser(desk, q => q(read, [studio.studioId, appointment]))).rejects.toMatchObject({ code: "42501" });
    } finally {
      await adminQuery("update public.studio_receptionists set active=true,deactivated_at=null where user_id=$1", [desk]);
    }
  });

  it("ties the lookup to an appointment in that studio and observes the directory's archive rule", async () => {
    expect((await asUser(desk, q => q(read, [studio.studioId, foreignAppointment]))).rows).toEqual([]);
    await adminQuery("update public.clients set archived_at=now() where id=$1", [studio.clientId]);
    try {
      expect((await asUser(desk, q => q(read, [studio.studioId, appointment]))).rows).toEqual([]);
    } finally {
      await adminQuery("update public.clients set archived_at=null where id=$1", [studio.clientId]);
    }
  });
});

const schedule = "select * from public.receptionist_calendar_v3($1, now(), now()+interval '31 days')";
const findClient = "select * from public.receptionist_booking_clients_v3($1, $2, 11)";

describe("receptionist scheduling names", () => {
  it("uses the regular profile name for schedule and surname search while the legal identity stays private", async () => {
    const calendar = await asUser(desk, q => q(schedule, [studio.studioId]));
    expect(calendar.rows.map(row => row.display_name)).toEqual(["Casey Rowan"]);
    expect(calendar.fields.map(field => field.name)).toEqual([
      "appointment_id", "starts_at", "ends_at", "status", "practitioner_id", "practitioner_display_name",
      "practitioner_color", "service_name", "display_name", "duration_minutes", "studio_timezone",
    ]);
    for (const term of ["roWaN", "0188", "sample-client@"]) {
      const matches = await asUser(desk, q => q(findClient, [studio.studioId, term]));
      expect(matches.rows).toEqual([{ client_id: studio.clientId, display_name: "Casey Rowan", phone, email }]);
    }
    for (const term of ["Quillfeather", "Foreign Surname", "%%"]) {
      const matches = await asUser(desk, q => q(findClient, [studio.studioId, term]));
      expect(matches.rows).toEqual([]);
    }
    // Independent clients of the older directory retain their original projection.
    const old = await asUser(desk, q => q("select display_name from public.receptionist_calendar_v2($1, now(), now()+interval '31 days')", [studio.studioId]));
    expect(old.rows).toEqual([{ display_name: "Name on file" }]);
  });

  it("honors the preferred name in calendar and booking and searches the label reception actually sees", async () => {
    await adminQuery("update public.clients set preferred_name='Kit' where id=$1", [studio.clientId]);
    try {
      const calendar = await asUser(desk, q => q(schedule, [studio.studioId]));
      expect(calendar.rows.map(row => row.display_name)).toEqual(["Kit"]);
      const preferred = await asUser(desk, q => q(findClient, [studio.studioId, "kit"]));
      expect(preferred.rows.map(row => row.display_name)).toEqual(["Kit"]);
      expect((await asUser(desk, q => q(findClient, [studio.studioId, "Rowan"]))).rows).toEqual([]);
    } finally {
      await adminQuery("update public.clients set preferred_name=null where id=$1", [studio.clientId]);
    }
  });

  it("requires active studio reception for either projection and enforces the booking search bounds", async () => {
    for (const [sql, extra] of [[schedule, []], [findClient, ["Rowan"]]] as const) {
      await expect(asUser(desk, q => q(sql, [other.studioId, ...extra]))).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(studio.userId, q => q(sql, [studio.studioId, ...extra]))).rejects.toMatchObject({ code: "42501" });
      for (const role of ["anon", "service_role"] as const) {
        await expect(asRole(role, q => q(sql, [studio.studioId, ...extra]))).rejects.toMatchObject({ code: "42501" });
      }
    }
    await expect(asUser(desk, q => q(findClient, [studio.studioId, " "]))).rejects.toMatchObject({ code: "22023" });
  });
});
