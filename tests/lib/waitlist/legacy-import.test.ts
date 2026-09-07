import { describe, expect, it } from "vitest";
import {
  planLegacyWaitlistImport,
  summariseImportPlan,
  type LegacyImportRow,
} from "@/lib/waitlist/legacy-import";

// WAIT-ADMIT-01 — the one rule: a fact the source does not contain is never
// manufactured here. Both fabrications the schema makes easy get their own
// suite, because both are silent in production if this module gets them wrong.

const IMPORTED_AT = new Date("2026-09-07T12:00:00.000Z");
const plan = (rows: LegacyImportRow[]) =>
  planLegacyWaitlistImport(rows, { importedAt: IMPORTED_AT });

describe("no fabricated join date", () => {
  it("refuses to default a missing date to the import instant", () => {
    const result = plan([{ email: "a@example.com", name: "A Person" }]);
    expect(result.ready).toHaveLength(0);
    expect(result.needsDecision[0]?.missing).toEqual(["joined_at"]);
    expect(result.needsDecision[0]?.detail).toContain("erase the real wait");
  });

  it("keeps an operator-supplied date and marks its weaker provenance", () => {
    const result = plan([
      { email: "a@example.com", name: "A Person", joinedAt: "2025-11-02T09:30:00.000Z" },
    ]);
    expect(result.ready).toHaveLength(1);
    expect(result.ready[0]?.value.joinedAt.toISOString()).toBe("2025-11-02T09:30:00.000Z");
    expect(result.ready[0]?.value.joinedAtProvenance).toBe("operator_supplied");
  });

  it("rejects a future join date rather than storing it", () => {
    const result = plan([
      { email: "a@example.com", name: "A Person", joinedAt: "2027-01-01T00:00:00.000Z" },
    ]);
    expect(result.rejected[0]?.reason).toContain("in the future");
  });

  it("rejects an unparseable date instead of falling back", () => {
    const result = plan([{ email: "a@example.com", name: "A Person", joinedAt: "last spring" }]);
    expect(result.rejected[0]?.reason).toContain("not a valid date");
    expect(result.ready).toHaveLength(0);
  });
});

describe("no fabricated name", () => {
  it("refuses to synthesise one from the email local part", () => {
    const result = plan([{ email: "jordan.smith@example.com", joinedAt: "2025-11-02" }]);
    expect(result.ready).toHaveLength(0);
    expect(result.needsDecision[0]?.missing).toEqual(["name"]);
    expect(result.needsDecision[0]?.detail).toContain("will not invent it");
  });

  it("treats a whitespace-only name as absent, matching the table CHECK", () => {
    const result = plan([{ email: "a@example.com", name: "   ", joinedAt: "2025-11-02" }]);
    expect(result.needsDecision[0]?.missing).toEqual(["name"]);
  });

  it("reports both gaps at once so the operator makes one pass", () => {
    const result = plan([{ email: "a@example.com" }]);
    expect(result.needsDecision[0]?.missing).toEqual(["name", "joined_at"]);
  });
});

describe("duplicates are surfaced, never merged", () => {
  it("keeps the first occurrence and flags the rest with its index", () => {
    const result = plan([
      { email: "a@example.com", name: "First", joinedAt: "2025-01-01" },
      { email: "b@example.com", name: "Other", joinedAt: "2025-01-02" },
      { email: "A@Example.com", name: "Second", joinedAt: "2025-06-01" },
    ]);
    expect(result.ready.map((r) => r.value.emailNormalized)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(result.duplicates).toEqual([
      { kind: "duplicate", rowIndex: 2, emailNormalized: "a@example.com", firstSeenAtIndex: 0 },
    ]);
  });
});

describe("bounds mirror the table constraints", () => {
  it.each([
    [{ email: "" }, "email is required"],
    [{ email: "not-an-email" }, "not a valid address"],
    [{ email: `${"a".repeat(250)}@example.com` }, "exceeds 254"],
    [{ email: "a@example.com", name: "n".repeat(121) }, "name exceeds 120"],
    [{ email: "a@example.com", phone: "1".repeat(41) }, "phone exceeds 40"],
  ])("rejects %o", (row, expected) => {
    expect(plan([row as LegacyImportRow]).rejected[0]?.reason).toContain(expected);
  });

  it("rejects non-string fields without throwing", () => {
    const result = plan([{ email: 42 }, { email: null }, { email: { a: 1 } }]);
    expect(result.rejected).toHaveLength(3);
    expect(result.ready).toHaveLength(0);
  });
});

describe("the plan is reconcilable against the source", () => {
  it("reports every row exactly once, keyed by its input index", () => {
    const rows: LegacyImportRow[] = [
      { email: "ok@example.com", name: "OK", joinedAt: "2025-01-01" },
      { email: "bad" },
      { email: "nodate@example.com", name: "No Date" },
      { email: "OK@example.com", name: "Dup", joinedAt: "2025-02-01" },
    ];
    const result = plan(rows);
    const indices = [
      ...result.ready.map((r) => r.rowIndex),
      ...result.needsDecision.map((r) => r.rowIndex),
      ...result.rejected.map((r) => r.rowIndex),
      ...result.duplicates.map((r) => r.rowIndex),
    ].sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3]);
  });

  it("normalizes and exposes the emails the caller must check against live entries", () => {
    const result = plan([
      { email: "  Mixed@Example.COM ", name: "M", joinedAt: "2025-03-04" },
    ]);
    expect(result.emailsToCheck).toEqual(["mixed@example.com"]);
  });

  it("summarises with counts only, never an address", () => {
    const result = plan([
      { email: "a@example.com", name: "A", joinedAt: "2025-01-01" },
      { email: "b@example.com" },
      { email: "bad" },
      { email: "A@example.com", name: "A", joinedAt: "2025-01-01" },
    ]);
    const summary = summariseImportPlan(result);
    expect(summary).toBe("1 ready, 1 need a decision, 1 duplicate, 1 rejected");
    expect(summary).not.toContain("@");
  });
});

describe("a genuinely dateless row, when the operator has looked", () => {
  const dateless = [{ email: "a@example.com", name: "A Person" }];

  it("stays blocked by default — the first pass sends them back to their records", () => {
    const result = planLegacyWaitlistImport(dateless, { importedAt: IMPORTED_AT });
    expect(result.ready).toHaveLength(0);
    expect(result.needsDecision[0]?.missing).toEqual(["joined_at"]);
  });

  it("imports with provenance 'unknown' only on an explicit operator decision", () => {
    const result = planLegacyWaitlistImport(dateless, {
      importedAt: IMPORTED_AT,
      allowUnknownJoinedAt: true,
    });
    expect(result.needsDecision).toHaveLength(0);
    expect(result.ready[0]?.value.joinedAtProvenance).toBe("unknown");
    // The import instant is a QUEUE ANCHOR, not a claim about the wait — the
    // provenance is the only thing that says so, and it travels with it.
    expect(result.ready[0]?.value.joinedAt).toEqual(IMPORTED_AT);
  });

  it("still refuses a missing name — there is no allowUnknownName counterpart", () => {
    const result = planLegacyWaitlistImport([{ email: "a@example.com" }], {
      importedAt: IMPORTED_AT,
      allowUnknownJoinedAt: true,
    });
    expect(result.ready).toHaveLength(0);
    expect(result.needsDecision[0]?.missing).toEqual(["name"]);
  });

  it("still rejects a bad date rather than downgrading it to 'unknown'", () => {
    const result = planLegacyWaitlistImport(
      [{ email: "a@example.com", name: "A", joinedAt: "2027-01-01" }],
      { importedAt: IMPORTED_AT, allowUnknownJoinedAt: true },
    );
    expect(result.ready).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain("in the future");
  });

  it("counts undated rows separately in the summary", () => {
    const result = planLegacyWaitlistImport(
      [
        { email: "a@example.com", name: "A" },
        { email: "b@example.com", name: "B", joinedAt: "2025-01-01" },
      ],
      { importedAt: IMPORTED_AT, allowUnknownJoinedAt: true },
    );
    expect(summariseImportPlan(result)).toContain("2 ready (1 with no known join date)");
  });
});
