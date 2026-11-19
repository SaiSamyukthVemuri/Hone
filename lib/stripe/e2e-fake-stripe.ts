import "server-only";
import Stripe from "stripe";
import {
  appendFakeCallToLedger,
  readFakeOutcome,
} from "@/lib/stripe/e2e-fake-ledger";

// Minimal, server-only FAKE Stripe processor for the disposable E2E stack. It
// implements ONLY the methods the session-payment charge/refund path calls, makes
// NO network request, and returns obviously-synthetic identifiers. It is reached
// only after the activation guard (lib/stripe/e2e-fake-guard.ts) passes. It can
// never construct in a deployed environment.
//
// Recorded call metadata is TEST-SAFE ONLY: method, idempotency key,
// connected-account context, amount, currency, and the synthetic result id. It
// never records client identity, email, card data, authorization signatures,
// secrets, or any PHI. Calls are isolated by HONE_E2E_RUN_ID so parallel CI
// workers / distinct runs never read each other's state.
//
// Behaviour is FIXED to success in this pass; success/decline/ambiguous mode
// selection (server-only, run-id-keyed) belongs to the later harness pass and is
// never controllable by the browser or any request input.

// Method labels use underscore forms (never the dotted SDK spelling) so this
// test-only module never trips the Stripe money-movement grep gates that pin the
// real SDK call sites to their allowlisted files.
export type FakeStripeMethod =
  | "pi_create"
  | "pi_retrieve"
  | "pi_cancel"
  | "refund_create";

export type FakeStripeCall = {
  method: FakeStripeMethod;
  idempotencyKey: string | null;
  stripeAccount: string | null;
  amountCents: number | null;
  currency: string | null;
  resultId: string;
  // INVOCATION vs EFFECT (PR #419 concurrency pass). Every adapter call is
  // recorded (an "invocation"); replay=false marks the calls that actually
  // created a NEW synthetic processor result for a previously-unseen idempotency
  // key (an "effect"). A replay (same key seen before) returns the same result
  // id and records replay=true, so a concurrency test can see TWO app-level
  // invocations even though only ONE processor effect occurred. The fake's
  // idempotency can therefore never HIDE a duplicate server call.
  replay: boolean;
};

// Per-process, run-id-isolated recorder. A new Map per run id; distinct runs and
// parallel workers never collide.
const callsByRun = new Map<string, FakeStripeCall[]>();
// Idempotency replay: within a run, a repeated idempotency key returns the SAME
// synthetic result and records NO second call (proves retry never double-charges).
const idempotentResultByRun = new Map<string, Map<string, string>>();
const seqByRun = new Map<string, number>();
// PAY-CCY-01. The money each synthetic PaymentIntent and Charge was created
// with, so a later retrieve and a refund state it back exactly as real Stripe
// does. Real Stripe always states `amount` and `currency` on these objects,
// and the application now refuses to record any that do not equal the
// prepared attempt, so a fake that omitted them would fail closed.
type FakeMoney = { amount: number | null; currency: string | null };
const moneyByIdByRun = new Map<string, Map<string, FakeMoney>>();
function rememberMoney(run: string, id: string, money: FakeMoney): void {
  const m = moneyByIdByRun.get(run) ?? new Map<string, FakeMoney>();
  m.set(id, money);
  moneyByIdByRun.set(run, m);
}
function recalledMoney(run: string, id: string | null | undefined): FakeMoney {
  if (!id) return { amount: null, currency: null };
  return moneyByIdByRun.get(run)?.get(id) ?? { amount: null, currency: null };
}

// FAITHFUL PAYMENTINTENT STATE. The fake remembers what each PaymentIntent it created looks like (status, money, metadata,
// livemode, charge), so a later retrieve and cancel state it back the way real Stripe does: the stored status and metadata,
// amount and currency present, amount_received 0 until it is captured, and a cancel that moves the SAME object to
// "canceled". Without this the owner action "Close declined attempt" (which checks id, amount, currency, mode, the attempt
// id in the metadata, amount_received, and the cancel response) can never complete against the fake.
type FakePi = {
  id: string;
  status: string;
  amount: number | null;
  currency: string | null;
  metadata: Record<string, string>;
  latestCharge: string | null;
  // Set only on a declined intent, as real Stripe states `last_payment_error` on a PaymentIntent whose attempt was refused.
  lastPaymentError?: { type: "card_error"; code: string; decline_code: string; message: string } | null;
};
const piByIdByRun = new Map<string, Map<string, FakePi>>();
function storePi(run: string, pi: FakePi): void {
  const m = piByIdByRun.get(run) ?? new Map<string, FakePi>();
  m.set(pi.id, pi);
  piByIdByRun.set(run, m);
}
function storedPi(run: string, id: string): FakePi | null {
  return piByIdByRun.get(run)?.get(id) ?? null;
}
// Statuses real Stripe lets a PaymentIntent be cancelled from.
const CANCELLABLE = new Set(["requires_payment_method", "requires_capture", "requires_confirmation", "requires_action"]);
function piObject(pi: FakePi) {
  const captured = pi.status === "succeeded";
  return {
    id: pi.id,
    object: "payment_intent",
    status: pi.status,
    amount: pi.amount,
    currency: pi.currency,
    metadata: { ...pi.metadata },
    livemode: false, // the fake is test-mode only
    amount_received: captured ? (pi.amount ?? 0) : 0,
    latest_charge: pi.latestCharge,
    ...(pi.status === "canceled" ? { cancellation_reason: "requested_by_customer" } : {}),
    ...(pi.lastPaymentError ? { last_payment_error: { ...pi.lastPaymentError } } : {}),
  };
}

// A declined card. Real Stripe answers a declined off-session confirm with HTTP 402 and a card error that CARRIES the
// PaymentIntent (status requires_payment_method), and it later sends payment_intent.payment_failed. The fake does both,
// so the application's thrown-error branch and its webhook reconciliation both run, as they would against Stripe.
const DECLINE_ERROR = {
  type: "card_error" as const,
  code: "card_declined",
  decline_code: "generic_decline",
  message: "Your card was declined.",
};
const FAKE_WEBHOOK_DELAY_MS = 750;

export function buildFakePaymentFailedEvent(pi: FakePi, stripeAccount: string | null) {
  return {
    id: `evt_test_e2e_${pi.id}`,
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: "payment_intent.payment_failed",
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    ...(stripeAccount ? { account: stripeAccount } : {}),
    data: { object: piObject(pi) },
  };
}

// Posts the event, signed with the lane's webhook secret, to the application's own webhook route. A deferred send, after the
// charge call has returned and the executor has bound the intent to its attempt, which is the order real Stripe produces.
export async function deliverFakePaymentFailedWebhook(
  run: string,
  piId: string,
  stripeAccount: string | null,
  deps: { fetchImpl?: typeof fetch; origin?: string; secret?: string } = {},
): Promise<{ delivered: boolean; status: number | null }> {
  const pi = storedPi(run, piId);
  const secret = deps.secret ?? process.env.STRIPE_WEBHOOK_SECRET;
  if (!pi || !secret) return { delivered: false, status: null };
  const payload = JSON.stringify(buildFakePaymentFailedEvent(pi, stripeAccount));
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  // The lane's server sets PORT; with neither an origin nor a PORT (an ordinary unit test) nothing is sent.
  const origin =
    deps.origin ??
    process.env.HONE_E2E_APP_ORIGIN ??
    (process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : null);
  if (!origin) return { delivered: false, status: null };
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${origin}/api/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: payload,
    });
    return { delivered: res.ok, status: res.status };
  } catch {
    return { delivered: false, status: null };
  }
}

function runId(): string {
  return process.env.HONE_E2E_RUN_ID ?? "no-run";
}
function nextSeq(run: string): number {
  const n = (seqByRun.get(run) ?? 0) + 1;
  seqByRun.set(run, n);
  return n;
}
function record(run: string, call: FakeStripeCall): void {
  const list = callsByRun.get(run) ?? [];
  list.push(call);
  callsByRun.set(run, list);
  // Also persist to the guarded cross-process ledger so the separate Playwright
  // runner can observe calls. Best-effort + guarded: a no-op when fake mode is
  // off (ordinary unit tests) so nothing here can touch the filesystem there.
  try {
    appendFakeCallToLedger(run, call);
  } catch {
    /* guard off or ledger unavailable → in-memory only */
  }
}

// The configured outcome for this attempt (keyed by its idempotency key). Default
// success. Read from the guarded ledger so the Playwright process selects the
// behaviour server-side, never the browser.
function outcomeFor(run: string, idempotencyKey: string | null): "success" | "decline" | "processing" {
  if (!idempotencyKey) return "success";
  try {
    return readFakeOutcome(run, idempotencyKey);
  } catch {
    return "success";
  }
}
function idempotentResult(
  run: string,
  key: string | null | undefined,
): string | null {
  if (!key) return null;
  return idempotentResultByRun.get(run)?.get(key) ?? null;
}
function rememberIdempotent(run: string, key: string | null | undefined, id: string): void {
  if (!key) return;
  const m = idempotentResultByRun.get(run) ?? new Map<string, string>();
  m.set(key, id);
  idempotentResultByRun.set(run, m);
}

// ---- Test-process inspection API (NOT a production/browser surface) ----------
export function getFakeStripeCalls(run: string = runId()): ReadonlyArray<FakeStripeCall> {
  return [...(callsByRun.get(run) ?? [])];
}
export function resetFakeStripeState(run: string = runId()): void {
  callsByRun.delete(run);
  idempotentResultByRun.delete(run);
  seqByRun.delete(run);
  moneyByIdByRun.delete(run);
  piByIdByRun.delete(run);
}

// ---- The fake client -----------------------------------------------------------
type CreatePiParams = {
  amount?: number | null;
  currency?: string | null;
  metadata?: Record<string, string> | null;
};
type RequestOpts = { stripeAccount?: string; idempotencyKey?: string } | undefined;

function synthPaymentIntent(run: string, opts: RequestOpts, params?: CreatePiParams) {
  const key = opts?.idempotencyKey ?? null;
  const existing = idempotentResult(run, key);
  // A replay is a create whose idempotency key already produced an effect. It
  // returns the SAME synthetic result (Stripe's 24h idempotency window) and
  // creates NO new processor effect, but it IS still an app-level invocation.
  const replay = existing !== null;
  const seq = existing ? null : nextSeq(run);
  const id = existing ?? `pi_test_e2e_${run}_${seq}`;
  const chargeId = `ch_test_e2e_${run}_${(id.match(/_(\d+)$/)?.[1] ?? seq) ?? 1}`;
  const outcome = outcomeFor(run, key);
  if (!existing) {
    // First-seen key → THIS call is the unique processor effect.
    rememberIdempotent(run, key, id);
  }
  // Record EVERY invocation (replay flag distinguishes effect from replay) so a
  // duplicate server call can never be concealed behind one synthetic result.
  record(run, {
    method: "pi_create",
    idempotencyKey: key,
    stripeAccount: opts?.stripeAccount ?? null,
    amountCents: params?.amount ?? null,
    currency: params?.currency ?? null,
    resultId: id,
    replay,
  });
  // Success → succeeded (+ latest_charge); decline → requires_payment_method, thrown as a card error carrying the intent
  // (below). The executor does NOT persist that as failed on the immediate response: a PaymentIntent that is not
  // confirmed canceled can still complete, so the attempt stays pending_stripe and the payment_intent.payment_failed
  // webhook moves it to failed. processing → pending.
  const status =
    outcome === "decline"
      ? "requires_payment_method"
      : outcome === "processing"
        ? "processing"
        : "succeeded";
  // A replay states the money of the ORIGINAL create, as Stripe's idempotent
  // replay returns the original object rather than echoing the new request.
  const money: FakeMoney = existing
    ? recalledMoney(run, id)
    : { amount: params?.amount ?? null, currency: params?.currency ?? null };
  if (!existing) {
    rememberMoney(run, id, money);
    rememberMoney(run, chargeId, money);
  }
  // The first create states the PaymentIntent; a replay returns the stored object (same status, same metadata).
  if (!existing) {
    storePi(run, {
      id,
      status,
      amount: money.amount,
      currency: money.currency,
      metadata: { ...(params?.metadata ?? {}) },
      latestCharge: outcome === "success" ? chargeId : null,
      lastPaymentError: outcome === "decline" ? { ...DECLINE_ERROR } : null,
    });
  }
  if (outcome === "decline") {
    const declined = storedPi(run, id);
    if (declined) {
      // Only the FIRST send of a key is an effect: Stripe replays the same 402 for a repeated key and sends one event.
      if (!existing) {
        const t = setTimeout(() => {
          void deliverFakePaymentFailedWebhook(run, id, opts?.stripeAccount ?? null);
        }, FAKE_WEBHOOK_DELAY_MS);
        if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
      }
      throw new Stripe.errors.StripeCardError({
        type: "card_error",
        code: DECLINE_ERROR.code,
        decline_code: DECLINE_ERROR.decline_code,
        message: DECLINE_ERROR.message,
        statusCode: 402,
        payment_intent: piObject(declined),
      } as unknown as ConstructorParameters<typeof Stripe.errors.StripeCardError>[0]);
    }
  }
  const stored = storedPi(run, id);
  return {
    ...(stored ? piObject(stored) : {}),
    id,
    status: stored?.status ?? status,
    amount: money.amount,
    currency: money.currency,
    latest_charge: stored ? stored.latestCharge : outcome === "success" ? chargeId : null,
  };
}

// Returns a Stripe-shaped object implementing only the session-payment surface.
export function createFakeStripe(): Stripe {
  const fake = {
    paymentIntents: {
      create: async (params: CreatePiParams, opts?: RequestOpts) =>
        synthPaymentIntent(runId(), opts, params),
      retrieve: async (id: string, _p?: unknown, opts?: RequestOpts) => {
        record(runId(), {
          method: "pi_retrieve",
          idempotencyKey: null,
          stripeAccount: opts?.stripeAccount ?? null,
          amountCents: null,
          currency: null,
          resultId: id,
          replay: false, // a read, not a keyed effect
        });
        const run = runId();
        const known = storedPi(run, id);
        if (known) {
          // A PaymentIntent the fake created: state it back as stored. A "processing" one settles on this read (the
          // fake's existing behaviour for the Refresh action); a declined one stays requires_payment_method.
          if (known.status === "processing") {
            known.status = "succeeded";
            known.latestCharge = known.latestCharge ?? `ch_test_e2e_${run}_${(id.match(/_(\d+)$/)?.[1] ?? "r")}`;
            rememberMoney(run, known.latestCharge, { amount: known.amount, currency: known.currency });
          }
          return piObject(known);
        }
        const chargeId = `ch_test_e2e_${run}_r`;
        // An id the fake never created states no money, which the application treats as a mismatch, the same as real
        // Stripe disagreeing with the row. (Unchanged legacy behaviour for ids seeded outside the fake.)
        const money = recalledMoney(run, id);
        rememberMoney(run, chargeId, money);
        return {
          id,
          status: "succeeded",
          amount: money.amount,
          currency: money.currency,
          latest_charge: chargeId,
        };
      },
      cancel: async (id: string, _p?: unknown, opts?: RequestOpts) => {
        record(runId(), {
          method: "pi_cancel",
          idempotencyKey: null,
          stripeAccount: opts?.stripeAccount ?? null,
          amountCents: null,
          currency: null,
          resultId: id,
          replay: false,
        });
        const known = storedPi(runId(), id);
        if (known) {
          if (known.status === "canceled") return piObject(known);
          if (!CANCELLABLE.has(known.status)) {
            // Real Stripe refuses to cancel a PaymentIntent that is processing or already succeeded.
            const err = new Error(`This PaymentIntent (${id}) cannot be canceled because its status is ${known.status}.`) as Error & { type: string; code: string; statusCode: number };
            err.type = "invalid_request_error";
            err.code = "payment_intent_unexpected_state";
            err.statusCode = 400;
            throw err;
          }
          known.status = "canceled";
          return piObject(known);
        }
        return { id, status: "canceled" };
      },
    },
    refunds: {
      create: async (
        params: {
          charge?: string | null;
          amount?: number | null;
          currency?: string | null;
        },
        opts?: RequestOpts,
      ) => {
        const run = runId();
        const key = opts?.idempotencyKey ?? null;
        const existing = idempotentResult(run, key);
        const replay = existing !== null;
        const id = existing ?? `re_test_e2e_${run}_${nextSeq(run)}`;
        // Stripe takes a refund's currency from the CHARGE, never from the
        // request. A replay states the original refund's amount.
        const money: FakeMoney = existing
          ? recalledMoney(run, id)
          : {
              amount: params?.amount ?? null,
              currency: recalledMoney(run, params?.charge).currency,
            };
        if (!existing) {
          rememberIdempotent(run, key, id);
          rememberMoney(run, id, money);
        }
        // Record every refund invocation (replay flag), same invocation/effect
        // model as create, so a duplicate refund request can't be concealed.
        record(run, {
          method: "refund_create",
          idempotencyKey: key,
          stripeAccount: opts?.stripeAccount ?? null,
          amountCents: params?.amount ?? null,
          currency: params?.currency ?? null,
          resultId: id,
          replay,
        });
        return {
          id,
          status: "succeeded",
          amount: money.amount,
          currency: money.currency,
        };
      },
    },
  };
  return fake as unknown as Stripe;
}
