// PURE. The rules by which the signed-in shell decides WHEN to ask "how many unread notifications do I have, and which are new?"
// NotificationsProvider only wires timers, fetch and storage to this; every rule is testable here without a browser (the repo has
// no jsdom, the same split as lib/calendar/change-poller, whose status classifier and bounds this reuses on purpose).
//
// Rules, as the HON-48 bounds applied to the bell:
//   * ONE poll per tab: the provider is mounted once in the shell, never inside a bell (the header renders every control twice)
//   * poll only while the tab is VISIBLE and online; a hidden tab aborts its request and sends nothing
//   * never two requests at once (the next is scheduled only after one settles)
//   * back off exponentially after errors, up to a cap; a refusal (403) stops polling for good; a 401 or redirect stops it only
//     when it repeats (a middleware blip looks the same as an expired session)
//   * check IMMEDIATELY when the tab becomes visible, focused or online again
//
// DEDUPE IS BY EVENT ID, never by text. The first answer a screen receives only PRIMES the seen set (rows that already existed
// when the page loaded are never "new"); after that, an id the screen has not seen is an arrival, once, however many polls, retries,
// reconnects or reloads return it (the seen set is persisted for the tab by the provider and handed back as `initialSeen`).
//
// The answer carries ids and a count only: no text, no client name (a toast's wording is a product decision, and the centre shows the
// same viewer exactly what the summary counted).
import {
  PROBE_BACKOFF_MAX_MS,
  UNAUTH_CONFIRM_STRIKES,
  classifyProbeStatus,
  type PollerEnv,
} from "@/lib/calendar/change-poller";

export { classifyProbeStatus };
export type { PollerEnv };

/** Named so the interval can be tuned against the measured request cost. */
export const SUMMARY_INTERVAL_MS = 30_000;
/** A request that has not answered by then is aborted and counted as a transient failure. */
export const SUMMARY_TIMEOUT_MS = 8_000;
/** The most ids the endpoint returns and the most the screen remembers. */
export const SUMMARY_MAX_IDS = 20;
export const SEEN_MAX = 200;
export const ARRIVALS_MAX = 50;

export type Summary = { unread: number; ids: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate the endpoint's JSON; anything else is a transient failure, never a number shown on the bell. */
export function parseSummary(body: unknown): Summary | null {
  if (typeof body !== "object" || body === null) return null;
  const { unread, ids } = body as { unread?: unknown; ids?: unknown };
  if (typeof unread !== "number" || !Number.isInteger(unread) || unread < 0) return null;
  if (!Array.isArray(ids) || ids.length > SUMMARY_MAX_IDS || !ids.every((i) => typeof i === "string" && UUID.test(i))) return null;
  return { unread, ids: [...new Set(ids as string[])] };
}

export type ProbeResult =
  | { kind: "ok"; summary: Summary }
  | { kind: "transient" }
  | { kind: "refused" }
  | { kind: "unauthenticated" };

export type LivePollerState = {
  inFlight: boolean;
  nextProbeAtMs: number;
  consecutiveErrors: number;
  unauthStrikes: number;
  stopped: boolean;
  /** The persisted unread count for this viewer (the computed disinfectant part is added by the provider, never here). */
  persistedUnread: number;
  /** True once one answer has been received: the first answer only primes `seen`. */
  primed: boolean;
  /** Ids this screen has already accounted for, newest last, bounded. */
  seen: string[];
  /** Ids that arrived after the screen loaded, each exactly once, newest last, bounded. */
  arrivals: string[];
};

export type LivePollerEvent =
  | { type: "tick"; nowMs: number; env: PollerEnv }
  | { type: "returned"; nowMs: number; env: PollerEnv }
  | { type: "hidden" }
  /** A new server render carried its own count (navigation, a mark-read): the server's number wins. */
  | { type: "baseline"; persistedUnread: number }
  | { type: "probed"; nowMs: number; env: PollerEnv; result: ProbeResult; jitter: number };

export type LivePollerEffect = { type: "probe" } | { type: "abort" };

export function initialLivePollerState(persistedUnread: number, nowMs: number, initialSeen: readonly string[] = []): LivePollerState {
  return {
    inFlight: false,
    nextProbeAtMs: nowMs,
    consecutiveErrors: 0,
    unauthStrikes: 0,
    stopped: false,
    persistedUnread,
    primed: false,
    seen: initialSeen.filter((i) => UUID.test(i)).slice(-SEEN_MAX),
    arrivals: [],
  };
}

/** The wait after the n-th consecutive failure: 60 s, 120 s ... capped (the interval is already long, so back-off starts above it). */
export function summaryBackoffMs(consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) return SUMMARY_INTERVAL_MS;
  return Math.min(PROBE_BACKOFF_MAX_MS * 5, SUMMARY_INTERVAL_MS * 2 ** consecutiveErrors);
}

type Step = { state: LivePollerState; effects: LivePollerEffect[] };

function settle(input: LivePollerState, nowMs: number, env: PollerEnv): Step {
  if (input.stopped) return { state: input, effects: [] };
  if (!input.inFlight && env.visible && env.online && nowMs >= input.nextProbeAtMs) {
    return { state: { ...input, inFlight: true }, effects: [{ type: "probe" }] };
  }
  return { state: input, effects: [] };
}

/** Which of `ids` are new to `state`, and the next seen set. Pure; exported for the unit tests. */
export function applyIds(state: Pick<LivePollerState, "primed" | "seen" | "arrivals">, ids: readonly string[]) {
  const known = new Set(state.seen);
  const fresh = ids.filter((i) => !known.has(i));
  const seen = [...state.seen, ...fresh].slice(-SEEN_MAX);
  const arrivals = state.primed ? [...state.arrivals, ...fresh].slice(-ARRIVALS_MAX) : state.arrivals;
  return { seen, arrivals, fresh: state.primed ? fresh : [] };
}

export function stepLivePoller(state: LivePollerState, event: LivePollerEvent): Step {
  switch (event.type) {
    case "tick":
      return settle(state, event.nowMs, event.env);
    case "returned":
      // Immediate check on return, even inside a back-off window; the error count is kept so a dead endpoint still backs off.
      return settle({ ...state, nextProbeAtMs: Math.min(state.nextProbeAtMs, event.nowMs) }, event.nowMs, event.env);
    case "hidden":
      return state.inFlight ? { state: { ...state, inFlight: false }, effects: [{ type: "abort" }] } : { state, effects: [] };
    case "baseline":
      return { state: { ...state, persistedUnread: event.persistedUnread }, effects: [] };
    case "probed": {
      // A late answer to a request that was aborted or superseded decides nothing.
      if (!state.inFlight) return { state, effects: [] };
      const next: LivePollerState = { ...state, inFlight: false };
      const r = event.result;
      if (r.kind === "refused") return { state: { ...next, stopped: true }, effects: [] };
      if (r.kind === "unauthenticated" || r.kind === "transient") {
        const errors = next.consecutiveErrors + 1;
        const strikes = r.kind === "unauthenticated" ? next.unauthStrikes + 1 : 0;
        if (strikes >= UNAUTH_CONFIRM_STRIKES) return { state: { ...next, unauthStrikes: strikes, stopped: true }, effects: [] };
        // The last known count is KEPT on failure; only a good answer changes it.
        return settle({ ...next, consecutiveErrors: errors, unauthStrikes: strikes, nextProbeAtMs: event.nowMs + summaryBackoffMs(errors) }, event.nowMs, event.env);
      }
      // A little jitter keeps several tabs from probing in lockstep.
      const wait = Math.round(SUMMARY_INTERVAL_MS * (0.9 + 0.2 * event.jitter));
      const applied = applyIds(next, r.summary.ids);
      return settle(
        {
          ...next,
          consecutiveErrors: 0,
          unauthStrikes: 0,
          nextProbeAtMs: event.nowMs + wait,
          persistedUnread: r.summary.unread,
          primed: true,
          seen: applied.seen,
          arrivals: applied.arrivals,
        },
        event.nowMs,
        event.env,
      );
    }
  }
}

/** Milliseconds until the machine next has something to do, or null when only an event (a result, a return) can wake it. */
export function nextLiveWakeDelayMs(state: LivePollerState, nowMs: number, env: PollerEnv): number | null {
  if (state.stopped || state.inFlight || !env.visible || !env.online) return null;
  return Math.max(0, state.nextProbeAtMs - nowMs);
}
