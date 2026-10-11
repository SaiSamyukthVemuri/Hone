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
// STUDIO-READY-02a / migration 0216 (#824) — the receptionist membership.
// ===========================================================================
//
// A receptionist is a `studio_receptionists` row and NOT a `practitioners`
// row, so every existing RLS policy (is_studio_member / is_studio_owner read
// practitioners) and every existing command (actor resolved from practitioners)
// refuses them BY CONSTRUCTION. This suite proves that with a REAL receptionist
// JWT against the real migrated schema, generically over every public table
// that carries a studio_id (so a table added later is covered without editing
// this file), and proves the three projections return only their fixed columns.

let S: SynthStudio; // the studio the receptionist works for (capacity ON)
let X: SynthStudio; // another studio

let receptionistUserId = "";
let receptionistId = "";
let service = "";
let appointmentId = "";
let archivedClientId = "";
let templateId = "";

const owner = () => S.practitioners.find((p) => p.role === "owner")!;
const P1 = () => S.practitioners[1];

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
const WINDOW_FROM = "2031-07-01T00:00:00Z";
const WINDOW_TO = "2031-07-31T00:00:00Z";

async function seedAuthUser(label: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    id,
    `${label}-${id.slice(0, 8)}@harness.local`,
  ]);
  return id;
}

const errCode = (e: unknown) => (e as { code?: string }).code;

beforeAll(async () => {
  S = await seedSynthStudioB();
  X = await seedSynthStudioA();
  await adminQuery(
    `update public.studios
        set practitioner_capacity_enabled = true,
            practitioner_capacity_booking_enabled = true,
            timezone = 'America/Los_Angeles',
            buffer_minutes = 0
      where id = $1`,
    [S.studioId],
  );
  await adminQuery(`select public.save_weekly_availability($1, null, $2::jsonb)`, [
    S.studioId,
    JSON.stringify(
      Array.from({ length: 7 }, (_, d) => ({ day_of_week: d, is_open: true, open_time: "08:00", close_time: "20:00" })),
    ),
  ]);
  const sv = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1, $2, 'Electrolysis 30', 30, 8500, true) returning id`,
    [randomUUID(), S.studioId],
  );
  service = sv.rows[0].id as string;

  // Clinical content the receptionist must never reach.
  await adminQuery(
    `update public.clients
        set phone = '+13105550142', email = 'client.one@example.test',
            date_of_birth = '1980-02-03', address = '1 Clinical Way',
            allergies = 'lidocaine', notes = 'pacemaker; avoid galvanic',
            contraindications = '{"pacemaker": true}'::jsonb
      where id = $1`,
    [S.clientId],
  );
  await adminQuery(
    `insert into public.client_intake_forms (studio_id, client_id, status, submitted_at, responses)
     values ($1, $2, 'submitted', '2031-06-01T10:00:00Z', '{"health": {"pacemaker": "yes", "pregnant": "no"}}'::jsonb)`,
    [S.studioId, S.clientId],
  );
  const tpl = await adminQuery(
    `insert into public.consent_form_templates (studio_id, title, body)
     values ($1, 'Electrolysis consent', 'I consent to treatment.') returning id`,
    [S.studioId],
  );
  templateId = tpl.rows[0].id as string;
  await adminQuery(
    `insert into public.client_consent_signatures
       (studio_id, client_id, template_id, template_title_snapshot, template_body_snapshot,
        template_version, template_hash, signature_name, signed_at, response)
     values ($1, $2, $3, 'Electrolysis consent', 'I consent to treatment.', 1, 'abc123', 'Client One',
             '2031-06-02T10:00:00Z', 'accepted')`,
    [S.studioId, S.clientId, templateId],
  );
  await adminQuery(
    `insert into public.client_clinical_notes (studio_id, client_id, practitioner_id, kind, body)
     values ($1, $2, $3, 'consultation', 'History of keloids on the jawline.')`,
    [S.studioId, S.clientId, P1().practitionerId],
  );
  await adminQuery(
    `insert into public.sessions (studio_id, client_id, practitioner_id, modality)
     values ($1, $2, $3, 'electrolysis')`,
    [S.studioId, S.clientId, P1().practitionerId],
  );
  const appt = await adminQuery(
    `select r.appointment_id from public.create_internal_appointment_v2(
       $1, $2, $3, $4, $5, ('2031-07-10 10:00'::timestamp at time zone 'America/Los_Angeles'), $6, 'clinical: pacemaker', null, false) r`,
    [S.studioId, owner().practitionerId, P1().practitionerId, S.clientId, service, hash64()],
  );
  appointmentId = appt.rows[0].appointment_id as string;
  await adminQuery(
    `insert into public.studio_timed_blocks (id, studio_id, practitioner_id, starts_at, ends_at, category)
     values ($1, $2, null, '2031-07-11T19:00:00Z', '2031-07-11T20:00:00Z', 'break')`,
    [randomUUID(), S.studioId],
  );
  const archived = await adminQuery(
    `insert into public.clients (id, studio_id, name, phone, archived_at)
     values ($1, $2, 'Archived Person', '+13105550199', now()) returning id`,
    [randomUUID(), S.studioId],
  );
  archivedClientId = archived.rows[0].id as string;

  // The receptionist: an auth user whose ONLY membership is studio_receptionists.
  receptionistUserId = await seedAuthUser("front-desk");
  const r = await adminQuery(
    `select public.add_studio_receptionist($1, $2, $3, 'Front Desk', 'desk@example.test') as id`,
    [S.studioId, owner().practitionerId, receptionistUserId],
  );
  receptionistId = r.rows[0].id as string;
});

afterAll(async () => {
  // The clinical seeds hold RESTRICT references (signatures -> template;
  // clinical notes and sessions -> their practitioner, same-studio), so they
  // go before the studio cascade.
  if (S) {
    for (const t of ["client_consent_signatures", "client_clinical_notes", "sessions"]) {
      await adminQuery(`delete from public."${t}" where studio_id = $1`, [S.studioId]);
    }
  }
  for (const s of [S, X]) if (s) await dropSynthStudio(s);
  if (receptionistUserId) await adminQuery(`delete from auth.users where id = $1`, [receptionistUserId]);
  await closePool();
});

const asReceptionist = <T>(fn: Parameters<typeof asUser<T>>[1]) => asUser<T>(receptionistUserId, fn);

describe("STUDIO-READY-02a: a receptionist is refused everywhere by construction", () => {
  it("has a membership row and NO practitioners row", async () => {
    const m = await adminQuery(
      `select (select count(*)::int from public.studio_receptionists where user_id = $1 and active) as recep,
              (select count(*)::int from public.practitioners where user_id = $1) as prac`,
      [receptionistUserId],
    );
    expect(m.rows[0]).toEqual({ recep: 1, prac: 0 });
    const helpers = await asReceptionist((q) =>
      q(`select public.is_studio_member($1) as member, public.is_studio_owner($1) as owner`, [S.studioId]),
    );
    expect(helpers.rows[0]).toEqual({ member: false, owner: false });
  });

  it("reads ZERO rows of S from EVERY public table that carries a studio_id (raw PostgREST-equivalent reads)", async () => {
    const tables = await adminQuery(
      `select c.table_name
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'studio_id'
          and t.table_type = 'BASE TABLE'
          and c.table_name <> 'studio_receptionists'
        order by c.table_name`,
    );
    expect(tables.rows.length).toBeGreaterThan(40);
    const leaks: string[] = [];
    for (const { table_name } of tables.rows as { table_name: string }[]) {
      const n = await asReceptionist((q) =>
        q(`select count(*)::int as n from public."${table_name}" where studio_id = $1`, [S.studioId]),
      )
        .then((r) => r.rows[0].n as number)
        .catch((e) => (errCode(e) === "42501" ? 0 : -1));
      if (n !== 0) leaks.push(`${table_name}=${n}`);
    }
    expect(leaks).toEqual([]);
  });

  it("the denial is not vacuous: the OWNER sees the seeded clinical rows", async () => {
    for (const t of [
      "clients",
      "appointments",
      "client_intake_forms",
      "client_consent_signatures",
      "client_clinical_notes",
      "sessions",
    ]) {
      const n = await asUser(owner().userId, (q) =>
        q(`select count(*)::int as n from public."${t}" where studio_id = $1`, [S.studioId]),
      );
      expect(n.rows[0].n, t).toBeGreaterThan(0);
    }
  });

  it("no authenticated policy exists on the treatment-images bucket (objects reachable only by server signing)", async () => {
    const p = await adminQuery(
      `select count(*)::int as n from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and 'authenticated' = any(roles) and qual ilike '%treatment-images%'`,
    );
    expect(p.rows[0].n).toBe(0);
  });

  it("existing commands refuse the receptionist's identity, and it is never a booking target", async () => {
    // As ACTOR: not a practitioners id, so not_authorized.
    const asActor = await adminQuery(
      `select result from public.create_internal_appointment_v2($1,$2,$3,$4,$5,('2031-07-12 10:00'::timestamp at time zone 'America/Los_Angeles'),$6,null,null,false)`,
      [S.studioId, receptionistId, P1().practitionerId, S.clientId, service, hash64()],
    );
    expect(asActor.rows[0].result).toBe("not_authorized");
    // As TARGET: invalid_practitioner, even for the owner.
    const asTarget = await adminQuery(
      `select result from public.create_internal_appointment_v2($1,$2,$3,$4,$5,('2031-07-12 10:00'::timestamp at time zone 'America/Los_Angeles'),$6,null,null,false)`,
      [S.studioId, owner().practitionerId, receptionistId, S.clientId, service, hash64()],
    );
    expect(asTarget.rows[0].result).toBe("invalid_practitioner");
    // Cancel refuses the receptionist as actor.
    const cancel = await adminQuery(
      `select public.practitioner_cancel_appointment($1, $2, $3, 'x') as r`,
      [appointmentId, S.studioId, receptionistId],
    );
    expect(cancel.rows[0].r).toBe("not_authorized");
    // Not eligibility-capable: 0134's eligibility guard refuses an id that is
    // not an active practitioner (23514) before the practitioners FK (23503)
    // would; either way no row can exist.
    const elig = await adminQuery(
      `insert into public.service_practitioners (service_id, practitioner_id, studio_id) values ($1, $2, $3)`,
      [service, receptionistId, S.studioId],
    )
      .then(() => null)
      .catch((e) => errCode(e));
    expect(["23514", "23503"]).toContain(elig);
    const rows = await adminQuery(
      `select count(*)::int as n from public.service_practitioners where practitioner_id = $1`,
      [receptionistId],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("is never a capacity fan-out key: a studio-wide block covers practitioners only", async () => {
    const keys = await adminQuery(
      `select distinct resource_key from public.studio_calendar_reservations
        where studio_id = $1 and source_kind <> 'appointment'`,
      [S.studioId],
    );
    const set = new Set(keys.rows.map((r) => r.resource_key as string));
    expect(set.has(receptionistId)).toBe(false);
    expect(set).toEqual(new Set(S.practitioners.map((p) => p.practitionerId)));
  });
});

describe("STUDIO-READY-02a: the three projections", () => {
  it("receptionist_calendar returns exactly its fixed columns, and nothing clinical", async () => {
    const r = await asReceptionist((q) =>
      q(`select * from public.receptionist_calendar($1, $2, $3)`, [S.studioId, WINDOW_FROM, WINDOW_TO]),
    );
    expect(r.fields.map((f) => f.name)).toEqual([
      "appointment_id",
      "starts_at",
      "ends_at",
      "status",
      "practitioner_id",
      "practitioner_display_name",
      "practitioner_color",
      "service_id",
      "service_name",
      "client_id",
      "client_display_name",
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      appointment_id: appointmentId,
      status: "confirmed",
      practitioner_id: P1().practitionerId,
      service_name: "Electrolysis 30",
      client_id: S.clientId,
    });
    // The appointment's own notes ('clinical: pacemaker') are not in the row.
    expect(JSON.stringify(r.rows[0])).not.toMatch(/pacemaker/);
  });

  it("receptionist_calendar_closures returns kind and interval per resource, no labels", async () => {
    const r = await asReceptionist((q) =>
      q(`select * from public.receptionist_calendar_closures($1, $2, $3)`, [S.studioId, WINDOW_FROM, WINDOW_TO]),
    );
    expect(r.fields.map((f) => f.name)).toEqual([
      "source_kind",
      "starts_at",
      "ends_at",
      "resource_practitioner_id",
    ]);
    // The studio-wide break fans out to every practitioner on a capacity-ON studio.
    const breaks = r.rows.filter((x) => x.source_kind === "timed_block");
    expect(new Set(breaks.map((x) => x.resource_practitioner_id))).toEqual(
      new Set(S.practitioners.map((p) => p.practitionerId)),
    );
  });

  it("receptionist_client_contacts returns contact fields and completion facts only", async () => {
    const r = await asReceptionist((q) =>
      q(`select * from public.receptionist_client_contacts($1, null, 25)`, [S.studioId]),
    );
    expect(r.fields.map((f) => f.name)).toEqual([
      "client_id",
      "name",
      "phone",
      "email",
      "intake_status",
      "intake_submitted_at",
      "consent_accepted_at",
    ]);
    const me = r.rows.find((x) => x.client_id === S.clientId)!;
    expect(me).toMatchObject({
      phone: "+13105550142",
      email: "client.one@example.test",
      intake_status: "submitted",
    });
    expect(me.consent_accepted_at).not.toBeNull();
    const text = JSON.stringify(r.rows);
    for (const secret of ["1980-02-03", "Clinical Way", "lidocaine", "pacemaker", "keloids", "pregnant"]) {
      expect(text).not.toContain(secret);
    }
    // Archived clients stay out.
    expect(r.rows.some((x) => x.client_id === archivedClientId)).toBe(false);
  });

  it("contact search is literal and bounded: LIKE metacharacters do not widen it; limits clamp to 50", async () => {
    const hit = await asReceptionist((q) =>
      q(`select client_id from public.receptionist_client_contacts($1, 'client.one', 25)`, [S.studioId]),
    );
    expect(hit.rows.map((x) => x.client_id)).toEqual([S.clientId]);
    const wild = await asReceptionist((q) =>
      q(`select client_id from public.receptionist_client_contacts($1, '%%', 25)`, [S.studioId]),
    );
    expect(wild.rows).toHaveLength(0);
    const short = await asReceptionist((q) =>
      q(`select * from public.receptionist_client_contacts($1, 'a', 25)`, [S.studioId]),
    )
      .then(() => null)
      .catch((e) => errCode(e));
    expect(short).toBe("22023");
  });

  it("every projection refuses a practitioner, another studio, and an over-wide window", async () => {
    for (const sql of [
      `select * from public.receptionist_calendar($1, $2, $3)`,
      `select * from public.receptionist_calendar_closures($1, $2, $3)`,
    ]) {
      const asPractitioner = await asUser(P1().userId, (q) => q(sql, [S.studioId, WINDOW_FROM, WINDOW_TO]))
        .then(() => null)
        .catch((e) => errCode(e));
      expect(asPractitioner).toBe("42501");
      const otherStudio = await asReceptionist((q) => q(sql, [X.studioId, WINDOW_FROM, WINDOW_TO]))
        .then(() => null)
        .catch((e) => errCode(e));
      expect(otherStudio).toBe("42501");
      const wide = await asReceptionist((q) => q(sql, [S.studioId, "2031-01-01T00:00:00Z", "2031-07-01T00:00:00Z"]))
        .then(() => null)
        .catch((e) => errCode(e));
      expect(wide).toBe("22023");
    }
    const contacts = await asUser(P1().userId, (q) =>
      q(`select * from public.receptionist_client_contacts($1, null, 25)`, [S.studioId]),
    )
      .then(() => null)
      .catch((e) => errCode(e));
    expect(contacts).toBe("42501");
  });

  it("grants: projections are authenticated-only; lifecycle commands are service-role-only", async () => {
    const g = await adminQuery(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authed,
              has_function_privilege('service_role', p.oid, 'execute') as service
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('receptionist_calendar', 'receptionist_calendar_closures', 'receptionist_client_contacts',
                            'add_studio_receptionist', 'set_studio_receptionist_active', 'receptionist_actor_id')
        order by p.proname`,
    );
    const byName = Object.fromEntries(g.rows.map((r) => [r.proname, [r.anon, r.authed, r.service]]));
    expect(byName).toEqual({
      add_studio_receptionist: [false, false, true],
      receptionist_actor_id: [false, false, false],
      receptionist_calendar: [false, true, false],
      receptionist_calendar_closures: [false, true, false],
      receptionist_client_contacts: [false, true, false],
      set_studio_receptionist_active: [false, false, true],
    });
    const anonCall = await asRole("anon", (q) =>
      q(`select * from public.receptionist_calendar($1, $2, $3)`, [S.studioId, WINDOW_FROM, WINDOW_TO]),
    )
      .then(() => null)
      .catch((e) => errCode(e));
    expect(anonCall).toBe("42501");
  });
});

describe("STUDIO-READY-02a: membership lifecycle and the dual-membership guard", () => {
  it("only an ACTIVE OWNER may add a receptionist; a practitioner or another studio's owner may not", async () => {
    const u = await seedAuthUser("candidate");
    try {
      for (const actor of [P1().practitionerId, X.practitioners[0].practitionerId]) {
        const e = await adminQuery(`select public.add_studio_receptionist($1, $2, $3, 'X', null)`, [S.studioId, actor, u])
          .then(() => null)
          .catch((err) => errCode(err));
        expect(e).toBe("42501");
      }
    } finally {
      await adminQuery(`delete from auth.users where id = $1`, [u]);
    }
  });

  it("RLS on the membership: the receptionist reads their own row, the owner reads the studio's, a practitioner reads none", async () => {
    const own = await asReceptionist((q) => q(`select id from public.studio_receptionists`, []));
    expect(own.rows.map((r) => r.id)).toEqual([receptionistId]);
    const asOwner = await asUser(owner().userId, (q) =>
      q(`select id from public.studio_receptionists where studio_id = $1`, [S.studioId]),
    );
    expect(asOwner.rows.map((r) => r.id)).toEqual([receptionistId]);
    const asPractitioner = await asUser(P1().userId, (q) =>
      q(`select id from public.studio_receptionists where studio_id = $1`, [S.studioId]),
    );
    expect(asPractitioner.rows).toHaveLength(0);
    const write = await asReceptionist((q) =>
      q(`update public.studio_receptionists set display_name = 'Owner Now' where id = $1`, [receptionistId]),
    )
      .then(() => null)
      .catch((e) => errCode(e));
    expect(write).toBe("42501");
  });

  it("deactivation closes every projection; reactivation reopens them", async () => {
    expect(
      (await adminQuery(`select public.set_studio_receptionist_active($1, $2, $3, false) as r`, [
        S.studioId,
        owner().practitionerId,
        receptionistId,
      ])).rows[0].r,
    ).toBe("updated");
    const closed = await asReceptionist((q) =>
      q(`select * from public.receptionist_calendar($1, $2, $3)`, [S.studioId, WINDOW_FROM, WINDOW_TO]),
    )
      .then(() => null)
      .catch((e) => errCode(e));
    expect(closed).toBe("42501");
    expect(
      (await adminQuery(`select public.set_studio_receptionist_active($1, $2, $3, true) as r`, [
        S.studioId,
        owner().practitionerId,
        receptionistId,
      ])).rows[0].r,
    ).toBe("updated");
    const open = await asReceptionist((q) =>
      q(`select count(*)::int as n from public.receptionist_calendar($1, $2, $3)`, [S.studioId, WINDOW_FROM, WINDOW_TO]),
    );
    expect(open.rows[0].n).toBe(1);
    // A practitioner may not toggle it.
    expect(
      (await adminQuery(`select public.set_studio_receptionist_active($1, $2, $3, false) as r`, [
        S.studioId,
        P1().practitionerId,
        receptionistId,
      ])).rows[0].r,
    ).toBe("not_authorized");
  });

  it("one person is never an active practitioner AND an active receptionist in the same studio (either order)", async () => {
    // The receptionist cannot be added as a practitioner of S.
    const asPractitioner = await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
       values ($1, $2, $3, 'Front Desk', 'desk@example.test', 'practitioner', true)`,
      [randomUUID(), S.studioId, receptionistUserId],
    )
      .then(() => null)
      .catch((e) => errCode(e));
    expect(asPractitioner).toBe("23514");
    // A practitioner of S cannot be added as a receptionist of S.
    const asReceptionistToo = await adminQuery(
      `select public.add_studio_receptionist($1, $2, $3, 'P1', null)`,
      [S.studioId, owner().practitionerId, P1().userId],
    )
      .then(() => null)
      .catch((e) => errCode(e));
    expect(asReceptionistToo).toBe("23514");
  });

  it("multi-studio: the same person may practise in another studio, and each membership stays in its own studio", async () => {
    const prId = randomUUID();
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
       values ($1, $2, $3, 'Desk elsewhere', 'desk@example.test', 'practitioner', true)`,
      [prId, X.studioId, receptionistUserId],
    );
    X.practitioners.push({ userId: receptionistUserId, practitionerId: prId, role: "practitioner", email: "" });
    try {
      const helpers = await asReceptionist((q) =>
        q(`select public.is_studio_member($1) as s_member, public.is_studio_member($2) as x_member`, [
          S.studioId,
          X.studioId,
        ]),
      );
      expect(helpers.rows[0]).toEqual({ s_member: false, x_member: true });
      // Practising in X grants nothing clinical in S.
      const sClients = await asReceptionist((q) =>
        q(`select count(*)::int as n from public.clients where studio_id = $1`, [S.studioId]),
      );
      expect(sClients.rows[0].n).toBe(0);
      // And the S projection still works, scoped to S.
      const cal = await asReceptionist((q) =>
        q(`select count(*)::int as n from public.receptionist_calendar($1, $2, $3)`, [S.studioId, WINDOW_FROM, WINDOW_TO]),
      );
      expect(cal.rows[0].n).toBe(1);
    } finally {
      // Detach so X's teardown never deletes the shared auth user twice.
      X.practitioners = X.practitioners.filter((p) => p.practitionerId !== prId);
      await adminQuery(`delete from public.practitioners where id = $1`, [prId]);
    }
  });
});
