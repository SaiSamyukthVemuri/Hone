import { describe, expect, it } from "vitest";
import { padDecimalText } from "@/lib/export/decimal-text";

describe("padDecimalText: exact decimal text for the export", () => {
  it.each([
    ["1.85", 2, "1.85"],
    ["0.033", 3, "0.033"],
    ["1.8", 2, "1.80"],
    ["3", 0, "3"],
    ["3", 2, "3.00"],
    ["-0.5", 2, "-0.50"],
    ["0.1234", 2, "0.1234"], // never rounds or drops a recorded digit
    ["9007199254740993", 0, "9007199254740993"], // above 2^53: a JS number would give ...992
    ["9007199254740993.10", 1, "9007199254740993.10"],
    ["12345678901234567890.123456789", 2, "12345678901234567890.123456789"],
  ])("%s at %i decimals is %s", (v, d, out) => {
    expect(padDecimalText(v, d)).toBe(out);
  });

  it("keeps null as null and leaves non-decimal text alone", () => {
    expect(padDecimalText(null, 2)).toBeNull();
    expect(padDecimalText(undefined, 2)).toBeNull();
    expect(padDecimalText("NaN", 2)).toBe("NaN");
    expect(padDecimalText("1.5", null)).toBe("1.5");
  });

  // Anything that is not plain decimal text comes back byte for byte. It is never routed through String(Number(v)), which would turn "1e5" into
  // "100000", "Infinity" into a number-like word, and a 17-digit value into a rounded one.
  it("returns non-plain-text input unchanged, never String(Number(v))", () => {
    for (const v of ["1e5", "1E-3", "NaN", "Infinity", "-Infinity", "0x10", "1,5", "1.", ".5", "", "  "]) {
      expect(padDecimalText(v, 2), v).toBe(v);
    }
    expect(padDecimalText("1e5", 2)).not.toBe(String(Number("1e5")));
  });
});
