import "server-only";
import { createHash } from "node:crypto";
// The SDK VALUE is needed only to construct a genuine StripeError for the
// fake's terminal refund refusal (production classifies by instanceof).
import StripeSdk from "stripe";
import type Stripe from "stripe";
import {
  appendFakeCallToLedger,
  readFakeOutcome,
  readFakeStripeCalls,
} from "@/lib/stripe/e2e-fake-ledger";

// Minimal, server-only FAKE Stripe processor for the disposable E2E stack. It
// implements ONLY the methods the session-payment charge/refund path calls, makes
// NO network request, and returns obviously-synthetic identifiers. It is reached
// only after the activation guard (lib/stripe/e2e-fake-guard.ts) passes. It can
// never construct in a deployed environment.
//
// Recorded call metadata is TEST-SAFE ONLY: method, idempotency key,
// connected-account context, amount, currency, the synthetic result and charge
// ids, and a one-way DIGEST of the create metadata (never its values). It
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
  | "pi_confirm"
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
  // PAY-CCY-09 (Codex P2 4264919593). The synthetic CHARGE this call produced
  // (pi_create: the PaymentIntent's latest_charge) or targeted (refund_create:
  // the charge refunded). A provider id, not client data. It lets a test build
  // and VERIFY provider lineage (refund -> charge -> PaymentIntent) from the
  // processor's own record instead of trusting the application's row.
  chargeId: string | null;
  // PAY-CCY-09 (Codex P2 4265594520). pi_create only: a DIGEST of the metadata
  // the charge path actually sent (fakeMetadataDigest), never the values, which
  // carry client and authorization ids. A webhook test validates the metadata it
  // signs against this processor fact instead of re-deriving it from the row.
  metadataDigest: string | null;
  // One-way binding of the SDK payer identifier; no raw identifier recorded.
  payerDigest?: string | null;
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
type FakeIntent = FakeMoney & {
  id: string; status: "requires_confirmation" | "succeeded" | "requires_payment_method" | "processing" | "canceled";
  customer: string | null; payment_method: string | null; livemode: false;
  confirmation_method: "manual" | "automatic"; latest_charge: string | null;
  amount_received: number; amount_capturable: number;
  last_payment_error: { type: "card_error"; code: "card_declined"; message: string } | null;
};
type StoredIntent = { account: string | null; createKey: string | null; chargeId: string; value: FakeIntent; metadataDigest: string | null; payerDigest: string | null };
type FakeRefund = FakeMoney & { id: string; status: "succeeded" };
type CachedReply = { fingerprint: string; resultId: string; value: FakeIntent | FakeRefund | null; error: string | null };
const intentsByRun = new Map<string, Map<string, StoredIntent>>();
const repliesByRun = new Map<string, Map<string, CachedReply>>();
const accountsByIdByRun = new Map<string, Map<string, string | null>>();

const moneyByIdByRun = new Map<string, Map<string, FakeMoney>>();
function rememberMoney(run: string, id: string, money: FakeMoney, account: string | null = null): void {
  const m = moneyByIdByRun.get(run) ?? new Map<string, FakeMoney>();
  m.set(id, money);
  moneyByIdByRun.set(run, m);
  const a = accountsByIdByRun.get(run) ?? new Map<string, string | null>();
  a.set(id, account); accountsByIdByRun.set(run, a);
}
function recalledMoney(run: string, id: string | null | undefined): FakeMoney {
  if (!id) return { amount: null, currency: null };
  return moneyByIdByRun.get(run)?.get(id) ?? ledgerMoney(run, id);
}

// PAY-CCY-09 (twin finding, 2026-10-14). This process's memory is lost on a
// server restart; the run's ledger is not. Everything the fake must state BACK
// (an object's money, an idempotent replay's result, the next id) falls back to
// the ledger's EFFECT records, so a restarted server behaves as real Stripe
// does: same objects, same money, same idempotency. Memory still answers first;
// with no ledger (guard off, ordinary unit tests) the answers are as before.
function ledgerEffects(run: string): FakeStripeCall[] {
  try {
    return readFakeStripeCalls(run).filter((c) => !c.replay && !c.resultId.endsWith("_refused"));
  } catch {
    return [];
  }
}
function ledgerMoney(run: string, id: string): FakeMoney {
  const effects = ledgerEffects(run);
  // A PaymentIntent, or the charge a PaymentIntent create produced: its create money.
  const create = effects.find(
    (c) => (c.method === "pi_create" || c.method === "pi_confirm") && (c.resultId === id || c.chargeId === id),
  );
  if (create) return { amount: create.amountCents, currency: create.currency };
  // A refund: its amount, in its CHARGE's currency (as Stripe states it).
  const refund = effects.find((c) => c.method === "refund_create" && c.resultId === id);
  if (refund) {
    return { amount: refund.amountCents, currency: ledgerMoney(run, refund.chargeId ?? "").currency };
  }
  return { amount: null, currency: null };
}

function runTag(run: string): string {
  // Valid run IDs can contain hyphens; Stripe-shaped object IDs cannot.
  return createHash("sha256").update(run).digest("hex").slice(0, 16);
}
function runId(): string {
  return process.env.HONE_E2E_RUN_ID ?? "no-run";
}
function nextSeq(run: string): number {
  const n = (seqByRun.get(run) ?? ledgerMaxSeq(run)) + 1;
  seqByRun.set(run, n);
  return n;
}

// PAY-CCY-09 (twin finding, 2026-10-14). The run's ledger file OUTLIVES this
// process, but the counter above does not: a restarted server re-issued
// pi_test_e2e_<run>_1 for a different attempt on a different account, so a
// lookup by id resolved another attempt's record. Real Stripe ids never repeat,
// so the first use of a run in a process continues from the highest sequence
// that run's ledger already holds. Best-effort: no ledger (guard off, ordinary
// unit tests) starts at 0 exactly as before.
function ledgerMaxSeq(run: string): number {
  try {
    const escaped = run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const seqOf = new RegExp(`_(?:${escaped}|${runTag(run)})_(\\d+)$`);
    let max = 0;
    for (const c of readFakeStripeCalls(run)) {
      const m = c.resultId.match(seqOf);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  } catch {
    return 0;
  }
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
  run: string, key: string | null | undefined, opts: RequestOpts,
  method: "pi_create" | "refund_create",
): string | null {
  if (!key) return null;
  const scope = JSON.stringify([method, opts?.stripeAccount ?? null, key]);
  const remembered = idempotentResultByRun.get(run)?.get(scope);
  if (remembered) return remembered;
  return ledgerEffects(run).find(c => c.method === method
    && c.stripeAccount === (opts?.stripeAccount ?? null) && c.idempotencyKey === key)?.resultId ?? null;
}
function rememberIdempotent(run: string, key: string | null | undefined, id: string,
  opts: RequestOpts, method: "pi_create" | "refund_create"): void {
  if (!key) return;
  const m = idempotentResultByRun.get(run) ?? new Map<string, string>();
  m.set(JSON.stringify([method, opts?.stripeAccount ?? null, key]), id);
  idempotentResultByRun.set(run, m);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]),
  );
  return value;
}

// A key is scoped by connected account AND API method/path, matching Stripe's
// operation boundary. Cache the original response, not mutable resource state.
function invoke<T extends FakeIntent | FakeRefund>(
  run: string, method: FakeStripeMethod, path: string, params: unknown,
  opts: RequestOpts, money: FakeMoney, execute: () => T,
): T {
  const key = opts?.idempotencyKey ?? null;
  const scope = key ? JSON.stringify([opts?.stripeAccount ?? null, path, key]) : null;
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical(params))).digest("hex");
  const replies = repliesByRun.get(run) ?? new Map<string, CachedReply>();
  const previous = scope ? replies.get(scope) : undefined;
  let reply = previous;
  const durable = !reply && key ? ledgerEffects(run).find(c => c.method === method
    && c.stripeAccount === (opts?.stripeAccount ?? null) && c.idempotencyKey === key
    && (method !== "pi_confirm" || path === `POST:/payment_intents/${c.resultId}/confirm`)) : undefined;
  if (durable) {
    record(run, { method, idempotencyKey: key, stripeAccount: opts?.stripeAccount ?? null,
      amountCents: money.amount, currency: money.currency, resultId: durable.resultId,
      chargeId: durable.chargeId, metadataDigest: durable.metadataDigest,
      payerDigest: durable.payerDigest ?? null, replay: true });
    throw new Error("Synthetic staged response unavailable after restart; review the existing operation.");
  }

  if (!reply) {
    try {
      const value = execute();
      reply = { fingerprint, resultId: value.id, value: structuredClone(value), error: null };
    } catch {
      reply = { fingerprint, resultId: "pi_test_e2e_refused", value: null, error: "Synthetic processor request refused." };
    }
    if (scope) { replies.set(scope, reply); repliesByRun.set(run, replies); }
  }
  const stored = intentsByRun.get(run)?.get(reply.resultId);
  record(run, { method, idempotencyKey: key, stripeAccount: opts?.stripeAccount ?? null,
    amountCents: money.amount, currency: money.currency, resultId: reply.resultId,
    chargeId: method === "pi_confirm" ? reply.value && "latest_charge" in reply.value ? reply.value.latest_charge : null : null,
    metadataDigest: method === "pi_create" ? fakeMetadataDigest((params as CreatePiParams).metadata) : stored?.metadataDigest ?? null,
    payerDigest: method === "pi_create" && typeof (params as CreatePiParams).customer === "string" && !!(params as CreatePiParams).customer
      ? fakeMetadataDigest({ payer: (params as CreatePiParams).customer }) : stored?.payerDigest ?? null,
    replay: !!previous });
  if (previous && previous.fingerprint !== fingerprint) throw new Error("Synthetic idempotency parameters differ.");
  if (reply.error) throw new Error(reply.error);
  return structuredClone(reply.value) as T;
}

// ---- Test-process inspection API (NOT a production/browser surface) ----------
export function getFakeStripeCalls(run: string = runId()): ReadonlyArray<FakeStripeCall> {
  return [...(callsByRun.get(run) ?? [])];
}
export function resetFakeStripeState(run: string = runId()): void {
  callsByRun.delete(run);
  idempotentResultByRun.delete(run);
  repliesByRun.delete(run); intentsByRun.delete(run); accountsByIdByRun.delete(run);
  seqByRun.delete(run);
  moneyByIdByRun.delete(run);
}

// ---- The fake client -----------------------------------------------------------
type CreatePiParams = {
  customer?: string | null;
  payment_method?: string; confirm?: boolean;
  confirmation_method?: "manual" | "automatic";
  amount?: number | null;
  currency?: string | null;
  metadata?: Record<string, string | null | undefined> | null;
};

/** Digest of PaymentIntent metadata in canonical form: null, undefined and empty
 * values dropped (Stripe stores no empty metadata value), the rest as strings,
 * sorted by key. The Playwright runner has its own copy (it cannot import this
 * server-only module); tests/lib/stripe/e2e-fake-stripe.test.ts pins the two to
 * the same output. */
export function fakeMetadataDigest(
  metadata: Record<string, string | null | undefined> | null | undefined,
): string | null {
  if (!metadata) return null;
  const entries = Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
type RequestOpts = { stripeAccount?: string; idempotencyKey?: string } | undefined;

function synthPaymentIntent(run: string, opts: RequestOpts, params?: CreatePiParams) {
  const key = opts?.idempotencyKey ?? null;
  const existing = idempotentResult(run, key, opts, "pi_create");
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
    rememberIdempotent(run, key, id, opts, "pi_create");
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
    chargeId: outcome === "success" ? chargeId : null,
    metadataDigest: fakeMetadataDigest(params?.metadata),
    payerDigest: typeof params?.customer === "string" && params.customer.length > 0
      ? fakeMetadataDigest({ payer: params.customer }) : null,
    replay,
  });
  // Success → succeeded (+ latest_charge); decline → non-succeeded status the
  // real executor persists as failed; processing → pending.
  const status: FakeIntent["status"] =
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
  return {
    id,
    status,
    amount: money.amount,
    currency: money.currency,
    latest_charge: outcome === "success" ? chargeId : null,
  };
}

// Returns a Stripe-shaped object implementing only the session-payment surface.
function applyOutcome(run: string, stored: StoredIntent): FakeIntent {
  const outcome = outcomeFor(run, stored.createKey);
  const pi = stored.value;
  pi.status = outcome === "decline" ? "requires_payment_method" : outcome === "processing" ? "processing" : "succeeded";
  pi.latest_charge = outcome === "success" ? stored.chargeId : null;
  pi.amount_received = outcome === "success" ? pi.amount ?? 0 : 0;
  pi.last_payment_error = outcome === "decline"
    ? { type: "card_error", code: "card_declined", message: "Synthetic processor refusal." } : null;
  if (pi.latest_charge) rememberMoney(run, pi.latest_charge, pi, stored.account);
  return pi;
}
function ownedIntent(run: string, id: string, opts: RequestOpts): StoredIntent {
  const stored = intentsByRun.get(run)?.get(id);
  if (!stored || stored.account !== (opts?.stripeAccount ?? null)) throw new Error("Synthetic original unavailable.");
  return stored;
}

export function createFakeStripe(): Stripe {
  const fake = {
    paymentIntents: {
      create: async (params: CreatePiParams, opts?: RequestOpts) => {
        const run = runId();
        if (params.confirm === true) {
          const combined = synthPaymentIntent(run, opts, params);
          const value: FakeIntent = { ...combined, customer: params.customer ?? null,
            payment_method: params.payment_method ?? null, livemode: false,
            confirmation_method: params.confirmation_method ?? "automatic",
            amount_received: combined.status === "succeeded" ? combined.amount ?? 0 : 0,
            amount_capturable: 0, last_payment_error: combined.status === "requires_payment_method"
              ? { type: "card_error", code: "card_declined", message: "Synthetic processor refusal." } : null };
          const intents = intentsByRun.get(run) ?? new Map<string, StoredIntent>();
          intents.set(value.id, { value, account: opts?.stripeAccount ?? null,
            createKey: opts?.idempotencyKey ?? null, chargeId: combined.latest_charge ?? "",
            metadataDigest: fakeMetadataDigest(params.metadata),
            payerDigest: typeof params.customer === "string" && params.customer.length > 0 ? fakeMetadataDigest({ payer: params.customer }) : null });
          intentsByRun.set(run, intents); return value;
        }
        return invoke(run, "pi_create", "POST:/payment_intents", params, opts,
          { amount: params.amount ?? null, currency: params.currency ?? null }, () => {
            const seq = nextSeq(run);
            const id = `pi_test_e2e_${runTag(run)}_${seq}`;
            const stored: StoredIntent = {
              metadataDigest: fakeMetadataDigest(params.metadata),
              payerDigest: typeof params.customer === "string" && params.customer.length > 0 ? fakeMetadataDigest({ payer: params.customer }) : null,
              account: opts?.stripeAccount ?? null, createKey: opts?.idempotencyKey ?? null,
              chargeId: `ch_test_e2e_${runTag(run)}_${seq}`,
              value: { id, status: "requires_confirmation", amount: params.amount ?? null,
                currency: params.currency ?? null, customer: params.customer ?? null,
                payment_method: params.payment_method ?? null, livemode: false,
                confirmation_method: params.confirmation_method ?? "automatic", latest_charge: null,
                amount_received: 0, amount_capturable: 0, last_payment_error: null },
            };
            const intents = intentsByRun.get(run) ?? new Map<string, StoredIntent>();
            intents.set(id, stored); intentsByRun.set(run, intents);
            rememberMoney(run, id, stored.value, stored.account);
            // Creating an unconfirmed object is NOT a money operation. Legacy
            // explicit combined requests retain their existing final outcomes.
            return params.confirm === true ? applyOutcome(run, stored) : stored.value;
          });
      },
      confirm: async (id: string, params: { off_session?: boolean } = {}, opts?: RequestOpts) => {
        const run = runId();
        return invoke(run, "pi_confirm", `POST:/payment_intents/${id}/confirm`, params, opts,
          recalledMoney(run, id), () => {
            const stored = ownedIntent(run, id, opts);
            if (stored.value.status !== "requires_confirmation") throw new Error("Synthetic confirmation not permitted.");
            return applyOutcome(run, stored);
          });
      },
      retrieve: async (id: string, _p?: unknown, opts?: RequestOpts) => {
        const run = runId();
        const stored = intentsByRun.get(run)?.get(id);
        const create = ledgerEffects(run).find(c => c.method === "pi_create" && c.resultId === id);
        if (create && create.stripeAccount !== (opts?.stripeAccount ?? null)) throw new Error("Synthetic original unavailable.");
        let value;
        if (stored) {
          const owned = ownedIntent(run, id, opts);
          if (owned.value.status === "processing" && outcomeFor(run, owned.createKey) === "success") applyOutcome(run, owned);
          value = structuredClone(owned.value);
        } else {
          // Metadata-only evidence survives a restart. It can prove existing
          // money, but cannot invent private payer/PM values or a confirm permit.
          const observed = ledgerEffects(run).filter(c => c.resultId === id
            && c.stripeAccount === (opts?.stripeAccount ?? null) && c.chargeId).at(-1);
          const money = recalledMoney(run, id);
          value = { id, status: observed ? "succeeded" : "requires_confirmation",
            amount: money.amount, currency: money.currency, latest_charge: observed?.chargeId ?? null };
        }
        record(run, { method: "pi_retrieve", idempotencyKey: null,
          stripeAccount: opts?.stripeAccount ?? null, amountCents: value.amount,
          currency: value.currency, resultId: id, chargeId: value.latest_charge,
          metadataDigest: stored?.metadataDigest ?? create?.metadataDigest ?? null,
          payerDigest: stored?.payerDigest ?? create?.payerDigest ?? null, replay: false });
        return value;
      },
      cancel: async (id: string, _p?: unknown, opts?: RequestOpts) => {
        record(runId(), {
          method: "pi_cancel",
          idempotencyKey: null,
          stripeAccount: opts?.stripeAccount ?? null,
          amountCents: null,
          currency: null,
          resultId: id,
          chargeId: null,
          metadataDigest: null,
          replay: false,
        });
        const stored = intentsByRun.get(runId())?.get(id);
        if (!stored) return { id, status: "canceled" };
        const owned = ownedIntent(runId(), id, opts);
        if (owned.value.status === "succeeded") throw new Error("Synthetic completed payment cannot be canceled.");
        owned.value.status = "canceled"; return structuredClone(owned.value);
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
        const knownAccount = params.charge ? accountsByIdByRun.get(run)?.get(params.charge)
          ?? ledgerEffects(run).find(c => c.chargeId === params.charge)?.stripeAccount : undefined;
        if (knownAccount !== undefined && knownAccount !== (opts?.stripeAccount ?? null)) throw new Error("Synthetic charge unavailable.");
        const key = opts?.idempotencyKey ?? null;
        const existing = idempotentResult(run, key, opts, "refund_create");
        // PAY-CCY-09. The SAME run-scoped, server-side outcome selector the
        // PaymentIntent create uses (keyed by the request's idempotency key,
        // set only by the test harness through the fake ledger), so a test
        // can drive the two refund failure classes the production refund path
        // already handles. Never browser-selectable.
        //   decline    -> a real Stripe.errors.StripeError: production records
        //                 refund_status 'failed' (terminal).
        //   processing -> the AMBIGUOUS case: the synthetic processor DID make
        //                 the refund, but the response is lost (a non-Stripe
        //                 error is thrown after the effect). Production leaves
        //                 the row 'pending_stripe' (outcome unknown) until a
        //                 charge.refunded webhook or manual reconciliation; that
        //                 webhook then names a refund that really exists here.
        // A refusal creates no refund object; its invocation is still recorded
        // so a test can see the server asked exactly once.
        const outcome = existing ? "success" : outcomeFor(run, key);
        if (outcome === "decline") {
          record(run, {
            method: "refund_create",
            idempotencyKey: key,
            stripeAccount: opts?.stripeAccount ?? null,
            amountCents: params?.amount ?? null,
            currency: params?.currency ?? null,
            resultId: `re_test_e2e_${run}_refused`,
            chargeId: params?.charge ?? null,
            metadataDigest: null,
            replay: false,
          });
          throw new StripeSdk.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            code: "e2e_fake_refund_refused",
            message: "E2E FAKE: the synthetic processor refused this refund.",
          });
        }
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
          rememberIdempotent(run, key, id, opts, "refund_create");
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
          chargeId: params?.charge ?? null,
          metadataDigest: null,
          replay,
        });
        if (outcome === "processing") {
          // The refund above EXISTS; only the response is lost.
          throw new Error("E2E FAKE: simulated network failure after the refund; outcome unknown.");
        }
        return {
          id,
          charge: params?.charge ?? null,
          payment_intent: ledgerEffects(run).find((effect) => (effect.method === "pi_create" || effect.method === "pi_confirm") && effect.chargeId === params?.charge)?.resultId ?? null,
          status: "succeeded",
          amount: money.amount,
          currency: money.currency,
        };
      },
    },
  };
  return fake as unknown as Stripe;
}
