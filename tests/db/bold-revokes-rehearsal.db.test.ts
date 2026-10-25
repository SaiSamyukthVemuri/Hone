// REHEARSAL - NEVER MERGE. BOLD-REVOKES (Insurance lane, closes M-5).
//
// Runs the B-OLD application code (production 9488913d, unchanged) against a
// database at 0246 (migrations 0213-0246 from #1035 head 4f5143f3, 0214 =
// a8bdcefe). For every payment write B-OLD can still attempt between S1 and S3 it
// records the outcome: refused (exact error, nothing partially written),
// succeeded, or partial. Synthetic data only; fake Stripe (no provider call).
//
// This test never fails on a B-OLD refusal: refusals are the DATA. It fails only
// when its own harness is wrong (a seed error), so a misleading "refused" can
// never be a harness mistake. Results are printed as BOLD_REVOKES_RESULT lines.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asUser, closePool } from "./helpers/harness";
import { seedEligibleQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const WEBHOOK_SECRET = "whsec_rehearsal_synthetic";
const RUN_ID = `rehearsal-bold-${randomUUID().slice(0, 8)}`;

// The webhook arms that call Stripe (paymentMethods.retrieve, accounts.retrieve)
// get a synthetic client: no network, no provider call. Everything else in
// lib/stripe/server is the real module.
const sig = new Stripe("sk_test_dummy_synthetic");
vi.mock("@/lib/stripe/server", async (orig) => {
  const real = await orig<typeof import("@/lib/stripe/server")>();
  const client = {
    webhooks: new Stripe("sk_test_dummy_synthetic").webhooks,
    paymentMethods: {
      retrieve: async (id: string) => ({
        id,
        object: "payment_method",
        type: "card",
        card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030, funding: "credit", country: "CA" },
      }),
    },
    accounts: {
      retrieve: async (id: string) => ({
        id,
        object: "account",
        country: "CA",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        requirements: { currently_due: [], past_due: [], disabled_reason: null },
        capabilities: { card_payments: "active", transfers: "active" },
      }),
    },
  };
  return { ...real, getStripe: () => client as unknown as Stripe };
});

const saved = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  sk: process.env.STRIPE_SECRET_KEY,
  wh: process.env.STRIPE_WEBHOOK_SECRET,
  fake: process.env.HONE_E2E_FAKE_STRIPE,
  run: process.env.HONE_E2E_RUN_ID,
};
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy_synthetic";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.HONE_E2E_FAKE_STRIPE = "1";
  process.env.HONE_E2E_RUN_ID = RUN_ID;
});
afterAll(async () => {
  for (const [k, v] of Object.entries({
    NEXT_PUBLIC_SUPABASE_URL: saved.url,
    SUPABASE_SERVICE_ROLE_KEY: saved.key,
    STRIPE_SECRET_KEY: saved.sk,
    STRIPE_WEBHOOK_SECRET: saved.wh,
    HONE_E2E_FAKE_STRIPE: saved.fake,
    HONE_E2E_RUN_ID: saved.run,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await closePool();
  console.log("BOLD_REVOKES_SUMMARY " + JSON.stringify(summarise()));
});

type Outcome = "refused" | "succeeded" | "partial" | "no_effect" | "harness_error";
type Result = { scenario: string; id: string; write: string; outcome: Outcome; detail: Record<string, unknown> };
const results: Result[] = [];
function rec(scenario: string, id: string, write: string, outcome: Outcome, detail: Record<string, unknown> = {}) {
  const r = { scenario, id, write, outcome, detail };
  results.push(r);
  console.log("BOLD_REVOKES_RESULT " + JSON.stringify(r));
}
function summarise() {
  const by: Record<string, number> = {};
  for (const r of results) by[r.outcome] = (by[r.outcome] ?? 0) + 1;
  return by;
}
const clip = (s: unknown) => String(s ?? "").slice(0, 220);

type Caught = { ok: true; value: unknown } | { ok: false; code: string; message: string };
async function attempt(fn: () => Promise<unknown>): Promise<Caught> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? "", message: clip(err.message) };
  }
}

// A refusal that is B-OLD meeting the 0214 / 0239 / 0245 database, as opposed to
// a mistake in this harness.
const DB_REFUSAL = /payment_jurisdiction_missing|payment_currency_mismatch|payment_account_country|permission denied|42501/i;

// ---- fake Stripe ledger --------------------------------------------------
async function ledger() {
  const { getFakeStripeCalls } = await import("@/lib/stripe/e2e-fake-stripe");
  return getFakeStripeCalls().map((c) => `${(c as { method?: string }).method ?? "?"}`);
}
const count = (calls: string[], needle: string) => calls.filter((m) => m.includes(needle)).length;

// ---- DB helpers ----------------------------------------------------------
async function attemptRow(id: string) {
  const r = await adminQuery(
    `select status, stripe_payment_intent_id as pi, stripe_charge_id as ch, charged_at is not null as charged,
            refund_status, stripe_refund_id as refund_id, failure_code
       from public.payment_charge_attempts where id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}
async function eventRow(eventId: string) {
  const r = await adminQuery(
    `select processed_at is not null as processed, processing_claim_token is not null as claimed, error
       from public.stripe_events where stripe_event_id = $1`,
    [eventId],
  );
  return r.rows[0] ?? null;
}

async function setJurisdiction(studioId: string, country: "CA" | "US") {
  await adminQuery(
    `insert into public.studio_payment_jurisdictions
       (studio_id, payment_country, payment_currency, source, verification_reference)
     values ($1,$2,$3,'operator','REHEARSAL-SYNTHETIC')`,
    [studioId, country, country === "CA" ? "cad" : "usd"],
  );
}

// An attempt that already existed before S1 (so the 0214 insert guard never saw
// it): inserted with ONLY that trigger disabled, inside one transaction.
async function legacyAttempt(sc: PaymentScenario, reason: "session_payment" | "no_show_fee", status: "ready" | "pending_stripe", pi: string | null) {
  const card = await adminQuery(
    `select id, stripe_account_id, stripe_customer_id, stripe_payment_method_id,
            card_authorization_signature_id as sig
       from public.client_payment_methods where studio_id=$1 and client_id=$2 and status='active' limit 1`,
    [sc.studioId, sc.clientId],
  );
  const c = card.rows[0];
  if (!c) throw new Error("harness: seeded scenario has no active card");
  let appointmentId = sc.appointmentId;
  let sessionId: string | null = sc.sessionId ?? null;
  if (reason === "no_show_fee") {
    appointmentId = await newAppointment(sc);
    sessionId = null;
  }
  return adminTx(async (q) => {
    await q(`alter table public.payment_charge_attempts disable trigger payment_charge_attempts_jurisdiction_guard`);
    const r = await q(
      `insert into public.payment_charge_attempts
         (studio_id, charge_reason, client_id, session_id, appointment_id, created_by_practitioner_id,
          amount_cents, currency, status, stripe_livemode, client_payment_method_id,
          card_authorization_signature_id, stripe_account_id, stripe_customer_id,
          stripe_payment_method_id, stripe_payment_intent_id)
       values ($1,$2,$3,$4,$5,$6,$7,'cad',$8,false,$9,$10,$11,$12,$13,$14) returning id`,
      [sc.studioId, reason, sc.clientId, sessionId, appointmentId, sc.practitionerId,
       reason === "session_payment" ? sc.expectedAmountMinor : 5000, status, c.id, c.sig,
       c.stripe_account_id, c.stripe_customer_id, c.stripe_payment_method_id, pi],
    );
    await q(`alter table public.payment_charge_attempts enable trigger payment_charge_attempts_jurisdiction_guard`);
    return r.rows[0].id as string;
  });
}

let slot = 0;
async function newAppointment(sc: PaymentScenario): Promise<string> {
  slot += 1;
  const base = Date.now() - (slot + 3) * 2 * 3_600_000;
  const r = await adminQuery(
    `insert into public.appointments
       (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3,$4,$5,60,'completed') returning id`,
    [sc.studioId, sc.practitionerId, sc.clientId,
     new Date(base - 3_600_000).toISOString(), new Date(base).toISOString()],
  );
  return r.rows[0].id;
}

// B-OLD's prepare insert for a session payment (payment-actions.ts): currency is
// the literal "cad".
async function prepareSession(sc: PaymentScenario, ccy = "cad") {
  const card = await adminQuery(
    `select id, stripe_account_id, stripe_customer_id, stripe_payment_method_id, card_authorization_signature_id as sig
       from public.client_payment_methods where studio_id=$1 and client_id=$2 and status='active' limit 1`,
    [sc.studioId, sc.clientId],
  );
  const c = card.rows[0];
  const appt = await newAppointment(sc);
  const sess = await adminQuery(
    `insert into public.sessions
       (studio_id, client_id, practitioner_id, performed_by_practitioner_id, modality, appointment_id, started_at, price_paid_cents)
     values ($1,$2,$3,$3,'electrolysis',$4,now(),$5) returning id`,
    [sc.studioId, sc.clientId, sc.practitionerId, appt, sc.expectedAmountMinor],
  );
  return attempt(async () => {
    const r = await adminQuery(
      `insert into public.payment_charge_attempts
         (studio_id, charge_reason, client_id, appointment_id, session_id, created_by_practitioner_id,
          amount_cents, currency, status, client_payment_method_id, card_authorization_signature_id,
          stripe_account_id, stripe_customer_id, stripe_payment_method_id, stripe_livemode)
       values ($1,'session_payment',$2,$3,$4,$5,$6,$7,'ready',$8,$9,$10,$11,$12,false) returning id`,
      [sc.studioId, sc.clientId, appt, sess.rows[0].id, sc.practitionerId, sc.expectedAmountMinor, ccy,
       c.id, c.sig, c.stripe_account_id, c.stripe_customer_id, c.stripe_payment_method_id],
    );
    return r.rows[0].id as string;
  });
}

// B-OLD's manual-fee prepare insert (manual-fee-actions.ts), minimal legal shape.
async function prepareFee(sc: PaymentScenario) {
  const appt = await newAppointment(sc);
  return attempt(async () => {
    const r = await adminQuery(
      `insert into public.payment_charge_attempts
         (studio_id, charge_reason, client_id, appointment_id, created_by_practitioner_id,
          amount_cents, currency, status, stripe_livemode)
       values ($1,'no_show_fee',$2,$3,$4,5000,'cad','ready',false) returning id`,
      [sc.studioId, sc.clientId, appt, sc.practitionerId],
    );
    return r.rows[0].id as string;
  });
}

// ---- webhook -------------------------------------------------------------
async function deliver(type: string, object: Record<string, unknown>, account: string) {
  const { POST } = await import("@/app/api/stripe/webhook/route");
  const eventId = `evt_rehearsal_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    type,
    account,
    livemode: false,
    data: { object },
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  });
  const header = sig.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const res = await POST(new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  }));
  let body: unknown = null;
  try { body = await res.json(); } catch { /* none */ }
  return { eventId, status: res.status, body: clip(JSON.stringify(body)) };
}

async function acctOf(sc: PaymentScenario): Promise<string> {
  const r = await adminQuery(`select stripe_account_id as a from public.studio_payment_settings where studio_id=$1 limit 1`, [sc.studioId]);
  return r.rows[0].a as string;
}

// ---- scenario ------------------------------------------------------------
async function scenario(name: string, jur: null | "CA" | "US") {
  const S = name;
  const sc = await seedEligibleQuickCheckoutScenario({ label: name.toLowerCase() });
  if (jur) await setJurisdiction(sc.studioId, jur);
  const account = await acctOf(sc);

  // W1 session charge prepare (quick checkout and the session page share it)
  const p1 = await prepareSession(sc);
  if (p1.ok) rec(S, "W1", "session charge prepare (INSERT attempt, currency cad)", "succeeded", { attemptId: "<id>" });
  else rec(S, "W1", "session charge prepare (INSERT attempt, currency cad)", DB_REFUSAL.test(p1.message) ? "refused" : "harness_error", { code: p1.code, error: p1.message });

  // W2 manual fee prepare
  const f1 = await prepareFee(sc);
  if (f1.ok) rec(S, "W2", "manual fee prepare (INSERT attempt)", "succeeded", {});
  else rec(S, "W2", "manual fee prepare (INSERT attempt)", DB_REFUSAL.test(f1.message) ? "refused" : "harness_error", { code: f1.code, error: f1.message });

  // W3 settlements: record cash, waive, supersede (authenticated owner, as PostgREST would)
  for (const [id, label, sql, args] of [
    ["W3a", "settlement record (paid_cash)", `select * from public.record_appointment_settlement($1,$2,'paid_cash',$3,null,false)`, null],
    ["W3b", "settlement waive", `select * from public.waive_appointment_fee($1,$2,$3,null,false)`, null],
  ] as const) {
    void args;
    const appt = await newAppointment(sc);
    const r = await attempt(() => asUser(sc.practitionerUserId, (q) => q(sql, [sc.studioId, appt, 5000])));
    if (r.ok) {
      const row = ((r.value as { rows: Array<Record<string, unknown>> }).rows[0] ?? {});
      const written = await adminQuery(`select count(*)::int as n from public.appointment_settlements where appointment_id=$1`, [appt]);
      rec(S, id, label, written.rows[0].n > 0 ? "succeeded" : "no_effect", { result: row.result ?? null, rows: written.rows[0].n });
    } else {
      const written = await adminQuery(`select count(*)::int as n from public.appointment_settlements where appointment_id=$1`, [appt]);
      rec(S, id, label, DB_REFUSAL.test(r.message) ? (written.rows[0].n === 0 ? "refused" : "partial") : "harness_error", { code: r.code, error: r.message, rows: written.rows[0].n });
    }
  }
  {
    // supersede needs an existing settlement; exists only when W3a succeeded.
    const appt = await newAppointment(sc);
    const first = await attempt(() => asUser(sc.practitionerUserId, (q) => q(`select * from public.record_appointment_settlement($1,$2,'paid_cash',5000,null,false)`, [sc.studioId, appt])));
    if (first.ok) {
      const sid = (await adminQuery(`select id from public.appointment_settlements where appointment_id=$1 order by recorded_at desc limit 1`, [appt])).rows[0]?.id;
      const r = await attempt(() => asUser(sc.practitionerUserId, (q) => q(`select * from public.supersede_appointment_settlement($1,$2,'paid_e_transfer',5000,'rehearsal',null,false)`, [sc.studioId, sid])));
      rec(S, "W3c", "settlement supersede", r.ok ? "succeeded" : DB_REFUSAL.test(r.message) ? "refused" : "harness_error", r.ok ? {} : { code: r.code, error: r.message });
    } else {
      rec(S, "W3c", "settlement supersede", "no_effect", { reason: "no settlement could be recorded first", firstError: first.message });
    }
  }

  // W4 execute an attempt (quick checkout / session charge / manual fee charge)
  let chargedId: string | null = null;
  const toRun: Array<[string, string, string | null]> = [];
  if (p1.ok) toRun.push(["W4a", "session charge execute (prepared under 0246)", p1.value as string]);
  if (!jur) {
    const legacy = await legacyAttempt(sc, "session_payment", "ready", null);
    toRun.push(["W4b", "session charge execute (attempt prepared BEFORE S1)", legacy]);
    const legacyFee = await legacyAttempt(sc, "no_show_fee", "ready", null);
    toRun.push(["W4c", "manual fee charge execute (attempt prepared BEFORE S1)", legacyFee]);
  }
  for (const [id, label, attemptId] of toRun) {
    if (!attemptId) continue;
    const before = await ledger();
    const { runSessionPaymentCharge } = await import("@/lib/billing/session-payment-charge");
    const r = await attempt(() => runSessionPaymentCharge({ attemptId, studioId: sc.studioId, practitionerId: sc.practitionerId }));
    const after = await ledger();
    const row = await attemptRow(attemptId);
    const piCreated = count(after, "paymentIntents") - count(before, "paymentIntents");
    const consistent = piCreated === 0 || (row && row.pi && (row.status === "succeeded" || row.status === "pending_stripe" || row.status === "failed"));
    const outcome: Outcome = !r.ok ? "harness_error"
      : piCreated > 0 && !consistent ? "partial"
      : (r.value as { ok?: boolean }).ok ? "succeeded" : "refused";
    rec(S, id, label, outcome, {
      result: clip(JSON.stringify(r.ok ? r.value : r)), fakeStripeCalls: after.length - before.length, fakePaymentIntents: piCreated, row,
    });
    if (row?.status === "succeeded" && row.pi && !chargedId) chargedId = attemptId;
  }

  // W5 success webhook for a charged attempt; W6 refund; W7 charge.refunded webhook
  if (chargedId) {
    const row = await attemptRow(chargedId);
    const { eventId, status, body } = await deliver("payment_intent.succeeded", {
      id: row.pi, object: "payment_intent", status: "succeeded", amount: sc.expectedAmountMinor, currency: "cad",
      latest_charge: row.ch ?? `ch_rehearsal_${randomUUID().slice(0, 8)}`,
      metadata: { hone_session_payment_charge_attempt_id: chargedId, hone_studio_id: sc.studioId, hone_client_id: sc.clientId, hone_environment: "test" },
    }, account);
    const ev = await eventRow(eventId);
    rec(S, "W5", "payment_intent.succeeded webhook", status === 500 ? "refused" : "succeeded", { http: status, body, event: ev, attemptAfter: await attemptRow(chargedId) });

    const { refundPaymentChargeAttempt } = await import("@/lib/billing/payment-refund");
    const before = await ledger();
    const rr = await attempt(() => refundPaymentChargeAttempt({ attemptId: chargedId!, studioId: sc.studioId, practitionerId: sc.practitionerId, internalNote: null }));
    const after = await ledger();
    const rrow = await attemptRow(chargedId);
    const refunds = count(after, "refunds") - count(before, "refunds");
    const consistent = refunds === 0 || (rrow?.refund_id && rrow.refund_status);
    rec(S, "W6", "refund (refundPaymentChargeAttempt)", !rr.ok ? "harness_error" : refunds > 0 && !consistent ? "partial" : (rr.value as { ok?: boolean }).ok ? "succeeded" : "refused",
      { result: clip(JSON.stringify(rr.ok ? rr.value : rr)), fakeRefunds: refunds, row: rrow });

    const refundObj = { id: rrow?.refund_id ?? `re_rehearsal_${randomUUID().slice(0, 8)}`, object: "refund", amount: sc.expectedAmountMinor, status: "succeeded", payment_intent: row.pi, charge: row.ch };
    const cr = await deliver("charge.refunded", {
      id: row.ch ?? "ch_rehearsal", object: "charge", amount: sc.expectedAmountMinor, amount_refunded: sc.expectedAmountMinor, currency: "cad",
      refunded: true, payment_intent: row.pi, refunds: { object: "list", data: [refundObj] },
      metadata: { hone_studio_id: sc.studioId },
    }, account);
    rec(S, "W7", "charge.refunded webhook (direct writer)", cr.status === 500 ? "refused" : "succeeded", { http: cr.status, body: cr.body, event: await eventRow(cr.eventId), attemptAfter: await attemptRow(chargedId) });
  } else {
    rec(S, "W5", "payment_intent.succeeded webhook", "no_effect", { reason: "no charge executed in this scenario" });
    rec(S, "W6", "refund (refundPaymentChargeAttempt)", "no_effect", { reason: "no charged attempt" });
    rec(S, "W7", "charge.refunded webhook (direct writer)", "no_effect", { reason: "no charged attempt" });
  }

  // W8 payment_failed webhook on a pending attempt (direct writer)
  if (!jur) {
    const pi = `pi_rehearsal_failed_${randomUUID().slice(0, 8)}`;
    const failing = await legacyAttempt(sc, "no_show_fee", "pending_stripe", pi);
    const d = await deliver("payment_intent.payment_failed", {
      id: pi, object: "payment_intent", status: "requires_payment_method", amount: 5000, currency: "cad",
      last_payment_error: { code: "card_declined", message: "synthetic" },
      metadata: { hone_session_payment_charge_attempt_id: failing, hone_studio_id: sc.studioId, hone_client_id: sc.clientId, hone_environment: "test" },
    }, account);
    rec(S, "W8", "payment_intent.payment_failed webhook (direct writer)", d.status === 500 ? "refused" : "succeeded", { http: d.status, body: d.body, event: await eventRow(d.eventId), attemptAfter: await attemptRow(failing) });
  }

  // W9 setup_intent.succeeded webhook (saved card)
  {
    const cust = await adminQuery(`select stripe_customer_id as c from public.client_stripe_customers where client_id=$1 limit 1`, [sc.clientId]);
    const sigId = (await adminQuery(`select id from public.client_consent_signatures where client_id=$1 order by template_version desc limit 1`, [sc.clientId])).rows[0].id;
    const before = (await adminQuery(`select id, status from public.client_payment_methods where client_id=$1 order by created_at`, [sc.clientId])).rows;
    const siId = `seti_rehearsal_${randomUUID().slice(0, 8)}`;
    const d = await deliver("setup_intent.succeeded", {
      id: siId, object: "setup_intent", status: "succeeded", customer: cust.rows[0].c, payment_method: `pm_rehearsal_${randomUUID().slice(0, 8)}`,
      metadata: { hone_studio_id: sc.studioId, hone_client_id: sc.clientId, hone_card_authorization_signature_id: sigId },
    }, account);
    const after = (await adminQuery(`select id, status from public.client_payment_methods where client_id=$1 order by created_at`, [sc.clientId])).rows;
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    rec(S, "W9", "setup_intent.succeeded webhook (save card)", d.status === 500 && unchanged ? "refused" : d.status === 500 ? "partial" : "succeeded",
      { http: d.status, body: d.body, event: await eventRow(d.eventId), cardsBefore: before.length, cardsAfter: after.length, activeCardUnchanged: unchanged });
  }

  // W10 Connect account provisioning claim for a studio with no account yet
  {
    const fresh = await adminQuery(`select id from public.studios where id=$1`, [sc.studioId]);
    void fresh;
    const { seedStudio } = await import("./helpers/harness");
    const st = await seedStudio(`${name.toLowerCase()}-prov`);
    if (jur) await setJurisdiction(st.studioId, jur);
    const r = await attempt(async () => {
      const { createAdminClient } = await import("@/lib/supabase/admin-server");
      const { data, error } = await createAdminClient().rpc("create_or_claim_stripe_account_provisioning", { p_studio_id: st.studioId, p_stripe_livemode: false });
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return data;
    });
    const rows = (await adminQuery(`select count(*)::int as n from public.stripe_account_provisioning_attempts where studio_id=$1`, [st.studioId])).rows[0].n;
    rec(S, "W10", "Connect account provisioning claim (onboarding start)", r.ok ? "succeeded" : DB_REFUSAL.test(r.message) ? (rows === 0 ? "refused" : "partial") : "harness_error", r.ok ? { rows } : { code: r.code, error: r.message, rows });
  }

  // W11 customer provisioning claim + complete (portal card setup, step 1)
  {
    const extra = (await adminQuery(`insert into public.clients (id, studio_id, name) values (gen_random_uuid(), $1, 'Client extra') returning id`, [sc.studioId])).rows[0].id;
    const r = await attempt(async () => {
      const { createAdminClient } = await import("@/lib/supabase/admin-server");
      const admin = createAdminClient();
      const { data, error } = await admin.rpc("create_or_claim_stripe_customer_provisioning", { p_client_id: extra, p_studio_id: sc.studioId, p_stripe_account_id: account, p_stripe_livemode: false });
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      const claim = Array.isArray(data) ? data[0] : data;
      const done = await admin.rpc("complete_stripe_customer_provisioning", { p_attempt_id: claim.attempt_id, p_claim_token: claim.out_processing_claim_token, p_stripe_customer_id: `cus_rehearsal_${randomUUID().slice(0, 8)}` });
      if (done.error) throw Object.assign(new Error(done.error.message), { code: done.error.code });
      return "completed";
    });
    rec(S, "W11", "customer provisioning claim+complete (card setup step 1)", r.ok ? "succeeded" : DB_REFUSAL.test(r.message) ? "refused" : "harness_error", r.ok ? {} : { code: r.code, error: r.message });
  }

  // W12 account.updated / dispute webhooks (not revoked)
  {
    const d = await deliver("account.updated", { id: account, object: "account", country: "CA", charges_enabled: true, payouts_enabled: true, details_submitted: true }, account);
    rec(S, "W12", "account.updated webhook (status sync)", d.status === 500 ? "refused" : "succeeded", { http: d.status, body: d.body, event: await eventRow(d.eventId) });
    const x = await deliver("charge.dispute.created", { id: `dp_rehearsal_${randomUUID().slice(0, 8)}`, object: "dispute", amount: 5000, currency: "cad", charge: "ch_rehearsal_dispute", reason: "fraudulent", status: "needs_response" }, account);
    rec(S, "W13", "charge.dispute.created webhook (alert only)", x.status === 500 ? "refused" : "succeeded", { http: x.status, body: x.body, event: await eventRow(x.eventId) });
  }
}

describe("BOLD-REVOKES: B-OLD 9488913d against the 0246 database", () => {
  it("SA: studio with NO payment jurisdiction row (S1 done, S2 not yet)", async () => {
    await scenario("SA", null);
    expect(results.filter((r) => r.scenario === "SA" && r.outcome === "harness_error")).toEqual([]);
  }, 180_000);
  it("SB: studio initialised CA/cad at S2, still served by B-OLD", async () => {
    await scenario("SB", "CA");
    expect(results.filter((r) => r.scenario === "SB" && r.outcome === "harness_error")).toEqual([]);
  }, 180_000);
  it("SC: studio initialised US/usd at S2, still served by B-OLD (B-OLD hard-codes cad)", async () => {
    await scenario("SC", "US");
    expect(results.filter((r) => r.scenario === "SC" && r.outcome === "harness_error")).toEqual([]);
  }, 180_000);
});
