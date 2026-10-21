// 0215 — DELIVERY-VISIBILITY-01, against a real database.
//
// What these cases pin, with synthetic fixtures only:
//
//   * DEDUPLICATED: repeated failures of one (studio, channel, purpose, class)
//     are ONE open incident with a count, even when they race; a different
//     class, purpose, channel or studio is a different incident.
//   * ATOMIC: an incident commits with the failure that caused it, and a
//     rolled-back failure leaves no incident.
//   * TRUTHFUL: retry-in-progress and ambiguous states (unknown, delayed,
//     accepted, sent) are not incidents; refused, bounced, failed, suppressed
//     (email) and refused, undelivered, failed (SMS) are.
//   * BOTH LEDGERS: Twilio's callback path (record_sms_delivery_status) and the
//     Resend event path (process_email_provider_event) open incidents with no
//     application change.
//   * OWNER-ONLY READ: the studio's owner reads its incidents; another
//     studio's owner, a non-owner member, anon and service_role cannot.
//   * HEARTBEAT and HEALTH: a sweep run is recorded; health reports the
//     receipt backlog and accepted-but-silent attempts as counts.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  adminTx,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
const sid = () => `SM${randomUUID().replace(/-/g, "")}`;

let A: SeededStudio;
let B: SeededStudio;
let apptA: string;
let apptB: string;

let slot = 0;
async function seedAppointment(s: SeededStudio): Promise<string> {
  const hoursOut = 60 + slot++ * 2;
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

beforeAll(async () => {
  A = await seedStudio("incidents-a");
  B = await seedStudio("incidents-b");
  apptA = await seedAppointment(A);
  apptB = await seedAppointment(B);
});

afterAll(async () => {
  await closePool();
});

type Incident = {
  id: string;
  studio_id: string;
  channel: string;
  purpose: string;
  failure_class: string;
  occurrences: number;
  last_email_message_id: string | null;
  last_sms_message_id: string | null;
  last_appointment_id: string | null;
  last_reason: string | null;
  resolved_at: string | null;
};

async function incidents(studioId: string): Promise<Incident[]> {
  return q<Incident>(
    `select * from public.delivery_incidents where studio_id = $1 order by channel, purpose, failure_class, first_seen_at`,
    [studioId],
  );
}

async function resolveAll(studioId: string): Promise<void> {
  for (const i of await incidents(studioId)) {
    if (!i.resolved_at) await q(`select public.resolve_delivery_incident($1, 'fixed')`, [i.id]);
  }
}

async function beginEmail(s: SeededStudio, appt: string, purpose = "appointment_reminder_24h"): Promise<string> {
  return (
    await q<{ id: string }>(`select public.begin_appointment_email_message($1, $2, $3) as id`, [s.studioId, appt, purpose])
  )[0]!.id;
}

async function settleEmail(id: string, outcome: string, emailId: string | null = null, err: string | null = null) {
  return (
    await q<{ r: string }>(`select public.settle_email_message($1, $2, $3, $4, null) as r`, [id, outcome, emailId, err])
  )[0]!.r;
}

/** Record, claim and process one Resend event, as the webhook route does. */
async function emailEvent(type: string, emailId: string, tag: string, extra: Record<string, string | null> = {}) {
  const rec = (
    await q<{ receipt_id: string }>(
      `select * from public.record_email_provider_event($1, $2, $3, $4, now(), $5, $6, $7, $8)`,
      [
        `msg_${randomUUID().replace(/-/g, "")}`,
        type,
        emailId,
        tag,
        extra.bounceType ?? null,
        extra.bounceSubtype ?? null,
        extra.failureReason ?? null,
        extra.suppressionType ?? null,
      ],
    )
  )[0]!;
  return (await q<{ result: string }>(`select * from public.process_email_provider_event($1)`, [rec.receipt_id]))[0]!;
}

async function beginSms(s: SeededStudio, appt: string, purpose = "appointment_reminder_2h"): Promise<string> {
  return (
    await q<{ id: string }>(`select public.begin_appointment_sms_message($1, $2, $3) as id`, [s.studioId, appt, purpose])
  )[0]!.id;
}

// ---------------------------------------------------------------------------

describe("DEDUPLICATED: one open incident per studio, channel, purpose and class", () => {
  it("counts repeated refusals as one incident and keeps the latest attempt and reason", async () => {
    await resolveAll(A.studioId);
    const ids: string[] = [];
    for (const err of ["validation_error", "rate_limit_exceeded", "validation_error"]) {
      const id = await beginEmail(A, apptA);
      ids.push(id);
      expect(await settleEmail(id, "refused", null, err)).toBe("settled");
    }
    const open = (await incidents(A.studioId)).filter((i) => !i.resolved_at);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      channel: "email",
      purpose: "appointment_reminder_24h",
      failure_class: "refused",
      occurrences: 3,
      last_email_message_id: ids[2],
      last_appointment_id: apptA,
      last_reason: "validation_error",
    });
  });

  it("keeps a different class, purpose, channel and studio apart", async () => {
    await resolveAll(A.studioId);
    await resolveAll(B.studioId);
    const bounced = await beginEmail(A, apptA);
    const e1 = randomUUID();
    await settleEmail(bounced, "accepted", e1);
    await emailEvent("email.bounced", e1, bounced, { bounceType: "permanent", bounceSubtype: "no_email" });
    const confirm = await beginEmail(A, apptA, "appointment_confirmation");
    await settleEmail(confirm, "refused", null, "validation_error");
    const sms = await beginSms(A, apptA);
    await q(`select public.settle_sms_message($1, 'refused', null, 21610, null)`, [sms]);
    const other = await beginEmail(B, apptB);
    await settleEmail(other, "refused", null, "validation_error");

    const a = (await incidents(A.studioId)).filter((i) => !i.resolved_at).map((i) => `${i.channel}/${i.purpose}/${i.failure_class}/${i.last_reason}`);
    expect(a.sort()).toEqual(
      [
        "email/appointment_confirmation/refused/validation_error",
        "email/appointment_reminder_24h/bounced/no_email",
        "sms/appointment_reminder_2h/refused/twilio_21610",
      ].sort(),
    );
    const b = (await incidents(B.studioId)).filter((i) => !i.resolved_at);
    expect(b).toHaveLength(1);
    expect(b[0]!.studio_id).toBe(B.studioId);
  });

  it("collapses failures that race each other into one incident", async () => {
    await resolveAll(A.studioId);
    const ids = await Promise.all([beginEmail(A, apptA, "appointment_reminder_2h"), beginEmail(A, apptA, "appointment_reminder_2h"), beginEmail(A, apptA, "appointment_reminder_2h")]);
    await Promise.all(ids.map((id) => settleEmail(id, "refused", null, "validation_error")));
    const open = (await incidents(A.studioId)).filter((i) => !i.resolved_at && i.purpose === "appointment_reminder_2h");
    expect(open).toHaveLength(1);
    expect(open[0]!.occurrences).toBe(3);
  });

  it("opens a new incident after the last one is resolved", async () => {
    await resolveAll(A.studioId);
    const first = await beginEmail(A, apptA);
    await settleEmail(first, "refused", null, "validation_error");
    const [open] = (await incidents(A.studioId)).filter((i) => !i.resolved_at);
    expect(await q<{ r: string }>(`select public.resolve_delivery_incident($1, 'fixed') as r`, [open!.id])).toEqual([{ r: "resolved" }]);
    expect(await q<{ r: string }>(`select public.resolve_delivery_incident($1, 'fixed') as r`, [open!.id])).toEqual([{ r: "already_resolved" }]);
    const second = await beginEmail(A, apptA);
    await settleEmail(second, "refused", null, "validation_error");
    const reopened = (await incidents(A.studioId)).filter((i) => !i.resolved_at);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.id).not.toBe(open!.id);
    expect(reopened[0]!.occurrences).toBe(1);
  });
});

describe("ATOMIC and TRUTHFUL", () => {
  it("leaves no incident when the failure itself rolls back", async () => {
    await resolveAll(A.studioId);
    const id = await beginEmail(A, apptA);
    await expect(
      adminTx(async (tx) => {
        await tx(`select public.settle_email_message($1, 'refused', null, 'validation_error', null)`, [id]);
        throw new Error("the caller's transaction failed");
      }),
    ).rejects.toThrow("the caller's transaction failed");
    expect((await incidents(A.studioId)).filter((i) => !i.resolved_at)).toEqual([]);
    expect((await q<{ status: string }>(`select status from public.email_outbound_messages where id = $1`, [id]))[0]!.status).toBe("claimed");
  });

  it("never opens an incident for an ambiguous, delayed, accepted, sent, delivered or skipped attempt", async () => {
    await resolveAll(A.studioId);
    const unknown = await beginEmail(A, apptA);
    await settleEmail(unknown, "unknown", null, "timeout");
    const skipped = await beginEmail(A, apptA);
    await q(`select public.settle_email_message($1, 'skipped', null, null, 'no_recipient')`, [skipped]);
    const flowing = await beginEmail(A, apptA);
    const e = randomUUID();
    await settleEmail(flowing, "accepted", e);
    for (const type of ["email.sent", "email.delivery_delayed", "email.delivered", "email.opened"]) {
      await emailEvent(type, e, flowing);
    }
    const sms = await beginSms(A, apptA);
    await q(`select public.settle_sms_message($1, 'unknown', null, null, null)`, [sms]);
    expect((await incidents(A.studioId)).filter((i) => !i.resolved_at)).toEqual([]);
  });

  it("opens an incident from each provider path with no application change", async () => {
    await resolveAll(A.studioId);
    // Resend: suppressed, through the signed-event processor.
    const m = await beginEmail(A, apptA);
    const e = randomUUID();
    await settleEmail(m, "accepted", e);
    await emailEvent("email.suppressed", e, m, { suppressionType: "on_account_suppression_list" });
    // Twilio: undelivered, through the status-callback command.
    const s = await beginSms(A, apptA);
    const smsSid = sid();
    await q(`select public.settle_sms_message($1, 'accepted', $2, null, null)`, [s, smsSid]);
    await q(`select * from public.record_sms_delivery_status($1, $2, 'undelivered', 30003)`, [s, smsSid]);
    // A late, repeated callback is stale and does not count again.
    await q(`select * from public.record_sms_delivery_status($1, $2, 'undelivered', 30003)`, [s, smsSid]);

    const open = (await incidents(A.studioId)).filter((i) => !i.resolved_at);
    expect(open.map((i) => [i.channel, i.failure_class, i.occurrences, i.last_reason])).toEqual([
      ["email", "suppressed", 1, "on_account_suppression_list"],
      ["sms", "undelivered", 1, "twilio_30003"],
    ]);
    expect(open[1]!.last_sms_message_id).toBe(s);
  });
});

describe("OWNER-ONLY READ", () => {
  it("lets the studio's owner read its incidents, operational metadata only", async () => {
    await resolveAll(A.studioId);
    const id = await beginEmail(A, apptA);
    await settleEmail(id, "refused", null, "validation_error");
    const rows = (
      await asUser(A.userId, (query) => query(`select * from public.owner_delivery_incidents($1)`, [A.studioId]))
    ).rows as Array<Record<string, unknown>>;
    expect(rows.filter((r) => r.resolved_at === null)).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "channel", "failure_class", "first_seen_at", "incident_id", "last_appointment_id", "last_reason",
        "last_seen_at", "occurrences", "purpose", "resolution", "resolved_at",
      ].sort(),
    );
  });

  it("refuses another studio's owner, a non-owner member, anon and service_role", async () => {
    const member = await seedMember(A, "incidents-member");
    for (const userId of [B.userId, member.userId]) {
      await expect(
        asUser(userId, (query) => query(`select * from public.owner_delivery_incidents($1)`, [A.studioId])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    for (const role of ["anon", "service_role"] as const) {
      await expect(
        asRole(role, (query) => query(`select * from public.owner_delivery_incidents($1)`, [A.studioId])),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("grants no table privilege to any browser role and leaves the commands where they belong", async () => {
    for (const table of ["public.delivery_incidents", "public.delivery_sweep_heartbeat"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await q<{ any: boolean }>(
          `select has_table_privilege($1, $2, 'select') or has_table_privilege($1, $2, 'insert')
               or has_table_privilege($1, $2, 'update') or has_table_privilege($1, $2, 'delete') as any`,
          [role, table],
        );
        expect(r[0]!.any, `${role} on ${table}`).toBe(false);
      }
    }
    const expectExec = async (fn: string, role: string, expected: boolean) => {
      const r = await q<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn]);
      expect(r[0]!.ok, `${role} execute ${fn}`).toBe(expected);
    };
    for (const fn of [
      "public.record_email_sweep_run(integer, integer, integer)",
      "public.email_delivery_health()",
      "public.resolve_delivery_incident(uuid, text)",
    ]) {
      await expectExec(fn, "anon", false);
      await expectExec(fn, "authenticated", false);
      await expectExec(fn, "service_role", true);
    }
    await expectExec("public.owner_delivery_incidents(uuid)", "anon", false);
    await expectExec("public.owner_delivery_incidents(uuid)", "authenticated", true);
    await expectExec("public.owner_delivery_incidents(uuid)", "service_role", false);
    for (const fn of ["public.email_outbound_messages_open_incident()", "public.sms_outbound_messages_open_incident()"]) {
      for (const role of ["anon", "authenticated", "service_role"]) await expectExec(fn, role, false);
    }
  });
});

describe("SUPPORT QUEUE (platform-only, service_role)", () => {
  it("lists open incidents across studios with the studio name, and recent resolutions only when asked", async () => {
    await resolveAll(A.studioId);
    await resolveAll(B.studioId);
    const a = await beginEmail(A, apptA);
    await settleEmail(a, "refused", null, "validation_error");
    const b = await beginEmail(B, apptB);
    await settleEmail(b, "refused", null, "validation_error");
    const open = await q<{ studio_id: string; studio_name: string; resolved_at: string | null }>(
      `select * from public.support_delivery_incidents(false) where studio_id = any($1::uuid[])`,
      [[A.studioId, B.studioId]],
    );
    expect(open.map((r) => r.studio_name).sort()).toEqual(["Harness incidents-a", "Harness incidents-b"]);
    expect(open.every((r) => r.resolved_at === null)).toBe(true);
    const withResolved = await q(
      `select * from public.support_delivery_incidents(true) where studio_id = $1 and resolved_at is not null`,
      [A.studioId],
    );
    expect(withResolved.length).toBeGreaterThan(0);
  });

  it("counts Resend receipts by outcome, including the unattributed ones only support sees", async () => {
    await q(
      `select * from public.process_email_provider_event(
         (select receipt_id from public.record_email_provider_event($1, 'email.delivered', $2, null, now(), null, null, null, null)))`,
      [`msg_${randomUUID().replace(/-/g, "")}`, randomUUID()],
    );
    const rows = await q<{ processing_state: string; processing_result: string; receipts: number }>(
      `select * from public.support_email_receipt_outcomes()`,
    );
    expect(rows.find((r) => r.processing_result === "unmatched_email_id")?.receipts).toBeGreaterThan(0);
  });

  it("is closed to every browser role", async () => {
    for (const fn of ["public.support_delivery_incidents(boolean)", "public.support_email_receipt_outcomes()"]) {
      for (const [role, expected] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
        const r = await q<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn]);
        expect(r[0]!.ok, `${role} execute ${fn}`).toBe(expected);
      }
    }
  });
});

describe("HEARTBEAT and HEALTH", () => {
  it("records each sweep run and refuses an impossible one", async () => {
    expect(await q(`select public.record_email_sweep_run(4, 3, 1) as r`)).toEqual([{ r: "recorded" }]);
    expect(await q(`select public.record_email_sweep_run(1, 1, 1) as r`)).toEqual([{ r: "invalid_input" }]);
    const h = (await q<{ last_sweep_failed: number; last_sweep_at: string | null }>(`select * from public.email_delivery_health()`))[0]!;
    expect(h.last_sweep_failed).toBe(1);
    expect(h.last_sweep_at).not.toBeNull();
  });

  it("reports a pending receipt's age and an accepted attempt with no report as counts", async () => {
    const before = (await q<{ pending_receipts: number; unreported_accepted: number }>(`select * from public.email_delivery_health()`))[0]!;
    const rec = (
      await q<{ receipt_id: string }>(
        `select * from public.record_email_provider_event($1, 'email.delivered', $2, null, now(), null, null, null, null)`,
        [`msg_${randomUUID().replace(/-/g, "")}`, randomUUID()],
      )
    )[0]!;
    const quiet = await beginEmail(A, apptA);
    await settleEmail(quiet, "accepted", randomUUID());
    await adminTx(async (tx) => {
      await tx(`alter table public.email_outbound_messages disable trigger email_outbound_messages_identity_guard`);
      await tx(`update public.email_outbound_messages set settled_at = now() - interval '25 hours' where id = $1`, [quiet]);
      await tx(`alter table public.email_outbound_messages enable trigger email_outbound_messages_identity_guard`);
    });
    const after = (await q<{ pending_receipts: number; oldest_pending_seconds: number | null; unreported_accepted: number }>(`select * from public.email_delivery_health()`))[0]!;
    expect(after.pending_receipts).toBe(before.pending_receipts + 1);
    expect(after.oldest_pending_seconds).not.toBeNull();
    expect(after.unreported_accepted).toBe(before.unreported_accepted + 1);
    await q(`select * from public.process_email_provider_event($1)`, [rec.receipt_id]);
  });
});


describe("AGED CLAIM HEALTH — no inference of provider acceptance (4310259234)", () => {
  it.each([
    { status: "claimed", hours: 25, claimed: 1, accepted: 0 },
    { status: "claimed", hours: 23, claimed: 0, accepted: 0 },
    { status: "claimed", hours: 24, claimed: 0, accepted: 0 },
    { status: "accepted", hours: 25, claimed: 0, accepted: 1 },
    { status: "accepted", hours: 23, claimed: 0, accepted: 0 },
    { status: "sent", hours: 25, claimed: 0, accepted: 1 },
    { status: "delivered", hours: 25, claimed: 0, accepted: 0 },
    { status: "refused", hours: 25, claimed: 0, accepted: 0 },
    { status: "unknown", hours: 25, claimed: 0, accepted: 0 },
  ])("$status at $hours hours: aged claims +$claimed, accepted +$accepted", async ({ status, hours, claimed, accepted }) => {
    const id = await beginEmail(A, apptA);
    if (status === "refused" || status === "unknown") await settleEmail(id, status, null, "validation_error");
    else if (status !== "claimed") {
      const providerId = randomUUID();
      await settleEmail(id, "accepted", providerId);
      if (status === "sent" || status === "delivered") await emailEvent(`email.${status}`, providerId, id);
    }
    type Health = { stale_claimed: number; unreported_accepted: number };
    await adminTx(async (tx) => {
      const before = ((await tx(`select * from public.email_delivery_health()`)).rows as Health[])[0]!;
      // Synthetic fixture only; the production identity guard stays intact.
      await tx(`alter table public.email_outbound_messages disable trigger email_outbound_messages_identity_guard`);
      await tx(`update public.email_outbound_messages set claimed_at = now() - ($2::text || ' hours')::interval,
        settled_at = case when settled_at is null then null else now() - ($2::text || ' hours')::interval end,
        provider_status_at = case when provider_status_at is null then null else now() - ($2::text || ' hours')::interval end
        where id = $1`, [id, String(hours)]);
      await tx(`alter table public.email_outbound_messages enable trigger email_outbound_messages_identity_guard`);
      const after = ((await tx(`select * from public.email_delivery_health()`)).rows as Health[])[0]!;
      expect(after.stale_claimed).toBe(before.stale_claimed + claimed);
      expect(after.unreported_accepted).toBe(before.unreported_accepted + accepted);
      const [row] = (await tx(`select status, provider_email_id from public.email_outbound_messages where id = $1`, [id])).rows as { status: string; provider_email_id: string | null }[];
      expect(row!.status).toBe(status);
      if (status === "claimed") expect(row!.provider_email_id).toBeNull();
    });
  });
});
