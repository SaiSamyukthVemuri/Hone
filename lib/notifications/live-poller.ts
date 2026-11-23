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

/** An opaque, stable marker of WHO the answer is for (never a raw id). The seen set is only ever reused for the same marker. */
export type Summary = { unread: number; ids: string[]; viewer: string };
const VIEWER = /^[0-9a-f]{16}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate the endpoint's JSON; anything else is a transient failure, never a number shown on the bell. */
export function parseSummary(body: unknown): Summary | null {
  if (typeof body !== "object" || body === null) return null;
  const { unread, ids, viewer } = body as { unread?: unknown; ids?: unknown; viewer?: unknown };
  if (typeof viewer !== "string" || !VIEWER.test(viewer)) return null;
  if (typeof unread !== "number" || !Number.isInteger(unread) || unread < 0) return null;
  if (!Array.isArray(ids) || ids.length > SUMMARY_MAX_IDS || !ids.every((i) => typeof i === "string" && UUID.test(i))) return null;
  return { unread, ids: [...new Set(ids as string[])], viewer };
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
  /** The server render this machine last took its count from. A render with a DIFFERENT revision is authoritative even when its number is unchanged. */
  revision: number;
  /** Bumped by every authoritative baseline. An answer to a probe started under an older generation is stale and decides nothing. */
  generation: number;
  /** The persisted unread count for this viewer (the computed disinfectant part is added by the provider, never here). */
  persistedUnread: number;
  /** True once one answer has been received: the first answer only primes `seen`. */
  primed: boolean;
  /** Who `seen` belongs to (null until known). A different viewer's answer discards it. */
  viewer: string | null;
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
  | { type: "baseline"; persistedUnread: number; revision: number }
  /** `generation` is the one the probe STARTED under (carried by the `probe` effect that began it). */
  | { type: "probed"; nowMs: number; env: PollerEnv; result: ProbeResult; jitter: number; generation: number };

export type LivePollerEffect = { type: "probe"; generation: number } | { type: "abort" };

export function initialLivePollerState(
  persistedUnread: number,
  nowMs: number,
  initialSeen: readonly string[] = [],
  initialViewer: string | null = null,
  revision = 0,
): LivePollerState {
  return {
    inFlight: false,
    nextProbeAtMs: nowMs,
    consecutiveErrors: 0,
    unauthStrikes: 0,
    stopped: false,
    revision,
    generation: 0,
    persistedUnread,
    primed: false,
    viewer: initialViewer,
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
    return { state: { ...input, inFlight: true }, effects: [{ type: "probe", generation: input.generation }] };
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
    case "baseline": {
      // The same render again (this machine's own start-up, a re-render of the provider): nothing new.
      if (event.revision === state.revision) return { state, effects: [] };
      // A NEW server render is authoritative for the persisted count, whatever its number: a render that says 0 after a poll said 5 must
      // show 0, so the revision (not the number) is what marks it fresh. A request that read before this render and resolves after it
      // would restore the stale number, so the generation moves on and that request is aborted; its late answer is also ignored by
      // generation, in case the abort loses the race.
      return {
        state: { ...state, persistedUnread: event.persistedUnread, revision: event.revision, generation: state.generation + 1, inFlight: false },
        effects: state.inFlight ? [{ type: "abort" }] : [],
      };
    }
    case "probed": {
      // A late answer to a request that was aborted or superseded decides nothing.
      if (!state.inFlight || event.generation !== state.generation) return { state, effects: [] };
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
      // The seen set belongs to ONE viewer. An answer for a different (or, for a set remembered without a marker, unknown) viewer
      // means a sign-out and sign-in as someone else in this tab: drop everything remembered and prime afresh.
      const sameViewer = next.viewer === r.summary.viewer;
      const base = sameViewer ? next : { ...next, seen: [], arrivals: [], primed: false };
      const applied = applyIds(base, r.summary.ids);
      return settle(
        {
          ...next,
          consecutiveErrors: 0,
          unauthStrikes: 0,
          nextProbeAtMs: event.nowMs + wait,
          persistedUnread: r.summary.unread,
          primed: true,
          viewer: r.summary.viewer,
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
