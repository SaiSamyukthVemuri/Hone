import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  centsToAmountInputValue,
  formatCadFromCents,
  parseCadAmountToCents,
} from "@/lib/billing/cad-amount";
import { SESSION_PAYMENT_AMOUNT_CEILING_CENTS } from "@/lib/billing/session-payment-types";

// F-PAY-002. THE strict money parser, exercised on the inputs that made the
// old Number()+Math.round() approach unsafe.
//
// The value this produces becomes payment_charge_attempts.amount_cents and
// then the integer handed to Stripe, so "close enough" is not a category that
// exists here. Every case below is a real keystroke sequence a practitioner or
// a hostile client could produce.

const CEILING = SESSION_PAYMENT_AMOUNT_CEILING_CENTS;

function cents(raw: string): number | null {
  const r = parseCadAmountToCents(raw, CEILING);
  return r.ok ? r.cents : null;
}

describe("ordinary CAD amounts parse to exact cents", () => {
  const ACCEPTED: Array<[string, number]> = [
    ["0", 0],
    ["0.00", 0],
    ["1", 100],
    ["120", 12_000],
    ["120.0", 12_000],
    ["120.00", 12_000],
    ["120.5", 12_050],
    ["120.50", 12_050],
    ["120.05", 12_005],
    ["100.99", 10_099],
    ["$120.00", 12_000],
    ["  120.00  ", 12_000],
    ["1,200.00", 120_000],
    ["$1,200", 120_000],
    ["2000.00", 200_000],
    ["2000", 200_000],
  ];

  for (const [raw, expected] of ACCEPTED) {
    it(`${JSON.stringify(raw)} -> ${expected} cents`, () => {
      expect(cents(raw)).toBe(expected);
    });
  }
});

// WHAT THIS BLOCK DOES AND DOES NOT PROVE.
//
// It proves the OUTPUT is exact for every accepted input, including the values
// whose naive `Number(x) * 100` is not the integer it looks like. It does NOT
// prove the implementation avoids floating point, and no black-box test could:
// inside the accepted domain (0 .. the ceiling, at most two decimals) a
// `Math.round(Number(x) * 100)` implementation returns the SAME answers, because
// rounding repairs the representation error at these magnitudes. The inputs
// that would separate them — three decimals, scientific notation, magnitudes
// past 2^53 — are rejected by the grammar before arithmetic happens at all.
//
// So the "no floating point" property is pinned STRUCTURALLY, in the separate
// test below, and this block is named for what it actually checks. Claiming
// otherwise here is the kind of assertion that reads as strong and proves
// nothing.
describe("cents are exact for every accepted input", () => {
  const FLOAT_HOSTILE: Array<[string, number]> = [
    ["0.07", 7],
    ["0.29", 29],
    ["1.005", -1], // three decimals: rejected outright, never rounded to 101
    ["8.20", 820],
    ["10.10", 1_010],
    ["16.08", 1_608],
    ["1.13", 113],
    ["1999.99", 199_999],
  ];

  for (const [raw, expected] of FLOAT_HOSTILE) {
    it(`${JSON.stringify(raw)} -> ${expected === -1 ? "rejected" : expected}`, () => {
      expect(cents(raw)).toBe(expected === -1 ? null : expected);
    });
  }

  it("agrees with exact decimal arithmetic across the whole cent range", () => {
    // Exhaustive over a range wide enough to catch a systematic off-by-one
    // from a float path, and cheap enough to run every time.
    for (let c = 0; c <= 5_000; c += 1) {
      expect(cents(centsToAmountInputValue(c))).toBe(c);
    }
  });
});

describe("malformed input is REJECTED, never normalised", () => {
  const MALFORMED = [
    "",
    "   ",
    "-1",
    "-100",
    "-0.01",
    "+100",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e2",
    "1E2",
    "1e-2",
    "0x64",
    "0b1010",
    "0o144",
    "12.345",
    "10.999",
    "120.",
    ".50",
    ".",
    "1.2.3",
    "1,20.00",
    "1,2345",
    ",100",
    "100,",
    "1 200",
    "100 dollars",
    "one hundred",
    "$",
    "$$120",
    "120$",
    "12,0.00",
    "١٢٣", // Arabic-Indic digits: not the grammar
    "1 200", // non-breaking space
    "١٢٠",
  ];

  for (const raw of MALFORMED) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      expect(cents(raw)).toBeNull();
    });
  }

  it("reports blank separately from malformed, so copy can differ", () => {
    expect(parseCadAmountToCents("", CEILING)).toEqual({
      ok: false,
      reason: "blank",
    });
    expect(parseCadAmountToCents("   ", CEILING)).toEqual({
      ok: false,
      reason: "blank",
    });
    expect(parseCadAmountToCents("1e2", CEILING)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("never turns a third decimal into a charge, in either direction", () => {
    expect(cents("10.994")).toBeNull();
    expect(cents("10.999")).toBeNull();
    expect(cents("0.001")).toBeNull();
  });
});

describe("the ceiling rejects rather than clamps", () => {
  it("accepts exactly the ceiling", () => {
    expect(cents("2000.00")).toBe(CEILING);
  });

  it("rejects one cent above the ceiling", () => {
    expect(parseCadAmountToCents("2000.01", CEILING)).toEqual({
      ok: false,
      reason: "above_ceiling",
    });
  });

  it("rejects an absurd magnitude without clamping to the ceiling", () => {
    const r = parseCadAmountToCents("999999999999", CEILING);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("cents");
  });

  it("stays exact past Number.MAX_SAFE_INTEGER instead of losing precision", () => {
    // 9007199254740993 is the first integer a double cannot represent. The
    // answer must be a rejection, never a silently rounded neighbour.
    expect(cents("9007199254740993")).toBeNull();
    expect(cents("90071992547409.93")).toBeNull();
  });

  it("bounds the input length before doing any numeric work", () => {
    expect(cents("9".repeat(1000))).toBeNull();
  });

  it("honours a caller-supplied ceiling rather than a hard-coded one", () => {
    expect(parseCadAmountToCents("5.01", 500)).toEqual({
      ok: false,
      reason: "above_ceiling",
    });
    expect(parseCadAmountToCents("5.00", 500)).toEqual({ ok: true, cents: 500 });
  });
});

describe("the implementation itself never multiplies a float", () => {
  // The structural half of the claim the block above deliberately stopped
  // making. It is a source pin BECAUSE the property is not observable from
  // outputs — see the reasoning there. Kept narrow: exactly the operations that
  // would reintroduce IEEE-754 into a cents computation.
  const SRC = readFileSync(
    path.resolve(__dirname, "../../../lib/billing/cad-amount.ts"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("uses BigInt for the cents computation", () => {
    expect(SRC).toMatch(/BigInt\(wholeDigits\) \* 100n \+ BigInt\(fractionDigits\)/);
  });

  it("contains no float multiplication, rounding, clamping or parseFloat", () => {
    expect(SRC).not.toMatch(/\* *100(?!n)/);
    expect(SRC).not.toMatch(/Math\.round\(/);
    expect(SRC).not.toMatch(/Math\.min\(/);
    expect(SRC).not.toMatch(/Math\.max\(/);
    expect(SRC).not.toMatch(/parseFloat\(/);
    expect(SRC).not.toMatch(/toFixed\(/);
    // Number() appears exactly once, narrowing an already-bounded BigInt.
    expect((SRC.match(/Number\(/g) ?? []).length).toBe(1);
  });
});

describe("formatting round-trips with parsing", () => {
  it("formats cents as CAD", () => {
    expect(formatCadFromCents(0)).toBe("$0.00");
    expect(formatCadFromCents(5)).toBe("$0.05");
    expect(formatCadFromCents(50)).toBe("$0.50");
    expect(formatCadFromCents(12_000)).toBe("$120.00");
    expect(formatCadFromCents(14_500)).toBe("$145.00");
    expect(formatCadFromCents(200_000)).toBe("$2000.00");
  });

  it("formats a negative amount without losing the sign", () => {
    // Not reachable from the parser, but refund/adjustment call sites exist.
    expect(formatCadFromCents(-2_500)).toBe("-$25.00");
  });

  it("prefills an input with a value the parser accepts back unchanged", () => {
    for (const c of [1, 99, 100, 12_000, 14_500, 200_000]) {
      expect(centsToAmountInputValue(c)).not.toMatch(/[$,]/);
      expect(cents(centsToAmountInputValue(c))).toBe(c);
    }
  });

  it("normalises a value outside its domain rather than emitting nonsense", () => {
    // The prefill is only ever handed a positive reference price. Anything else
    // has no representation in the grammar (no sign, no sub-cent), so it
    // collapses to a parseable zero instead of a string like "-1.-50" that the
    // parser would reject and that would read as a broken form to the operator.
    for (const bad of [0, -1, -2_500, NaN, Infinity, -Infinity, 12.7]) {
      const out = centsToAmountInputValue(bad);
      expect(out).toMatch(/^\d+\.\d{2}$/);
      expect(parseCadAmountToCents(out, CEILING).ok).toBe(true);
    }
    expect(centsToAmountInputValue(-2_500)).toBe("0.00");
  });
});
