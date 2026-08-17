import { describe, expect, it } from "vitest";
import {
  CLIENT_BUDGET_LEVELS,
  CLIENT_BUDGET_LEVEL_LABELS,
  MAX_BUDGET_NOTE_LENGTH,
  isClientBudgetLevel,
  parseClientBudgetLevel,
} from "@/lib/budget/levels";

// The budget vocabulary is the one place the UI chips, the server action, the
// export and the DB CHECK constraint all have to agree. These tests pin the
// vocabulary itself; tests/migrations/0183-client-budget-context.test.ts pins
// it against the constraint in the migration file.

describe("client budget vocabulary", () => {
  it("is exactly three levels, in render order", () => {
    expect(CLIENT_BUDGET_LEVELS).toEqual([
      "no_stated_limit",
      "somewhat_limited",
      "severely_limited",
    ]);
  });

  it("labels every level, with no orphans in either direction", () => {
    expect(Object.keys(CLIENT_BUDGET_LEVEL_LABELS).sort()).toEqual(
      [...CLIENT_BUDGET_LEVELS].sort(),
    );
  });

  it("does NOT claim a client has unlimited resources", () => {
    // "No stated limit" records what the practitioner was told. "Unlimited"
    // would assert a fact about the client's finances that nobody verified.
    for (const label of Object.values(CLIENT_BUDGET_LEVEL_LABELS)) {
      expect(label).not.toMatch(/unlimited/i);
    }
    expect(CLIENT_BUDGET_LEVEL_LABELS.no_stated_limit).toBe("No stated limit");
  });

  it("uses no clinical, financial-assessment or scoring language", () => {
    const forbidden =
      /afford|score|risk|income|socioeconomic|eligib|credit|poverty/i;
    for (const label of Object.values(CLIENT_BUDGET_LEVEL_LABELS)) {
      expect(label).not.toMatch(forbidden);
    }
    for (const value of CLIENT_BUDGET_LEVELS) {
      expect(value).not.toMatch(forbidden);
    }
  });

  it("shares the client_personal_notes free-text ceiling", () => {
    expect(MAX_BUDGET_NOTE_LENGTH).toBe(20000);
  });
});

describe("parseClientBudgetLevel", () => {
  it("accepts each canonical value", () => {
    for (const level of CLIENT_BUDGET_LEVELS) {
      expect(parseClientBudgetLevel(level)).toBe(level);
    }
  });

  it("treats absent / empty / whitespace as 'no level recorded'", () => {
    for (const input of [null, undefined, "", "   ", "\n"]) {
      expect(parseClientBudgetLevel(input)).toBeNull();
    }
  });

  it("rejects anything outside the vocabulary rather than coercing it", () => {
    for (const input of [
      "unlimited",
      "Unlimited",
      "NO_STATED_LIMIT",
      "somewhat limited",
      "severely-limited",
      0,
      {},
      [],
      true,
    ]) {
      // Note the action distinguishes "absent" from "present but invalid";
      // this function returns null for both and the action refuses the latter.
      expect(parseClientBudgetLevel(input as unknown)).toBeNull();
    }
  });

  it("tolerates surrounding whitespace on an otherwise valid value", () => {
    expect(parseClientBudgetLevel("  somewhat_limited  ")).toBe(
      "somewhat_limited",
    );
  });
});

describe("isClientBudgetLevel", () => {
  it("is exact — no trimming, no case folding", () => {
    expect(isClientBudgetLevel("somewhat_limited")).toBe(true);
    expect(isClientBudgetLevel(" somewhat_limited ")).toBe(false);
    expect(isClientBudgetLevel("Somewhat_limited")).toBe(false);
    expect(isClientBudgetLevel(null)).toBe(false);
  });
});
