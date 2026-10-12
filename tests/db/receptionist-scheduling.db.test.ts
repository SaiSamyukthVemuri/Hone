import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioA,
  seedSynthStudioB,
  type SynthStudio,
} from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// ===========================================================================
// STUDIO-READY-02c / migration 0220 (#824): receptionist scheduling over the
// SHARED core, against the real migrated schema and REAL database roles.
// ===========================================================================
//
// A receptionist books, moves/reassigns and cancels a treating practitioner's
// appointment through the same create/move/cancel cores the practitioner
// commands use (their unchanged behaviour is pinned by the existing suites). The
// human actor is recorded; a practitioner identity is never borrowed. Every
// negative below is a direct database call, the way a forged API request would
// arrive.

let S: SynthStudio; // the receptionist's studio (capacity ON)
let X: SynthStudio; // another studio

let deskUser = "";
let deskId = "";
let otherDeskUser = ""; // a receptionist of X
let service = "";
let xService = "";

const owner = () => S.practitioners.find((p) => p.role === "owner")!;
const P1 = () => S.practitioners.filter((p) => p.role !== "owner")[0];
const xOwner = () => X.practitioners.find((p) => p.role === "owner")!;

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
const errCode = (e: unknown) => (e as { code?: string }).code;
// Local wall-clock times in the studio's zone, all far in the future.
const at = (local: string) => `('${local}'::timestamp at time zone 'America/Los_Angeles')`;

async function seedAuthUser(label: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    id,
    `${label}-${id.slice(0, 8)}@harness.local`,
  ]);
  return id;
}

async function openAllWeek(studioId: string) {
  await adminQuery(`select public.save_weekly_availability($1, null, $2::jsonb)`, [
    studioId,
    JSON.stringify(
      Array.from({ length: 7 }, (_, d) => ({ day_of_week: d, is_open: true, open_time: "08:00", close_time: "20:00" })),
    ),
  ]);
}

beforeAll(async () => {
  S = await seedSynthStudioB();
  X = await seedSynthStudioA();
  for (const st of [S, X]) {
    await adminQuery(
      `update public.studios
          set practitioner_capacity_enabled = true,
              practitioner_capacity_booking_enabled = true,
              timezone = 'America/Los_Angeles',
              buffer_minutes = 0
        where id = $1`,
      [st.studioId],
    );
    await openAllWeek(st.studioId);
  }
  service = (
    await adminQuery(
      `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
       values ($1, $2, 'Electrolysis 30', 30, 8500, true) returning id`,
      [randomUUID(), S.studioId],
    )
  ).rows[0].id as string;
  xService = (
    await adminQuery(
      `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
       values ($1, $2, 'Other 30', 30, 9000, true) returning id`,
      [randomUUID(), X.studioId],
    )
  ).rows[0].id as string;
  for (const p of S.practitioners) {
    await adminQuery(`insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($3, $1, $2) on conflict do nothing`, [
      service,
      p.practitionerId,
      S.studioId,
    ]);
  }

  deskUser = await seedAuthUser("desk");
  deskId = (
    await adminQuery(`select public.add_studio_receptionist($1, $2, $3, 'Front Desk', 'desk@example.test') as id`, [
      S.studioId,
      owner().practitionerId,
      deskUser,
    ])
  ).rows[0].id as string;
  otherDeskUser = await seedAuthUser("desk-x");
  await adminQuery(`select public.add_studio_receptionist($1, $2, $3, 'Other Desk', 'desk-x@example.test')`, [
    X.studioId,
    xOwner().practitionerId,
    otherDeskUser,
  ]);
});

afterAll(async () => {
  for (const s of [S, X]) if (s) await dropSynthStudio(s);
  for (const u of [deskUser, otherDeskUser]) if (u) await adminQuery(`delete from auth.users where id = $1`, [u]);
  await closePool();
});

type Row = Record<string, unknown>;
const asDesk = <T>(fn: Parameters<typeof asUser<T>>[1]) => asUser<T>(deskUser, fn);

async function deskBook(local: string, target = P1().practitionerId, client = S.clientId, svc = service, studio = S.studioId) {
  return asDesk(async (q) => {
    const r = await q(
      `select * from public.receptionist_create_appointment($1, $2, $3, $4, ${at(local)}, $5)`,
      [studio, target, client, svc, hash64()],
    );
    return r.rows[0] as Row;
  });
}

const appt = (id: string) =>
  adminQuery(`select * from public.appointments where id = $1`, [id]).then((r) => r.rows[0] as Row);
const audits = (id: string) =>
  adminQuery(
    `select actor_type, actor_id, actor_practitioner_id, actor_receptionist_id, action, details
       from public.appointment_audit where appointment_id = $1 order by created_at, action`,
    [id],
  ).then((r) => r.rows as Row[]);

describe("0220: a receptionist books, moves and cancels through the shared core", () => {
  it("BOOKS for a treating practitioner, attributed to the receptionist and never to a practitioner", async () => {
    const r = await deskBook("2031-08-04 10:00");
    expect(r.result).toBe("created");
    const a = await appt(r.appointment_id as string);
    expect(a).toMatchObject({
      practitioner_id: P1().practitionerId,
      created_by_receptionist_id: deskId,
      created_by_practitioner_id: null,
      notes: null,
      booked_outside_availability: false,
      status: "confirmed",
    });
    const [ev] = await audits(r.appointment_id as string);
    expect(ev).toMatchObject({
      actor_type: "receptionist",
      actor_id: deskId,
      actor_receptionist_id: deskId,
      actor_practitioner_id: null,
      action: "created",
    });
    expect((ev.details as Row).source).toBe("receptionist_booking_command");
  });

  it("MOVES and REASSIGNS, and the audit names the receptionist", async () => {
    const b = await deskBook("2031-08-05 10:00");
    const before = await appt(b.appointment_id as string);
    const m = await asDesk((q) =>
      q(
        `select * from public.receptionist_move_appointment($1, $2, $3, $4, $5, ${at("2031-08-05 13:00")})`,
        [S.studioId, b.appointment_id, owner().practitionerId, before.starts_at, before.ends_at],
      ).then((r) => r.rows[0] as Row),
    );
    expect(m.result).toBe("moved_and_reassigned");
    expect((await appt(b.appointment_id as string)).practitioner_id).toBe(owner().practitionerId);
    const evs = await audits(b.appointment_id as string);
    expect(evs.map((e) => [e.action, e.actor_type, e.actor_receptionist_id])).toEqual([
      ["created", "receptionist", deskId],
      ["moved_and_reassigned", "receptionist", deskId],
    ]);
    expect((evs[1].details as Row).source).toBe("receptionist_move_command");
  });

  it("CANCELS, recording the role word AND which receptionist", async () => {
    const b = await deskBook("2031-08-06 10:00");
    const c = await asDesk((q) =>
      q(`select public.receptionist_cancel_appointment($1, $2, 'client called') as r`, [S.studioId, b.appointment_id]).then(
        (r) => r.rows[0].r as string,
      ),
    );
    expect(c).toBe("cancelled");
    expect(await appt(b.appointment_id as string)).toMatchObject({
      status: "cancelled",
      cancelled_by: "receptionist",
      cancelled_by_receptionist_id: deskId,
      cancelled_by_practitioner_id: null,
      cancellation_reason: "client called",
    });
    const evs = await audits(b.appointment_id as string);
    expect(evs[1]).toMatchObject({ action: "cancelled", actor_type: "receptionist", actor_receptionist_id: deskId });
    expect((evs[1].details as Row).role).toBe("receptionist");
  });

  it("may cancel and move a booking a PRACTITIONER made, as the contract allows (any treating practitioner)", async () => {
    const made = await adminQuery(
      `select r.* from public.create_internal_appointment_v2($1, $2, $2, $3, $4, ${at("2031-08-07 10:00")}, $5) r`,
      [S.studioId, P1().practitionerId, S.clientId, service, hash64()],
    );
    const id = made.rows[0].appointment_id as string;
    const c = await asDesk((q) =>
      q(`select public.receptionist_cancel_appointment($1, $2, null) as r`, [S.studioId, id]).then((r) => r.rows[0].r),
    );
    expect(c).toBe("cancelled");
    expect(await appt(id)).toMatchObject({ created_by_practitioner_id: P1().practitionerId, cancelled_by_receptionist_id: deskId });
  });

  it("runs the SAME validator: an occupied slot is refused exactly as for a practitioner", async () => {
    const first = await deskBook("2031-08-08 10:00");
    expect(first.result).toBe("created");
    const again = await deskBook("2031-08-08 10:00").catch((e: unknown) => ({ code: errCode(e) }) as Row);
    // The validator answers first; the exclusion constraint is the race backstop.
    expect(["created"]).not.toContain(again.result);
  });
});

describe("0220: what a receptionist may NOT do", () => {
  it("cannot target anyone who is not an ACTIVE owner or practitioner, themselves included", async () => {
    // Their own auth user and their receptionist row id are not practitioners.
    for (const target of [deskUser, deskId, randomUUID()]) {
      expect((await deskBook("2031-08-11 10:00", target)).result, target).toBe("invalid_practitioner");
    }
    // An inactive practitioner is refused for a booking and for a reassignment.
    await adminQuery(`update public.practitioners set active = false where id = $1`, [P1().practitionerId]);
    try {
      expect((await deskBook("2031-08-11 11:00")).result).toBe("invalid_practitioner");
      const b = await deskBook("2031-08-11 12:00", owner().practitionerId);
      const before = await appt(b.appointment_id as string);
      const m = await asDesk((q) =>
        q(`select * from public.receptionist_move_appointment($1, $2, $3, $4, $5, $4)`, [
          S.studioId,
          b.appointment_id,
          P1().practitionerId,
          before.starts_at,
          before.ends_at,
        ]).then((r) => r.rows[0] as Row),
      );
      expect(m.result).toBe("invalid_practitioner");
    } finally {
      await adminQuery(`update public.practitioners set active = true where id = $1`, [P1().practitionerId]);
    }
  });

  it("has NO override: the commands take no override argument, and the core refuses one for the receptionist kind", async () => {
    const args = await adminQuery(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'receptionist\\_%\\_appointment'`,
    );
    expect(args.rows.length).toBe(3);
    for (const r of args.rows) {
      expect(r.args, r.proname).not.toMatch(/override|outside|actor|notes|duration/);
    }
    const viaCore = await adminQuery(
      `select r.result from public.create_appointment_core('receptionist', $1, $2, $3, $4, $5, ${at("2031-08-12 10:00")}, $6, null, 60, false) r`,
      [S.studioId, deskId, P1().practitionerId, S.clientId, service, hash64()],
    );
    expect(viaCore.rows[0].result).toBe("not_authorized");
    const viaCore2 = await adminQuery(
      `select r.result from public.create_appointment_core('receptionist', $1, $2, $3, $4, $5, ${at("2031-08-12 21:00")}, $6, null, null, true) r`,
      [S.studioId, deskId, P1().practitionerId, S.clientId, service, hash64()],
    );
    expect(viaCore2.rows[0].result).toBe("not_authorized");
  });

  it("an unknown actor kind is refused by every core", async () => {
    const r = await adminQuery(
      `select (select r.result from public.create_appointment_core('owner', $1, $2, $3, $4, $5, ${at("2031-08-12 11:00")}, $6, null, null, false) r) as c,
              public.cancel_appointment_core('client', $7, $1, $2, null) as x`,
      [S.studioId, deskId, P1().practitionerId, S.clientId, service, hash64(), randomUUID()],
    );
    expect(r.rows[0]).toEqual({ c: "not_authorized", x: "not_authorized" });
  });

  it("a DEACTIVATED receptionist's next call is refused, on all three commands", async () => {
    const b = await deskBook("2031-08-13 10:00");
    const before = await appt(b.appointment_id as string);
    await adminQuery(`select public.set_studio_receptionist_active($1, $2, $3, false)`, [
      S.studioId,
      owner().practitionerId,
      deskId,
    ]);
    try {
      expect((await deskBook("2031-08-13 12:00")).result).toBe("not_authorized");
      const m = await asDesk((q) =>
        q(`select * from public.receptionist_move_appointment($1, $2, null, $3, $4, ${at("2031-08-13 15:00")})`, [
          S.studioId,
          b.appointment_id,
          before.starts_at,
          before.ends_at,
        ]).then((r) => r.rows[0] as Row),
      );
      expect(m.result).toBe("not_authorized");
      const c = await asDesk((q) =>
        q(`select public.receptionist_cancel_appointment($1, $2, null) as r`, [S.studioId, b.appointment_id]).then(
          (r) => r.rows[0].r,
        ),
      );
      expect(c).toBe("not_authorized");
      expect((await appt(b.appointment_id as string)).status).toBe("confirmed");
    } finally {
      await adminQuery(`select public.set_studio_receptionist_active($1, $2, $3, true)`, [
        S.studioId,
        owner().practitionerId,
        deskId,
      ]);
    }
  });
});

describe("0220: cross-studio protection", () => {
  it("naming ANOTHER studio is refused: the actor is resolved per studio from the signed-in user", async () => {
    expect((await deskBook("2031-08-14 10:00", xOwner().practitionerId, X.clientId, xService, X.studioId)).result).toBe(
      "not_authorized",
    );
  });

  it("another studio's client, service or practitioner cannot be smuggled into the receptionist's own studio", async () => {
    expect((await deskBook("2031-08-14 11:00", xOwner().practitionerId)).result).toBe("invalid_practitioner");
    expect((await deskBook("2031-08-14 12:00", P1().practitionerId, X.clientId)).result).toBe("invalid_client");
    expect((await deskBook("2031-08-14 13:00", P1().practitionerId, S.clientId, xService)).result).toBe("invalid_service");
  });

  it("another studio's appointment is neither cancellable nor movable", async () => {
    const theirs = await adminQuery(
      `select r.* from public.create_internal_appointment_v2($1, $2, $2, $3, $4, ${at("2031-08-15 10:00")}, $5) r`,
      [X.studioId, xOwner().practitionerId, X.clientId, xService, hash64()],
    );
    const id = theirs.rows[0].appointment_id as string;
    const before = await appt(id);
    const c = await asDesk((q) =>
      q(`select public.receptionist_cancel_appointment($1, $2, null) as r`, [S.studioId, id]).then((r) => r.rows[0].r),
    );
    expect(c).toBe("not_cancelable");
    const m = await asDesk((q) =>
      q(`select * from public.receptionist_move_appointment($1, $2, null, $3, $4, ${at("2031-08-15 15:00")})`, [
        S.studioId,
        id,
        before.starts_at,
        before.ends_at,
      ]).then((r) => r.rows[0] as Row),
    );
    expect(m.result).toBe("appointment_not_found");
    expect((await appt(id)).status).toBe("confirmed");
    // And X's own receptionist, naming S, is refused.
    const xDesk = await asUser(otherDeskUser, (q) =>
      q(`select * from public.receptionist_create_appointment($1, $2, $3, $4, ${at("2031-08-15 11:00")}, $5)`, [
        S.studioId,
        P1().practitionerId,
        S.clientId,
        service,
        hash64(),
      ]).then((r) => r.rows[0] as Row),
    );
    expect(xDesk.result).toBe("not_authorized");
  });
});

describe("0220: direct API negatives (real roles)", () => {
  it("anon and service_role cannot execute the receptionist commands or the projection", async () => {
    for (const role of ["anon", "service_role"] as const) {
      for (const sql of [
        `select * from public.receptionist_create_appointment('${randomUUID()}', null, null, null, now(), null)`,
        `select public.receptionist_cancel_appointment('${randomUUID()}', '${randomUUID()}', null)`,
        `select * from public.receptionist_move_appointment('${randomUUID()}', '${randomUUID()}', null, now(), now(), now())`,
        `select * from public.receptionist_booking_options('${randomUUID()}')`,
      ]) {
        const e = await asRole(role, (q) => q(sql)).catch((err: unknown) => err);
        expect(errCode(e), `${role}: ${sql.slice(0, 50)}`).toBe("42501");
      }
    }
  });

  it("no API role can reach a core, and a receptionist cannot call the practitioner commands", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      const e = await asRole(role, (q) =>
        q(`select public.cancel_appointment_core('receptionist', $1, $2, $3, null)`, [randomUUID(), S.studioId, deskId]),
      ).catch((err: unknown) => err);
      expect(errCode(e), role).toBe("42501");
    }
    const asDeskCallingPractitionerCmd = await asDesk((q) =>
      q(`select public.practitioner_cancel_appointment($1, $2, $3, null)`, [randomUUID(), S.studioId, owner().practitionerId]),
    ).catch((err: unknown) => err);
    expect(errCode(asDeskCallingPractitionerCmd)).toBe("42501");
    const asDeskCallingCreate = await asDesk((q) =>
      q(`select * from public.create_internal_appointment_v2($1, $2, $2, $3, $4, now() + interval '30 days', null)`, [
        S.studioId,
        owner().practitionerId,
        S.clientId,
        service,
      ]),
    ).catch((err: unknown) => err);
    expect(errCode(asDeskCallingCreate)).toBe("42501");
  });

  it("a PRACTITIONER's own JWT gets not_authorized from the receptionist commands: no receptionist row, no authority", async () => {
    const r = await asUser(P1().userId, (q) =>
      q(`select * from public.receptionist_create_appointment($1, $2, $3, $4, ${at("2031-08-18 10:00")}, $5)`, [
        S.studioId,
        P1().practitionerId,
        S.clientId,
        service,
        hash64(),
      ]).then((x) => x.rows[0] as Row),
    );
    expect(r.result).toBe("not_authorized");
    const e = await asUser(P1().userId, (q) => q(`select * from public.receptionist_booking_options($1)`, [S.studioId])).catch(
      (err: unknown) => err,
    );
    expect(errCode(e)).toBe("42501");
  });

  it("a receptionist still cannot write appointments or audit rows directly", async () => {
    const ins = await asDesk((q) =>
      q(`insert into public.appointments (studio_id, client_id, starts_at, ends_at, duration_minutes, status)
         values ($1, $2, now() + interval '40 days', now() + interval '40 days 30 minutes', 30, 'confirmed')`, [
        S.studioId,
        S.clientId,
      ]),
    ).catch((err: unknown) => err);
    expect(errCode(ins)).toBe("42501");
    const aud = await asDesk((q) =>
      q(`insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
         values (null, 'receptionist', $1, 'created', '{}'::jsonb)`, [deskId]),
    ).catch((err: unknown) => err);
    expect(errCode(aud)).toBe("42501");
  });
});

describe("0220: attribution integrity", () => {
  it("the new columns are NULLABLE with no default, so the public 11-column INSERT shape is unaffected", async () => {
    const r = await adminQuery(
      `select column_name, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = 'appointments'
          and column_name in ('created_by_receptionist_id', 'cancelled_by_receptionist_id')
        order by 1`,
    );
    expect(r.rows).toEqual([
      { column_name: "cancelled_by_receptionist_id", is_nullable: "YES", column_default: null },
      { column_name: "created_by_receptionist_id", is_nullable: "YES", column_default: null },
    ]);
  });

  it("a row can never name two creator kinds or two canceller kinds", async () => {
    const b = await deskBook("2031-08-19 10:00");
    const e1 = await adminQuery(`update public.appointments set created_by_practitioner_id = $2 where id = $1`, [
      b.appointment_id,
      owner().practitionerId,
    ]).catch((err: unknown) => err);
    expect(errCode(e1)).toBe("23514");
  });

  it("a receptionist id from ANOTHER studio cannot be attributed (composite same-studio FK)", async () => {
    const b = await deskBook("2031-08-19 12:00");
    const foreign = await adminQuery(`select id from public.studio_receptionists where studio_id = $1`, [X.studioId]);
    const e = await adminQuery(`update public.appointments set created_by_receptionist_id = $2 where id = $1`, [
      b.appointment_id,
      foreign.rows[0].id,
    ]).catch((err: unknown) => err);
    expect(errCode(e)).toBe("23503");
  });

  it("the audit trigger derives the receptionist correlation and never accepts a cross-studio one", async () => {
    const b = await deskBook("2031-08-19 14:00");
    const foreign = await adminQuery(`select id from public.studio_receptionists where studio_id = $1`, [X.studioId]);
    // A privileged writer naming X's receptionist on S's appointment: the
    // correlation is derived as NULL, never the foreign id.
    await adminQuery(
      `insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details, actor_receptionist_id)
       values ($1, 'receptionist', $2, 'note', '{}'::jsonb, $2)`,
      [b.appointment_id, foreign.rows[0].id],
    );
    const evs = await audits(b.appointment_id as string);
    const last = evs.find((e) => e.action === "note")!;
    expect(last.actor_receptionist_id).toBeNull();
  });
});

describe("0220: the booking-form projection", () => {
  it("returns active services and bookable practitioners, with fixed columns and no price or email", async () => {
    const r = await asDesk((q) => q(`select * from public.receptionist_booking_options($1)`, [S.studioId]));
    expect(Object.keys(r.rows[0]).sort()).toEqual(["color", "duration_minutes", "id", "kind", "name"]);
    const kinds = new Set(r.rows.map((x) => x.kind));
    expect(kinds).toEqual(new Set(["service", "practitioner"]));
    const ids = r.rows.filter((x) => x.kind === "practitioner").map((x) => x.id);
    expect(ids.sort()).toEqual(S.practitioners.map((p) => p.practitionerId).sort());
    expect(ids).not.toContain(deskId);
    expect(r.rows.filter((x) => x.kind === "service").map((x) => x.id)).toEqual([service]);
  });

  it("refuses another studio's options", async () => {
    const e = await asDesk((q) => q(`select * from public.receptionist_booking_options($1)`, [X.studioId])).catch(
      (err: unknown) => err,
    );
    expect(errCode(e)).toBe("42501");
  });
});
