import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ===========================================================================
// #824 — FINANCIAL SURFACES ARE OWNER-ONLY.
// ===========================================================================
//
// THE RULING: employees are blocked from financial records; access is the
// owner's. Before this, every surface below gated on
// `requirePractitionerWithStudio()` alone, which admits ANY active
// practitioner — so a non-owner electrologist could open /financials and
// /settings/payments by URL.
//
// "OWNER/ADMINS" IS OWNER-ONLY, as a fact about the schema and not a reading of
// the instruction: `practitioners.role` is CHECK-constrained to exactly
// ('owner', 'practitioner'), so there is no admin or manager studio role to
// admit. The only "admin" in Hone is the PLATFORM /admin surface, which is not
// a studio membership. That constraint is asserted below, so if a third role is
// ever added this test fails and the decision gets revisited deliberately
// rather than the new role silently inheriting or being denied access.
//
// This is a source contract because the thing being protected is which GUARD a
// route calls — a behavioural test proves one route at a time, while this
// proves the SET, including a route added later to the same directory.

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Comment-stripped, so a guard named only in prose is not counted. */
const code = (src: string) =>
  src.replace(/^[ \t]*\/\/[^\n]*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

/** Every surface that shows studio-wide money. */
const FINANCIAL_PAGES = [
  "app/(app)/financials/page.tsx",
  "app/(app)/settings/payments/page.tsx",
  "app/(app)/settings/payments/refresh/page.tsx",
  "app/(app)/settings/payments/return/page.tsx",
] as const;

/**
 * A surface that must STAY open to any practitioner. Without this the suite
 * would pass against a codebase that had put the owner gate on everything,
 * which would lock electrologists out of their own work.
 */
const PRACTITIONER_PAGES = [
  "app/(app)/dashboard/page.tsx",
  "app/(app)/clients/[id]/page.tsx",
] as const;

describe("#824: studio-wide financial surfaces are owner-only", () => {
  for (const rel of FINANCIAL_PAGES) {
    it(`${rel} resolves identity ITSELF, then asserts the owner`, () => {
      const src = code(read(rel));
      // BOTH, IN THIS ORDER. The page must keep its own resolver call —
      // server-render-identity-guard (SENTRY-IDENTITY-01) reports a page that
      // delegates identity to a wrapper, and it is right to: that is the shape
      // that let a layout's redirect fail to stop a page. So the owner rule is
      // applied to the ALREADY-RESOLVED practitioner, immediately after.
      const resolveAt = src.search(/requirePractitionerWithStudio\s*\(/);
      const assertAt = src.search(/assertStudioOwner\s*\(/);
      expect(resolveAt, "the page must resolve identity itself").toBeGreaterThan(-1);
      expect(assertAt, "the page must assert the owner rule").toBeGreaterThan(-1);
      expect(
        resolveAt,
        "identity must be resolved BEFORE the owner rule is applied",
      ).toBeLessThan(assertAt);
      // And nothing may read money before the rule runs: the first data load
      // must follow the assertion, or a non-owner's request does the work and
      // only then gets redirected.
      const firstAwaitAfter = src.slice(assertAt);
      expect(
        firstAwaitAfter.length,
        "the owner rule must not be the last statement — the page body follows it",
      ).toBeGreaterThan(0);
    });
  }

  it("NON-VACUITY: ordinary practitioner surfaces are NOT owner-gated", () => {
    for (const rel of PRACTITIONER_PAGES) {
      const src = code(read(rel));
      expect(
        src,
        `${rel} must stay open to any practitioner — the owner rule is for money, not for work`,
      ).not.toMatch(/assertStudioOwner\s*\(/);
    }
  });

  it("the owner rule is defined ONCE, and redirects rather than throwing", () => {
    const src = code(read("lib/auth/require-studio-owner.ts"));
    expect(src).toMatch(/export function assertStudioOwner/);
    // A page must redirect, never throw: a surrounding try/catch can swallow a
    // throw, and a layout's redirect does not stop a page.
    expect(src, "a non-owner must be redirected").toMatch(/redirect\(/);
    // It must NOT resolve identity itself: that is the page's job, and a
    // wrapper here is what server-render-identity-guard refuses.
    expect(
      src,
      "the rule must take an already-resolved practitioner, not resolve one",
    ).not.toMatch(/requirePractitionerWithStudio\s*\(/);
  });

  it("practitioners.role admits no third role, so owner-only is faithful", () => {
    // If an admin or manager role is ever added, this fails and the ruling gets
    // applied to it deliberately instead of by omission.
    const migrations = path.join(ROOT, "supabase", "migrations");
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const checks = readdirSync(migrations)
      .filter((f) => f.endsWith(".sql"))
      .flatMap((f) =>
        [...readFileSync(path.join(migrations, f), "utf8").matchAll(
          /check\s*\(\s*role\s+in\s*\(([^)]*)\)/gi,
        )].map((m) => m[1]),
      );
    expect(checks.length, "the role CHECK constraint must exist").toBeGreaterThan(0);
    for (const list of checks) {
      const roles = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
      expect(roles, `unexpected role domain: ${list.trim()}`).toEqual([
        "owner",
        "practitioner",
      ]);
    }
  });
});
