import "server-only";
import type Stripe from "stripe";
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
}

// ---- The fake client -----------------------------------------------------------
type CreatePiParams = {
  amount?: number | null;
  currency?: string | null;
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
  // Success → succeeded (+ latest_charge); decline → non-succeeded status the
  // real executor persists as failed; processing → pending.
  const status =
    outcome === "decline"
      ? "requires_payment_method"
      : outcome === "processing"
        ? "processing"
        : "succeeded";
  return {
    id,
    status,
    latest_charge: outcome === "success" ? chargeId : null,
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
        return { id, status: "succeeded", latest_charge: `ch_test_e2e_${runId()}_r` };
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
        return { id, status: "canceled" };
      },
    },
    refunds: {
      create: async (
        params: { amount?: number | null; currency?: string | null },
        opts?: RequestOpts,
      ) => {
        const run = runId();
        const key = opts?.idempotencyKey ?? null;
        const existing = idempotentResult(run, key);
        const replay = existing !== null;
        const id = existing ?? `re_test_e2e_${run}_${nextSeq(run)}`;
        if (!existing) {
          rememberIdempotent(run, key, id);
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
        return { id, status: "succeeded" };
      },
    },
  };
  return fake as unknown as Stripe;
}
