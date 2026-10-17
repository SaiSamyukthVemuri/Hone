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


/** The body of a `{ … }` block starting at `braceAt`, brace-matched. */
function blockBody(src: string, braceAt: number): string {
  let depth = 0;
  for (let i = braceAt; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(braceAt + 1, i);
    }
  }
  throw new Error("unbalanced braces while scoping the refusal branch");
}

/** The parenthesised body of `create table … (` starting at `parenAt`. */
function parenBody(src: string, parenAt: number): string {
  let depth = 0;
  for (let i = parenAt; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(parenAt + 1, i);
    }
  }
  throw new Error("unbalanced parens while scoping the practitioners table");
}

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
      // AND THE BRANCH ITSELF MUST HALT. Scoped to the branch BODY by
      // brace-matching, not to a character window (Codex P2 4303218405): a
      // 400-character window around the condition swept up the OWNER's later
      // `redirect(url)` in refresh/page.tsx, so deleting the non-owner's own
      // `redirect("/settings/payments")` still passed while a non-owner went on
      // to create the connected account. The window proved the wrong thing.
      //
      // Both halting shapes are accepted on purpose: page.tsx RETURNS the
      // owner-only message, the two Connect callbacks REDIRECT to it, and
      // redirect() throws in Next. An earlier draft demanded a literal
      // `return` and failed the callbacks for being correct.
      const body = blockBody(src, src.indexOf("{", refuseAt));
      expect(
        body,
        "the non-owner branch must halt — return a refusal or redirect away",
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
    // owner-only because there IS no admin studio role. The only "admin" in
    // Hone is the PLATFORM /admin surface, which is not a studio membership.
    //
    // SCOPED TO THE practitioners TABLE (Codex P2 4303218407). An earlier draft
    // collected EVERY `check (role in (…))` across all migrations, and
    // 0007_pending_invitations.sql carries an identical check on
    // pending_invitations.role — so deleting the practitioners constraint would
    // have left the array non-empty and the test green, with the guarantee it
    // claims no longer enforced. Measured: both checks exist and both read
    // ('owner','practitioner'), which is exactly why the loose version passed.
    const migrations = path.join(ROOT, "supabase", "migrations");
    const found: string[][] = [];
    for (const f of readdirSync(migrations).filter((n) => n.endsWith(".sql"))) {
      const sql = readFileSync(path.join(migrations, f), "utf8");
      const create = /create table\s+(?:if not exists\s+)?public\.practitioners\s*\(/i.exec(sql);
      if (!create) continue;
      const columns = parenBody(sql, create.index + create[0].length - 1);
      const check = /check\s*\(\s*role\s+in\s*\(([^)]*)\)/i.exec(columns);
      if (check) {
        found.push([...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort());
      }
    }
    // NON-VACUITY: the constraint must be FOUND on practitioners itself, so
    // removing or renaming it fails here rather than passing by absence.
    expect(found.length, "practitioners.role must carry a role CHECK constraint").toBe(1);
    expect(found[0], "unexpected practitioners.role domain").toEqual([
      "owner",
      "practitioner",
    ]);
  });
});
