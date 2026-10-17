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
  // EVERY FILE THAT TOUCHES THE BUCKET OR PATH IS CLASSIFIED (Codex P2
  // 4303573209). Sweeping for `createSignedUrl` alone was not enough: a new
  // photo surface that hands its bucket and path to a GENERIC signing helper
  // contains the treatment-image reference but no `createSignedUrl`, so it was
  // invisible — while the DB proof's whole structure rests on there being
  // exactly TWO minting sites.
  //
  // So the SET of referencing files is pinned, not just the signing ones. A new
  // file that mentions the bucket or path FAILS until it is classified here,
  // which is what makes the generic-helper case impossible to add silently.
  const GUARDED_SIGNING_SITES = [PAGE, ACTIONS] as const;

  /** Calls one of the guarded server actions; mints nothing itself. */
  const GUARDED_ACTION_CALLERS = [
    "app/(app)/clients/[id]/images/TreatmentImagesManager.tsx",
  ] as const;

  /**
   * Reference the bucket or path in CODE but perform NO signing: the export
   * registry, sanitising, the storage-path helpers, and the log redactor.
   *
   * `lib/types/database.ts` is deliberately ABSENT: its only mention is inside
   * a comment, and the sweep strips comments, so the classification is of CODE
   * references. `lib/ops/redact.ts` is present and was nearly MISSED — see the
   * note on the sweep below.
   */
  const NON_SIGNING_REFERENCES = [
    "lib/export/resource-registry.ts",
    "lib/images/treatment-image-sanitize.ts",
    "lib/images/treatment-images.ts",
    "lib/ops/redact.ts",
  ] as const;

  // THE SWEEP READS FILES DIRECTLY, AND THAT IS LOAD-BEARING. An audit of this
  // same question with `grep` MISSED lib/ops/redact.ts entirely: that file
  // contains a deliberate raw NUL byte as a redaction sentinel
  // (`\u0000U${i}\u0000`), so grep classifies it as BINARY and skips it
  // silently — `grep -c` reports 0 while `grep -ac` reports 2. Node's
  // readFileSync has no such behaviour, so this sweep sees it. Measured, not
  // assumed.
  function referencingFiles(): string[] {
    const out: string[] = [];
    for (const rel of globSync("{app,lib,components}/**/*.{ts,tsx}", {
      cwd: ROOT,
      nodir: true,
    })) {
      if (/treatment-images|TREATMENT_IMAGE/.test(code(read(rel)))) out.push(rel);
    }
    return out.sort();
  }

  it("every file touching the treatment-image bucket or path is classified", () => {
    const expected = [
      ...GUARDED_SIGNING_SITES,
      ...GUARDED_ACTION_CALLERS,
      ...NON_SIGNING_REFERENCES,
    ].sort();
    expect(
      referencingFiles(),
      "a file references the treatment-image bucket or path without being " +
        "classified — if it signs, add it to the DB proof in " +
        "tests/db/receptionist-photo-denial.db.test.ts first, then here",
    ).toEqual(expected);
  });

  it("only the two guarded sites mint a signature", () => {
    const signers = referencingFiles().filter((rel) =>
      /createSignedUrl/.test(code(read(rel))),
    );
    expect(signers.sort(), "a third minting site appeared").toEqual(
      [...GUARDED_SIGNING_SITES].sort(),
    );
    // NON-VACUITY: the classified non-signers really do not sign, so the
    // comparison above is not passing because the sweep found nothing.
    for (const rel of [...GUARDED_ACTION_CALLERS, ...NON_SIGNING_REFERENCES]) {
      expect(code(read(rel)), `${rel} must not mint a signature`).not.toMatch(
        /createSignedUrl/,
      );
    }
  });

  it("both known signing sites still exist (this guard is not passing by absence)", () => {
    // NON-VACUITY. If the page or the actions were renamed, the sweep above
    // would find nothing and report success while proving nothing.
    expect(/createSignedUrl/.test(code(read(PAGE))), `${PAGE} must still sign`).toBe(true);
    expect(/createSignedUrl/.test(code(read(ACTIONS))), `${ACTIONS} must still sign`).toBe(true);
  });

  it("the images page gates on the REDIRECTING guard, and it precedes every signature", () => {
    // NAMES THE REAL HELPERS (Codex P2 4301986282). The previous version banned
    // `getCurrentPractitionerWithStudioOrThrow`, WHICH DOES NOT EXIST IN THIS
    // REPOSITORY — so the negative assertion could never match and was
    // vacuous. The two real helpers in lib/supabase/queries.ts are:
    //   * requirePractitionerWithStudio()   :251  REDIRECTS  -> correct for a page
    //   * getCurrentPractitionerWithStudio() :202  THROWS     -> for server actions
    // A page must use the redirecting one: a surrounding try/catch can swallow
    // a throw, and a layout's redirect does not stop a page (layouts and pages
    // render in parallel).
    const src = code(read(PAGE));
    const guardAt = src.search(/requirePractitionerWithStudio\s*\(/);
    expect(guardAt, "the page must call requirePractitionerWithStudio()").toBeGreaterThan(-1);
    expect(
      src,
      "the page must not use the THROWING helper — a try/catch can swallow it",
    ).not.toMatch(/getCurrentPractitionerWithStudio\s*\(/);
    // ORDER, not merely presence: banning the throwing helper does not stop the
    // redirecting one being called AFTER a read or a signature, which would
    // leak before it gated. Both call sites must follow the guard.
    const signAt = src.indexOf("createSignedUrl");
    expect(signAt, "the page must sign").toBeGreaterThan(-1);
    expect(guardAt, "the guard must precede every createSignedUrl").toBeLessThan(signAt);
    const lastSign = src.lastIndexOf("createSignedUrl");
    expect(guardAt, "including the LAST signing site, not just the first").toBeLessThan(lastSign);
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
