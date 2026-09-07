import { describe, expect, it } from "vitest";

import {
  combineFacts,
  known,
  mapFact,
  notYetSupported,
  unknownBecause,
  type Fact,
  type FinancialUnknownCause,
} from "@/lib/finance/financial-fact";
import {
  UNKNOWN_ACTION,
  UNKNOWN_EXPLANATION,
  UNKNOWN_LABEL,
} from "@/lib/finance/financial-copy";

const ALL_CAUSES: FinancialUnknownCause[] = [
  "not_recorded",
  "unavailable",
  "unknowable",
  "not_yet_supported",
  "not_enumerable",
  "records_incomplete",
];

describe("Fact<T> — known zero is a value, every absence is a cause", () => {
  it("KNOWN ZERO IS NOT UNKNOWN. It is the answer when we looked and it was nothing", () => {
    const zero = known(0);
    expect(zero.known).toBe(true);
    expect(zero).toEqual({ known: true, value: 0 });
  });

  it("every unknown carries a cause, and no unknown carries a value", () => {
    for (const cause of ALL_CAUSES) {
      const fact = unknownBecause<number>(cause);
      expect(fact.known).toBe(false);
      expect(fact).not.toHaveProperty("value");
      if (!fact.known) expect(fact.cause).toBe(cause);
    }
  });

  it("mapFact cannot invent a value: the transform never runs on an unknown", () => {
    let ran = 0;
    const out = mapFact(unknownBecause<number>("unavailable"), (n) => {
      ran += 1;
      return n * 2;
    });
    expect(ran).toBe(0);
    expect(out.known).toBe(false);
    if (!out.known) expect(out.cause).toBe("unavailable");
  });

  it("mapFact preserves a known zero rather than treating it as falsy", () => {
    const out = mapFact(known(0), (n) => n + 1);
    expect(out).toEqual({ known: true, value: 1 });
  });

  it("UNKNOWN IS CONTAGIOUS through combineFacts, and the first cause wins", () => {
    const a = unknownBecause<number>("not_recorded");
    const b = unknownBecause<number>("unavailable");
    const out = combineFacts(a, b, (x, y) => x + y);
    expect(out.known).toBe(false);
    // The owner reads the sentence for the thing that actually went wrong,
    // not for whichever operand happened to be second.
    if (!out.known) expect(out.cause).toBe("not_recorded");
  });

  it("combineFacts adds two known zeroes to a known zero", () => {
    expect(combineFacts(known(0), known(0), (x, y) => x + y)).toEqual({
      known: true,
      value: 0,
    });
  });

  it("notYetSupported() is a release statement, never a studio one", () => {
    const fact: Fact<number> = notYetSupported<number>();
    expect(fact).toEqual({ known: false, cause: "not_yet_supported" });
  });
});

describe("every cause is its own sentence", () => {
  it("ALL_CAUSES IS COMPLETE — the list cannot silently fall behind the union", () => {
    // Without this, adding a cause to the union leaves every loop below quietly
    // under-covering it: the suite stays green while the new member is never
    // exercised. UNKNOWN_LABEL is keyed by the union, so the compiler forces it
    // to hold every member, which makes its keys the honest census.
    expect([...ALL_CAUSES].sort()).toEqual(Object.keys(UNKNOWN_LABEL).sort());
    expect([...ALL_CAUSES].sort()).toEqual(Object.keys(UNKNOWN_EXPLANATION).sort());
    expect(new Set(ALL_CAUSES).size).toBe(ALL_CAUSES.length);
  });

  it("every cause has a label and an explanation", () => {
    for (const cause of ALL_CAUSES) {
      expect(UNKNOWN_LABEL[cause].length).toBeGreaterThan(0);
      expect(UNKNOWN_EXPLANATION[cause].length).toBeGreaterThan(30);
    }
  });

  it("no two causes share a label or an explanation", () => {
    const labels = ALL_CAUSES.map((c) => UNKNOWN_LABEL[c]);
    const explanations = ALL_CAUSES.map((c) => UNKNOWN_EXPLANATION[c]);
    expect(new Set(labels).size).toBe(ALL_CAUSES.length);
    expect(new Set(explanations).size).toBe(ALL_CAUSES.length);
  });

  it("NO DISPOSITION RECORDED is not the same claim as a READ FAILURE", () => {
    // The whole reason this type exists. One is the studio's state; the other
    // is Hone's. Collapsing them was the design review's rejected proposal.
    expect(UNKNOWN_LABEL.not_recorded).not.toBe(UNKNOWN_LABEL.unavailable);
    expect(UNKNOWN_EXPLANATION.not_recorded).not.toBe(UNKNOWN_EXPLANATION.unavailable);
  });

  it("HISTORICALLY UNKNOWABLE is not the same claim as CURRENTLY UNAVAILABLE", () => {
    // One will never have an answer; the other might on the next request. Only
    // one of them is worth offering the owner an action for.
    expect(UNKNOWN_LABEL.unknowable).not.toBe(UNKNOWN_LABEL.unavailable);
    expect(UNKNOWN_EXPLANATION.unknowable).not.toBe(UNKNOWN_EXPLANATION.unavailable);
    expect(UNKNOWN_ACTION.unknowable).toBeUndefined();
    expect(UNKNOWN_ACTION.unavailable).toBeTruthy();
  });

  it("no cause is presented as a zero, a dash, or a shared 'Not available'", () => {
    for (const cause of ALL_CAUSES) {
      const label = UNKNOWN_LABEL[cause];
      expect(label).not.toMatch(/^\s*[-—–]\s*$/);
      expect(label).not.toMatch(/^\$?0([.,]00)?$/);
      expect(label.toLowerCase()).not.toBe("not available");
    }
  });
});
