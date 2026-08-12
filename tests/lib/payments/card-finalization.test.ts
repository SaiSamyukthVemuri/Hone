import { describe, expect, it } from "vitest";
import {
  pollForCardPersistence,
  type CardConfirmResult,
} from "@/lib/payments/card-finalization";

// BEHAVIOURAL proof of the card finalization state machine.
//
// This is the real code path the portal runs — the component delegates to
// pollForCardPersistence. It is tested here rather than through the browser
// because the unit lane's environment is "node" with no DOM shim or React
// testing library, and the fake-Stripe e2e lane cannot drive Stripe Elements
// (confirmSetup needs real Stripe.js and a live client_secret; e2e-payment/
// exercises server-authoritative charge flows instead). Extracting the state
// machine is what makes the decisions testable at all.

const saved = (): CardConfirmResult => ({
  ok: true,
  state: "saved",
  brand: "visa",
  last4: "4242",
});
const pending = (): CardConfirmResult => ({ ok: true, state: "pending" });
const rejected = (): CardConfirmResult => ({ ok: true, state: "rejected" });
const failed = (): CardConfirmResult => ({ ok: false, error: "transient" });

/** Deterministic clock + instant sleeps: no real waiting, exact bounds. */
function harness(responses: Array<CardConfirmResult | "hang">, msPerSleep = 1200) {
  let t = 0;
  const seen: string[] = [];
  let i = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    confirm: async (setupIntentId: string) => {
      seen.push(setupIntentId);
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r === "hang") {
        // Never resolves on its own — only the per-attempt timeout can end it.
        return new Promise<CardConfirmResult>(() => {});
      }
      return r;
    },
    calls: () => seen,
    clock: () => t,
    msPerSleep,
  };
}

describe("A — ACCEPTED then SAVED", () => {
  it("does not report saved while Hone is still pending, and reports saved once it persists", async () => {
    const h = harness([pending(), pending(), saved()]);
    const out = await pollForCardPersistence({
      setupIntentId: "seti_a",
      confirm: h.confirm,
      now: h.now,
      sleep: h.sleep,
    });
    expect(out.outcome).toBe("saved");
    // Three reads: two pending, then the one that persisted. "saved" could not
    // have been reported earlier because it was not true earlier.
    expect(out.attemptsMade).toBe(3);
    expect(h.calls()).toEqual(["seti_a", "seti_a", "seti_a"]);
  });

  it("returns saved on the very first read when the webhook already won the race", async () => {
    const h = harness([saved()]);
    const out = await pollForCardPersistence({
      setupIntentId: "seti_fast",
      confirm: h.confirm,
      now: h.now,
      sleep: h.sleep,
    });
    expect(out.outcome).toBe("saved");
    expect(out.attemptsMade).toBe(1);
  });

  it("always asks about the SAME SetupIntent — it can never mint another", async () => {
    const h = harness([pending(), pending(), saved()]);
    await pollForCardPersistence({
      setupIntentId: "seti_same",
      confirm: h.confirm,
      now: h.now,
      sleep: h.sleep,
    });
    expect(new Set(h.calls())).toEqual(new Set(["seti_same"]));
  });
});

describe("B — TERMINAL REJECTION", () => {
  it("stops immediately on a durable rejection and never says saved", async () => {
    const h = harness([pending(), rejected(), saved()]);
    const out = await pollForCardPersistence({
      setupIntentId: "seti_b",
      confirm: h.confirm,
      now: h.now,
      sleep: h.sleep,
    });
    expect(out.outcome).toBe("rejected");
    // It must NOT keep polling past a terminal answer and flip to saved.
    expect(out.attemptsMade).toBe(2);
  });

  it("never leaves the caller finalizing indefinitely on rejection", async () => {
    const h = harness([rejected()]);
    const out = await pollForCardPersistence({
      setupIntentId: "seti_b2",
      confirm: h.confirm,
      now: h.now,
      sleep: h.sleep,
      attempts: 12,
    });
    expect(out.outcome).toBe("rejected");
    expect(out.deadlineReached).toBe(false);
  });
});

describe("C — FINALIZATION WINDOW EXPIRES, then recovers", () => {
  it("ends as pending — never saved — when Hone has not persisted in time", async () => {
    const h = harness([pending()]);
    const out = await pollForCardPersistence({
      setupIntentId: "seti_c",
      confirm: h.confirm,
      now: h.now,
      sleep: h.sleep,
    });
    expect(out.outcome).toBe("pending");
    expect(out.attemptsMade).toBeLessThanOrEqual(12);
  });

  it("the WALL CLOCK bounds the window, not just the attempt count", async () => {
    // An attempt budget alone is not a ceiling. Here each sleep advances the
    // clock past the deadline well before the 12 attempts are spent.
    const h = harness([pending()], 9_000);
    const out = await pollForCardPersistence({
      setupIntentId: "seti_deadline",
      confirm: h.confirm,
      now: h.now,
      sleep: async (ms: number) => h.sleep(ms === 1200 ? 9_000 : ms),
      deadlineMs: 20_000,
    });
    expect(out.outcome).toBe("pending");
    expect(out.deadlineReached).toBe(true);
    expect(out.attemptsMade).toBeLessThan(12);
  });

  it("a hung read cannot pin the caller in finalizing forever", async () => {
    // The per-attempt timeout is what ends this; without it the promise never
    // settles and the UI would sit in "finalizing" indefinitely.
    const h = harness(["hang"]);
    const out = await pollForCardPersistence({
      setupIntentId: "seti_hang",
      confirm: h.confirm,
      now: h.now,
      sleep: h.sleep,
      attempts: 2,
      attemptTimeoutMs: 5_000,
    });
    expect(out.outcome).toBe("pending");
    expect(out.attemptsMade).toBe(2);
  });

  it("a transient read failure is treated as not-yet, never as saved", async () => {
    const h = harness([failed(), failed(), saved()]);
    const out = await pollForCardPersistence({
      setupIntentId: "seti_flaky",
      confirm: h.confirm,
      now: h.now,
      sleep: h.sleep,
    });
    expect(out.outcome).toBe("saved");
    expect(out.attemptsMade).toBe(3);
  });

  it("CHECK STATUS AGAIN: a short re-poll on the same SetupIntent reaches saved", async () => {
    // The recovery action re-enters the SAME state machine with a small budget.
    // It issues only confirmation reads — there is no Stripe call in this
    // module at all, so it cannot submit another card.
    const h = harness([pending(), saved()]);
    const out = await pollForCardPersistence({
      setupIntentId: "seti_recover",
      confirm: h.confirm,
      now: h.now,
      sleep: h.sleep,
      attempts: 3,
    });
    expect(out.outcome).toBe("saved");
    expect(out.attemptsMade).toBe(2);
    expect(new Set(h.calls())).toEqual(new Set(["seti_recover"]));
  });

  it("respects the attempt budget exactly", async () => {
    const h = harness([pending()]);
    const out = await pollForCardPersistence({
      setupIntentId: "seti_budget",
      confirm: h.confirm,
      now: h.now,
      sleep: h.sleep,
      attempts: 3,
    });
    expect(out.attemptsMade).toBe(3);
    expect(out.outcome).toBe("pending");
  });

  it("stops immediately when the caller unmounts", async () => {
    const h = harness([pending()]);
    let cancelled = false;
    const out = await pollForCardPersistence({
      setupIntentId: "seti_cancel",
      confirm: async (id) => {
        cancelled = true; // unmount during the first read
        return h.confirm(id);
      },
      now: h.now,
      sleep: h.sleep,
      isCancelled: () => cancelled,
    });
    expect(out.outcome).toBe("pending");
    expect(out.attemptsMade).toBe(1);
  });
});
