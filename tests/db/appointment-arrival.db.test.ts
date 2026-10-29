import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// HON-48 / 0268: check-in. Owner and practitioner may check a client in; a
// receptionist may NOT until the one isolated predicate is changed. Orthogonal
// to status; idempotent; audited; cleared when the appointment closes.

let a: SeededStudio;
let b: SeededStudio;
let aPractitioner: { userId: string; practitionerId: string };
let aDesk: { userId: string; rowId: string };

async function seedDesk(studio: SeededStudio, label: string) {
  const userId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [userId, `${label}-${userId.slice(0, 8)}@harness.local`]);
  const r = await adminQuery(
    "insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',true) returning id",
    [studio.studioId, userId],
  );
  return { userId, rowId: r.rows[0].id as string };
}

// Each appointment gets its own day: the overlap guards (0134/0152) refuse two
// at the same time for one practitioner, and these tests are about arrival.
let slot = 0;
async function seedAppointment(studio: SeededStudio, status = "confirmed") {
  const day = new Date(Date.UTC(2031, 2, 4 + slot++, 15, 0, 0));
  const startsAt = day.toISOString();
  const endsAt = new Date(day.getTime() + 3_600_000).toISOString();
  const r = await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 60, 'confirmed', encode(sha256(gen_random_uuid()::text::bytea), 'hex')) returning id`,
    [studio.studioId, studio.practitionerId, studio.clientId, startsAt, endsAt],
  );
  const id = r.rows[0].id as string;
  if (status !== "confirmed") await adminQuery("update public.appointments set status = $2 where id = $1", [id, status]);
  return id;
}

const arrive = (userId: string, studio: string, appt: string, arrived = true) =>
  asUser(userId, async (q) => (await q("select public.set_appointment_arrived($1,$2,$3) as r", [studio, appt, arrived])).rows[0].r as string);

const arrivedAt = async (appt: string) =>
  (await adminQuery("select arrived_at from public.appointments where id = $1", [appt])).rows[0].arrived_at as Date | null;

const audit = async (appt: string) =>
  (await adminQuery("select actor_type, actor_id, action from public.appointment_audit where appointment_id = $1 and action in ('checked_in','check_in_undone') order by created_at, id", [appt])).rows;

beforeAll(async () => {
  a = await seedStudio("arrival-a");
  b = await seedStudio("arrival-b");
  aPractitioner = await seedMember(a, "arrival-a-prac");
  aDesk = await seedDesk(a, "desk-a");
});

afterAll(async () => {
  await closePool();
});

describe("who may check a client in", () => {
  it("the receptionist decision is false by default", async () => {
    expect((await adminQuery("select public.arrival_receptionist_allowed() as ok")).rows[0].ok).toBe(false);
  });

  it("the owner checks in, with the owner practitioner row as the audited actor", async () => {
    const id = await seedAppointment(a);
    expect(await arrive(a.userId, a.studioId, id)).toBe("arrived");
    expect(await arrivedAt(id)).not.toBeNull();
    expect(await audit(id)).toEqual([{ actor_type: "practitioner", actor_id: a.practitionerId, action: "checked_in" }]);
  });

  it("a practitioner (non-owner) checks in", async () => {
    const id = await seedAppointment(a);
    expect(await arrive(aPractitioner.userId, a.studioId, id)).toBe("arrived");
    expect((await audit(id))[0]).toMatchObject({ actor_id: aPractitioner.practitionerId });
  });

  it("the receptionist is refused by default, and nothing changes", async () => {
    const id = await seedAppointment(a);
    expect(await arrive(aDesk.userId, a.studioId, id)).toBe("not_authorized");
    expect(await arrivedAt(id)).toBeNull();
    expect(await audit(id)).toEqual([]);
  });

  it("an inactive practitioner is refused", async () => {
    const m = await seedMember(a, "arrival-a-inactive");
    await adminQuery("update public.practitioners set active = false where id = $1", [m.practitionerId]);
    const id = await seedAppointment(a);
    expect(await arrive(m.userId, a.studioId, id)).toBe("not_authorized");
    expect(await arrivedAt(id)).toBeNull();
  });

  it("another studio's owner is refused, and cannot reach this studio's appointment", async () => {
    const id = await seedAppointment(a);
    expect(await arrive(b.userId, a.studioId, id)).toBe("not_authorized");
    // own studio named, foreign appointment id: not found, never written
    expect(await arrive(b.userId, b.studioId, id)).toBe("not_found");
    expect(await arrivedAt(id)).toBeNull();
  });

  it("the single predicate is the ONLY thing that lets a receptionist in (flipped inside a rolled-back transaction)", async () => {
    const id = await seedAppointment(a);
    const sentinel = new Error("rollback");
    let result = "";
    let ownerResult = "";
    let actor = "";
    await adminTx(async (q) => {
      await q("create or replace function public.arrival_receptionist_allowed() returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$ select true $$");
      await q("set local role authenticated");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: aDesk.userId, role: "authenticated" })]);
      result = (await q("select public.set_appointment_arrived($1,$2,true) as r", [a.studioId, id])).rows[0].r;
      await q("reset role"); // the audit table is not readable by the API role
      actor = (await q("select actor_type from public.appointment_audit where appointment_id = $1 and action = 'checked_in'", [id])).rows[0]?.actor_type ?? "";
      await q("set local role authenticated");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.userId, role: "authenticated" })]);
      ownerResult = (await q("select public.set_appointment_arrived($1,$2,true) as r", [a.studioId, id])).rows[0].r;
      throw sentinel;
    }).catch((e) => { if (e !== sentinel) throw e; });
    expect(result).toBe("arrived");
    expect(actor).toBe("receptionist");
    expect(ownerResult).toBe("unchanged");
    // rolled back: the predicate is false again and the row is untouched
    expect((await adminQuery("select public.arrival_receptionist_allowed() as ok")).rows[0].ok).toBe(false);
    expect(await arrivedAt(id)).toBeNull();
    expect(await arrive(aDesk.userId, a.studioId, id)).toBe("not_authorized");
  });
});

describe("the command", () => {
  it("is idempotent: a second check-in keeps the first time and adds no audit row", async () => {
    const id = await seedAppointment(a);
    expect(await arrive(a.userId, a.studioId, id)).toBe("arrived");
    const first = await arrivedAt(id);
    expect(await arrive(a.userId, a.studioId, id)).toBe("unchanged");
    expect(await arrivedAt(id)).toEqual(first);
    expect(await audit(id)).toHaveLength(1);
  });

  it("undo clears it, is idempotent, and is audited", async () => {
    const id = await seedAppointment(a);
    await arrive(a.userId, a.studioId, id);
    expect(await arrive(a.userId, a.studioId, id, false)).toBe("cleared");
    expect(await arrivedAt(id)).toBeNull();
    expect(await arrive(a.userId, a.studioId, id, false)).toBe("unchanged");
    expect((await audit(id)).map((r) => r.action)).toEqual(["checked_in", "check_in_undone"]);
  });

  it("does not touch status or the appointment's time", async () => {
    const id = await seedAppointment(a);
    const before = (await adminQuery("select status, starts_at, ends_at, practitioner_id from public.appointments where id = $1", [id])).rows[0];
    await arrive(a.userId, a.studioId, id);
    expect((await adminQuery("select status, starts_at, ends_at, practitioner_id from public.appointments where id = $1", [id])).rows[0]).toEqual(before);
  });

  it.each(["cancelled", "no_show", "completed"])("refuses a %s appointment", async (status) => {
    const id = await seedAppointment(a, status);
    expect(await arrive(a.userId, a.studioId, id)).toBe("wrong_status");
    expect(await arrivedAt(id)).toBeNull();
  });

  it("a missing appointment is not_found", async () => {
    expect(await arrive(a.userId, a.studioId, randomUUID())).toBe("not_found");
  });

  it("a null flag is refused, not read as false", async () => {
    const id = await seedAppointment(a);
    await arrive(a.userId, a.studioId, id);
    const r = await asUser(a.userId, async (q) => (await q("select public.set_appointment_arrived($1,$2,null) as r", [a.studioId, id])).rows[0].r);
    expect(r).toBe("wrong_status");
    expect(await arrivedAt(id)).not.toBeNull();
  });
});

describe("a closed appointment is never checked in", () => {
  it.each(["cancelled", "no_show"])("%s clears the arrival, and reverting does not bring it back", async (status) => {
    const id = await seedAppointment(a);
    await arrive(a.userId, a.studioId, id);
    await adminQuery("update public.appointments set status = $2 where id = $1", [id, status]);
    expect(await arrivedAt(id)).toBeNull();
    await adminQuery("update public.appointments set status = 'confirmed' where id = $1", [id]);
    expect(await arrivedAt(id)).toBeNull();
  });

  it("completing keeps the arrival (the client did arrive)", async () => {
    const id = await seedAppointment(a);
    await arrive(a.userId, a.studioId, id);
    await adminQuery("update public.appointments set status = 'completed' where id = $1", [id]);
    expect(await arrivedAt(id)).not.toBeNull();
  });
});

describe("privileges", () => {
  const sig = "public.set_appointment_arrived(uuid,uuid,boolean)";
  it("only authenticated may execute the command; every internal helper is closed to all four roles", async () => {
    const rows = (await adminQuery(
      `select r.role,
              has_function_privilege(r.role, '${sig}', 'execute') as command,
              has_function_privilege(r.role, 'public.appointment_arrival_actor(uuid)', 'execute') as actor,
              has_function_privilege(r.role, 'public.arrival_receptionist_allowed()', 'execute') as predicate,
              has_function_privilege(r.role, 'public.clear_arrival_on_close()', 'execute') as trigger_fn
         from (values ('anon'),('authenticated'),('service_role'),('public')) r(role)`,
    )).rows;
    const by = Object.fromEntries(rows.map((r) => [r.role, r]));
    expect(by.authenticated.command).toBe(true);
    for (const role of ["anon", "service_role", "public"]) expect(by[role].command, role).toBe(false);
    for (const role of ["anon", "authenticated", "service_role", "public"]) {
      expect(by[role].actor, role).toBe(false);
      expect(by[role].predicate, role).toBe(false);
      expect(by[role].trigger_fn, role).toBe(false);
    }
  });

  it("anon and service_role calls are refused by privilege", async () => {
    const id = await seedAppointment(a);
    await expect(asRole("anon", (q) => q(`select ${sig.replace("(uuid,uuid,boolean)", "")}($1,$2,true)`, [a.studioId, id]))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("service_role", (q) => q(`select ${sig.replace("(uuid,uuid,boolean)", "")}($1,$2,true)`, [a.studioId, id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("no API role can write arrived_at directly", async () => {
    const id = await seedAppointment(a);
    await expect(asUser(a.userId, (q) => q("update public.appointments set arrived_at = now() where id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("service_role", (q) => q("update public.appointments set arrived_at = now() where id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    expect(await arrivedAt(id)).toBeNull();
  });
});
