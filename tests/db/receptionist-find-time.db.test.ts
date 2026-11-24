import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

const findSql = "select * from public.receptionist_find_openings($1,$2,$3,$4,$4)";
const bookSql = "select * from public.receptionist_book_opening($1,$2,$3,$4,$5,$6)";
const day = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const weekday = new Date(day + "T12:00:00Z").getUTCDay();
let studio: SeededStudio, other: SeededStudio, desk: string, inactive: string, foreignDesk: string, colleague: string;
const serviceId = randomUUID();

async function receptionist(studioId: string, active: boolean) {
  const id = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [id, id + "@harness.local"]);
  await adminQuery("insert into public.studio_receptionists(studio_id,user_id,display_name,active,deactivated_at) values ($1,$2,'Test desk',$3,$4)",
    [studioId, id, active, active ? null : new Date()]);
  return id;
}

beforeAll(async () => {
  studio = await seedStudio("desk-open");
  other = await seedStudio("desk-foreign");
  colleague = (await seedMember(studio, "colleague")).practitionerId;
  desk = await receptionist(studio.studioId, true);
  inactive = await receptionist(studio.studioId, false);
  foreignDesk = await receptionist(other.studioId, true);
  await adminQuery("update public.studios set timezone='America/Toronto', buffer_minutes=15 where id=$1", [studio.studioId]);
  await adminQuery("insert into public.services(id,studio_id,name,default_duration_minutes,active) values ($1,$2,'Test service',45,true)", [serviceId, studio.studioId]);
  await adminQuery("insert into public.studio_availability_default(studio_id,day_of_week,is_open,open_time,close_time) values ($1,$2,true,'11:00','15:00')", [studio.studioId, weekday]);
});
afterAll(closePool);

const find = (practitioner: string | null = null) =>
  asUser(desk, q => q(findSql, [studio.studioId, serviceId, practitioner, day]));
const book = (start: Date, end: Date, client = studio.clientId) =>
  asUser(desk, q => q(bookSql, [studio.studioId, client, serviceId, studio.practitionerId, start, end]));

describe("desk opening authority", () => {
  it("refuses both reads and writes for another studio, a deactivated desk or practitioner-only identity", async () => {
    const findArgs = [studio.studioId, serviceId, studio.practitionerId, day];
    const bookArgs = [studio.studioId, studio.clientId, serviceId, studio.practitionerId, new Date(), new Date()];
    for (const actor of [foreignDesk, inactive, studio.userId]) {
      await expect(asUser(actor, q => q(findSql, findArgs))).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(actor, q => q(bookSql, bookArgs))).rejects.toMatchObject({ code: "42501" });
    }
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, q => q(findSql, findArgs))).rejects.toMatchObject({ code: "42501" });
      await expect(asRole(role, q => q(bookSql, bookArgs))).rejects.toMatchObject({ code: "42501" });
    }
    expect((await find(other.practitionerId)).rowCount).toBe(0);
  });

  it("returns only practitioner identity and open times, with the service duration in the studio clock", async () => {
    const r = await find();
    expect(r.fields.map(f => f.name)).toEqual(["practitioner_id","practitioner_name","starts_at","ends_at","local_date","local_time","has_more"]);
    expect([...new Set(r.rows.map(row => row.practitioner_id))].sort()).toEqual([studio.practitionerId, colleague].sort());
    expect(r.rows[0].local_time).toBe("11:00");
    expect(r.rows[0].ends_at.getTime() - r.rows[0].starts_at.getTime()).toBe(45 * 60_000);
    await expect(asUser(desk, q => q("select * from public.receptionist_find_openings($1,$2,null,$3::date,$3::date+7)", [studio.studioId, serviceId, day]))).rejects.toMatchObject({ code: "22023" });
  });

  it("caps a busy day and still revalidates an exact offer beyond the displayed list", async () => {
    const extra = await seedMember(studio, "extra");
    await adminQuery("update public.studio_availability_default set open_time='00:00', close_time='23:59' where studio_id=$1", [studio.studioId]);
    try {
      const { rows } = await find();
      expect(rows).toHaveLength(48);
      expect(rows.every(row => row.has_more === true)).toBe(true);
      const later = (await find(studio.practitionerId)).rows.find(row => row.local_time === "19:00");
      expect(later).toBeDefined();
      expect(rows.some(row => row.starts_at.getTime() === later!.starts_at.getTime())).toBe(false);
      const exact = await asUser(desk, q => q(
        "select * from public.receptionist_find_openings($1,$2,$3,$4,$4,$5)",
        [studio.studioId, serviceId, studio.practitionerId, day, later!.starts_at]));
      expect(exact.rows).toEqual([{ ...later, has_more: false }]);
    } finally {
      await adminQuery("update public.studio_availability_default set open_time='11:00', close_time='15:00' where studio_id=$1", [studio.studioId]);
      await adminQuery("update public.practitioners set active=false where id=$1", [extra.practitionerId]);
    }
  });

  it("refuses wrong, archived, stale-duration and closed-hours offers in a shared calendar", async () => {
    const { starts_at: start, ends_at: end } = (await find(studio.practitionerId)).rows[0];
    expect((await book(start, end, other.clientId)).rows[0].result).toBe("invalid_client");
    await adminQuery("update public.clients set archived_at=now() where id=$1", [studio.clientId]);
    expect((await book(start, end)).rows[0].result).toBe("invalid_client");
    await adminQuery("update public.clients set archived_at=null where id=$1", [studio.clientId]);
    await adminQuery("update public.services set default_duration_minutes=60 where id=$1", [serviceId]);
    expect((await book(start, end)).rows[0].result).toBe("opening_unavailable");
    await adminQuery("update public.services set default_duration_minutes=45 where id=$1", [serviceId]);
    await adminQuery("update public.studio_availability_default set is_open=false where studio_id=$1", [studio.studioId]);
    expect((await book(start, end)).rows[0].result).toBe("opening_unavailable");
    await adminQuery("update public.studio_availability_default set is_open=true where studio_id=$1", [studio.studioId]);
  });

  it("books exactly once under competition, attributes it to the desk, and removes the shared slot for everyone", async () => {
    const { starts_at: start, ends_at: end } = (await find(studio.practitionerId)).rows[0];
    const attempts = await Promise.all([book(start, end), book(start, end)]);
    expect(attempts.map(a => a.rows[0].result).sort()).toEqual(["created", "opening_unavailable"]);
    const stored = await adminQuery(
      "select a.starts_at, a.ends_at, r.user_id from public.appointments a join public.studio_receptionists r on r.id=a.created_by_receptionist_id where a.studio_id=$1",
      [studio.studioId]);
    expect(stored.rows).toEqual([{ starts_at: start, ends_at: end, user_id: desk }]);
    expect((await find(colleague)).rows.some(o => o.starts_at.getTime() === start.getTime())).toBe(false);
  });

  it("restricts practitioner-capacity offers to service-eligible staff and closes them when booking pauses", async () => {
    await adminQuery("update public.studios set practitioner_capacity_enabled=true, practitioner_capacity_booking_enabled=true where id=$1", [studio.studioId]);
    await adminQuery("delete from public.service_practitioners where studio_id=$1 and service_id=$2", [studio.studioId, serviceId]);
    await adminQuery("insert into public.service_practitioners(studio_id,service_id,practitioner_id) values ($1,$2,$3)", [studio.studioId, serviceId, colleague]);
    const r = await find();
    expect([...new Set(r.rows.map(row => row.practitioner_id))]).toEqual([colleague]);
    await adminQuery("update public.studios set practitioner_capacity_booking_enabled=false where id=$1", [studio.studioId]);
    expect((await find()).rows).toEqual([]);
  });
});
