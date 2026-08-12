// Card-on-file finalization state machine.
//
// STRIPE ACCEPTED != HONE CARD SAVED. Stripe's confirmSetup resolving means the
// provider accepted the card; Hone records it asynchronously from the
// setup_intent.succeeded webhook. This module owns the wait in between.
//
// It lives outside the React component on purpose: the component cannot be
// rendered in the unit lane (environment is "node", and the repository carries
// no React testing library or DOM shim), and the fake-Stripe browser lane
// cannot drive Stripe Elements — `confirmSetup` needs real Stripe.js from
// js.stripe.com plus a live SetupIntent client_secret, and the payment E2E lane
// covers server-authoritative charge flows rather than Elements. Extracting the state
// machine means the part with the actual decisions is behaviourally testable
// today, instead of being covered only by source greps.
//
// THREE independent bounds, because an attempt count is not a wall-clock
// ceiling — each confirmation request can take arbitrary network time:
//   * deadlineMs        — overall wall clock, checked before every attempt;
//   * attemptTimeoutMs  — per request, so one hung read cannot pin the caller
//                         in "finalizing" forever;
//   * attempts          — request budget.
// Whichever binds first ends the window, truthfully, as "pending".

export type CardConfirmState = "saved" | "rejected" | "pending";

export type CardConfirmResult =
  | { ok: true; state: "saved"; last4: string; brand: string }
  | { ok: true; state: "rejected" }
  | { ok: true; state: "pending" }
  | { ok: false; error: string };

export const CONFIRM_POLL_INTERVAL_MS = 1200;
export const CONFIRM_MAX_ATTEMPTS = 12;
export const CONFIRM_ATTEMPT_TIMEOUT_MS = 5_000;
export const CONFIRM_DEADLINE_MS = 20_000;

export type PollOptions = {
  setupIntentId: string;
  /** The authoritative Hone-side read. Never Stripe. */
  confirm: (setupIntentId: string) => Promise<CardConfirmResult>;
  attempts?: number;
  intervalMs?: number;
  attemptTimeoutMs?: number;
  deadlineMs?: number;
  /** Injected for tests; defaults to real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Stops the loop when the caller has unmounted. */
  isCancelled?: () => boolean;
};

export type PollOutcome = {
  outcome: CardConfirmState;
  /** Confirmation requests actually issued. Never exceeds the budget. */
  attemptsMade: number;
  /** True when the wall-clock deadline ended the window. */
  deadlineReached: boolean;
};

/** Resolves to "timeout" rather than hanging if a read outlives its budget. */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T | "timeout"> {
  return (await Promise.race([p, sleep(ms).then(() => "timeout" as const)])) as T | "timeout";
}

/**
 * Waits for Hone's OWN record of the card. Returns "saved" only when Hone has
 * an active row for this SetupIntent — never merely because Stripe succeeded.
 *
 * Issues no Stripe call of any kind: it cannot mint a SetupIntent and cannot
 * re-confirm one, so a confirmation timeout can never submit another card.
 */
export async function pollForCardPersistence(opts: PollOptions): Promise<PollOutcome> {
  const {
    setupIntentId,
    confirm,
    attempts = CONFIRM_MAX_ATTEMPTS,
    intervalMs = CONFIRM_POLL_INTERVAL_MS,
    attemptTimeoutMs = CONFIRM_ATTEMPT_TIMEOUT_MS,
    deadlineMs = CONFIRM_DEADLINE_MS,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    isCancelled = () => false,
  } = opts;

  const deadline = now() + deadlineMs;
  let attemptsMade = 0;

  for (let i = 0; i < attempts; i++) {
    if (isCancelled()) return { outcome: "pending", attemptsMade, deadlineReached: false };
    if (now() >= deadline) {
      return { outcome: "pending", attemptsMade, deadlineReached: true };
    }

    attemptsMade++;
    const res = await withTimeout(confirm(setupIntentId), attemptTimeoutMs, sleep);
    if (isCancelled()) return { outcome: "pending", attemptsMade, deadlineReached: false };

    if (res !== "timeout" && res.ok && res.state === "saved") {
      return { outcome: "saved", attemptsMade, deadlineReached: false };
    }
    if (res !== "timeout" && res.ok && res.state === "rejected") {
      return { outcome: "rejected", attemptsMade, deadlineReached: false };
    }
    // A timeout, a transient read failure, or a genuine "not yet" are all
    // "keep waiting". None of them may be reported as saved.

    if (now() >= deadline) {
      return { outcome: "pending", attemptsMade, deadlineReached: true };
    }
    await sleep(intervalMs);
  }

  return { outcome: "pending", attemptsMade, deadlineReached: now() >= deadline };
}
