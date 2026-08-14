import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// IMPORT-01: the smoke doc must not describe a capability the server refuses.
//
// THE FAILURE THIS EXISTS TO PREVENT
// The first pass at documenting the mitigation put a "self-service execution
// is OFF" banner at the top of the Quick Import smoke section and left the
// body underneath describing, as the current owner flow, "Copy template →
// paste → Preview import → Confirm import". A reader skimming for the
// procedure finds the procedure. A contradiction inside one "current" section
// is worse than stale documentation, because it reads as authoritative.
//
// So the section is now structural, ordinary owner / operator / root fix
// pending, and this guard holds that shape. It is deliberately NOT a
// word-count or a hash: it asserts the one property that matters, which is
// that the ORDINARY-OWNER part never presents the executable flow as
// something the owner performs.

const ROOT = path.resolve(__dirname, "../..");
const SMOKE = readFileSync(path.join(ROOT, "docs/12_SMOKE_TESTS.md"), "utf8");
const LIMITS = readFileSync(
  path.join(ROOT, "docs/production/known-limitations.md"),
  "utf8",
);

/** The Quick Import smoke section, bounded by the next `## ` heading. */
function smokeSection(): string {
  const lines = SMOKE.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## Quick Import smoke"));
  expect(start, "the Quick Import smoke section is gone").toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const offset = rest.findIndex((l) => l.startsWith("## "));
  return lines.slice(start, offset === -1 ? undefined : start + 1 + offset).join("\n");
}

/** One `### ` part of that section, bounded by the next `### ` or the end. */
function part(section: string, headingFragment: string): string {
  const lines = section.split("\n");
  const start = lines.findIndex(
    (l) => l.startsWith("### ") && l.includes(headingFragment),
  );
  expect(start, `no "### …${headingFragment}…" part`).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const offset = rest.findIndex((l) => l.startsWith("### "));
  return lines
    .slice(start, offset === -1 ? undefined : start + 1 + offset)
    .join("\n");
}

const SECTION = smokeSection();
const OWNER_PART = part(SECTION, "Ordinary studio owner");
const OPERATOR_PART = part(SECTION, "Platform operator");
const ROOT_FIX_PART = part(SECTION, "Root fix still pending");

// The rendered labels of the executable island. These are the words a reader
// looks for when they want to know how to run an import.
const EXECUTABLE_CONTROLS = [
  "Copy template",
  "Preview import",
  "Confirm import",
  "paste box",
];

describe("the Quick Import smoke section is structurally current", () => {
  it("has all three parts, and they are real (the extractor is not lying)", () => {
    expect(SECTION.length).toBeGreaterThan(2000);
    for (const [name, text] of [
      ["owner", OWNER_PART],
      ["operator", OPERATOR_PART],
      ["root fix", ROOT_FIX_PART],
    ] as const) {
      expect(text.length, `${name} part is empty`).toBeGreaterThan(200);
    }
    // Disjoint: the parts do not overlap, so a "not contains" on one cannot be
    // silently answered by another's text.
    expect(OWNER_PART).not.toContain("### 2.");
    expect(OPERATOR_PART).not.toContain("### 1.");
    expect(OPERATOR_PART).not.toContain("### 3.");
    expect(OWNER_PART.length + OPERATOR_PART.length + ROOT_FIX_PART.length)
      .toBeLessThanOrEqual(SECTION.length);
  });

  it("the ordinary-owner part states the contract that is actually enforced", () => {
    expect(OWNER_PART).toMatch(/informational/i);
    expect(OWNER_PART).toMatch(/operator-assisted/i);
    expect(OWNER_PART).toMatch(/no executable control/i);
    expect(OWNER_PART).toMatch(/writes nothing/i);
    expect(OWNER_PART).toMatch(/support@hone\.care/);
    // The server, not the page, is named as the boundary.
    expect(OWNER_PART).toMatch(/ownerContext\(\)/);
    expect(OWNER_PART).toMatch(/before the first statement/i);
  });
});

describe("the ordinary-owner part never describes a self-service run", () => {
  it("names no executable control except to say it is absent", () => {
    // The distinction that matters: "no Confirm import" is correct copy;
    // "→ Confirm import" is the contradiction. Every mention in this part must
    // sit inside a negation.
    let checked = 0;
    for (const label of EXECUTABLE_CONTROLS) {
      let idx = OWNER_PART.indexOf(label);
      while (idx !== -1) {
        checked += 1;
        const before = OWNER_PART.slice(Math.max(0, idx - 16), idx);
        expect(
          /\b(no|not|never|without|nor)\b[\s*_`(]*$/i.test(before),
          `"${label}" appears in the ordinary-owner part WITHOUT a negation, ` +
            `context: ${JSON.stringify(OWNER_PART.slice(Math.max(0, idx - 40), idx + label.length))}`,
        ).toBe(true);
        idx = OWNER_PART.indexOf(label, idx + 1);
      }
    }
    // Anti-vacuity: the loop must actually have examined mentions. If the copy
    // stops naming the controls at all, this guard would otherwise pass while
    // proving nothing.
    expect(
      checked,
      "the ordinary-owner part names none of the executable controls, so this guard is vacuous",
    ).toBeGreaterThanOrEqual(3);
  });

  it("contains no step-arrow workflow chain", () => {
    // A described procedure in this codebase's docs always reads
    // "A → B → C". Its presence in the owner part is the shape of the bug.
    for (const re of [
      /Copy template\s*(→|->)/,
      /(→|->)\s*\*{0,2}Preview import/,
      /(→|->)\s*\*{0,2}Confirm import/,
      /paste rows\s*(→|->)/,
    ]) {
      expect(
        re.test(OWNER_PART),
        `the ordinary-owner part describes a workflow step chain (${re})`,
      ).toBe(false);
    }
    // Non-vacuous: the OPERATOR part genuinely does contain such a chain, so
    // the detector demonstrably fires on real prose.
    expect(/(→|->)\s*\*{0,2}Confirm import/.test(OPERATOR_PART)).toBe(true);
  });

  it("does not resurrect the retired 'Coming this week' promise", () => {
    // The section is allowed to say the Data card "no longer says 'Coming this
    // week'", that is a smoke instruction. What it may not do is state the
    // promise. Same negation rule as the control labels above.
    let idx = SECTION.indexOf("Coming this week");
    let seen = 0;
    while (idx !== -1) {
      seen += 1;
      const before = SECTION.slice(Math.max(0, idx - 24), idx);
      expect(
        /\bno longer\b[^.]*$/i.test(before),
        `"Coming this week" is stated as a promise, context: ${JSON.stringify(
          SECTION.slice(Math.max(0, idx - 40), idx + 16),
        )}`,
      ).toBe(true);
      idx = SECTION.indexOf("Coming this week", idx + 1);
    }
    expect(seen, "expected the retired promise to be named as retired").toBe(1);
  });
});

describe("the operator part is honest about what it still is", () => {
  it("carries the non-atomic warning, not just the happy path", () => {
    expect(OPERATOR_PART).toMatch(/not atomic/i);
    expect(OPERATOR_PART).toMatch(/no transaction/i);
    expect(OPERATOR_PART).toMatch(/0087/);
    expect(OPERATOR_PART).toMatch(/skip/i);
    expect(OPERATOR_PART).toMatch(/deliberate|supervised|real migration/i);
  });

  it("is explicit that operator standing is required, with no service role", () => {
    expect(OPERATOR_PART).toMatch(/ADMIN_EMAILS/);
    expect(OPERATOR_PART).toMatch(/no service role/i);
  });
});

describe("the root fix is recorded as still pending, in both places", () => {
  it("the smoke section says self-service stays disabled until it ships", () => {
    expect(ROOT_FIX_PART).toMatch(/staged/i);
    expect(ROOT_FIX_PART).toMatch(/transactional/i);
    expect(ROOT_FIX_PART).toMatch(/resumable/i);
    expect(ROOT_FIX_PART).toMatch(/attach-to-existing/i);
    expect(ROOT_FIX_PART).toMatch(/L24/);
  });

  it("known-limitations still carries L24 and does not claim it is fixed", () => {
    expect(LIMITS).toMatch(/## L24 —/);
    const l24 = LIMITS.slice(LIMITS.indexOf("## L24 —"));
    const end = l24.indexOf("\n## ");
    const body = end === -1 ? l24 : l24.slice(0, end);
    expect(body.length).toBeGreaterThan(500);
    expect(body).toMatch(/not fixed|NOT fixed/);
    expect(body).toMatch(/operator/i);
    // The mitigation must never be recorded as closing the defect.
    expect(body).not.toMatch(/—\s*\*\*CLOSED/);
  });
});
