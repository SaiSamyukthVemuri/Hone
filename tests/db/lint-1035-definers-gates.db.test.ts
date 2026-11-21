// LINT-1035 — cross-studio and wrong-role refusals for the authenticated-
// executable SECURITY DEFINER functions of migrations 0213-0246.
//
// Two synthetic studios (A and B), an owner, a non-owner practitioner, an
// active and an inactive receptionist, and a user who belongs to neither. Each
// function is called as the WRONG caller; the assertion is the specific refusal
// AND that nothing changed in the target studio. Where a function has a
// success path that is cheap to build, the RIGHT caller is run first, so a
// refusal cannot be a fixture error.
//
// Synthetic data, disposable CI stack only.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

type Out = { ok: true; rows: Array<Record<string, unknown>> } | { ok: false; code: string; message: string };

async function call(userId: string, text: string, params: unknown[] = []): Promise<Out> {
  try {
    const r = await asUser(userId, (q) => q(text, params));
    return { ok: true, rows: r.rows as Array<Record<string, unknown>> };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? "", message: err.message ?? "" };
  }
}

function refused(o: Out, code: string, message?: RegExp): void {
  expect(o.ok, `expected a refusal, got ${JSON.stringify(o)}`).toBe(false);
  if (o.ok) return;
  expect(o.code).toBe(code);
  if (message) expect(o.message).toMatch(message);
}

function first(o: Out): Record<string, unknown> {
  if (!o.ok) throw new Error(`expected rows, got ${o.code}: ${o.message}`);
  return o.rows[0] ?? {};
}

let A: SeededStudio;
let B: SeededStudio;
let memberA: { userId: string; practitionerId: string };
let desk: { userId: string; id: string }; // active receptionist of A
let deskB: { userId: string; id: string }; // active receptionist of B
let off: { userId: string; id: string }; // INACTIVE receptionist of A
let stranger: string; // belongs to no studio
let serviceA: string;
let serviceB: string;
let apptA: string;
let apptB: string;
let machineA: string;
let machineB: string;
let sessA: { sessionId: string; blockId: string };
let sessB: { sessionId: string; blockId: string };
let imageA: string;
let imageB: string;

async function authUser(label: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [id, `${label}-${id.slice(0, 8)}@harness.local`]);
  return id;
}

async function receptionist(studio: SeededStudio, label: string, active: boolean) {
  const userId = await authUser(label);
  const id = randomUUID();
  await adminQuery(
    `insert into public.studio_receptionists (id, studio_id, user_id, display_name, active, deactivated_at)
     values ($1,$2,$3,$4,$5,$6)`,
    [id, studio.studioId, userId, `Desk ${label}`, active, active ? null : new Date().toISOString()],
  );
  return { userId, id };
}

async function service(studio: SeededStudio): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'Lint service',60,0,true)`,
    [id, studio.studioId],
  );
  return id;
}

async function appointment(studio: SeededStudio, dayOffset: number): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.appointments
       (id,studio_id,client_id,practitioner_id,starts_at,ends_at,duration_minutes,status)
     values ($1,$2,$3,$4,now()+make_interval(days=>$5),now()+make_interval(days=>$5,hours=>1),60,'confirmed')`,
    [id, studio.studioId, studio.clientId, studio.practitionerId, dayOffset],
  );
  return id;
}

async function machine(studio: SeededStudio): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.studio_machines (id, studio_id, machine_profile_id, machine_profile_version, display_name)
     values ($1,$2,'lint-profile',1,'Lint unit')`,
    [id, studio.studioId],
  );
  return id;
}

async function image(studio: SeededStudio): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.treatment_images
       (id, studio_id, client_id, storage_path, content_type, size_bytes, uploaded_by)
     values ($1,$2,$3,$4,'image/jpeg',10,$5)`,
    [id, studio.studioId, studio.clientId, `${studio.studioId}/${studio.clientId}/${id}.jpg`, studio.practitionerId],
  );
  return id;
}

beforeAll(async () => {
  A = await seedStudio("lint-a");
  B = await seedStudio("lint-b");
  memberA = await seedMember(A, "lint-member");
  desk = await receptionist(A, "desk-a", true);
  deskB = await receptionist(B, "desk-b", true);
  off = await receptionist(A, "desk-off", false);
  stranger = await authUser("stranger");
  serviceA = await service(A);
  serviceB = await service(B);
  apptA = await appointment(A, 9);
  apptB = await appointment(B, 9);
  machineA = await machine(A);
  machineB = await machine(B);
  sessA = await seedSession(A);
  sessB = await seedSession(B);
  imageA = await image(A);
  imageB = await image(B);
});

afterAll(async () => {
  await closePool();
});

async function apptRow(id: string) {
  return (await adminQuery(`select status, starts_at, practitioner_id from public.appointments where id=$1`, [id])).rows[0];
}

describe("receptionist read projections (0216, 0220)", () => {
  const FROM = "now() - interval '1 day'";
  const TO = "now() + interval '30 days'";
  const reads: Array<[string, (s: string) => string]> = [
    ["receptionist_calendar", (s) => `select * from public.receptionist_calendar('${s}', ${FROM}, ${TO})`],
    ["receptionist_calendar_closures", (s) => `select * from public.receptionist_calendar_closures('${s}', ${FROM}, ${TO})`],
    ["receptionist_client_contacts", (s) => `select * from public.receptionist_client_contacts('${s}', 'Client', 10)`],
    ["receptionist_booking_options", (s) => `select * from public.receptionist_booking_options('${s}')`],
  ];

  it("positive control: the desk of A reads A, and only A", async () => {
    const cal = await call(desk.userId, reads[0][1](A.studioId));
    expect(cal.ok).toBe(true);
    if (cal.ok) {
      const ids = cal.rows.map((r) => r.appointment_id);
      expect(ids).toContain(apptA);
      expect(ids).not.toContain(apptB);
    }
    const opts = await call(desk.userId, reads[3][1](A.studioId));
    expect(opts.ok).toBe(true);
    if (opts.ok) {
      const ids = opts.rows.map((r) => r.id);
      expect(ids).toContain(serviceA);
      expect(ids).not.toContain(serviceB);
    }
  });

  for (const [name, sql] of reads) {
    it(`${name}: refuses a receptionist of ANOTHER studio`, async () => {
      refused(await call(desk.userId, sql(B.studioId)), "42501", /not_authorized/);
    });
    it(`${name}: refuses an INACTIVE receptionist of the same studio`, async () => {
      refused(await call(off.userId, sql(A.studioId)), "42501", /not_authorized/);
    });
    it(`${name}: refuses a practitioner who is not a receptionist (owner and member)`, async () => {
      refused(await call(A.userId, sql(A.studioId)), "42501", /not_authorized/);
      refused(await call(memberA.userId, sql(A.studioId)), "42501", /not_authorized/);
    });
    it(`${name}: refuses a user who belongs to no studio`, async () => {
      refused(await call(stranger, sql(A.studioId)), "42501", /not_authorized/);
    });
  }
});

describe("receptionist write commands (0220)", () => {
  const startsAt = () => new Date(Date.now() + 30 * 86400_000).toISOString();

  it("create: another studio's desk, an inactive desk and non-desk users get not_authorized, and nothing is booked", async () => {
    const before = (await adminQuery(`select count(*)::int n from public.appointments where studio_id in ($1,$2)`, [A.studioId, B.studioId])).rows[0].n;
    const sql = `select * from public.receptionist_create_appointment($1,$2,$3,$4,$5)`;
    for (const who of [desk.userId, off.userId, A.userId, memberA.userId, stranger]) {
      const target = who === desk.userId ? [B.studioId, B.practitionerId, B.clientId, serviceB] : [A.studioId, A.practitionerId, A.clientId, serviceA];
      const o = await call(who, sql, [...target, startsAt()]);
      expect(first(o).result, `caller ${who}`).toBe("not_authorized");
    }
    const after = (await adminQuery(`select count(*)::int n from public.appointments where studio_id in ($1,$2)`, [A.studioId, B.studioId])).rows[0].n;
    expect(after).toBe(before);
  });

  it("create: the desk of A cannot book A's chair for B's client, service or practitioner", async () => {
    const sql = `select * from public.receptionist_create_appointment($1,$2,$3,$4,$5)`;
    // Positive control: the same desk passes the gate for its own studio's ids.
    const own = await call(desk.userId, sql, [A.studioId, A.practitionerId, A.clientId, serviceA, startsAt()]);
    expect(first(own).result).not.toBe("not_authorized");
    expect(first(await call(desk.userId, sql, [A.studioId, A.practitionerId, B.clientId, serviceA, startsAt()])).result).toBe("invalid_client");
    expect(first(await call(desk.userId, sql, [A.studioId, B.practitionerId, A.clientId, serviceA, startsAt()])).result).toBe("invalid_practitioner");
    expect(first(await call(desk.userId, sql, [A.studioId, A.practitionerId, A.clientId, serviceB, startsAt()])).result).toBe("invalid_service");
    const leaked = (await adminQuery(`select count(*)::int n from public.appointments where studio_id=$1 and client_id=$2`, [A.studioId, B.clientId])).rows[0].n;
    expect(leaked).toBe(0);
  });

  it("cancel: refuses B's appointment through B's studio id (wrong desk) and through A's studio id (wrong scope)", async () => {
    const sql = `select public.receptionist_cancel_appointment($1,$2,$3) as r`;
    expect(first(await call(desk.userId, sql, [B.studioId, apptB, "lint"])).r).toBe("not_authorized");
    expect(first(await call(desk.userId, sql, [A.studioId, apptB, "lint"])).r).toBe("not_cancelable");
    for (const who of [off.userId, A.userId, memberA.userId, stranger, deskB.userId]) {
      expect(first(await call(who, sql, [A.studioId, apptA, "lint"])).r, `caller ${who}`).toBe("not_authorized");
    }
    expect((await apptRow(apptB)).status).toBe("confirmed");
    expect((await apptRow(apptA)).status).toBe("confirmed");
  });

  it("move: refuses B's appointment and B's practitioner; B's row is unchanged", async () => {
    const before = await apptRow(apptB);
    const sql = `select * from public.receptionist_move_appointment($1,$2,$3,$4,$5,$6)`;
    const exp = await adminQuery(`select starts_at, ends_at from public.appointments where id=$1`, [apptB]);
    const mv = new Date(Date.now() + 40 * 86400_000).toISOString();
    const args = (studio: string, appt: string, pract: string) => [studio, appt, pract, exp.rows[0].starts_at, exp.rows[0].ends_at, mv];
    expect(first(await call(desk.userId, sql, args(B.studioId, apptB, B.practitionerId))).result).toBe("not_authorized");
    const viaA = first(await call(desk.userId, sql, args(A.studioId, apptB, A.practitionerId))).result;
    expect(viaA).not.toBe("not_authorized"); // the desk is A's, so the gate passes ...
    expect(viaA).not.toBe("moved"); // ... and the appointment scope refuses
    const toB = first(await call(desk.userId, sql, args(A.studioId, apptA, B.practitionerId))).result;
    expect(toB).not.toBe("moved");
    for (const who of [off.userId, A.userId, memberA.userId, stranger, deskB.userId]) {
      expect(first(await call(who, sql, args(A.studioId, apptA, A.practitionerId))).result, `caller ${who}`).toBe("not_authorized");
    }
    const after = await apptRow(apptB);
    expect(after.starts_at).toEqual(before.starts_at);
    expect(after.practitioner_id).toBe(before.practitioner_id);
    expect((await apptRow(apptA)).practitioner_id).toBe(A.practitionerId);
  });

  it("the receptionist cannot call an owner command (no owner authority from the desk)", async () => {
    refused(await call(desk.userId, `select public.register_studio_machine($1,'lint-profile',1,'x')`, [A.studioId]), "42501");
    refused(await call(desk.userId, `select * from public.owner_delivery_incidents($1)`, [A.studioId]), "42501");
  });
});

describe("owner-only commands (0221, 0223, 0236)", () => {
  it("owner_delivery_concerns / owner_delivery_incidents: owner of A reads; member, foreign owner, desk, stranger refused", async () => {
    for (const fn of ["owner_delivery_concerns", "owner_delivery_incidents"]) {
      const sql = `select * from public.${fn}($1)`;
      expect((await call(A.userId, sql, [A.studioId])).ok, `${fn} owner`).toBe(true);
      for (const who of [memberA.userId, B.userId, desk.userId, stranger]) {
        refused(await call(who, sql, [A.studioId]), "42501", /not the owner/);
      }
    }
  });

  it("report_delivery_concern: member, foreign owner, desk and stranger refused before any argument is read", async () => {
    const sql = `select * from public.report_delivery_concern($1,$2,'email','delivered_not_received')`;
    for (const who of [memberA.userId, B.userId, desk.userId, stranger]) {
      refused(await call(who, sql, [A.studioId, apptA]), "42501", /not the owner/);
    }
    const n = (await adminQuery(`select count(*)::int n from public.delivery_concerns where studio_id=$1`, [A.studioId])).rows[0].n;
    expect(n).toBe(0);
  });

  it("register_studio_machine: only the owner of THAT studio", async () => {
    for (const who of [memberA.userId, B.userId, desk.userId, stranger]) {
      refused(await call(who, `select public.register_studio_machine($1,'lint-profile',1,'Unit')`, [A.studioId]), "42501", /Only the studio owner/);
    }
    const n = (await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1`, [A.studioId])).rows[0].n;
    expect(n).toBe(1); // the fixture machine only
  });

  it("retire_studio_machine: member, foreign owner, desk, stranger refused; the unit stays in service", async () => {
    for (const who of [memberA.userId, B.userId, desk.userId, stranger]) {
      refused(await call(who, `select public.retire_studio_machine($1)`, [machineA]), "42501", /Only the studio owner/);
    }
    const r = await adminQuery(`select retired_at from public.studio_machines where id=$1`, [machineA]);
    expect(r.rows[0].retired_at).toBeNull();
    refused(await call(A.userId, `select public.retire_studio_machine($1)`, [randomUUID()]), "P0002", /Unknown machine/);
  });
});

describe("own-practitioner commands (0223)", () => {
  it("set_own_default_machine: another studio's machine, a non-member and a desk change nothing", async () => {
    refused(await call(A.userId, `select public.set_own_default_machine($1,$2,'m')`, [A.studioId, machineB]), "42501", /another studio/);
    for (const who of [stranger, desk.userId, B.userId]) {
      const o = await call(who, `select public.set_own_default_machine($1,$2,'m') as r`, [A.studioId, machineA]);
      expect(first(o).r, `caller ${who}`).toBeNull();
    }
    const p = await adminQuery(`select default_machine_id from public.practitioners where id = any($1::uuid[])`, [[A.practitionerId, B.practitionerId, memberA.practitionerId]]);
    expect(p.rows.every((r) => r.default_machine_id === null)).toBe(true);
    // Positive control: the owner of A sets A's machine as default.
    const ok = await call(A.userId, `select public.set_own_default_machine($1,$2,'m') as r`, [A.studioId, machineA]);
    expect(first(ok).r).toBe(A.practitionerId);
  });

  const group = (block: string, machine: string, sess: string, client: string) => [block, machine, "lint-mode", "g1", "{1}", "[]", sess, client];
  const submission = (block: string, machine: string, sess: string, client: string) => [block, machine, "lint-mode", "lint-key-0001", '[{"group_key":"g1"}]', sess, client];
  const GSQL = `select public.record_treatment_setup_group($1,$2,$3,$4,$5::smallint[],$6::jsonb,$7,$8) as r`;
  const SSQL = `select public.record_treatment_setup_submission($1,$2,$3,$4,$5::jsonb,$6,$7) as r`;
  const captured = async () => (await adminQuery(`select count(*)::int n from public.treatment_setup_captures where studio_id = any($1::uuid[])`, [[A.studioId, B.studioId]])).rows[0].n;

  for (const [label, sql, args] of [
    ["record_treatment_setup_group", GSQL, group],
    ["record_treatment_setup_submission", SSQL, submission],
  ] as const) {
    it(`${label}: a foreign owner, a desk and a stranger cannot write into A's block`, async () => {
      const before = await captured();
      for (const who of [B.userId, desk.userId, stranger]) {
        refused(await call(who, sql, args(sessA.blockId, machineA, sessA.sessionId, A.clientId)), "42501", /Not an active member/);
      }
      expect(await captured()).toBe(before);
    });

    it(`${label}: a member of A is bound to the route's session and client, and to A's machines`, async () => {
      const before = await captured();
      // B's client against A's block: the route ids do not match the block.
      refused(await call(A.userId, sql, args(sessA.blockId, machineA, sessA.sessionId, B.clientId)), "P0002", /Unknown treatment block/);
      // B's session against A's block.
      refused(await call(A.userId, sql, args(sessA.blockId, machineA, sessB.sessionId, A.clientId)), "P0002", /Unknown treatment block/);
      // B's block entirely.
      refused(await call(A.userId, sql, args(sessB.blockId, machineA, sessB.sessionId, B.clientId)), "42501", /Not an active member/);
      // B's machine on A's block.
      refused(await call(A.userId, sql, args(sessA.blockId, machineB, sessA.sessionId, A.clientId)), "42501", /another studio/);
      expect(await captured()).toBe(before);
    });
  }

  it("create_block_with_initial_setup: a foreign owner and a wrong client cannot add a block to A's session", async () => {
    const nulls = [
      "null::jsonb", "null::jsonb", "null::jsonb", "false", "null::text", "null::text[]", "null::text", "null::uuid",
      "null::text", "null::int", "null::numeric", "null::text", "null::jsonb", "null::text", "null::int", "null::int",
      "null::text", "null::text", "null::int", "null::numeric", "null::int", "null::int", "null::numeric", "null::numeric",
      "null::uuid", "null::text", "null::text", "null::jsonb",
    ];
    const sql = `select public.create_block_with_initial_setup($1::uuid,$2::uuid,${nulls.join(",")}) as r`;
    const blocks = async (studio: string) => (await adminQuery(`select count(*)::int n from public.session_blocks where studio_id=$1`, [studio])).rows[0].n;
    const before = await blocks(A.studioId);
    refused(await call(B.userId, sql, [sessA.sessionId, A.clientId]), "23514", /not found or not writable/);
    refused(await call(stranger, sql, [sessA.sessionId, A.clientId]), "23514", /not found or not writable/);
    refused(await call(desk.userId, sql, [sessA.sessionId, A.clientId]), "23514", /not found or not writable/);
    refused(await call(A.userId, sql, [sessA.sessionId, B.clientId]), "23514", /does not belong to that client/);
    expect(await blocks(A.studioId)).toBe(before);
  });

  it("start_session: a foreign owner cannot start or reuse a chart in A", async () => {
    const before = (await adminQuery(`select count(*)::int n from public.sessions where studio_id=$1`, [A.studioId])).rows[0].n;
    for (const who of [B.userId, desk.userId, stranger]) {
      const o = await call(who, `select * from public.start_session($1,'electrolysis',null,90,$2)`, [A.clientId, A.studioId]);
      expect(o.ok, `caller ${who} got ${JSON.stringify(o)}`).toBe(false);
    }
    expect((await adminQuery(`select count(*)::int n from public.sessions where studio_id=$1`, [A.studioId])).rows[0].n).toBe(before);
  });
});

describe("image and portrait commands (0231, 0232)", () => {
  const imageRow = async (id: string) => (await adminQuery(`select deleted_at, capture_stage from public.treatment_images where id=$1`, [id])).rows[0];

  it("set_treatment_image_capture_stage: B's owner and a stranger cannot touch A's image", async () => {
    for (const who of [B.userId, stranger, desk.userId]) {
      const o = await call(who, `select public.set_treatment_image_capture_stage($1,$2,'before') as r`, [imageA, A.clientId]);
      expect(first(o).r, `caller ${who}`).toBeNull();
    }
    expect((await imageRow(imageA)).capture_stage).toBeNull();
  });

  it("archive_treatment_image: B's owner and a stranger cannot archive A's image", async () => {
    for (const who of [B.userId, stranger, desk.userId]) {
      const o = await call(who, `select public.archive_treatment_image($1,$2) as r`, [imageA, A.clientId]);
      expect(first(o).r, `caller ${who}`).toBeNull();
    }
    expect((await imageRow(imageA)).deleted_at).toBeNull();
  });

  it("set_client_portrait: B's owner cannot set A's client portrait, and A cannot point it at B's image", async () => {
    refused(await call(B.userId, `select public.set_client_portrait($1,$2,null)`, [A.clientId, imageA]), "23514", /not available/);
    refused(await call(stranger, `select public.set_client_portrait($1,$2,null)`, [A.clientId, imageA]), "23514", /not available/);
    // The integrity trigger refuses an image of another client/studio even for A's own owner.
    refused(await call(A.userId, `select public.set_client_portrait($1,$2,null)`, [A.clientId, imageB]), "23514", /same client/);
    const c = await adminQuery(`select portrait_image_id from public.clients where id=$1`, [A.clientId]);
    expect(c.rows[0].portrait_image_id).toBeNull();
    // Positive control: A's owner sets A's own image.
    const ok = await call(A.userId, `select public.set_client_portrait($1,$2,null) as r`, [A.clientId, imageA]);
    expect(first(ok).r).toBe(imageA);
  });
});

describe("audit commands (0233)", () => {
  const meta = JSON.stringify({ scope: "day", day: "2026-01-02" });
  it("record_clinical_records_audit: a member, a foreign owner and a stranger cannot record an export for A's client", async () => {
    const sql = `select public.record_clinical_records_audit($1,'clinical_records_previewed',$2::jsonb) as r`;
    refused(await call(memberA.userId, sql, [A.clientId, meta]), "42501", /only the studio owner/);
    refused(await call(B.userId, sql, [A.clientId, meta]), "42501", /only the studio owner/);
    refused(await call(stranger, sql, [A.clientId, meta]), "42501", /only the studio owner/);
    const ok = await call(A.userId, sql, [A.clientId, meta]);
    expect(first(ok).r).toBeTruthy();
  });

  it("audit_actor_is_caller: true only for the caller's own practitioner in that studio", async () => {
    const sql = `select public.audit_actor_is_caller($1,$2) as r`;
    expect(first(await call(A.userId, sql, [A.practitionerId, A.studioId])).r).toBe(true);
    expect(first(await call(B.userId, sql, [A.practitionerId, A.studioId])).r).toBe(false);
    expect(first(await call(memberA.userId, sql, [A.practitionerId, A.studioId])).r).toBe(false);
    expect(first(await call(stranger, sql, [A.practitionerId, A.studioId])).r).toBe(false);
  });
});
