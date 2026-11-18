import { describe, expect, it } from "vitest";
import {
  HOLD_OFF_RECHECK_MS,
  LOOP_MAX_REFRESHES,
  LOOP_SUSPEND_MS,
  PROBE_BACKOFF_MAX_MS,
  PROBE_INTERVAL_MS,
  initialPollerState,
  nextWakeDelayMs,
  probeBackoffMs,
  stepPoller,
  type PollerEnv,
  type PollerEvent,
  type PollerState,
} from "@/lib/calendar/change-poller";

const OK: PollerEnv = { visible: true, online: true, dialogOpen: false, editing: false };
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

/** Drives the machine and records every effect, like the component does. */
function rig(baseline = A, t0 = 0) {
  let state: PollerState = initialPollerState(baseline, t0);
  const effects: string[] = [];
  const send = (e: PollerEvent) => {
    const out = stepPoller(state, e);
    state = out.state;
    for (const f of out.effects) effects.push(f.type);
    return out.effects.map((f) => f.type);
  };
  return { get state() { return state; }, effects, send };
}
const tick = (nowMs: number, env = OK): PollerEvent => ({ type: "tick", nowMs, env });
const ok = (nowMs: number, fingerprint: string, env = OK): PollerEvent => ({ type: "probed", nowMs, env, result: { kind: "ok", fingerprint }, jitter: 0.5 });
const transient = (nowMs: number): PollerEvent => ({ type: "probed", nowMs, env: OK, result: { kind: "transient" }, jitter: 0.5 });

describe("when it probes", () => {
  it("not before the interval, then once", () => {
    const r = rig();
    expect(r.send(tick(PROBE_INTERVAL_MS - 1))).toEqual([]);
    expect(r.send(tick(PROBE_INTERVAL_MS))).toEqual(["probe"]);
  });
  it("never two requests at once: a tick while one is in flight sends nothing", () => {
    const r = rig();
    r.send(tick(PROBE_INTERVAL_MS));
    expect(r.send(tick(PROBE_INTERVAL_MS * 5))).toEqual([]);
    expect(r.send({ type: "returned", nowMs: PROBE_INTERVAL_MS * 6, env: OK })).toEqual([]);
  });
  it("never while hidden or offline", () => {
    const r = rig();
    expect(r.send(tick(10_000, { ...OK, visible: false }))).toEqual([]);
    expect(r.send(tick(10_000, { ...OK, online: false }))).toEqual([]);
  });
  it("hiding the tab aborts the request in flight, and its late answer decides nothing", () => {
    const r = rig();
    r.send(tick(PROBE_INTERVAL_MS));
    expect(r.send({ type: "hidden" })).toEqual(["abort"]);
    expect(r.send(ok(PROBE_INTERVAL_MS + 100, B))).toEqual([]);
    expect(r.state.pending).toBeNull();
  });
  it("returning to the tab probes IMMEDIATELY, even inside a back-off window", () => {
    const r = rig();
    r.send(tick(PROBE_INTERVAL_MS));
    r.send(transient(2_000));
    r.send(transient(2_001)); // late duplicate is ignored: not in flight
    expect(r.state.nextProbeAtMs).toBeGreaterThan(2_500); // backed off: the next scheduled probe is later than the return below
    expect(r.send({ type: "returned", nowMs: 2_500, env: OK })).toEqual(["probe"]);
  });
});

describe("when it refreshes", () => {
  it("only when the server fingerprint differs from the baseline", () => {
    const r = rig();
    r.send(tick(PROBE_INTERVAL_MS));
    expect(r.send(ok(1_600, A))).toEqual([]); // same: nothing
    expect(r.effects).not.toContain("refresh");
  });
  it("on a change it refreshes once", () => {
    const r = rig();
    r.send(tick(PROBE_INTERVAL_MS));
    expect(r.send(ok(1_600, B))).toEqual(["refresh"]);
  });
  it("a new render's fingerprint becomes the baseline: the same value is then no change", () => {
    const r = rig();
    r.send(tick(PROBE_INTERVAL_MS));
    r.send(ok(1_600, B)); // refresh fired
    r.send({ type: "baseline", fingerprint: B });
    r.send(tick(4_000));
    expect(r.send(ok(4_100, B))).toEqual([]);
  });
  it("own actions: a render that already carries the new fingerprint costs no refresh", () => {
    const r = rig();
    r.send({ type: "baseline", fingerprint: B });
    r.send(tick(PROBE_INTERVAL_MS));
    expect(r.send(ok(1_600, B))).toEqual([]);
  });
});

describe("hold-offs keep a change pending, never drop it", () => {
  for (const [name, env] of [
    ["a dialog is open", { ...OK, dialogOpen: true }],
    ["a field has focus", { ...OK, editing: true }],
  ] as const) {
    it(`${name}: no refresh, change stays pending, applied when it clears`, () => {
      const r = rig();
      r.send(tick(PROBE_INTERVAL_MS, env));
      expect(r.send(ok(1_600, B, env))).toEqual([]);
      expect(r.state.pending).toBe(B);
      expect(r.state.baseline).toBe(A); // baseline never advances early
      expect(nextWakeDelayMs(r.state, 1_700, env)).toBe(HOLD_OFF_RECHECK_MS);
      expect(r.send(tick(2_200, env))).not.toContain("refresh");
      expect(r.send(tick(2_700, OK))).toContain("refresh");
      expect(r.state.pending).toBeNull();
    });
  }
  it("hidden tab: a change seen while hidden is applied on return", () => {
    const r = rig();
    r.send(tick(PROBE_INTERVAL_MS));
    r.send(ok(1_600, B, { ...OK, visible: false }));
    expect(r.state.pending).toBe(B);
    expect(r.send({ type: "returned", nowMs: 9_000, env: OK })).toContain("refresh");
  });
  it("a pending change that the next render already shows is cleared", () => {
    const r = rig();
    r.send(tick(PROBE_INTERVAL_MS, { ...OK, dialogOpen: true }));
    r.send(ok(1_600, B, { ...OK, dialogOpen: true }));
    r.send({ type: "baseline", fingerprint: B });
    expect(r.state.pending).toBeNull();
  });
});

describe("errors", () => {
  it("back off exponentially to a cap, and reset on success", () => {
    expect(probeBackoffMs(0)).toBe(PROBE_INTERVAL_MS);
    expect(probeBackoffMs(1)).toBe(PROBE_INTERVAL_MS * 2);
    expect(probeBackoffMs(2)).toBe(PROBE_INTERVAL_MS * 4);
    expect(probeBackoffMs(50)).toBe(PROBE_BACKOFF_MAX_MS);
    const r = rig();
    let now = PROBE_INTERVAL_MS;
    r.send(tick(now));
    r.send(transient(now + 50));
    expect(r.state.consecutiveErrors).toBe(1);
    now = r.state.nextProbeAtMs;
    r.send(tick(now));
    r.send(transient(now + 50));
    expect(r.state.consecutiveErrors).toBe(2);
    expect(r.state.nextProbeAtMs - (now + 50)).toBe(probeBackoffMs(2));
    now = r.state.nextProbeAtMs;
    r.send(tick(now));
    r.send(ok(now + 50, A));
    expect(r.state.consecutiveErrors).toBe(0);
  });
  it("a failure never refreshes", () => {
    const r = rig();
    r.send(tick(PROBE_INTERVAL_MS));
    r.send(transient(1_600));
    expect(r.effects).not.toContain("refresh");
  });
  it("an auth refusal stops polling for good", () => {
    const r = rig();
    r.send(tick(PROBE_INTERVAL_MS));
    r.send({ type: "probed", nowMs: 1_600, env: OK, result: { kind: "auth" }, jitter: 0 });
    expect(r.state.stopped).toBe(true);
    expect(r.send(tick(999_999))).toEqual([]);
    expect(r.send({ type: "returned", nowMs: 1_000_000, env: OK })).toEqual([]);
    expect(nextWakeDelayMs(r.state, 1_000_000, OK)).toBeNull();
  });
});

describe("the refresh loop it is built against", () => {
  it("a mismatch that persists costs ONE refresh, not one per probe", () => {
    const r = rig();
    let now = PROBE_INTERVAL_MS;
    let refreshes = 0;
    for (let i = 0; i < 20; i += 1) {
      r.send(tick(now));
      refreshes += r.send(ok(now + 50, B)).filter((e) => e === "refresh").length;
      // the render came back still carrying A (a disagreement between page and probe)
      r.send({ type: "baseline", fingerprint: A });
      now += 2_000;
    }
    expect(refreshes).toBe(1);
  });
  it("a fingerprint that keeps changing is capped by the breaker, which logs once and suspends", () => {
    const r = rig();
    let now = PROBE_INTERVAL_MS;
    const seen: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      r.send(tick(now));
      seen.push(...r.send(ok(now + 10, `${i.toString(16).padStart(2, "0")}${"0".repeat(30)}`)));
      now += 2_000;
    }
    expect(seen.filter((e) => e === "refresh")).toHaveLength(LOOP_MAX_REFRESHES);
    expect(seen.filter((e) => e === "log")).toHaveLength(1);
    expect(r.state.suspendedUntilMs).toBeGreaterThan(0);
    expect(nextWakeDelayMs(r.state, now, OK)).toBeGreaterThan(0);
    // after the suspension it resumes
    const later = r.state.suspendedUntilMs + 1;
    expect(r.send(tick(later))).toContain("probe");
    expect(LOOP_SUSPEND_MS).toBeGreaterThan(60_000);
  });
});

describe("nextWakeDelayMs", () => {
  it("sleeps while hidden or in flight; otherwise wakes at the next probe", () => {
    const s = initialPollerState(A, 0);
    expect(nextWakeDelayMs(s, 0, { ...OK, visible: false })).toBeNull();
    expect(nextWakeDelayMs(s, 0, OK)).toBe(PROBE_INTERVAL_MS);
    expect(nextWakeDelayMs({ ...s, inFlight: true }, 0, OK)).toBeNull();
  });
});
