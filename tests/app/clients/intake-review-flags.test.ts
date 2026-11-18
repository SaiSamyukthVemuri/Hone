import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #266. Source-grep pins for the practitioner-only intake review flags:
//   * the deriver is pure (no DB / supabase client);
//   * the flags module + the review page never use the forbidden
//     clinical-decision language (scoped to the new code, not the whole repo —
//     older intake comments legitimately contain some terms);
//   * the card is NOT on the public client-facing /intake/[token] route.
// The allowed wording and the mounted card are proved behaviourally in
// tests/lib/intake/review-flags*.test.ts and intake-invalid-catalogue-flags.test.ts.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const MODULE = read("lib/intake/review-flags.ts");
const PAGE = read("app/(app)/clients/[id]/intake/page.tsx");
const PUBLIC_INTAKE = read("app/intake/[token]/page.tsx");

// Strip comments so doc-comments that ENUMERATE forbidden terms (explaining
// what the feature must NOT do) don't trip the wording checks.
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

describe("review-flags deriver is pure", () => {
  it("does no I/O (no supabase / createClient / fetch)", () => {
    expect(MODULE).not.toMatch(/supabase|createClient|createAdminClient|fetch\(/);
  });

  it("derives only from existing intake question keys (no new field, no _notes parsing)", () => {
    expect(MODULE).toMatch(/@\/lib\/intake\/questions/);
    // Free-text companions must never be inspected (would be inference).
    expect(codeOnly(MODULE)).not.toMatch(/_notes/);
  });
});

describe("forbidden clinical-decision wording (new code only)", () => {
  const forbidden: Array<[string, RegExp]> = [
    ["safe", /\bsafe\b/i],
    ["unsafe", /\bunsafe\b/i],
    ["cleared", /\bcleared\b/i],
    ["approved", /\bapproved\b/i],
    ["do not treat", /do not treat/i],
    ["contraindicated", /contraindicat/i],
    ["diagnosis", /diagnos/i],
    ["clinically verified", /clinically verified/i],
    ["recommended treatment", /recommended treatment/i],
  ];
  for (const [name, re] of forbidden) {
    it(`flags module never uses "${name}"`, () => {
      expect(codeOnly(MODULE)).not.toMatch(re);
    });
    it(`review page never uses "${name}"`, () => {
      expect(codeOnly(PAGE)).not.toMatch(re);
    });
  }
});

describe("practitioner-only surface", () => {
  it("the public client-facing intake route does NOT render review flags", () => {
    expect(PUBLIC_INTAKE).not.toMatch(/deriveIntakeReviewFlags|IntakeReviewFlags/);
  });
});

// PR #267. Modality/category badges.
describe("modality badges (PR #267)", () => {
  it("the public client-facing route still has no modality badges", () => {
    expect(PUBLIC_INTAKE).not.toMatch(/MODALITY_WORDING|thermolysis|galvanic/i);
  });
});
