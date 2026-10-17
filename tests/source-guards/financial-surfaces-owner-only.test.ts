import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ===========================================================================
// #824 — studio-wide financial surfaces refuse a non-owner BEFORE any read.
// ===========================================================================
//
// THIS FILE ADDS TRIPWIRES ONLY. The surfaces were ALREADY owner-only before
// this PR. An earlier version of this change treated them as open and added a
// redirect, which was wrong twice over: it closed nothing, and it made the
// existing user-facing refusal unreachable. What was actually missing was the
// tripwire — delete any of these blocks today and no test notices.
//
// WHAT ALREADY EXISTS:
//   * app/(app)/settings/payments/page.tsx, .../refresh/page.tsx and
//     .../return/page.tsx each refuse with `role !== "owner"` and render
//     "Only the studio owner can manage payments."
//   * /financials needs no page check: lib/finance/financial-briefing.ts
//     refuses on the role as the FIRST STATEMENT of loadFinancialsView, before
//     any Supabase client exists, so a non-owner causes no studio-wide query
//     and receives no aggregate — not merely an aggregate they are not shown.
//
// THE BEHAVIOUR IS PROVED ELSEWHERE AND IS DELIBERATELY NOT DUPLICATED.
// tests/lib/finance/financial-briefing.test.ts calls loadFinancialsView with a
// RECORDING stub client and asserts both `access === "refused"` and
// `tables === []` — no read happened — across "practitioner", "admin",
// "Owner", "OWNER", "" and "superuser". A second copy would be two places to
// keep true, one of which would rot.

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Comment-stripped, so a refusal named only in prose is not counted. */
const code = (src: string) =>
  src.replace(/^[ \t]*\/\/[^\n]*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

const PAYMENT_PAGES = [
  "app/(app)/settings/payments/page.tsx",
  "app/(app)/settings/payments/refresh/page.tsx",
  "app/(app)/settings/payments/return/page.tsx",
] as const;

/**
 * Surfaces that must STAY open to any practitioner. Without these the suite
 * would pass against a codebase that had put an owner refusal on everything,
 * which would lock electrologists out of their own work.
 */
const PRACTITIONER_PAGES = [
  "app/(app)/dashboard/page.tsx",
  "app/(app)/clients/[id]/page.tsx",
] as const;

describe("#824: financial surfaces refuse a non-owner before any read", () => {
  for (const rel of PAYMENT_PAGES) {
    it(`${rel} refuses a non-owner before it loads anything`, () => {
      const src = code(read(rel));
      const resolveAt = src.search(/requirePractitionerWithStudio\s*\(/);
      const refuseAt = src.search(/practitioner\.role\s*!==\s*"owner"/);
      expect(resolveAt, "the page must resolve identity itself").toBeGreaterThan(-1);
      expect(refuseAt, "the page must refuse a non-owner").toBeGreaterThan(-1);
      // ORDER IS THE PROPERTY, not presence. Nothing may be awaited between
      // resolving the identity and refusing, or a non-owner's request does the
      // work and is only then turned away.
      expect(
        src.slice(resolveAt, refuseAt),
        "no await may sit between resolving identity and the owner refusal",
      ).not.toMatch(/\bawait\b/);
      // AND IT MUST HALT, by either shape. page.tsx RETURNS an owner-only
      // message; the two Connect callbacks REDIRECT to /settings/payments,
      // which then shows that message. redirect() throws in Next, so both
      // halt — asserting only `return` would have failed the callbacks for
      // being correct, which is what the first draft of this test did.
      expect(
        src.slice(refuseAt, refuseAt + 400),
        "the refusal must halt — return a refusal or redirect away, not merely branch",
      ).toMatch(/\breturn\b|\bredirect\s*\(/);
    });
  }

  it("/financials delegates to a helper whose refusal precedes every read", () => {
    const page = code(read("app/(app)/financials/page.tsx"));
    expect(
      page,
      "the page must hand the practitioner to the helper that refuses",
    ).toMatch(/loadFinancialsView\s*\(\s*practitioner/);

    const helper = code(read("lib/finance/financial-briefing.ts"));
    const refuseAt = helper.search(/practitioner\.role\s*!==\s*"owner"/);
    expect(refuseAt, "the helper must refuse on the role").toBeGreaterThan(-1);
    const firstRead = helper.search(/\.from\(/);
    // NON-VACUITY: the helper really does read, so the ordering below compares
    // against something rather than passing because nothing was found.
    expect(firstRead, "the helper must actually read a table").toBeGreaterThan(-1);
    expect(refuseAt, "the refusal must precede every table read").toBeLessThan(firstRead);
  });

  it("NON-VACUITY: ordinary practitioner surfaces carry NO owner refusal", () => {
    for (const rel of PRACTITIONER_PAGES) {
      const src = code(read(rel));
      expect(
        src,
        `${rel} must stay open to any practitioner — the refusal is for money, not for work`,
      ).not.toMatch(/practitioner\.role\s*!==\s*"owner"/);
    }
  });

  it("practitioners.role admits no third role, so owner-only is unambiguous", () => {
    // THE ONE GENUINELY NEW GUARANTEE IN THIS PR. "Owner/admins" resolves to
    // owner-only because there IS no admin studio role: practitioners.role is
    // CHECK-constrained to exactly ('owner','practitioner'). The only "admin"
    // in Hone is the PLATFORM /admin surface, which is not a studio
    // membership. If a third role is ever added this fails, and the financial
    // rule gets applied to it deliberately instead of by omission.
    const migrations = path.join(ROOT, "supabase", "migrations");
    const checks = readdirSync(migrations)
      .filter((f) => f.endsWith(".sql"))
      .flatMap((f) =>
        [
          ...readFileSync(path.join(migrations, f), "utf8").matchAll(
            /check\s*\(\s*role\s+in\s*\(([^)]*)\)/gi,
          ),
        ].map((m) => m[1]),
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
