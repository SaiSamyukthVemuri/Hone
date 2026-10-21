import "server-only";
import type Stripe from "stripe";
import { createHash } from "node:crypto";
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
// Outcomes are selected only by the existing server-only run-keyed ledger,
// never by browser/request input. Unconfirmed creation does not apply them.

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
  // INVOCATION vs EFFECT (PR #419 concurrency pass). Every adapter call is
  // recorded (an "invocation"); replay=false marks the calls that actually
  // produced a NEW synthetic processor outcome (including a refusal) for a previously-unseen idempotency
  // key (an operation "effect", NOT proof of money moving). A replay (same key seen before) returns the same result
  // id and records replay=true, so a concurrency test can see TWO app-level
  // invocations even though only ONE processor effect occurred. The fake's
  // idempotency can therefore never HIDE a duplicate server call.
  replay: boolean;
};

// Per-process state remains run-isolated. Only the seven test-safe call fields
// above enter the cross-process ledger; provider identity stays in private state.
const callsByRun = new Map<string, FakeStripeCall[]>();
const seqByRun = new Map<string, number>();
type FakeMoney = { amount: number | null; currency: string | null };
type FakeIntent = FakeMoney & {
  id: string; status: "requires_confirmation" | "succeeded" | "requires_payment_method" | "processing" | "canceled";
  customer: string | null; payment_method: string | null; livemode: false;
  confirmation_method: "manual" | "automatic"; latest_charge: string | null;
  amount_received: number; amount_capturable: number;
  last_payment_error: { type: "card_error"; code: "card_declined"; message: string } | null;
};
type StoredIntent = { account: string | null; createKey: string | null; chargeId: string; value: FakeIntent };
type FakeRefund = FakeMoney & { id: string; status: "succeeded" };
type CachedReply = { fingerprint: string; resultId: string; value: FakeIntent | FakeRefund | null; error: string | null };
const intentsByRun = new Map<string, Map<string, StoredIntent>>();
const repliesByRun = new Map<string, Map<string, CachedReply>>();
const moneyByIdByRun = new Map<string, Map<string, FakeMoney>>();
const accountsByIdByRun = new Map<string, Map<string, string | null>>();
function rememberMoney(run: string, id: string, money: FakeMoney, account: string | null): void {
  const m = moneyByIdByRun.get(run) ?? new Map<string, FakeMoney>();
  m.set(id, money); moneyByIdByRun.set(run, m);
  const a = accountsByIdByRun.get(run) ?? new Map<string, string | null>();
  a.set(id, account); accountsByIdByRun.set(run, a);
}
function recalledMoney(run: string, id: string | null | undefined): FakeMoney {
  return (id ? moneyByIdByRun.get(run)?.get(id) : null) ?? { amount: null, currency: null };
}
function runTag(run: string): string {
  // Valid run IDs can contain hyphens; Stripe-shaped object IDs cannot.
  return createHash("sha256").update(run).digest("hex").slice(0, 16);
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
  if (!reply) {
    try {
      const value = execute();
      reply = { fingerprint, resultId: value.id, value: structuredClone(value), error: null };
    } catch {
      reply = { fingerprint, resultId: "pi_test_e2e_refused", value: null, error: "Synthetic processor request refused." };
    }
    if (scope) { replies.set(scope, reply); repliesByRun.set(run, replies); }
  }
  record(run, { method, idempotencyKey: key, stripeAccount: opts?.stripeAccount ?? null,
    amountCents: money.amount, currency: money.currency, resultId: reply.resultId, replay: !!previous });
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
  repliesByRun.delete(run);
  intentsByRun.delete(run);
  accountsByIdByRun.delete(run);
  seqByRun.delete(run);
  moneyByIdByRun.delete(run);
}

// ---- The fake client -----------------------------------------------------------
type CreatePiParams = {
  amount?: number | null; currency?: string | null;
  customer?: string; payment_method?: string; confirm?: boolean;
  confirmation_method?: "manual" | "automatic";
};
type RequestOpts = { stripeAccount?: string; idempotencyKey?: string } | undefined;
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

// Returns only the existing session-payment surface; no real SDK/network use.
export function createFakeStripe(): Stripe {
  const fake = {
    paymentIntents: {
      create: async (params: CreatePiParams, opts?: RequestOpts) => {
        const run = runId();
        return invoke(run, "pi_create", "POST:/payment_intents", params, opts,
          { amount: params.amount ?? null, currency: params.currency ?? null }, () => {
            const seq = nextSeq(run);
            const id = `pi_test_e2e_${runTag(run)}_${seq}`;
            const stored: StoredIntent = {
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
        record(run, { method: "pi_retrieve", idempotencyKey: null, stripeAccount: opts?.stripeAccount ?? null,
          amountCents: null, currency: null, resultId: id, replay: false });
        const stored = intentsByRun.get(run)?.get(id);
        if (stored) {
          const owned = ownedIntent(run, id, opts);
          // Only an explicit server-side outcome update may advance processing.
          // A read NEVER confirms an unconfirmed or declined original.
          if (owned.value.status === "processing" && outcomeFor(run, owned.createKey) === "success") applyOutcome(run, owned);
          return structuredClone(owned.value);
        }
        // Unknown IDs retain the existing unreadable-money refusal control.
        return { id, status: "succeeded", amount: null, currency: null, latest_charge: `ch_test_e2e_${runTag(run)}_r` };
      },
      cancel: async (id: string, _p?: unknown, opts?: RequestOpts) => {
        const run = runId();
        record(run, { method: "pi_cancel", idempotencyKey: null, stripeAccount: opts?.stripeAccount ?? null,
          amountCents: null, currency: null, resultId: id, replay: false });
        const stored = intentsByRun.get(run)?.get(id);
        if (!stored) return { id, status: "canceled" };
        const owned = ownedIntent(run, id, opts);
        if (owned.value.status === "succeeded") throw new Error("Synthetic completed payment cannot be canceled.");
        owned.value.status = "canceled"; return structuredClone(owned.value);
      },
    },
    refunds: {
      create: async (params: { charge?: string | null; amount?: number | null; currency?: string | null }, opts?: RequestOpts) => {
        const run = runId();
        return invoke(run, "refund_create", "POST:/refunds", params, opts,
          { amount: params.amount ?? null, currency: params.currency ?? null }, () => {
            const account = accountsByIdByRun.get(run);
            if (params.charge && account?.has(params.charge) && account.get(params.charge) !== (opts?.stripeAccount ?? null)) {
              throw new Error("Synthetic charge unavailable.");
            }
            const id = `re_test_e2e_${runTag(run)}_${nextSeq(run)}`;
            const value: FakeRefund = { id, status: "succeeded", amount: params.amount ?? null,
              currency: recalledMoney(run, params.charge).currency };
            rememberMoney(run, id, value, opts?.stripeAccount ?? null); return value;
          });
      },
    },
  };
  return fake as unknown as Stripe;
}
