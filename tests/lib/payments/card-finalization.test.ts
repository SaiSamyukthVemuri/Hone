import { describe, expect, it } from "vitest";
import {
  pollForCardPersistence,
  type CardConfirmResult,
} from "@/lib/payments/card-finalization";

// BEHAVIOURAL proof of the card finalization state machine.
//
// This is the real code path the portal runs, the component delegates to
// pollForCardPersistence. It is tested here rather than through the browser
// because the unit lane's environment is "node" with no DOM shim or React
// testing library, and the fake-Stripe browser lane cannot drive Stripe
// Elements (confirmSetup needs real Stripe.js and a live client_secret; the
// payment E2E lane exercises server-authoritative charge flows instead).

const saved = (): CardConfirmResult => ({
  ok: true,
  state: "saved",
  brand: "visa",
  last4: "4242",
});
const pending = (): CardConfirmResult => ({ ok: true, state: "pending" });
const rejected = (): CardConfirmResult => ({ ok: true, state: "rejected" });
const failed = (): CardConfirmResult => ({ ok: false, error: "transient" });

// ---------------------------------------------------------------------------
// FAKE CLOCK, scheduling a timer is NOT the same event as it firing.
//
// The previous harness advanced time inside `sleep`, which was also called to
// construct the losing branch of the timeout race. A confirmation that resolved
// instantly still "spent" its full unused 5s budget, so every fast path was
// mismodelled and the deadline arithmetic was never really under test.
//
// Here `setTimer` only ENQUEUES. Time moves when the code under test awaits
// something that cannot resolve without a timer, at which point the clock jumps
// to the earliest pending timer and fires it. Already-resolved promises win
// their race before any timer runs, so a fast confirm advances the clock by 0.
// ---------------------------------------------------------------------------
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fire: () => void }>();

  const setTimer = (ms: number, fire: () => void) => {
    const id = ++seq;
    timers.set(id, { at: t + ms, fire });
    return () => {
      timers.delete(id);
    };
  };

  /** Fire the earliest pending timer, advancing the clock to its due time. */
  const advanceToNextTimer = (): boolean => {
    let next: { id: number; at: number; fire: () => void } | null = null;
    for (const [id, timer] of timers) {
      if (!next || timer.at < next.at) next = { id, ...timer };
    }
    if (!next) return false;
    timers.delete(next.id);
    t = Math.max(t, next.at);
    next.fire();
    return true;
  };

  /**
   * Drive the machine to completion. Each turn drains the microtask queue with
   * a real macrotask tick; if the result still has not resolved, the machine
   * must be parked on a timer, so we fire the earliest one. A fast confirm
   * therefore never advances the clock.
   */
  const drain = () => new Promise<void>((r) => setImmediate(r));
  const run = async <T>(work: Promise<T>): Promise<T> => {
    let done = false;
    const result = work.then((v) => {
      done = true;
      return v;
    });
    for (let guard = 0; guard < 100_000 && !done; guard++) {
      await drain();
      if (done) break;
      if (!advanceToNextTimer()) break; // parked on nothing: let it settle
    }
    return result;
  };

  return { now: () => t, setTimer, run, elapsed: () => t, pending: () => timers.size };
}

function responder(script: Array<CardConfirmResult | "hang">) {
  const seen: string[] = [];
  let i = 0;
  return {
    calls: () => seen,
    confirm: async (setupIntentId: string) => {
      seen.push(setupIntentId);
      const r = script[Math.min(i++, script.length - 1)];
      if (r === "hang") return new Promise<CardConfirmResult>(() => {});
      return r;
    },
  };
}

describe("A: ACCEPTED then SAVED", () => {
  it("does not report saved while Hone is pending, and reports saved once it persists", async () => {
    const c = fakeClock();
    const r = responder([pending(), pending(), saved()]);
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_a",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
      }),
    );
    expect(out.outcome).toBe("saved");
    expect(out.attemptsMade).toBe(3);
    expect(r.calls()).toEqual(["seti_a", "seti_a", "seti_a"]);
  });

  it("5: a fast successful confirm does NOT advance the clock by its unused timeout", async () => {
    // The specific harness defect this replaces: scheduling the losing timeout
    // used to consume its full budget even when the read won instantly.
    const c = fakeClock();
    const r = responder([saved()]);
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_fast",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
        attemptTimeoutMs: 5_000,
      }),
    );
    expect(out.outcome).toBe("saved");
    expect(out.attemptsMade).toBe(1);
    expect(c.elapsed()).toBe(0);
    // …and the losing timer was cleared rather than left armed.
    expect(c.pending()).toBe(0);
  });

  it("always asks about the SAME SetupIntent, it can never mint another", async () => {
    const c = fakeClock();
    const r = responder([pending(), pending(), saved()]);
    await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_same",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
      }),
    );
    expect(new Set(r.calls())).toEqual(new Set(["seti_same"]));
  });
});

describe("B: TERMINAL REJECTION", () => {
  it("6: stops immediately on a durable rejection and never says saved", async () => {
    const c = fakeClock();
    const r = responder([pending(), rejected(), saved()]);
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_b",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
      }),
    );
    expect(out.outcome).toBe("rejected");
    expect(out.attemptsMade).toBe(2);
    expect(out.deadlineReached).toBe(false);
  });

  it("6: saved terminates immediately too, with no further reads", async () => {
    const c = fakeClock();
    const r = responder([saved(), rejected()]);
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_b2",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
      }),
    );
    expect(out.outcome).toBe("saved");
    expect(r.calls()).toHaveLength(1);
  });
});

describe("C: the wall-clock deadline is HARD", () => {
  it("1: pending responses stop by the deadline", async () => {
    const c = fakeClock();
    const r = responder([pending()]);
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_deadline",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
        deadlineMs: 20_000,
        intervalMs: 1_200,
        attempts: 1_000, // deliberately generous: the CLOCK must bind, not this
      }),
    );
    expect(out.outcome).toBe("pending");
    expect(out.deadlineReached).toBe(true);
    expect(c.elapsed()).toBeLessThanOrEqual(20_000);
  });

  it("2: a hung read stops at min(per-attempt timeout, remaining deadline)", async () => {
    const c = fakeClock();
    const r = responder(["hang"]);
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_hang",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
        attemptTimeoutMs: 5_000,
        deadlineMs: 20_000,
        attempts: 100,
      }),
    );
    expect(out.outcome).toBe("pending");
    expect(out.deadlineReached).toBe(true);
    // Four 5s hangs exhaust exactly 20s; it must not run to 100 attempts.
    expect(c.elapsed()).toBe(20_000);
    expect(out.attemptsMade).toBeLessThanOrEqual(4);
  });

  it("3: a single attempt cannot exceed the remaining deadline (isolates the attempt clamp)", async () => {
    // ONE attempt, so the inter-attempt clamp cannot mask this. 3s deadline vs a
    // 5s per-attempt budget on a hung read: clamped it settles at exactly 3s;
    // unclamped it would run to 5s and overshoot the whole window.
    const c = fakeClock();
    const r = responder(["hang"]);
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_clamp",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
        attemptTimeoutMs: 5_000,
        deadlineMs: 3_000,
        attempts: 1,
      }),
    );
    expect(out.outcome).toBe("pending");
    expect(out.attemptsMade).toBe(1);
    expect(c.elapsed()).toBe(3_000);
  });

  it("4: interval sleeps cannot push beyond the deadline", async () => {
    // Instant pending replies, so ONLY the inter-attempt pauses consume time.
    // An unclamped 5s interval would overshoot a 12s deadline to 15s.
    const c = fakeClock();
    const r = responder([pending()]);
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_interval",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
        attemptTimeoutMs: 30_000,
        intervalMs: 5_000,
        deadlineMs: 12_000,
        attempts: 100,
      }),
    );
    expect(out.outcome).toBe("pending");
    expect(out.deadlineReached).toBe(true);
    expect(c.elapsed()).toBe(12_000);
  });

  it("a transient read failure is treated as not-yet, never as saved", async () => {
    const c = fakeClock();
    const r = responder([failed(), failed(), saved()]);
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_flaky",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
      }),
    );
    expect(out.outcome).toBe("saved");
    expect(out.attemptsMade).toBe(3);
  });

  it("respects the attempt budget when the clock is not the binding constraint", async () => {
    const c = fakeClock();
    const r = responder([pending()]);
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_budget",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
        attempts: 3,
        deadlineMs: 10_000_000,
      }),
    );
    expect(out.attemptsMade).toBe(3);
    expect(out.outcome).toBe("pending");
  });

  it("stops immediately when the caller unmounts", async () => {
    const c = fakeClock();
    let cancelled = false;
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_cancel",
        confirm: async () => {
          cancelled = true;
          return pending();
        },
        now: c.now,
        setTimer: c.setTimer,
        isCancelled: () => cancelled,
      }),
    );
    expect(out.outcome).toBe("pending");
    expect(out.attemptsMade).toBe(1);
  });
});

describe("7: CHECK STATUS AGAIN", () => {
  it("re-reads the SAME SetupIntent on a small budget and can reach saved", async () => {
    const c = fakeClock();
    const r = responder([pending(), saved()]);
    const out = await c.run(
      pollForCardPersistence({
        setupIntentId: "seti_recover",
        confirm: r.confirm,
        now: c.now,
        setTimer: c.setTimer,
        attempts: 3,
      }),
    );
    expect(out.outcome).toBe("saved");
    expect(out.attemptsMade).toBe(2);
    expect(new Set(r.calls())).toEqual(new Set(["seti_recover"]));
  });

  it("issues no Stripe submission path, the module cannot create or confirm a SetupIntent", async () => {
    // Structural, and necessarily so: this asserts the ABSENCE of a call.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "lib/payments/card-finalization.ts"),
      "utf8",
    );
    const exec = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(exec).not.toMatch(/confirmSetup|createCardSetupIntent|stripe\./);
  });
});
