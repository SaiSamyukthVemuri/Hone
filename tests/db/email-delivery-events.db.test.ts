// 0212 — DELIVERY-EVENTS-01, against a real database.
//
// What these cases pin, each with synthetic fixtures only (no provider, no
// network, no real address):
//
//   * REPLAY: a delivery id is recorded once; a retry or replay of it is
//     answered `duplicate` and is never applied twice, even when two workers
//     race the same receipt.
//   * ORDER: statuses only move forward, so every arrival order of the same
//     events ends in the same state; late, repeated and lower events are
//     `stale` and change nothing.
//   * CRASH RECOVERY: a receipt whose processing never ran, never finished or
//     failed mid-transaction stays pending, is found again by the sweep and is
//     applied exactly once; a receipt that keeps failing is quarantined after a
//     bounded number of attempts instead of retrying forever.
//   * TENANT ISOLATION: an event reaches a studio only through the ledger row
//     it matched. An event naming one studio's row but carrying another
//     message's id changes neither; unmatched, ignored and quarantined
//     receipts link to no studio; no browser role can read either table or
//     call any command.
//   * PROVIDER FAILURE: an ambiguous answer is resolved by the provider's own
//     report and is never allowed to overwrite one; refusals, bounces,
//     failures and suppressions are recorded as what they are, with reason
//     slugs and never the provider's free text.
//   * MINIMUM METADATA: neither table has anywhere to put an address, a
//     subject, a body or a payload.
//
// Signature rejection and the replay WINDOW are properties of the route, not
// the database: tests/lib/email/resend-webhook.test.ts and
// tests/app/api/resend-webhook.test.ts.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  adminTx,
  asRole,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
const emailId = () => randomUUID();
const deliveryId = () => `msg_${randomUUID().replace(/-/g, "")}`;

let A: SeededStudio;
let B: SeededStudio;
let apptA: string;
let apptB: string;

/** Every receipt a case creates, so no case leaves one pending for the next. */
const created: string[] = [];

let slot = 0;
async function seedAppointment(s: SeededStudio): Promise<string> {
  const hoursOut = 40 + slot++ * 2;
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
  A = await seedStudio("email-events-a");
  B = await seedStudio("email-events-b");
  apptA = await seedAppointment(A);
  apptB = await seedAppointment(B);
});

afterEach(async () => {
  // Finish anything a case left pending, so a later sweep never meets it.
  for (const id of created.splice(0)) {
    await q(`select * from public.process_email_provider_event($1)`, [id]);
  }
});

afterAll(async () => {
  await closePool();
});

type Ledger = {
  id: string;
  studio_id: string;
  status: string;
  provider_email_id: string | null;
  provider_error: string | null;
  bounce_type: string | null;
  provider_reason: string | null;
  complained_at: string | null;
  provider_status_at: string | null;
  skip_reason: string | null;
};

type Receipt = {
  id: string;
  processing_state: string;
  processing_result: string | null;
  processing_attempts: number;
  processing_claimed_at: string | null;
  email_message_id: string | null;
};

type Processed = {
  result: string;
  reason: string | null;
  message_id: string | null;
  message_studio_id: string | null;
  message_status: string | null;
};

async function begin(s: SeededStudio, appt: string, purpose = "appointment_reminder_24h"): Promise<string> {
  const r = await q<{ id: string | null }>(
    `select public.begin_appointment_email_message($1, $2, $3) as id`,
    [s.studioId, appt, purpose],
  );
  return r[0]!.id!;
}

async function settle(
  id: string,
  outcome: string,
  providerEmailId: string | null = null,
  providerError: string | null = null,
  skipReason: string | null = null,
): Promise<string> {
  const r = await q<{ r: string }>(
    `select public.settle_email_message($1, $2, $3, $4, $5) as r`,
    [id, outcome, providerEmailId, providerError, skipReason],
  );
  return r[0]!.r;
}

async function ledger(id: string): Promise<Ledger> {
  return (await q<Ledger>(`select * from public.email_outbound_messages where id = $1`, [id]))[0]!;
}

async function receiptRow(id: string): Promise<Receipt> {
  return (await q<Receipt>(`select * from public.email_provider_events where id = $1`, [id]))[0]!;
}

type EventInput = {
  type: string;
  emailId?: string | null;
  tag?: string | null;
  delivery?: string;
  at?: string | null;
  bounceType?: string | null;
  bounceSubtype?: string | null;
  failureReason?: string | null;
  suppressionType?: string | null;
};

async function record(e: EventInput): Promise<{ result: string; receipt_id: string | null; receipt_state: string | null }> {
  const r = await q<{ result: string; receipt_id: string | null; receipt_state: string | null }>(
    `select * from public.record_email_provider_event($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.delivery ?? deliveryId(),
      e.type,
      e.emailId ?? null,
      e.tag ?? null,
      e.at ?? null,
      e.bounceType ?? null,
      e.bounceSubtype ?? null,
      e.failureReason ?? null,
      e.suppressionType ?? null,
    ],
  );
  if (r[0]!.receipt_id && r[0]!.result === "recorded") created.push(r[0]!.receipt_id);
  return r[0]!;
}

async function claim(receiptId: string | null, limit: number | null = null): Promise<string[]> {
  const r = await q<{ receipt_id: string }>(`select * from public.claim_email_provider_events($1, $2)`, [
    receiptId,
    limit,
  ]);
  return r.map((x) => x.receipt_id);
}

async function processReceipt(id: string): Promise<Processed> {
  return (await q<Processed>(`select * from public.process_email_provider_event($1)`, [id]))[0]!;
}

/** What the route does with one verified delivery: record, claim, process. */
async function deliver(e: EventInput): Promise<Processed & { receiptId: string }> {
  const rec = await record(e);
  expect(rec.result).toBe("recorded");
  expect(await claim(rec.receipt_id)).toEqual([rec.receipt_id]);
  return { ...(await processReceipt(rec.receipt_id!)), receiptId: rec.receipt_id! };
}

/** An accepted attempt with a fresh provider email id. */
async function acceptedMessage(s: SeededStudio = A, appt: string = apptA): Promise<{ id: string; emailId: string }> {
  const id = await begin(s, appt);
  const e = emailId();
  expect(await settle(id, "accepted", e)).toBe("settled");
  return { id, emailId: e };
}

/** Move a receipt into the past. received_at is write-once by trigger, so the
 *  trigger is disabled for this one statement, inside one transaction, as the
 *  table owner -- the same deliberately noisy route seedLegacyRecordStatus takes. */
async function backdateReceived(id: string, seconds: number): Promise<void> {
  await adminTx(async (tx) => {
    await tx(`alter table public.email_provider_events disable trigger email_provider_events_identity_guard`);
    await tx(
      `update public.email_provider_events set received_at = now() - make_interval(secs => $2) where id = $1`,
      [id, seconds],
    );
    await tx(`alter table public.email_provider_events enable trigger email_provider_events_identity_guard`);
  });
}

async function backdateClaim(id: string, seconds: number): Promise<void> {
  await q(
    `update public.email_provider_events
        set processing_claimed_at = now() - make_interval(secs => $2)
      where id = $1`,
    [id, seconds],
  );
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

// ---------------------------------------------------------------------------

describe("privilege closure: no browser role reaches either table or any command", () => {
  const COMMANDS = [
    "public.begin_appointment_email_message(uuid, uuid, text)",
    "public.settle_email_message(uuid, text, text, text, text)",
    "public.record_email_provider_event(text, text, text, uuid, timestamptz, text, text, text, text)",
    "public.claim_email_provider_events(uuid, integer)",
    "public.process_email_provider_event(uuid)",
  ];
  const TRIGGERS = [
    "public.email_outbound_messages_server_timestamps()",
    "public.email_outbound_messages_identity_guard()",
    "public.email_provider_events_server_defaults()",
    "public.email_provider_events_identity_guard()",
  ];

  it("grants no table privilege to anon, authenticated or service_role", async () => {
    for (const table of ["public.email_outbound_messages", "public.email_provider_events"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await q<{ any: boolean }>(
          `select has_table_privilege($1, $2, 'select')
               or has_table_privilege($1, $2, 'insert')
               or has_table_privilege($1, $2, 'update')
               or has_table_privilege($1, $2, 'delete') as any`,
          [role, table],
        );
        expect(r[0]!.any, `${role} on ${table}`).toBe(false);
      }
    }
  });

  it("lets ONLY service_role execute the five commands, and nobody call a trigger function", async () => {
    for (const fn of COMMANDS) {
      for (const [role, expected] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
        const r = await q<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn]);
        expect(r[0]!.ok, `${role} execute ${fn}`).toBe(expected);
      }
    }
    for (const fn of TRIGGERS) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await q<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn]);
        expect(r[0]!.ok, `${role} execute ${fn}`).toBe(false);
      }
    }
  });

  it("keeps RLS on with no policy at all on either table", async () => {
    const r = await q<{ relname: string; relrowsecurity: boolean; policies: string }>(
      `select c.relname, c.relrowsecurity,
              (select count(*) from pg_policies p
                where p.schemaname = 'public' and p.tablename = c.relname)::text as policies
         from pg_class c
        where c.relnamespace = 'public'::regnamespace
          and c.relname in ('email_outbound_messages', 'email_provider_events')
        order by c.relname`,
    );
    expect(r).toEqual([
      { relname: "email_outbound_messages", relrowsecurity: true, policies: "0" },
      { relname: "email_provider_events", relrowsecurity: true, policies: "0" },
    ]);
  });

  it("refuses a signed-in studio owner, even for their own studio's rows", async () => {
    await acceptedMessage(A, apptA);
    await expect(
      asUser(A.userId, (query) => query(`select count(*) from public.email_outbound_messages where studio_id = $1`, [A.studioId])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(A.userId, (query) => query(`select count(*) from public.email_provider_events`)),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole("authenticated", (query) => query(`select * from public.process_email_provider_event($1)`, [randomUUID()])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole("anon", (query) =>
        query(`select * from public.record_email_provider_event('msg_x', 'email.sent', null, null, null, null, null, null, null)`),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the ledger: claim before the call, settle once", () => {
  it("creates a row only for the studio's own appointment and a known purpose", async () => {
    const id = await begin(A, apptA);
    const row = await ledger(id);
    expect(row).toMatchObject({ studio_id: A.studioId, status: "claimed", provider_email_id: null });

    const cross = await q<{ id: string | null }>(
      `select public.begin_appointment_email_message($1, $2, 'appointment_confirmation') as id`,
      [A.studioId, apptB],
    );
    expect(cross[0]!.id, "studio A cannot claim studio B's appointment").toBeNull();
    const badPurpose = await q<{ id: string | null }>(
      `select public.begin_appointment_email_message($1, $2, 'marketing_blast') as id`,
      [A.studioId, apptA],
    );
    expect(badPurpose[0]!.id).toBeNull();
  });

  it("settles a claimed row once, and answers a repeat by what it says", async () => {
    const id = await begin(A, apptA);
    const e = emailId();
    expect(await settle(id, "accepted", e)).toBe("settled");
    expect(await settle(id, "accepted", e)).toBe("already_settled");
    expect(await settle(id, "accepted", emailId())).toBe("not_claimed");
    expect(await settle(id, "refused", null, "validation_error")).toBe("not_claimed");
    expect((await ledger(id)).status).toBe("accepted");
  });

  it.each([
    ["accepted without an email id", ["accepted", null, null, null]],
    ["accepted with an id that is not the provider's shape", ["accepted", "fake-resend-message-id", null, null]],
    ["skipped without a reason", ["skipped", null, null, null]],
    ["a reason that is free text", ["skipped", null, null, "Opted out by phone"]],
    ["an error on a success", ["accepted", randomUUID(), "validation_error", null]],
    ["an outcome outside the vocabulary", ["delivered", null, null, null]],
  ] as const)("refuses %s", async (_label, [outcome, eid, err, skip]) => {
    const id = await begin(A, apptA);
    expect(await settle(id, outcome, eid, err, skip)).toBe("invalid_input");
    expect((await ledger(id)).status).toBe("claimed");
  });

  it("never lets two attempts share one provider message", async () => {
    const first = await acceptedMessage();
    const second = await begin(A, apptA);
    expect(await settle(second, "accepted", first.emailId)).toBe("id_conflict");
    expect((await ledger(second)).status).toBe("claimed");
  });

  it("keeps an attempt's identity write-once", async () => {
    const m = await acceptedMessage();
    await expect(
      q(`update public.email_outbound_messages set provider_email_id = $2 where id = $1`, [m.id, emailId()]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      q(`update public.email_outbound_messages set studio_id = $2 where id = $1`, [m.id, B.studioId]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("REPLAY: one delivery id, one receipt, applied at most once", () => {
  it("answers a retried or replayed delivery `duplicate`, with the first receipt", async () => {
    const m = await acceptedMessage();
    const delivery = deliveryId();
    const first = await record({ delivery, type: "email.delivered", emailId: m.emailId, tag: m.id });
    const again = await record({ delivery, type: "email.delivered", emailId: m.emailId, tag: m.id });
    expect(first).toMatchObject({ result: "recorded", receipt_state: "pending" });
    expect(again).toEqual({ result: "duplicate", receipt_id: first.receipt_id, receipt_state: "pending" });

    await claim(first.receipt_id);
    expect((await processReceipt(first.receipt_id!)).result).toBe("applied");
    const late = await record({ delivery, type: "email.bounced", emailId: m.emailId, tag: m.id });
    expect(late).toEqual({ result: "duplicate", receipt_id: first.receipt_id, receipt_state: "applied" });
    // The replayed delivery could not smuggle a different event in.
    expect((await ledger(m.id)).status).toBe("delivered");
    const count = await q<{ n: string }>(
      `select count(*)::text as n from public.email_provider_events where provider_event_id = $1`,
      [delivery],
    );
    expect(count[0]!.n).toBe("1");
  });

  it("never applies a receipt twice, even when two workers race it", async () => {
    const m = await acceptedMessage();
    const rec = await record({ type: "email.delivered", emailId: m.emailId, tag: m.id });
    const [x, y] = await Promise.all([processReceipt(rec.receipt_id!), processReceipt(rec.receipt_id!)]);
    expect([x.result, y.result].sort()).toEqual(["already_processed", "applied"]);
    expect((await processReceipt(rec.receipt_id!)).result).toBe("already_processed");
  });

  it("forces a fresh receipt to start pending, whatever the inserter claims", async () => {
    const r = await q<{ id: string; processing_state: string; processing_attempts: number; email_message_id: string | null }>(
      `insert into public.email_provider_events
         (provider_event_id, event_type, processing_state, processing_result, processing_attempts, processed_at)
       values ($1, 'email.sent', 'applied', 'status_advanced', 9, now())
       returning id, processing_state, processing_attempts, email_message_id`,
      [deliveryId()],
    );
    created.push(r[0]!.id);
    expect(r[0]).toMatchObject({ processing_state: "pending", processing_attempts: 0, email_message_id: null });
  });

  it("keeps a processed receipt's outcome write-once", async () => {
    const m = await acceptedMessage();
    const done = await deliver({ type: "email.delivered", emailId: m.emailId, tag: m.id });
    await expect(
      q(`update public.email_provider_events set processing_state = 'pending', processed_at = null, processing_result = null, email_message_id = null where id = $1`, [done.receiptId]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      q(`update public.email_provider_events set event_type = 'email.bounced' where id = $1`, [done.receiptId]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it.each([
    ["a delivery id with spaces", { delivery: "msg with spaces", type: "email.sent" }],
    ["a type that is not provider-shaped", { type: "Email Delivered" }],
    ["an email id that is not a uuid", { type: "email.sent", emailId: "fake-resend-message-id" }],
    ["a free-text reason", { type: "email.bounced", emailId: randomUUID(), bounceSubtype: "Mailbox full for a@b.c" }],
  ] as const)("refuses %s rather than storing it", async (_label, e) => {
    const r = await record(e as EventInput);
    expect(r).toEqual({ result: "invalid_input", receipt_id: null, receipt_state: null });
  });
});

describe("ORDER: every arrival order ends in the same state", () => {
  const ORDERS = permutations(["email.sent", "email.delivery_delayed", "email.delivered", "email.bounced"] as const);

  it(`applies all ${ORDERS.length} orders of sent/delayed/delivered/bounced to the same end: bounced`, async () => {
    for (const order of ORDERS) {
      const m = await acceptedMessage();
      const outcomes: string[] = [];
      for (const [i, type] of order.entries()) {
        const p = await deliver({
          type,
          emailId: m.emailId,
          tag: m.id,
          at: new Date(Date.UTC(2026, 9, 11, 18, 0, i)).toISOString(),
          bounceType: type === "email.bounced" ? "permanent" : null,
          bounceSubtype: type === "email.bounced" ? "general" : null,
        });
        outcomes.push(p.result);
        expect(p.message_id, order.join(" > ")).toBe(m.id);
        expect(p.message_studio_id).toBe(A.studioId);
      }
      const row = await ledger(m.id);
      expect(row.status, order.join(" > ")).toBe("bounced");
      expect(row).toMatchObject({ bounce_type: "permanent", provider_reason: "general" });
      expect(outcomes.every((o) => o === "applied" || o === "stale"), order.join(" > ")).toBe(true);
      // Once bounced arrives, nothing after it applies.
      expect(outcomes.slice(order.indexOf("email.bounced") + 1).every((o) => o === "stale")).toBe(true);
    }
  });

  it("ends delivered in every order of sent/delayed/delivered", async () => {
    for (const order of permutations(["email.sent", "email.delivery_delayed", "email.delivered"] as const)) {
      const m = await acceptedMessage();
      for (const type of order) await deliver({ type, emailId: m.emailId, tag: m.id });
      expect((await ledger(m.id)).status, order.join(" > ")).toBe("delivered");
    }
  });

  it("treats a late delay after delivery, and a repeat, as stale", async () => {
    const m = await acceptedMessage();
    const at = "2026-10-11T18:05:00.000Z";
    expect((await deliver({ type: "email.delivered", emailId: m.emailId, tag: m.id, at })).result).toBe("applied");
    const late = await deliver({ type: "email.delivery_delayed", emailId: m.emailId, tag: m.id, at: "2026-10-11T18:01:00.000Z" });
    expect(late).toMatchObject({ result: "stale", reason: "not_forward", message_status: "delivered" });
    expect((await deliver({ type: "email.delivered", emailId: m.emailId, tag: m.id })).result).toBe("stale");
    const row = await ledger(m.id);
    expect(row.status).toBe("delivered");
    expect(new Date(row.provider_status_at!).toISOString()).toBe(at);
  });

  it("records a complaint that arrives before its delivery, once, and the delivery it implies", async () => {
    const m = await acceptedMessage();
    expect(await deliver({ type: "email.complained", emailId: m.emailId, tag: m.id })).toMatchObject({
      result: "applied",
      reason: "complaint_recorded",
      message_status: "delivered",
    });
    expect((await deliver({ type: "email.delivered", emailId: m.emailId, tag: m.id })).result).toBe("stale");
    expect((await deliver({ type: "email.complained", emailId: m.emailId, tag: m.id })).reason).toBe("duplicate_complaint");
    const row = await ledger(m.id);
    expect(row.status).toBe("delivered");
    expect(row.complained_at).not.toBeNull();
  });

  it("never lets an open or a click change a status", async () => {
    const m = await acceptedMessage();
    for (const type of ["email.opened", "email.clicked"]) {
      expect(await deliver({ type, emailId: m.emailId, tag: m.id })).toMatchObject({
        result: "ignored",
        reason: "engagement_not_delivery",
        message_id: null,
        message_studio_id: null,
      });
    }
    expect((await ledger(m.id)).status).toBe("accepted");
  });
});

describe("CRASH RECOVERY: a receipt is finished exactly once, whatever stopped the first try", () => {
  it("finds a receipt whose request died before processing, but only once it is a minute old", async () => {
    const m = await acceptedMessage();
    const rec = await record({ type: "email.delivered", emailId: m.emailId, tag: m.id });
    // The route died here: recorded, never claimed or processed.
    expect(await claim(null, 50)).not.toContain(rec.receipt_id);

    await backdateReceived(rec.receipt_id!, 61);
    const swept = await claim(null, 50);
    expect(swept).toContain(rec.receipt_id);
    expect(await processReceipt(rec.receipt_id!)).toMatchObject({ result: "applied", message_status: "delivered" });
    expect(await claim(null, 50)).not.toContain(rec.receipt_id);
    expect((await receiptRow(rec.receipt_id!)).processing_attempts).toBe(1);
  });

  it("does not take a receipt another worker holds, until that claim goes stale", async () => {
    const m = await acceptedMessage();
    const rec = await record({ type: "email.sent", emailId: m.emailId, tag: m.id });
    await backdateReceived(rec.receipt_id!, 120);
    expect(await claim(rec.receipt_id)).toEqual([rec.receipt_id]);
    // The holder crashed mid-attempt. Its claim is still fresh:
    expect(await claim(null, 50)).not.toContain(rec.receipt_id);
    expect(await claim(rec.receipt_id)).toEqual([]);

    await backdateClaim(rec.receipt_id!, 121);
    expect(await claim(null, 50)).toContain(rec.receipt_id);
    expect((await processReceipt(rec.receipt_id!)).result).toBe("applied");
    expect((await receiptRow(rec.receipt_id!)).processing_attempts).toBe(2);
  });

  it("rolls a failed processing transaction back whole, leaving the receipt for the sweep", async () => {
    const m = await acceptedMessage();
    const rec = await record({ type: "email.delivered", emailId: m.emailId, tag: m.id });
    expect(await claim(rec.receipt_id)).toEqual([rec.receipt_id]);

    // Another transaction holds the ledger row, so this attempt times out
    // after locking the receipt.
    let locked!: () => void;
    let release!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const gate = new Promise<void>((r) => (release = r));
    const holder = adminTx(async (tx) => {
      await tx(`select 1 from public.email_outbound_messages where id = $1 for update`, [m.id]);
      locked();
      await gate;
    });
    await lockTaken;
    await expect(
      adminTx(async (tx) => {
        await tx(`set local lock_timeout = '200ms'`);
        await tx(`select * from public.process_email_provider_event($1)`, [rec.receipt_id]);
      }),
    ).rejects.toMatchObject({ code: "55P03" });
    release();
    await holder;

    expect(await receiptRow(rec.receipt_id!)).toMatchObject({
      processing_state: "pending",
      processing_result: null,
      email_message_id: null,
      processing_attempts: 1,
    });
    expect((await ledger(m.id)).status).toBe("accepted");

    await backdateReceived(rec.receipt_id!, 61);
    await backdateClaim(rec.receipt_id!, 121);
    expect(await claim(null, 50)).toContain(rec.receipt_id);
    expect((await processReceipt(rec.receipt_id!)).result).toBe("applied");
    expect((await ledger(m.id)).status).toBe("delivered");
  });

  it("quarantines a receipt after five attempts instead of retrying it forever", async () => {
    const m = await acceptedMessage();
    const rec = await record({ type: "email.delivered", emailId: m.emailId, tag: m.id });
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await claim(rec.receipt_id), `attempt ${attempt}`).toEqual([rec.receipt_id]);
      await backdateClaim(rec.receipt_id!, 121); // each attempt died
    }
    expect(await claim(rec.receipt_id)).toEqual([]);
    expect(await receiptRow(rec.receipt_id!)).toMatchObject({
      processing_state: "quarantined",
      processing_result: "processing_exhausted",
      processing_attempts: 5,
      email_message_id: null,
    });
    expect((await processReceipt(rec.receipt_id!)).result).toBe("already_processed");
    expect((await ledger(m.id)).status).toBe("accepted");
  });

  it("gives concurrent sweeps disjoint receipts", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const m = await acceptedMessage();
      const rec = await record({ type: "email.sent", emailId: m.emailId, tag: m.id });
      await backdateReceived(rec.receipt_id!, 90);
      ids.push(rec.receipt_id!);
    }
    const [x, y] = await Promise.all([claim(null, 50), claim(null, 50)]);
    const mine = (list: string[]) => list.filter((id) => ids.includes(id));
    expect(mine(x).filter((id) => mine(y).includes(id))).toEqual([]);
    expect([...mine(x), ...mine(y)].sort()).toEqual([...ids].sort());
  });
});

describe("TENANT ISOLATION: an event reaches a studio only through its own ledger row", () => {
  it("applies a tagged event to its row and reports that row's studio", async () => {
    const a = await acceptedMessage(A, apptA);
    const b = await acceptedMessage(B, apptB);
    expect(await deliver({ type: "email.delivered", emailId: a.emailId, tag: a.id })).toMatchObject({
      result: "applied",
      message_id: a.id,
      message_studio_id: A.studioId,
    });
    expect(await deliver({ type: "email.delivered", emailId: b.emailId })).toMatchObject({
      result: "applied",
      message_id: b.id,
      message_studio_id: B.studioId,
    });
  });

  it("refuses an event that names one studio's row but carries another message's id", async () => {
    const a = await acceptedMessage(A, apptA);
    const b = await acceptedMessage(B, apptB);
    const p = await deliver({ type: "email.bounced", emailId: b.emailId, tag: a.id, bounceType: "permanent" });
    expect(p).toMatchObject({ result: "quarantined", reason: "email_id_mismatch", message_id: null, message_studio_id: null });
    expect((await ledger(a.id)).status).toBe("accepted");
    expect((await ledger(b.id)).status).toBe("accepted");
    expect((await receiptRow(p.receiptId)).email_message_id).toBeNull();
  });

  it("keeps events it cannot attribute platform-only", async () => {
    const unknownTag = await deliver({ type: "email.delivered", emailId: emailId(), tag: randomUUID() });
    expect(unknownTag).toMatchObject({ result: "unmatched", reason: "unmatched_tag", message_studio_id: null });
    const unknownId = await deliver({ type: "email.delivered", emailId: emailId() });
    expect(unknownId).toMatchObject({ result: "unmatched", reason: "unmatched_email_id", message_studio_id: null });
    const unknownType = await deliver({ type: "inbox.thread.created" });
    expect(unknownType).toMatchObject({ result: "quarantined", reason: "unknown_event_type" });
    const noId = await deliver({ type: "email.delivered", tag: (await acceptedMessage()).id });
    expect(noId).toMatchObject({ result: "quarantined", reason: "missing_email_id", message_studio_id: null });

    const linked = await q<{ n: string }>(
      `select count(*)::text as n
         from public.email_provider_events e
        where e.id = any($1::uuid[])
          and e.email_message_id is not null`,
      [[unknownTag.receiptId, unknownId.receiptId, unknownType.receiptId, noId.receiptId]],
    );
    expect(linked[0]!.n).toBe("0");
  });

  it("refuses an event for an attempt Hone recorded as never sent", async () => {
    const skipped = await begin(A, apptA);
    expect(await settle(skipped, "skipped", null, null, "opted_out")).toBe("settled");
    const p = await deliver({ type: "email.delivered", emailId: emailId(), tag: skipped });
    expect(p).toMatchObject({ result: "quarantined", reason: "not_sent", message_studio_id: null });
    expect((await ledger(skipped)).status).toBe("skipped");
  });

  it("refuses to adopt an email id another attempt already holds", async () => {
    const owner = await acceptedMessage(A, apptA);
    const claimed = await begin(B, apptB);
    const p = await deliver({ type: "email.delivered", emailId: owner.emailId, tag: claimed });
    expect(p).toMatchObject({ result: "quarantined", reason: "email_id_conflict" });
    expect(await ledger(claimed)).toMatchObject({ status: "claimed", provider_email_id: null });
  });
});

describe("PROVIDER FAILURE: answers are recorded for what they are", () => {
  it("resolves an ambiguous send from the provider's own report, and never the reverse", async () => {
    const id = await begin(A, apptA);
    expect(await settle(id, "unknown", null, "timeout")).toBe("settled");
    const e = emailId();
    // The send DID reach the provider: its event names our row by tag.
    expect(await deliver({ type: "email.sent", emailId: e, tag: id })).toMatchObject({ result: "applied", message_status: "sent" });
    expect(await ledger(id)).toMatchObject({ status: "sent", provider_email_id: e, provider_error: "timeout" });
    // A second ambiguous answer, or the retry's real one, changes nothing.
    expect(await settle(id, "unknown", null, "network_error")).toBe("already_settled");
    expect(await settle(id, "accepted", e)).toBe("already_settled");
  });

  it("lets a retry under the same idempotency key turn unknown into accepted", async () => {
    const id = await begin(A, apptA);
    expect(await settle(id, "unknown", null, "timeout")).toBe("settled");
    const e = emailId();
    expect(await settle(id, "accepted", e)).toBe("settled");
    expect(await ledger(id)).toMatchObject({ status: "accepted", provider_email_id: e });
  });

  it("records a refusal with its error slug, and no later event can turn it into a send", async () => {
    const id = await begin(A, apptA);
    expect(await settle(id, "refused", null, "validation_error")).toBe("settled");
    expect(await ledger(id)).toMatchObject({ status: "refused", provider_error: "validation_error" });
    expect((await deliver({ type: "email.delivered", emailId: emailId(), tag: id })).reason).toBe("not_sent");
  });

  it.each([
    ["email.failed", { failureReason: "reached_daily_quota" }, { status: "failed", provider_reason: "reached_daily_quota", bounce_type: null }],
    ["email.suppressed", { suppressionType: "on_account_suppression_list" }, { status: "suppressed", provider_reason: "on_account_suppression_list", bounce_type: null }],
    // A PERMANENT bounce records its reason slug. A transient bounce is not
    // terminal since 0227 (Codex P2 4265450918): it is recorded as
    // delivery_delayed -- see tests/db/email-receipt-quarantine-bound.db.test.ts.
    ["email.bounced", { bounceType: "permanent", bounceSubtype: "general" }, { status: "bounced", provider_reason: "general", bounce_type: "permanent" }],
  ] as const)("records %s with its reason slug", async (type, extra, expected) => {
    const m = await acceptedMessage();
    await deliver({ type: "email.delivery_delayed", emailId: m.emailId, tag: m.id });
    expect((await deliver({ type, emailId: m.emailId, tag: m.id, ...extra })).result).toBe("applied");
    expect(await ledger(m.id)).toMatchObject(expected);
  });
});

describe("MINIMUM METADATA: nowhere to put an address, a subject or a payload", () => {
  it("pins both tables' columns exactly", async () => {
    const cols = async (table: string) =>
      (
        await q<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = $1 order by column_name`,
          [table],
        )
      ).map((r) => r.column_name);
    expect(await cols("email_outbound_messages")).toEqual(
      [
        "appointment_id", "bounce_type", "claimed_at", "complained_at", "created_at", "id", "provider_email_id",
        "provider_error", "provider_reason", "provider_status_at", "purpose", "settled_at", "skip_reason", "status",
        "studio_id", "updated_at",
      ].sort(),
    );
    expect(await cols("email_provider_events")).toEqual(
      [
        "bounce_subtype", "bounce_type", "email_message_id", "event_type", "failure_reason", "hone_message_id", "id",
        "processed_at", "processing_attempts", "processing_claimed_at", "processing_result", "processing_state",
        "provider", "provider_created_at", "provider_email_id", "provider_event_id", "received_at", "suppression_type",
      ].sort(),
    );
  });
});
