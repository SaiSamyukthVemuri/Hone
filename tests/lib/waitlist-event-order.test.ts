import { describe, expect, it } from "vitest";
import {
  firstInversion,
  linearizeByTransitionChain,
  type EventRow,
} from "../db/helpers/event-order";

// WAIT-03 — the reconstruction of lifecycle event order, proven WITHOUT a
// database, because the defect is in the algorithm rather than in any data.
//
// THE FINDING THIS FILE RECORDS. The previous reconstruction walked the
// transition chain and, where a transition REPEATED, assigned the repeats to
// their slots in `occurred_at` order. Review pointed out that this can reassign
// rows between cycles and so hide an inversion involving DIFFERENT transitions —
// contradicting the limit the code claimed for itself, which was that only
// inversions between IDENTICAL transitions could go undetected.
//
// That is reproduced below against the real history shape it concerns: two
// complete release/requeue cycles.

const at = (ms: number) => new Date(1_700_000_000_000 + ms);
const ev = (from: string | null, to: string, ms: number): EventRow => ({
  from_status: from,
  to_status: to,
  occurred_at: at(ms),
});

/**
 * THE RETIRED ALGORITHM, reproduced exactly so the reproduction is executable
 * rather than argued. Shape-check, then assign each repeated transition class to
 * its slots in timestamp order.
 */
function legacyCanonicalize(rows: EventRow[]): EventRow[] {
  const heads = rows.filter((r) => r.from_status === null);
  const used = rows.map(() => false);
  const path: EventRow[] = [];
  const found: EventRow[][] = [];
  const walk = (i: number): void => {
    used[i] = true;
    path.push(rows[i]);
    if (path.length === rows.length) found.push([...path]);
    else {
      for (let j = 0; j < rows.length; j += 1) {
        if (!used[j] && rows[j].from_status === rows[i].to_status) walk(j);
      }
    }
    path.pop();
    used[i] = false;
  };
  walk(rows.indexOf(heads[0]));
  const key = (r: EventRow) => `${r.from_status}->${r.to_status}`;
  const byLabel = new Map<string, EventRow[]>();
  for (const r of rows) byLabel.set(key(r), [...(byLabel.get(key(r)) ?? []), r]);
  for (const list of byLabel.values()) {
    list.sort((x, y) => x.occurred_at.getTime() - y.occurred_at.getTime());
  }
  return found[0].map((r) => byLabel.get(key(r))!.shift()!);
}

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

describe("P2-B — timestamps must never establish event identity", () => {
  it("REPRODUCTION: the retired algorithm reports a backwards history as ordered", () => {
    // The observer's record shows the inversion plainly.
    expect(
      firstInversion(TRUE_EXECUTION_ORDER),
      "the fixture is supposed to contain an inversion",
    ).not.toBeNull();

    // The retired reconstruction sees the same eight rows and, because it sorts
    // each repeated transition class by the timestamp under test, hands back a
    // sequence that is perfectly ordered. The inversion is GONE.
    const rebuilt = legacyCanonicalize(TWO_CYCLES);
    expect(
      firstInversion(rebuilt),
      "the retired algorithm was supposed to hide this inversion",
    ).toBeNull();

    // And it is the same history: identical rows, only the cycle identity differs.
    const bag = (rows: EventRow[]) =>
      rows.map((r) => `${r.from_status}->${r.to_status}@${r.occurred_at.getTime()}`).sort();
    expect(bag(rebuilt)).toEqual(bag(TRUE_EXECUTION_ORDER));
  });

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
