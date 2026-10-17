import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { globSync } from "glob";

// ===========================================================================
// #824 ROLE MATRIX — the treatment-image SIGNING SITES stay where the proof
// can see them.
// ===========================================================================
//
// tests/db/receptionist-photo-denial.db.test.ts proves a receptionist cannot
// reach a signed photo URL. That proof rests on a structural fact: a signature
// is minted in exactly TWO places, and both read the row (or the page's guard)
// first. A third call site added later would bypass the reasoning entirely and
// NO RUNTIME TEST WOULD NOTICE — the DB proof would still pass, because it
// asserts what the database returns, not where the app calls from.
//
// So this is the tripwire for that assumption, and it is deliberately a
// source-contract test: the thing being pinned is the SHAPE of the codebase.

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Comment-stripped, so a call site mentioned in prose is not counted as one. */
function code(src: string): string {
  return src.replace(/^[ \t]*\/\/[^\n]*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

const PAGE = "app/(app)/clients/[id]/images/page.tsx";
const ACTIONS = "app/(app)/clients/[id]/images/actions.ts";

describe("#824: treatment-image signatures are minted in exactly two places", () => {
  it("only the images page and its actions call createSignedUrl for treatment images", () => {
    const offenders: string[] = [];
    const files = globSync("{app,lib,components}/**/*.{ts,tsx}", { cwd: ROOT, nodir: true });
    for (const rel of files) {
      if (rel === PAGE || rel === ACTIONS) continue;
      const src = code(read(rel));
      if (!/createSignedUrl/.test(src)) continue;
      // Another surface may legitimately sign a DIFFERENT bucket; only
      // treatment images are in scope for the role-matrix proof.
      if (/treatment-images|TREATMENT_IMAGE/.test(src)) offenders.push(rel);
    }
    expect(
      offenders,
      "a new treatment-image signing site bypasses the receptionist denial proof " +
        "in tests/db/receptionist-photo-denial.db.test.ts — add it to that proof, " +
        "then to this list: " + offenders.join(", "),
    ).toEqual([]);
  });

  it("both known signing sites still exist (this guard is not passing by absence)", () => {
    // NON-VACUITY. If the page or the actions were renamed, the sweep above
    // would find nothing and report success while proving nothing.
    expect(/createSignedUrl/.test(code(read(PAGE))), `${PAGE} must still sign`).toBe(true);
    expect(/createSignedUrl/.test(code(read(ACTIONS))), `${ACTIONS} must still sign`).toBe(true);
  });

  it("the images page gates on the REDIRECTING practitioner guard", () => {
    // requirePractitionerWithStudio redirects a non-practitioner to /no-access.
    // The throwing backstop must not be used for a page: a surrounding
    // try/catch can swallow it, and a layout's redirect does not stop a page
    // (layouts and pages render in parallel).
    const src = code(read(PAGE));
    expect(src, "the page must call requirePractitionerWithStudio()").toMatch(
      /requirePractitionerWithStudio\s*\(/,
    );
    expect(
      src,
      "the page must not rely on the throwing backstop to gate itself",
    ).not.toMatch(/getCurrentPractitionerWithStudioOrThrow\s*\(/);
  });

  it("the signing action resolves identity with the THROWING variant, before anything else", () => {
    // This is the PRIMARY barrier for a receptionist: membership "none" throws
    // "No active practitioner found" (lib/supabase/queries.ts:218-220) before a
    // single query runs. A server action must use the throwing variant — a
    // redirect would be swallowed by the surrounding try/catch, which is
    // exactly how a denial becomes a silent success.
    const src = code(read(ACTIONS));
    const fn = src.slice(src.indexOf("getTreatmentImageSignedUrlAction"));
    const body = fn.slice(0, fn.indexOf("\nexport ") === -1 ? fn.length : fn.indexOf("\nexport "));
    const identityAt = body.indexOf("getCurrentPractitionerWithStudio(");
    const readAt = body.indexOf("treatment_images");
    expect(identityAt, "the action must resolve an active practitioner").toBeGreaterThan(-1);
    expect(
      identityAt,
      "identity must be resolved BEFORE the row is read — it is the primary denial",
    ).toBeLessThan(readAt);
    expect(
      body,
      "a server action must not gate itself with the redirecting variant",
    ).not.toMatch(/requirePractitionerWithStudio\s*\(/);
  });

  it("the signing action reads the row BEFORE it signs", () => {
    // The order is the whole denial: no row -> no signature. If a future edit
    // signed from an input path instead, a receptionist who knew a path could
    // mint a URL without ever reading the row.
    const src = code(read(ACTIONS));
    const fn = src.slice(src.indexOf("getTreatmentImageSignedUrlAction"));
    const body = fn.slice(0, fn.indexOf("\nexport ") === -1 ? fn.length : fn.indexOf("\nexport "));
    const readAt = body.search(/from\(["'`]treatment_images["'`]\)|treatment_images/);
    const signAt = body.indexOf("createSignedUrl");
    expect(readAt, "the action must read the image row").toBeGreaterThan(-1);
    expect(signAt, "the action must sign").toBeGreaterThan(-1);
    expect(readAt, "the row read must precede the signature").toBeLessThan(signAt);
  });
});
