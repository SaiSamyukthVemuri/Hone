import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { evaluateReserved } from "../../scripts/migration-state.mjs";

// reserved_unallocated_above_hosted: numbers deliberately absent from the repo between the hosted max and a pending migration.
// The declaration is valid only strictly between hosted and the repo max, ascending, four digits, and with no repo file.
const base = { numbers: [248, 252], hostedMaxNumber: 248, repoMaxNumber: 252 };

describe("evaluateReserved", () => {
  it("absent declaration: nothing reserved, nothing invalid", () => {
    expect(evaluateReserved({ ...base, declared: undefined })).toEqual({ reserved: [], invalid: [] });
  });
  it("a valid declaration is returned as given", () => {
    expect(evaluateReserved({ ...base, declared: ["0249", "0250", "0251"] })).toEqual({ reserved: ["0249", "0250", "0251"], invalid: [] });
  });
  it("NEGATIVE CONTROL: a non-array is invalid", () => {
    expect(evaluateReserved({ ...base, declared: "0249" }).invalid.join(" ")).toMatch(/must be an array/);
  });
  it("NEGATIVE CONTROL: a malformed entry is invalid", () => {
    expect(evaluateReserved({ ...base, declared: ["249"] }).invalid.join(" ")).toMatch(/four-digit/);
  });
  it("NEGATIVE CONTROL: a number at or below the hosted max is invalid", () => {
    expect(evaluateReserved({ ...base, declared: ["0248"] }).invalid.join(" ")).toMatch(/hosted max/);
    expect(evaluateReserved({ ...base, declared: ["0200"] }).invalid.join(" ")).toMatch(/hosted max/);
  });
  it("NEGATIVE CONTROL: a number at or above the repo max is invalid", () => {
    expect(evaluateReserved({ ...base, declared: ["0252"] }).invalid.join(" ")).toMatch(/repo max/);
    expect(evaluateReserved({ ...base, declared: ["0253"] }).invalid.join(" ")).toMatch(/repo max/);
  });
  it("NEGATIVE CONTROL: a number that has a repo file is pending, not reserved", () => {
    expect(evaluateReserved({ numbers: [248, 250, 252], hostedMaxNumber: 248, repoMaxNumber: 252, declared: ["0249", "0250"] }).invalid.join(" ")).toMatch(/has a repo file/);
  });
  it("NEGATIVE CONTROL: duplicates and disorder are invalid", () => {
    expect(evaluateReserved({ ...base, declared: ["0250", "0249"] }).invalid.join(" ")).toMatch(/ascending/);
    expect(evaluateReserved({ ...base, declared: ["0249", "0249"] }).invalid.join(" ")).toMatch(/ascending/);
  });
  it("an invalid declaration reserves nothing (the shape rule is not relaxed by it)", () => {
    expect(evaluateReserved({ ...base, declared: ["0249", "0248"] }).reserved).toEqual([]);
  });
});
