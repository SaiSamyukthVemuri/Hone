import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, closePool, seedMember, seedStudio } from "./helpers/harness";

// 0278 (HON-44, Sam decision 6): a practitioner changes ONLY their own working hours; the owner any.
// The schedule commands are service_role-only; the actor is passed explicitly, as the app does.

async function fixture(capacity = true) {
  const s = await seedStudio("h278");
  const a = await seedMember(s, "h278a");
  const b = await seedMember(s, "h278b");
  if (capacity) await adminQuery(`update public.studios set practitioner_capacity_enabled = true where id = $1`, [s.studioId]);
  return { s, a, b };
}

const upsertDay = (studio: string, actor: string, scope: string | null, dow = 2) =>
  adminQuery(`select public.upsert_availability_day_locked($1,$2,$3,$4,true,'09:00','17:00') as r`, [studio, actor, scope, dow]).then((x) => x.rows[0].r as string);
const deleteDay = (studio: string, actor: string, scope: string | null, dow: number | null = 2) =>
  adminQuery(`select public.delete_availability_day_locked($1,$2,$3,$4) as r`, [studio, actor, scope, dow]).then((x) => x.rows[0].r as string);
const upsertOverride = (studio: string, actor: string, scope: string | null, date = "2031-09-15") =>
  adminQuery(`select public.upsert_availability_override_locked($1,$2,$3,$4::date,false,null,null,'x') as r`, [studio, actor, scope, date]).then((x) => x.rows[0].r as string);
const deleteOverrideById = (studio: string, actor: string, id: string | null, scope: string | null = null, date: string | null = null) =>
  adminQuery(`select public.delete_availability_override_locked($1,$2,$3,$4,$5::date) as r`, [studio, actor, id, scope, date]).then((x) => x.rows[0].r as string);
const weekly = (studio: string, actor: string, scope: string | null) =>
  adminQuery(`select public.save_weekly_availability_as($1,$2,$3,$4::jsonb) as r`, [studio, actor, scope, JSON.stringify([{ day_of_week: 1, is_open: true, open_time: "10:00", close_time: "16:00" }, { day_of_week: 3, is_open: false }])]).then((x) => x.rows[0].r as string);
const dayRows = async (studio: string, scope: string | null) =>
  Number((await adminQuery(`select count(*)::int n from public.studio_availability_default where studio_id = $1 and practitioner_id is not distinct from $2`, [studio, scope])).rows[0].n);
const overrideId = async (studio: string, scope: string | null) =>
  (await adminQuery(`select id from public.studio_availability_overrides where studio_id = $1 and practitioner_id is not distinct from $2 limit 1`, [studio, scope])).rows[0]?.id as string | undefined;

afterAll(async () => {
  await closePool();
});

describe("0278: a practitioner changes only their OWN hours", () => {
  it("own weekday: upsert then reset", async () => {
    const f = await fixture();
    expect(await upsertDay(f.s.studioId, f.a.practitionerId, f.a.practitionerId)).toBe("ok");
    expect(await dayRows(f.s.studioId, f.a.practitionerId)).toBe(1);
    expect(await deleteDay(f.s.studioId, f.a.practitionerId, f.a.practitionerId)).toBe("ok");
    expect(await dayRows(f.s.studioId, f.a.practitionerId)).toBe(0);
  });

  it("own date override: upsert then delete by scope+date and by row id", async () => {
    const f = await fixture();
    expect(await upsertOverride(f.s.studioId, f.a.practitionerId, f.a.practitionerId)).toBe("ok");
    expect(await deleteOverrideById(f.s.studioId, f.a.practitionerId, null, f.a.practitionerId, "2031-09-15")).toBe("ok");
    expect(await overrideId(f.s.studioId, f.a.practitionerId)).toBeUndefined();
    await upsertOverride(f.s.studioId, f.a.practitionerId, f.a.practitionerId);
    const id = (await overrideId(f.s.studioId, f.a.practitionerId))!;
    expect(await deleteOverrideById(f.s.studioId, f.a.practitionerId, id)).toBe("ok");
  });

  it("own atomic week save", async () => {
    const f = await fixture();
    expect(await weekly(f.s.studioId, f.a.practitionerId, f.a.practitionerId)).toBe("ok");
    expect(await dayRows(f.s.studioId, f.a.practitionerId)).toBe(2);
  });

  it("a colleague's schedule is refused on every command, and nothing changes", async () => {
    const f = await fixture();
    await upsertDay(f.s.studioId, f.s.practitionerId, f.b.practitionerId); // owner seeds B's day
    await upsertOverride(f.s.studioId, f.s.practitionerId, f.b.practitionerId);
    const bOverride = (await overrideId(f.s.studioId, f.b.practitionerId))!;
    const before = await dayRows(f.s.studioId, f.b.practitionerId);
    expect(await upsertDay(f.s.studioId, f.a.practitionerId, f.b.practitionerId, 4)).toBe("not_authorized");
    expect(await deleteDay(f.s.studioId, f.a.practitionerId, f.b.practitionerId)).toBe("not_authorized");
    expect(await upsertOverride(f.s.studioId, f.a.practitionerId, f.b.practitionerId, "2031-10-01")).toBe("not_authorized");
    expect(await deleteOverrideById(f.s.studioId, f.a.practitionerId, bOverride)).toBe("not_authorized");
    expect(await deleteOverrideById(f.s.studioId, f.a.practitionerId, null, f.b.practitionerId, "2031-09-15")).toBe("not_authorized");
    expect(await weekly(f.s.studioId, f.a.practitionerId, f.b.practitionerId)).toBe("not_authorized");
    expect(await dayRows(f.s.studioId, f.b.practitionerId)).toBe(before);
    expect(await overrideId(f.s.studioId, f.b.practitionerId)).toBe(bOverride);
  });

  it("the STUDIO-WIDE schedule is owner-only: a practitioner is refused on every command", async () => {
    const f = await fixture();
    expect(await upsertDay(f.s.studioId, f.a.practitionerId, null)).toBe("not_authorized");
    expect(await upsertOverride(f.s.studioId, f.a.practitionerId, null)).toBe("not_authorized");
    expect(await weekly(f.s.studioId, f.a.practitionerId, null)).toBe("not_authorized");
    expect(await deleteDay(f.s.studioId, f.a.practitionerId, null)).toBe("not_authorized");
    expect(await dayRows(f.s.studioId, null)).toBe(0);
    // an absent/unknown or studio-wide override id answers the same refusal (nothing revealed)
    await upsertOverride(f.s.studioId, f.s.practitionerId, null);
    const wide = (await overrideId(f.s.studioId, null))!;
    expect(await deleteOverrideById(f.s.studioId, f.a.practitionerId, wide)).toBe("not_authorized");
    expect(await deleteOverrideById(f.s.studioId, f.a.practitionerId, "00000000-0000-4000-8000-000000000000")).toBe("not_authorized");
    expect(await overrideId(f.s.studioId, null)).toBe(wide);
  });

  it("the owner may change the studio-wide schedule and any practitioner's", async () => {
    const f = await fixture();
    expect(await upsertDay(f.s.studioId, f.s.practitionerId, null)).toBe("ok");
    expect(await upsertDay(f.s.studioId, f.s.practitionerId, f.a.practitionerId)).toBe("ok");
    expect(await weekly(f.s.studioId, f.s.practitionerId, f.b.practitionerId)).toBe("ok");
    expect(await upsertOverride(f.s.studioId, f.s.practitionerId, f.b.practitionerId)).toBe("ok");
    const id = (await overrideId(f.s.studioId, f.b.practitionerId))!;
    expect(await deleteOverrideById(f.s.studioId, f.s.practitionerId, id)).toBe("ok");
  });

  it("existing scheduling rules still hold: a scoped row needs capacity ON", async () => {
    const f = await fixture(false);
    expect(await upsertDay(f.s.studioId, f.a.practitionerId, f.a.practitionerId)).toBe("capacity_disabled");
    expect(await weekly(f.s.studioId, f.a.practitionerId, f.a.practitionerId)).toBe("capacity_disabled");
    expect(await upsertDay(f.s.studioId, f.s.practitionerId, f.a.practitionerId)).toBe("capacity_disabled");
  });

  it("an inactive practitioner and a stranger from another studio are refused, even for their own id", async () => {
    const f = await fixture();
    const other = await seedStudio("h278x");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [f.b.practitionerId]);
    expect(await upsertDay(f.s.studioId, f.b.practitionerId, f.b.practitionerId)).toBe("not_authorized");
    expect(await upsertDay(f.s.studioId, other.practitionerId, other.practitionerId)).toBe("not_authorized");
    expect(await upsertDay(f.s.studioId, other.practitionerId, f.a.practitionerId)).toBe("not_authorized");
    expect(await dayRows(f.s.studioId, f.b.practitionerId)).toBe(0);
  });

  it("the old 0149 week save is untouched: still callable by service_role, still no actor", async () => {
    const f = await fixture();
    const r = await adminQuery(`select public.save_weekly_availability($1,$2,$3::jsonb) as r`, [f.s.studioId, f.a.practitionerId, JSON.stringify([{ day_of_week: 1, is_open: true, open_time: "10:00", close_time: "16:00" }])]);
    expect(r.rows[0].r).toBe("ok");
  });
});

describe("0278 revocation, cross-studio scope and existing visits (Privacy C2, Insurance W-5)", () => {
  it("a practitioner deactivated after their first successful save is refused at once", async () => {
    const f = await fixture();
    expect(await upsertDay(f.s.studioId, f.a.practitionerId, f.a.practitionerId)).toBe("ok");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [f.a.practitionerId]);
    expect(await upsertDay(f.s.studioId, f.a.practitionerId, f.a.practitionerId, 4)).toBe("not_authorized");
    expect(await deleteDay(f.s.studioId, f.a.practitionerId, f.a.practitionerId)).toBe("not_authorized");
    expect(await weekly(f.s.studioId, f.a.practitionerId, f.a.practitionerId)).toBe("not_authorized");
    expect(await dayRows(f.s.studioId, f.a.practitionerId)).toBe(1);
  });

  it("a role change takes effect at once: owner rights end the moment the role does", async () => {
    const f = await fixture();
    await adminQuery(`update public.practitioners set role = 'owner' where id = $1`, [f.a.practitionerId]);
    expect(await upsertDay(f.s.studioId, f.a.practitionerId, null)).toBe("ok"); // studio-wide, as an owner
    await adminQuery(`update public.practitioners set role = 'practitioner' where id = $1`, [f.a.practitionerId]);
    expect(await upsertDay(f.s.studioId, f.a.practitionerId, null, 4)).toBe("not_authorized");
    expect(await upsertDay(f.s.studioId, f.a.practitionerId, f.b.practitionerId, 4)).toBe("not_authorized");
  });

  it("another studio's practitioner id is never a reachable scope, for a member or an outsider", async () => {
    const f = await fixture();
    const other = await seedStudio("h278y");
    await adminQuery(`update public.studios set practitioner_capacity_enabled = true where id = $1`, [other.studioId]);
    expect(await upsertDay(f.s.studioId, f.a.practitionerId, other.practitionerId)).toBe("not_authorized");
    expect(await upsertDay(other.studioId, f.a.practitionerId, f.a.practitionerId)).toBe("not_authorized");
    expect(await upsertDay(other.studioId, f.a.practitionerId, other.practitionerId)).toBe("not_authorized");
    expect(await dayRows(other.studioId, other.practitionerId)).toBe(0);
  });

  it("an owner is unchanged: any scope, and studio-wide, exactly as under 0150", async () => {
    const f = await fixture();
    expect(await upsertDay(f.s.studioId, f.s.practitionerId, null)).toBe("ok");
    expect(await upsertDay(f.s.studioId, f.s.practitionerId, f.a.practitionerId)).toBe("ok");
    expect(await upsertOverride(f.s.studioId, f.s.practitionerId, f.b.practitionerId)).toBe("ok");
  });

  // Recorded behaviour, not a new rule: no hours command (0150 or 0278) looks at existing
  // appointments, so narrowing hours leaves a booked visit exactly as it was.
  it("narrowing own hours changes no existing appointment (there is no conflict check here, for owner or practitioner)", async () => {
    const f = await fixture();
    expect(await upsertDay(f.s.studioId, f.a.practitionerId, f.a.practitionerId, 2)).toBe("ok");
    const appt = await adminQuery(
      `insert into public.appointments
         (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status,
          cancellation_token_hash, buffer_minutes_snapshot, blocked_ends_at)
       values (gen_random_uuid(), $1, $2, $3, now() + interval '3 days', now() + interval '3 days 30 minutes', 30,
               'confirmed', encode(sha256(convert_to(random()::text, 'UTF8')), 'hex'), 15, now() + interval '3 days 45 minutes')
       returning id, starts_at, status`,
      [f.s.studioId, f.a.practitionerId, f.s.clientId],
    );
    const before = appt.rows[0];
    expect(await upsertOverride(f.s.studioId, f.a.practitionerId, f.a.practitionerId, "2031-09-15")).toBe("ok");
    expect(await deleteDay(f.s.studioId, f.a.practitionerId, f.a.practitionerId, 2)).toBe("ok");
    const after = (await adminQuery(`select id, starts_at, status from public.appointments where id = $1`, [before.id])).rows[0];
    expect(after).toEqual(before);
  });
});

describe("0278 the direct-table path stays owner-only (RLS unchanged) and grants are service_role only", () => {
  it("a practitioner's own login cannot write the availability tables directly", async () => {
    const f = await fixture();
    const { asUser } = await import("./helpers/harness");
    await expect(
      asUser(f.a.userId, (q) =>
        q(`insert into public.studio_availability_default (id, studio_id, practitioner_id, day_of_week, is_open, open_time, close_time) values (gen_random_uuid(),$1,$2,5,true,'09:00','10:00')`, [f.s.studioId, f.a.practitionerId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("anon and authenticated cannot execute any of the six; service_role can", async () => {
    const f = await fixture();
    const calls: Array<(q: (t: string, p?: unknown[]) => Promise<unknown>) => Promise<unknown>> = [
      (q) => q(`select public.authorize_schedule_writer($1,$2,$3)`, [f.s.studioId, f.a.practitionerId, f.a.practitionerId]),
      (q) => q(`select public.upsert_availability_day_locked($1,$2,$3,2,true,'09:00','17:00')`, [f.s.studioId, f.a.practitionerId, f.a.practitionerId]),
      (q) => q(`select public.delete_availability_day_locked($1,$2,$3,2)`, [f.s.studioId, f.a.practitionerId, f.a.practitionerId]),
      (q) => q(`select public.upsert_availability_override_locked($1,$2,$3,'2031-09-15'::date,false,null,null,'x')`, [f.s.studioId, f.a.practitionerId, f.a.practitionerId]),
      (q) => q(`select public.delete_availability_override_locked($1,$2,null,$3,'2031-09-15'::date)`, [f.s.studioId, f.a.practitionerId, f.a.practitionerId]),
      (q) => q(`select public.save_weekly_availability_as($1,$2,$3,'[]'::jsonb)`, [f.s.studioId, f.a.practitionerId, f.a.practitionerId]),
    ];
    for (const call of calls) {
      await expect(asRole("anon", call)).rejects.toMatchObject({ code: "42501" });
      await expect(asRole("authenticated", call)).rejects.toMatchObject({ code: "42501" });
      await expect(asRole("service_role", call)).resolves.toBeDefined();
    }
  });
});
