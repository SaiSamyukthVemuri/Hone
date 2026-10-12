// 0221 — DELIVERY-VISIBILITY-04, against a real database.
//
//   * PURPOSES: cancellation and postcare emails can be ledgered; anything
//     outside the vocabulary still cannot.
//   * CONCERNS: the studio OWNER records "client says they did not receive
//     it" for one appointment, channel and purpose. It snapshots what the
//     ledger said at that moment, never changes a ledger status, is
//     write-once, has at most one open concern per key, and only support can
//     close it.
//   * PERMISSION AND ISOLATION: a practitioner, another studio's owner, anon
//     and service_role cannot report or read a studio's concerns; an owner
//     cannot report against another studio's appointment.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

let A: SeededStudio;
let B: SeededStudio;
let slot = 0;

async function seedAppointment(s: SeededStudio): Promise<string> {
  const hoursOut = 90 + slot++ * 2;
  const r = await q<{ id: string }>(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3,
             now() + ($4::text || ' hours')::interval,
             now() + ($4::text || ' hours')::interval + interval '45 minutes',
             45, 'confirmed', $5)
     returning id`,
    [s.studioId, s.practitionerId, s.clientId, String(hoursOut), hash64()],
  );
  return r[0]!.id;
}

const report = (userId: string, studioId: string, appt: string, channel: string, purpose: string) =>
  asUser(userId, (query) =>
    query(`select * from public.report_delivery_concern($1, $2, $3, $4)`, [studioId, appt, channel, purpose]),
  ).then((r) => r.rows[0] as { result: string; concern_id: string | null; ledger_status: string | null });

beforeAll(async () => {
  A = await seedStudio("concerns-a");
  B = await seedStudio("concerns-b");
});
afterAll(async () => {
  await closePool();
});

describe("PURPOSES", () => {
  it("ledgers cancellation and postcare emails, and still refuses anything else", async () => {
    const appt = await seedAppointment(A);
    for (const purpose of ["appointment_cancellation", "appointment_postcare"]) {
      const r = await q<{ id: string | null }>(`select public.begin_appointment_email_message($1, $2, $3) as id`, [
        A.studioId,
        appt,
        purpose,
      ]);
      expect(r[0]!.id, purpose).not.toBeNull();
    }
    const bad = await q<{ id: string | null }>(`select public.begin_appointment_email_message($1, $2, 'marketing') as id`, [
      A.studioId,
      appt,
    ]);
    expect(bad[0]!.id).toBeNull();
    await expect(
      q(`insert into public.email_outbound_messages (studio_id, purpose, appointment_id) values ($1, 'marketing', $2)`, [
        A.studioId,
        appt,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("opens an incident for a refused postcare email like any other purpose", async () => {
    const appt = await seedAppointment(A);
    const [row] = await q<{ id: string }>(`select public.begin_appointment_email_message($1, $2, 'appointment_postcare') as id`, [
      A.studioId,
      appt,
    ]);
    await q(`select public.settle_email_message($1, 'refused', null, 'validation_error', null)`, [row!.id]);
    const inc = await q<{ occurrences: number }>(
      `select occurrences from public.delivery_incidents
        where studio_id = $1 and purpose = 'appointment_postcare' and resolved_at is null`,
      [A.studioId],
    );
    expect(inc).toHaveLength(1);
  });
});

describe("CONCERNS", () => {
  it("records the owner's report with the ledger's status at that moment, and changes no ledger status", async () => {
    const appt = await seedAppointment(A);
    const [row] = await q<{ id: string }>(`select public.begin_appointment_email_message($1, $2, 'appointment_reminder_24h') as id`, [
      A.studioId,
      appt,
    ]);
    const emailId = randomUUID();
    await q(`select public.settle_email_message($1, 'accepted', $2, null, null)`, [row!.id, emailId]);

    const r = await report(A.userId, A.studioId, appt, "email", "appointment_reminder_24h");
    expect(r).toMatchObject({ result: "reported", ledger_status: "accepted" });
    const [c] = await q<Record<string, unknown>>(`select * from public.delivery_concerns where id = $1`, [r.concern_id]);
    expect(c).toMatchObject({
      studio_id: A.studioId,
      appointment_id: appt,
      channel: "email",
      email_message_id: row!.id,
      reported_by_practitioner_id: A.practitionerId,
      state: "open",
    });
    const [m] = await q<{ status: string }>(`select status from public.email_outbound_messages where id = $1`, [row!.id]);
    expect(m!.status).toBe("accepted");
  });

  it("records `no_record` when the ledger holds nothing for that message", async () => {
    const appt = await seedAppointment(A);
    expect(await report(A.userId, A.studioId, appt, "sms", "appointment_reminder_2h")).toMatchObject({
      result: "reported",
      ledger_status: "no_record",
    });
  });

  it("keeps one open concern per appointment, channel and purpose, and lets support close it for good", async () => {
    const appt = await seedAppointment(A);
    const first = await report(A.userId, A.studioId, appt, "email", "appointment_confirmation");
    const again = await report(A.userId, A.studioId, appt, "email", "appointment_confirmation");
    expect(again).toMatchObject({ result: "already_open", concern_id: first.concern_id });

    expect(await q(`select public.close_delivery_concern($1, 'explained') as r`, [first.concern_id])).toEqual([{ r: "closed" }]);
    expect(await q(`select public.close_delivery_concern($1, 'not_actionable') as r`, [first.concern_id])).toEqual([
      { r: "already_closed" },
    ]);
    await expect(
      q(`update public.delivery_concerns set state = 'open', resolution = null, closed_at = null where id = $1`, [first.concern_id]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      q(`update public.delivery_concerns set ledger_status_at_report = 'delivered' where id = $1`, [first.concern_id]),
    ).rejects.toMatchObject({ code: "42501" });

    const reopened = await report(A.userId, A.studioId, appt, "email", "appointment_confirmation");
    expect(reopened.result).toBe("reported");
    expect(reopened.concern_id).not.toBe(first.concern_id);
  });

  it("refuses a purpose the channel cannot carry, and an appointment of another studio", async () => {
    const appt = await seedAppointment(A);
    expect(await report(A.userId, A.studioId, appt, "sms", "appointment_postcare")).toMatchObject({ result: "invalid_input" });
    const apptB = await seedAppointment(B);
    expect(await report(A.userId, A.studioId, apptB, "email", "appointment_confirmation")).toMatchObject({ result: "not_found" });
  });

  it("support sees the ledger status at report time AND now", async () => {
    const appt = await seedAppointment(A);
    const [row] = await q<{ id: string }>(`select public.begin_appointment_email_message($1, $2, 'appointment_cancellation') as id`, [
      A.studioId,
      appt,
    ]);
    const emailId = randomUUID();
    await q(`select public.settle_email_message($1, 'accepted', $2, null, null)`, [row!.id, emailId]);
    const r = await report(A.userId, A.studioId, appt, "email", "appointment_cancellation");
    // The provider later reports delivery.
    const [rec] = await q<{ receipt_id: string }>(
      `select * from public.record_email_provider_event($1, 'email.delivered', $2, $3, now(), null, null, null, null)`,
      [`msg_${randomUUID().replace(/-/g, "")}`, emailId, row!.id],
    );
    await q(`select * from public.process_email_provider_event($1)`, [rec!.receipt_id]);
    const [s] = await q<{ ledger_status_at_report: string; current_ledger_status: string; studio_name: string }>(
      `select * from public.support_delivery_concerns(false) where concern_id = $1`,
      [r.concern_id],
    );
    expect(s).toMatchObject({ ledger_status_at_report: "accepted", current_ledger_status: "delivered", studio_name: "Harness concerns-a" });
  });
});

describe("PERMISSION AND ISOLATION", () => {
  it("refuses a practitioner, another studio's owner, anon and service_role", async () => {
    const appt = await seedAppointment(A);
    const member = await seedMember(A, "concerns-member");
    for (const userId of [member.userId, B.userId]) {
      await expect(report(userId, A.studioId, appt, "email", "appointment_confirmation")).rejects.toMatchObject({ code: "42501" });
      await expect(
        asUser(userId, (query) => query(`select * from public.owner_delivery_concerns($1)`, [A.studioId])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    for (const role of ["anon", "service_role"] as const) {
      await expect(
        asRole(role, (query) =>
          query(`select * from public.report_delivery_concern($1, $2, 'email', 'appointment_confirmation')`, [A.studioId, appt]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("shows an owner only their own studio's concerns", async () => {
    const apptB = await seedAppointment(B);
    await report(B.userId, B.studioId, apptB, "email", "appointment_confirmation");
    const rows = (await asUser(A.userId, (query) => query(`select * from public.owner_delivery_concerns($1)`, [A.studioId])))
      .rows as Array<{ appointment_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.appointment_id === apptB)).toBe(false);
  });

  it("grants no table privilege, and each command only to its role", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const r = await q<{ any: boolean }>(
        `select has_table_privilege($1, 'public.delivery_concerns', 'select')
             or has_table_privilege($1, 'public.delivery_concerns', 'insert')
             or has_table_privilege($1, 'public.delivery_concerns', 'update') as any`,
        [role],
      );
      expect(r[0]!.any, role).toBe(false);
    }
    const exec = async (fn: string, role: string) =>
      (await q<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn]))[0]!.ok;
    for (const fn of ["public.report_delivery_concern(uuid, uuid, text, text)", "public.owner_delivery_concerns(uuid)"]) {
      expect(await exec(fn, "authenticated")).toBe(true);
      expect(await exec(fn, "anon")).toBe(false);
      expect(await exec(fn, "service_role")).toBe(false);
    }
    for (const fn of ["public.support_delivery_concerns(boolean)", "public.close_delivery_concern(uuid, text)"]) {
      expect(await exec(fn, "service_role")).toBe(true);
      expect(await exec(fn, "authenticated")).toBe(false);
      expect(await exec(fn, "anon")).toBe(false);
    }
  });
});
