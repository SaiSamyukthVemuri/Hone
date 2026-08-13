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
//   * deadlineMs        — a HARD overall wall clock. Every per-attempt budget
//                         and every inter-attempt pause is clamped to the time
//                         actually remaining, so the caller settles by the
//                         deadline rather than overshooting it by the last
//                         attempt's full timeout;
//   * attemptTimeoutMs  — per request ceiling, so one hung read cannot pin the
//                         caller in "finalizing" forever;
//   * attempts          — request budget.
// Whichever binds first ends the window, truthfully, as "pending". The only
// slack is ordinary event-loop scheduling jitter.

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
  /**
   * Schedules `fire` after `ms` and returns a cancel handle. Injected so tests
   * can distinguish SCHEDULING a timeout from the timeout actually FIRING — a
   * fake clock that advanced on scheduling would mismodel every fast path.
   */
  setTimer?: (ms: number, fire: () => void) => () => void;
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

/**
 * Resolves to "timeout" rather than hanging if a read outlives its budget.
 *
 * The timer is CLEARED as soon as the read settles. The previous version raced
 * against `sleep(ms)`, which meant a fast confirmation still left a live timer
 * behind — and, in a fake-clock test, still advanced time by the full unused
 * budget. `setTimer` returns a cancel handle so the loser is torn down.
 */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  setTimer: (ms: number, fire: () => void) => () => void,
): Promise<T | "timeout"> {
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<"timeout">((resolve) => {
        cancel = setTimer(ms, () => resolve("timeout"));
      }),
    ]);
  } finally {
    cancel?.();
  }
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
    setTimer = (ms: number, fire: () => void) => {
      const id = setTimeout(fire, ms);
      return () => clearTimeout(id);
    },
    isCancelled = () => false,
  } = opts;

  const deadline = now() + deadlineMs;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimer(ms, resolve);
    });
  /** Time left before the hard deadline; never negative. */
  const remaining = () => Math.max(0, deadline - now());
  let attemptsMade = 0;

  for (let i = 0; i < attempts; i++) {
    if (isCancelled()) return { outcome: "pending", attemptsMade, deadlineReached: false };
    if (remaining() <= 0) {
      return { outcome: "pending", attemptsMade, deadlineReached: true };
    }

    attemptsMade++;
    // THE DEADLINE IS HARD. An attempt may never be given more time than the
    // window has left, or the last attempt alone could overshoot by its full
    // per-attempt budget.
    const budget = Math.min(attemptTimeoutMs, remaining());
    const res = await withTimeout(confirm(setupIntentId), budget, setTimer);
    if (isCancelled()) return { outcome: "pending", attemptsMade, deadlineReached: false };

    if (res !== "timeout" && res.ok && res.state === "saved") {
      return { outcome: "saved", attemptsMade, deadlineReached: false };
    }
    if (res !== "timeout" && res.ok && res.state === "rejected") {
      return { outcome: "rejected", attemptsMade, deadlineReached: false };
    }
    // A timeout, a transient read failure, or a genuine "not yet" are all
    // "keep waiting". None of them may be reported as saved.

    const left = remaining();
    if (left <= 0) {
      return { outcome: "pending", attemptsMade, deadlineReached: true };
    }
    // The inter-attempt pause is capped the same way, so waiting between reads
    // cannot push past the deadline either.
    await sleep(Math.min(intervalMs, left));
  }

  return { outcome: "pending", attemptsMade, deadlineReached: remaining() <= 0 };
}
