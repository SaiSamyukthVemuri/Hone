import { describe, expect, it } from "vitest";
import {
  firstInversion,
  linearizeByTransitionChain,
  type EventRow,
} from "../db/helpers/event-order";

// WAIT-03 — reconstructing the order of an entry's lifecycle events from its
// transition labels, with no database needed.
//
// The contract that matters: this recovers an order ONLY when the labels
// determine exactly one, and refuses otherwise. A history that repeats a
// transition — two release/requeue cycles reach `waiting` three times — could
// only be disambiguated by `occurred_at`, which is the evidence these suites
// exist to check. So it refuses, and the concurrency tests capture event
// identity as they go instead.

const at = (ms: number) => new Date(1_700_000_000_000 + ms);
const ev = (from: string | null, to: string, ms: number): EventRow => ({
  from_status: from,
  to_status: to,
  occurred_at: at(ms),
});

// TWO COMPLETE CYCLES. Both orderings below contain exactly the same eight rows;
// they differ only in which cycle each repeated transition belongs to — which is
// precisely what a timestamp cannot tell you.
const TWO_CYCLES: EventRow[] = [
  ev(null, "waiting", 0),
  ev("waiting", "claimed", 10),
  ev("claimed", "invited", 20),
  ev("invited", "released", 30),
  ev("released", "waiting", 40),
  ev("waiting", "claimed", 50),
  ev("claimed", "invited", 60),
  ev("invited", "released", 70),
];

// The order in which the operations ACTUALLY ran, as an observer that controlled
// them would have recorded it. Cycle 1 took the LATE `waiting -> claimed` (50)
// and then an EARLIER `claimed -> invited` (20): it ran backwards.
const TRUE_EXECUTION_ORDER: EventRow[] = [
  ev(null, "waiting", 0),
  ev("waiting", "claimed", 50), // cycle 1
  ev("claimed", "invited", 20), // cycle 1 — 20 < 50, the inversion
  ev("invited", "released", 30),
  ev("released", "waiting", 40),
  ev("waiting", "claimed", 10), // cycle 2
  ev("claimed", "invited", 60),
  ev("invited", "released", 70),
];

describe("lifecycle event ordering — labels alone, never timestamps", () => {

  it("the replacement REFUSES rather than guessing", () => {
    const out = linearizeByTransitionChain(TWO_CYCLES);
    expect(out.ok, "a repeated history must not be linearized from labels alone").toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("ambiguous");
    // The message has to send the reader somewhere better, not just say no.
    expect(out.detail).toMatch(/identity at each operation boundary/i);
    expect(out.detail).toMatch(/occurred_at/);
  });

  it("a history that repeats NO transition still linearizes, and exactly", () => {
    const single: EventRow[] = [
      ev(null, "waiting", 0),
      ev("invited", "released", 30),
      ev("waiting", "claimed", 10),
      ev("claimed", "invited", 20),
    ];
    const out = linearizeByTransitionChain(single);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.chain.map((r) => r.to_status)).toEqual([
      "waiting",
      "claimed",
      "invited",
      "released",
    ]);
    expect(firstInversion(out.chain)).toBeNull();
  });

  it("linearization ignores the timestamps entirely", () => {
    // Same shape, timestamps reversed. The chain must be identical, and the
    // inversion must then be REPORTED rather than sorted away.
    const backwards: EventRow[] = [
      ev(null, "waiting", 100),
      ev("waiting", "claimed", 70),
      ev("claimed", "invited", 40),
      ev("invited", "released", 10),
    ];
    const out = linearizeByTransitionChain(backwards);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.chain.map((r) => r.to_status)).toEqual([
      "waiting",
      "claimed",
      "invited",
      "released",
    ]);
    expect(firstInversion(out.chain)).not.toBeNull();
  });

  it("a broken chain is reported, not silently truncated", () => {
    const orphaned: EventRow[] = [ev(null, "waiting", 0), ev("invited", "released", 10)];
    const out = linearizeByTransitionChain(orphaned);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("no-chain");
  });

  it("NEGATIVE CONTROL: firstInversion catches an inversion moved in memory", () => {
    // The chronology check must bite on data the harness perturbs, so that a
    // green result means something. The append-only table is never written to.
    const clean: EventRow[] = [
      ev(null, "waiting", 0),
      ev("waiting", "claimed", 10),
      ev("claimed", "invited", 20),
    ];
    expect(firstInversion(clean)).toBeNull();
    const perturbed = clean.map((r, i) => (i === 2 ? ev(r.from_status, r.to_status, 5) : r));
    expect(firstInversion(perturbed), "an inverted successor was not caught").not.toBeNull();
  });
});
