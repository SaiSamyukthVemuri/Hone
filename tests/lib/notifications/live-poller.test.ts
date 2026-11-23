import { describe, expect, it } from "vitest";
import {
  SEEN_MAX,
  SUMMARY_INTERVAL_MS,
  applyIds,
  classifyProbeStatus,
  initialLivePollerState,
  nextLiveWakeDelayMs,
  parseSummary,
  stepLivePoller,
  summaryBackoffMs,
  type LivePollerState,
  type PollerEnv,
  type ProbeResult,
} from "@/lib/notifications/live-poller";

const VISIBLE: PollerEnv = { visible: true, online: true, dialogOpen: false, editing: false };
const HIDDEN: PollerEnv = { ...VISIBLE, visible: false };
const OFFLINE: PollerEnv = { ...VISIBLE, online: false };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ME = "aaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbb";
const ok = (unread: number, ids: string[] = [], viewer = ME): ProbeResult => ({ kind: "ok", summary: { unread, ids, viewer } });

/** Start a machine, fire its first probe, and return the in-flight state. */
function inFlight(persisted = 0, seen: string[] = [], viewer: string | null = seen.length ? ME : null) {
  const s = initialLivePollerState(persisted, 0, seen, viewer);
  const out = stepLivePoller(s, { type: "tick", nowMs: 0, env: VISIBLE });
  expect(out.effects).toEqual([{ type: "probe", generation: 0 }]);
  return out.state;
}
const answer = (s: LivePollerState, result: ProbeResult, nowMs = 1_000, env = VISIBLE) => stepLivePoller(s, { type: "probed", nowMs, env, result, jitter: 0.5, generation: s.generation });

describe("when the machine probes", () => {
  it("probes at once on a visible online tab, and never two at a time", () => {
    const s = inFlight();
    expect(s.inFlight).toBe(true);
    expect(stepLivePoller(s, { type: "tick", nowMs: 99_999, env: VISIBLE }).effects).toEqual([]);
  });

  it("a hidden or offline tab sends nothing", () => {
    const s = initialLivePollerState(0, 0);
    expect(stepLivePoller(s, { type: "tick", nowMs: 0, env: HIDDEN }).effects).toEqual([]);
    expect(stepLivePoller(s, { type: "tick", nowMs: 0, env: OFFLINE }).effects).toEqual([]);
    expect(nextLiveWakeDelayMs(s, 0, HIDDEN)).toBeNull();
  });

  it("hiding the tab aborts the request in flight, and its late answer decides nothing", () => {
    const s = inFlight(3);
    const hidden = stepLivePoller(s, { type: "hidden" });
    expect(hidden.effects).toEqual([{ type: "abort" }]);
    const late = answer(hidden.state, ok(9, [id(1)]));
    expect(late.state.persistedUnread).toBe(3);
    expect(late.state.seen).toEqual([]);
  });

  it("returning to the tab checks immediately, even inside the wait", () => {
    const settled = answer(inFlight(), ok(0)).state;
    expect(stepLivePoller(settled, { type: "tick", nowMs: 2_000, env: VISIBLE }).effects).toEqual([]);
    expect(stepLivePoller(settled, { type: "returned", nowMs: 2_000, env: VISIBLE }).effects).toEqual([{ type: "probe", generation: 0 }]);
  });

  it("waits about one interval after a good answer, spread by jitter", () => {
    const lo = stepLivePoller(inFlight(), { type: "probed", nowMs: 0, env: VISIBLE, result: ok(0), jitter: 0, generation: 0 }).state.nextProbeAtMs;
    const hi = stepLivePoller(inFlight(), { type: "probed", nowMs: 0, env: VISIBLE, result: ok(0), jitter: 0.999, generation: 0 }).state.nextProbeAtMs;
    expect(lo).toBe(Math.round(SUMMARY_INTERVAL_MS * 0.9));
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeLessThanOrEqual(Math.round(SUMMARY_INTERVAL_MS * 1.1));
  });
});

describe("failures", () => {
  it("a transient failure keeps the last count and backs off exponentially, capped", () => {
    let s = inFlight(7);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      s = answer(s, { kind: "transient" }, 0).state;
      waits.push(s.nextProbeAtMs);
      expect(s.persistedUnread).toBe(7);
      s = stepLivePoller(s, { type: "returned", nowMs: 0, env: VISIBLE }).state;
    }
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(waits[5]).toBeLessThanOrEqual(summaryBackoffMs(99));
    expect(summaryBackoffMs(0)).toBe(SUMMARY_INTERVAL_MS);
  });

  it("a 403 stops polling for good", () => {
    const s = answer(inFlight(), { kind: "refused" }).state;
    expect(s.stopped).toBe(true);
    expect(stepLivePoller(s, { type: "returned", nowMs: 9e9, env: VISIBLE }).effects).toEqual([]);
    expect(nextLiveWakeDelayMs(s, 0, VISIBLE)).toBeNull();
  });

  it("a transient answer RESETS the 401 strike count: only consecutive 401s stop polling", () => {
    let s = inFlight();
    const next = (r: ProbeResult, n: number) => answer(stepLivePoller(s, { type: "returned", nowMs: n, env: VISIBLE }).state, r, n).state;
    s = answer(s, { kind: "unauthenticated" }, 0).state;
    s = next({ kind: "unauthenticated" }, 1);
    expect(s.unauthStrikes).toBe(2);
    s = next({ kind: "transient" }, 2);
    expect(s.unauthStrikes).toBe(0);
    s = next({ kind: "unauthenticated" }, 3);
    s = next({ kind: "unauthenticated" }, 4);
    expect(s.stopped).toBe(false); // two since the reset, not three
    s = next({ kind: "unauthenticated" }, 5);
    expect(s.stopped).toBe(true);
  });

  it("an opaque redirect (a manual fetch meeting the middleware) is an authentication answer, never a success", () => {
    expect(classifyProbeStatus(0, "opaqueredirect")).toBe("unauthenticated");
    expect(classifyProbeStatus(200, "opaqueredirect")).toBe("unauthenticated");
  });

  it("a 401 stops polling only when it repeats; a good answer in between resets the count", () => {
    let s = inFlight();
    s = answer(s, { kind: "unauthenticated" }, 0).state;
    s = answer(stepLivePoller(s, { type: "returned", nowMs: 1, env: VISIBLE }).state, { kind: "unauthenticated" }, 1).state;
    expect(s.stopped).toBe(false);
    s = answer(stepLivePoller(s, { type: "returned", nowMs: 2, env: VISIBLE }).state, ok(1), 2).state;
    expect(s.unauthStrikes).toBe(0);
    for (let i = 0; i < 3; i++) s = answer(stepLivePoller(s, { type: "returned", nowMs: 3 + i, env: VISIBLE }).state, { kind: "unauthenticated" }, 3 + i).state;
    expect(s.stopped).toBe(true);
  });
});

describe("a fresh server render is authoritative (revision), and a stale answer cannot restore the count (generation)", () => {
  it("tick -> baseline(0) -> a probe that started before it answers 5: the count stays 0 and the stale answer is ignored", () => {
    const started = stepLivePoller(initialLivePollerState(0, 0, [], null, 7), { type: "tick", nowMs: 0, env: VISIBLE });
    expect(started.effects).toEqual([{ type: "probe", generation: 0 }]);
    const rendered = stepLivePoller(started.state, { type: "baseline", persistedUnread: 0, revision: 8 });
    expect(rendered.state.persistedUnread).toBe(0);
    expect(rendered.state.generation).toBe(1);
    expect(rendered.effects).toEqual([{ type: "abort" }]); // the request that read before the render is dropped
    const late = stepLivePoller(rendered.state, { type: "probed", nowMs: 1_000, env: VISIBLE, result: ok(5, [id(1)]), jitter: 0.5, generation: 0 });
    expect(late.state.persistedUnread).toBe(0);
    expect(late.state.seen).toEqual([]);
  });

  it("even when the abort loses the race and a NEW probe is in flight, the OLD generation's answer is ignored", () => {
    let s = stepLivePoller(initialLivePollerState(0, 0), { type: "tick", nowMs: 0, env: VISIBLE }).state;
    s = stepLivePoller(s, { type: "baseline", persistedUnread: 0, revision: 1 }).state; // aborts + generation 1
    s = stepLivePoller(s, { type: "returned", nowMs: 10, env: VISIBLE }).state; // a new probe starts under generation 1
    expect(s.inFlight).toBe(true);
    const stale = stepLivePoller(s, { type: "probed", nowMs: 20, env: VISIBLE, result: ok(5, [id(1)]), jitter: 0.5, generation: 0 });
    expect(stale.state.persistedUnread).toBe(0);
    expect(stale.state.inFlight).toBe(true); // still waiting for the current generation's answer
    const fresh = stepLivePoller(s, { type: "probed", nowMs: 30, env: VISIBLE, result: ok(2, [id(2)]), jitter: 0.5, generation: 1 });
    expect(fresh.state.persistedUnread).toBe(2);
  });

  it("0 -> a poll says 5 -> mark-all-read renders 0 AGAIN: the new revision applies even though the number did not change", () => {
    let s = initialLivePollerState(0, 0, [], null, 1);
    s = stepLivePoller(s, { type: "tick", nowMs: 0, env: VISIBLE }).state;
    s = stepLivePoller(s, { type: "probed", nowMs: 100, env: VISIBLE, result: ok(5, [id(1)]), jitter: 0.5, generation: 0 }).state;
    expect(s.persistedUnread).toBe(5);
    const afterMarkRead = stepLivePoller(s, { type: "baseline", persistedUnread: 0, revision: 2 }).state;
    expect(afterMarkRead.persistedUnread).toBe(0);
  });

  it("the SAME revision again (a re-render of the provider, the machine's own start-up) changes nothing and aborts nothing", () => {
    const started = stepLivePoller(initialLivePollerState(3, 0, [], null, 4), { type: "tick", nowMs: 0, env: VISIBLE }).state;
    const again = stepLivePoller(started, { type: "baseline", persistedUnread: 3, revision: 4 });
    expect(again.state).toBe(started);
    expect(again.effects).toEqual([]);
  });

  it("an unrelated server render while a probe is in flight costs ONE extra probe, at once: the aborted probe is replaced, never lost", () => {
    const started = stepLivePoller(initialLivePollerState(2, 0, [], null, 1), { type: "tick", nowMs: 0, env: VISIBLE }).state;
    const rendered = stepLivePoller(started, { type: "baseline", persistedUnread: 2, revision: 2 }); // e.g. a revalidation from an unrelated action
    expect(rendered.effects).toEqual([{ type: "abort" }]);
    expect(rendered.state.inFlight).toBe(false);
    expect(nextLiveWakeDelayMs(rendered.state, 5, VISIBLE)).toBe(0); // the wake is immediate: nothing waits out the interval
    const next = stepLivePoller(rendered.state, { type: "tick", nowMs: 5, env: VISIBLE });
    expect(next.effects).toEqual([{ type: "probe", generation: 1 }]);
  });

  it("a baseline with no request in flight bumps the generation without an abort", () => {
    const out = stepLivePoller(initialLivePollerState(1, 0, [], null, 1), { type: "baseline", persistedUnread: 0, revision: 2 });
    expect(out.effects).toEqual([]);
    expect(out.state.generation).toBe(1);
  });
});

describe("the count and dedupe by event id", () => {
  it("the answer sets the persisted count; a server render's number replaces it", () => {
    const s = answer(inFlight(2), ok(5, [id(1)])).state;
    expect(s.persistedUnread).toBe(5);
    expect(stepLivePoller(s, { type: "baseline", persistedUnread: 0, revision: 1 }).state.persistedUnread).toBe(0);
  });

  it("the FIRST answer only primes: rows that existed at page load are never arrivals", () => {
    const s = answer(inFlight(), ok(3, [id(1), id(2), id(3)])).state;
    expect(s.arrivals).toEqual([]);
    expect(s.seen).toEqual([id(1), id(2), id(3)]);
  });

  it("an id first seen after priming arrives exactly once, however many polls return it", () => {
    let s = answer(inFlight(), ok(1, [id(1)])).state;
    s = answer(stepLivePoller(s, { type: "returned", nowMs: 2_000, env: VISIBLE }).state, ok(2, [id(2), id(1)]), 2_000).state;
    expect(s.arrivals).toEqual([id(2)]);
    s = answer(stepLivePoller(s, { type: "returned", nowMs: 3_000, env: VISIBLE }).state, ok(2, [id(2), id(1)]), 3_000).state;
    expect(s.arrivals).toEqual([id(2)]);
  });

  it("ids remembered from an earlier load of the same tab are not arrivals again (a reload does not repeat)", () => {
    const first = answer(inFlight(0, [id(5)]), ok(1, [id(5)])).state;
    let s = answer(stepLivePoller(first, { type: "returned", nowMs: 2_000, env: VISIBLE }).state, ok(2, [id(5), id(6)]), 2_000).state;
    expect(s.arrivals).toEqual([id(6)]);
    // the same event delivered by a retry after a failure
    s = answer(stepLivePoller(s, { type: "returned", nowMs: 3_000, env: VISIBLE }).state, { kind: "transient" }, 3_000).state;
    s = answer(stepLivePoller(s, { type: "returned", nowMs: 3_001, env: VISIBLE }).state, ok(2, [id(5), id(6)]), 3_001).state;
    expect(s.arrivals).toEqual([id(6)]);
  });

  it("dedupe is by id, never by text: two arrivals with the same wording are two arrivals", () => {
    // the summary carries no text at all, so identical-looking events can only be told apart by id
    const a = applyIds({ primed: true, seen: [], arrivals: [] }, [id(1), id(2)]);
    expect(a.fresh).toEqual([id(1), id(2)]);
  });

  it("the seen set is bounded, oldest dropped", () => {
    const many = Array.from({ length: SEEN_MAX + 30 }, (_, i) => id(i));
    expect(applyIds({ primed: false, seen: [], arrivals: [] }, many).seen).toHaveLength(SEEN_MAX);
  });
});

describe("the seen set belongs to ONE viewer (a sign-out and sign-in as someone else in the same tab)", () => {
  it("a set remembered for another viewer is discarded: the first person's ids are not carried over, and the first answer only primes", () => {
    const s = answer(inFlight(0, [id(1), id(2)], OTHER), ok(2, [id(1), id(2)], ME)).state;
    expect(s.viewer).toBe(ME);
    expect(s.seen).toEqual([id(1), id(2)]); // re-primed from THIS viewer's own answer, not inherited
    expect(s.arrivals).toEqual([]);
  });

  it("an id the previous person had seen is NOT suppressed for the new person once they have arrived", () => {
    let s = answer(inFlight(0, [id(9)], OTHER), ok(0, [], ME)).state; // new person primes with nothing
    expect(s.seen).toEqual([]);
    s = answer(stepLivePoller(s, { type: "returned", nowMs: 2_000, env: VISIBLE }).state, ok(1, [id(9)], ME), 2_000).state;
    expect(s.arrivals).toEqual([id(9)]);
  });

  it("a set remembered with NO marker is treated as another viewer's", () => {
    const s = answer(inFlight(0, [id(1)], null), ok(1, [id(1)], ME)).state;
    expect(s.viewer).toBe(ME);
    expect(s.arrivals).toEqual([]);
  });

  it("the same viewer keeps the remembered set (a reload does not repeat)", () => {
    const first = answer(inFlight(0, [id(5)], ME), ok(1, [id(5)], ME)).state;
    expect(first.seen).toEqual([id(5)]);
  });

  it("a different viewer's answer mid-session (another tab signed in as someone else) starts over", () => {
    let s = answer(inFlight(), ok(1, [id(1)], ME)).state;
    s = answer(stepLivePoller(s, { type: "returned", nowMs: 2_000, env: VISIBLE }).state, ok(3, [id(1), id(2), id(3)], OTHER), 2_000).state;
    expect(s.viewer).toBe(OTHER);
    expect(s.arrivals).toEqual([]);
    expect(s.seen).toEqual([id(1), id(2), id(3)]);
  });
});

describe("parseSummary refuses anything that is not the contract", () => {
  it.each([
    [null], ["x"], [{}], [{ unread: -1, ids: [] }], [{ unread: 1.5, ids: [] }], [{ unread: "3", ids: [] }],
    [{ unread: 1, ids: ["not-a-uuid"], viewer: ME }], [{ unread: 1, ids: "x", viewer: ME }], [{ unread: 1, ids: Array(21).fill(id(1)), viewer: ME }],
    [{ unread: 1, ids: [] }], [{ unread: 1, ids: [], viewer: "not-opaque" }], [{ unread: 1, ids: [], viewer: 5 }],
  ])("%j is not a summary", (body) => expect(parseSummary(body)).toBeNull());

  it("accepts the contract and drops duplicate ids", () => {
    expect(parseSummary({ unread: 2, ids: [id(1), id(1), id(2)], viewer: ME })).toEqual({ unread: 2, ids: [id(1), id(2)], viewer: ME });
  });
});
