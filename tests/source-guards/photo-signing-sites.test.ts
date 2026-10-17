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
//
// WHAT THIS FILE IS NOT: a proof. The denial is RLS — no readable row, no
// signature — proved behaviourally in the DB test above and controlled there
// against a live `using (true)` leak. This file only NOTICES if a minting site
// moves, multiplies, or stops gating. Its stated limitations are at the bottom.

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Comment-stripped, so a call site mentioned in prose is not counted as one. */
function code(src: string): string {
  return src.replace(/^[ \t]*\/\/[^\n]*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

const PAGE = "app/(app)/clients/[id]/images/page.tsx";
const ACTIONS = "app/(app)/clients/[id]/images/actions.ts";

type SrcFile = { rel: string; src: string };

/**
 * THE CORPUS IS DEFINED BY TWO INDEPENDENT TRIGGERS, and the first one is why
 * the earlier version of this guard had a realistic hole (Codex P2 4304... on
 * 5307a65d). It swept for the treatment-image NAME only, so a new surface
 * could read a `treatment_images` row and hand `row.storage_bucket` /
 * `row.storage_path` to a GENERIC signing helper: the helper names no
 * treatment image, so neither end entered the corpus and the tripwire stayed
 * green over an unreviewed minting path.
 *
 * TRIGGER 1 — CAN IT MINT AT ALL? Any file calling a Supabase storage API that
 * hands out a readable URL is classified, WHATEVER bucket it is given and
 * however it learns it. This is what closes the variable-supplied bucket: a
 * name pattern can never catch `createSignedUrl(objectPath)` on a `bucket`
 * parameter, but the call itself is always present. Repo-wide this matches
 * exactly the two guarded sites, so the rule is exact rather than approximate.
 *
 * `createSignedUrl` also matches the batch form `createSignedUrls`.
 * `getPublicUrl` and `createSignedUploadUrl` currently match NOTHING and are
 * included deliberately: a public URL on this bucket would be a worse leak
 * than a signed one, and a future edit reaching for either must land here.
 */
const MINTS = /createSignedUrl|createSignedUploadUrl|getPublicUrl/;

/**
 * TRIGGER 2 — DOES IT TOUCH TREATMENT-IMAGE DATA? The module path, the
 * exported constants (`TREATMENT_IMAGES_BUCKET`, the TTL, the limits) and the
 * TABLE name. The table spelling `treatment_images` is the half the earlier
 * sweep omitted while this same file already relied on it further down — that
 * made the omission an oversight in the corpus, not a deliberate scope.
 *
 * An import ALIAS cannot evade this: aliasing still names the module path in
 * the `from` clause, or the constant in the import clause.
 *
 * The generic storage COLUMN names (`storage_bucket`, `storage_path`) are
 * deliberately NOT triggers. They are not treatment-image-specific — any
 * future table may carry them — so matching them would fail this guard on
 * unrelated work. They are not needed for coverage either: to obtain those
 * values from a treatment image a caller must name the table (trigger 2), and
 * whatever finally signs must call a minting API (trigger 1).
 */
const TOUCHES = /treatment-images|TREATMENT_IMAGE|treatment_images/;

/**
 * Runtime source roots. Pinned by its own case below, because a sweep is only
 * as wide as its glob: a minting site added under a NEW top-level source root
 * would be invisible to this file no matter how good the patterns are.
 */
const SOURCE_ROOTS = ["app", "components", "lib"] as const;

let cached: SrcFile[] | null = null;
/** Read once: the corpus is consulted by several cases below. */
function repoFiles(): SrcFile[] {
  if (cached) return cached;
  cached = globSync(`{${SOURCE_ROOTS.join(",")}}/**/*.{ts,tsx}`, {
    cwd: ROOT,
    nodir: true,
  }).map((rel) => ({ rel, src: read(rel) }));
  return cached;
}

/** Everything the classification below must account for. */
function referencing(files: SrcFile[]): string[] {
  return files
    .filter((f) => {
      const c = code(f.src);
      return MINTS.test(c) || TOUCHES.test(c);
    })
    .map((f) => f.rel)
    .sort();
}

/** The subset that can actually hand out a URL. */
function minting(files: SrcFile[]): string[] {
  return files
    .filter((f) => MINTS.test(code(f.src)))
    .map((f) => f.rel)
    .sort();
}

describe("#824: treatment-image signatures are minted in exactly two places", () => {
  const GUARDED_SIGNING_SITES = [PAGE, ACTIONS] as const;

  /** Calls one of the guarded server actions; mints nothing itself. */
  const GUARDED_ACTION_CALLERS = [
    "app/(app)/clients/[id]/images/TreatmentImagesManager.tsx",
  ] as const;

  /**
   * Reference treatment-image data in CODE but perform NO minting: the export
   * registry, sanitising, the storage-path helpers, and the log redactor.
   *
   * `lib/types/database.ts` is deliberately ABSENT and stays absent under both
   * triggers: its only treatment-image mention is inside a comment and the
   * sweep strips comments, and its `storage_bucket` / `storage_path` rows are
   * generated types, which trigger 2 does not match by design (see above).
   * `lib/ops/redact.ts` is present and was nearly MISSED — see the note on the
   * sweep below.
   */
  const NON_SIGNING_REFERENCES = [
    "lib/export/resource-registry.ts",
    "lib/images/treatment-image-sanitize.ts",
    "lib/images/treatment-images.ts",
    "lib/ops/redact.ts",
  ] as const;

  // THE SWEEP READS FILES DIRECTLY, AND THAT IS LOAD-BEARING. An audit of this
  // same question with `grep` MISSED lib/ops/redact.ts entirely: that file
  // contains a deliberate raw NUL byte as a redaction sentinel, so grep
  // classifies it as BINARY and skips it silently — `grep -c` reports 0 while
  // `grep -ac` reports 2. Node's readFileSync has no such behaviour, so this
  // sweep sees it. Measured, not assumed.

  it("every file that can mint, or that touches treatment-image data, is classified", () => {
    const expected = [
      ...GUARDED_SIGNING_SITES,
      ...GUARDED_ACTION_CALLERS,
      ...NON_SIGNING_REFERENCES,
    ].sort();
    expect(
      referencing(repoFiles()),
      "a file can mint a storage URL, or touches treatment-image data, without " +
        "being classified — if it signs, add it to the DB proof in " +
        "tests/db/receptionist-photo-denial.db.test.ts first, then here",
    ).toEqual(expected);
  });

  it("only the two guarded sites can mint a URL at all", () => {
    expect(minting(repoFiles()).sort(), "a third minting site appeared").toEqual(
      [...GUARDED_SIGNING_SITES].sort(),
    );
    // NON-VACUITY: the classified non-signers really do not mint, so the
    // comparison above is not passing because the sweep found nothing.
    for (const rel of [...GUARDED_ACTION_CALLERS, ...NON_SIGNING_REFERENCES]) {
      expect(code(read(rel)), `${rel} must not mint a URL`).not.toMatch(MINTS);
    }
  });

  it("both known signing sites still exist (this guard is not passing by absence)", () => {
    // NON-VACUITY. If the page or the actions were renamed, the sweep above
    // would find nothing and report success while proving nothing.
    expect(/createSignedUrl/.test(code(read(PAGE))), `${PAGE} must still sign`).toBe(true);
    expect(/createSignedUrl/.test(code(read(ACTIONS))), `${ACTIONS} must still sign`).toBe(true);
  });

  it("the sweep covers every runtime source root", () => {
    // A guard is only as wide as its glob. If a new top-level root of runtime
    // code appears, a minting site inside it would be invisible to every case
    // above — so the root set is pinned here and this case fails until the
    // glob is revisited. Test harnesses (e2e*, tests) are excluded on purpose:
    // they ship nothing.
    const HARNESS = new Set([
      "e2e",
      "e2e-google",
      "e2e-mobile",
      "e2e-payment",
      "tests",
      "node_modules",
    ]);
    const roots = new Set<string>();
    // `node_modules` is excluded for SPEED, not correctness: globbing it took
    // 3.7s of this file's 5.0s, and vitest's per-test default is 5s — a test
    // sitting that close to its ceiling goes red under parallel load and reads
    // exactly like a broken diff.
    for (const rel of globSync("*/**/*.{ts,tsx}", {
      cwd: ROOT,
      nodir: true,
      ignore: ["node_modules/**"],
    })) {
      if (rel.endsWith(".d.ts")) continue; // declarations cannot mint
      const top = rel.split("/")[0];
      if (!HARNESS.has(top)) roots.add(top);
    }
    expect(
      [...roots].sort(),
      "a new root of runtime source appeared — widen SOURCE_ROOTS (or add it " +
        "to HARNESS if it ships nothing) so the sweep can still see a minting site",
    ).toEqual([...SOURCE_ROOTS].sort());
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

// ===========================================================================
// CONTROLS — one per REALISTIC bypass.
// ===========================================================================
//
// A tripwire that has never been seen to fire is a claim, not a guard. Each
// case below is a bypass someone could plausibly WRITE — not contrived
// obfuscation — fed through the SAME predicate the cases above use, and
// asserted to be caught. MEASURED, not assumed: regressing MINTS and TOUCHES
// to the pre-fix pattern fails exactly four of the five (the generic signer,
// the row-derived caller, the public URL and the upload URL) while the
// discriminating case below stays green.
// They are synthetic sources rather than files on disk
// deliberately: a control that had to write .ts into the tree could not run in
// CI (tsconfig includes `**/*.ts`, so a stray file fails typecheck and the
// error reads as though the diff caused it).

describe("#824: the sweep catches each realistic bypass", () => {
  const BYPASSES = [
    {
      what: "a GENERIC signer that receives the bucket in a VARIABLE and never names a treatment image",
      rel: "lib/storage/sign-object.ts",
      mints: true,
      src: `
        import { createClient } from "@/lib/supabase/server";
        export async function signObject(bucket: string, objectPath: string) {
          const supabase = await createClient();
          const { data } = await supabase.storage.from(bucket).createSignedUrl(objectPath, 60);
          return data?.signedUrl ?? null;
        }
      `,
    },
    {
      what: "a caller that reads the row and hands storage_bucket / storage_path to that helper, minting nothing itself",
      rel: "app/(app)/clients/[id]/gallery/page.tsx",
      mints: false,
      src: `
        import { signObject } from "@/lib/storage/sign-object";
        import { createClient } from "@/lib/supabase/server";
        export default async function Gallery({ params }: { params: { id: string } }) {
          const supabase = await createClient();
          const { data: rows } = await supabase
            .from("treatment_images")
            .select("storage_bucket, storage_path")
            .eq("client_id", params.id);
          const urls = await Promise.all(
            (rows ?? []).map((r) => signObject(r.storage_bucket, r.storage_path)),
          );
          return <div>{urls.length}</div>;
        }
      `,
    },
    {
      // ALREADY COVERED BEFORE THE FIX, and labelled so: under the pre-fix
      // predicate this case still passes, because `TREATMENT_IMAGES_BUCKET`
      // contains `TREATMENT_IMAGE`. It is kept as coverage of a named shape,
      // NOT as evidence that the fix changed anything. The four cases around
      // it are the ones that fail when the predicate is regressed.
      what: "an IMPORT ALIAS of the bucket constant, handed to a helper",
      rel: "lib/images/alias-route.ts",
      mints: false,
      src: `
        import { TREATMENT_IMAGES_BUCKET as B } from "@/lib/images/treatment-images";
        import { signObject } from "@/lib/storage/sign-object";
        export const sign = (p: string) => signObject(B, p);
      `,
    },
    {
      what: "a PUBLIC url on the bucket — a worse leak than a signature, and a different API",
      rel: "components/ClientPhotoStrip.tsx",
      mints: true,
      src: `
        import { createClient } from "@/lib/supabase/server";
        export async function strip(objectPath: string) {
          const supabase = await createClient();
          return supabase.storage.from("some-bucket").getPublicUrl(objectPath).data.publicUrl;
        }
      `,
    },
    {
      what: "an UPLOAD url, which also hands out write access to an object path",
      rel: "lib/storage/upload-url.ts",
      mints: true,
      src: `
        import { createClient } from "@/lib/supabase/server";
        export async function uploadUrl(bucket: string, objectPath: string) {
          const supabase = await createClient();
          return (await supabase.storage.from(bucket).createSignedUploadUrl(objectPath)).data;
        }
      `,
    },
  ] as const;

  for (const b of BYPASSES) {
    it(`CATCHES: ${b.what}`, () => {
      const mutant = { rel: b.rel, src: b.src };
      const corpus = [...repoFiles(), mutant];
      expect(
        referencing(corpus),
        `${b.rel} must enter the corpus, so the classification case fails until a human classifies it`,
      ).toContain(b.rel);
      if (b.mints) {
        expect(
          minting(corpus),
          `${b.rel} can hand out a URL, so it must fail the "only two guarded sites" case`,
        ).toContain(b.rel);
      } else {
        expect(
          minting(corpus),
          `${b.rel} mints nothing itself — it must be caught by the data trigger, not the minting one`,
        ).not.toContain(b.rel);
      }
    });
  }

  it("is not simply catching everything (the controls are discriminating)", () => {
    // NON-VACUITY FOR THE CONTROLS THEMSELVES. If the predicate matched any
    // file at all, every case above would pass while proving nothing.
    const innocuous = {
      rel: "lib/util/format-duration.ts",
      src: `
        export function formatDuration(mins: number) {
          const h = Math.floor(mins / 60);
          return h > 0 ? h + "h " + (mins % 60) + "m" : mins + "m";
        }
      `,
    };
    const corpus = [...repoFiles(), innocuous];
    expect(referencing(corpus)).not.toContain(innocuous.rel);
    expect(minting(corpus)).not.toContain(innocuous.rel);
  });
});

// ===========================================================================
// STATED LIMITATIONS — what this file does NOT establish.
// ===========================================================================
//
// 1. A SOURCE GUARD IS NOT A PROOF. It reads text. The denial is RLS, proved
//    behaviourally in tests/db/receptionist-photo-denial.db.test.ts against a
//    live-leak negative control. If this file and that one disagree, that one
//    is the evidence.
// 2. REACHABILITY IS NOT CHECKED. A classified site could gain a branch that
//    mints without the gate; order is asserted lexically, not on a call graph.
// 3. DYNAMIC DISPATCH IS NOT CHECKED. A minting call assembled at runtime
//    (`storage[fn](...)`, a string built from parts) matches no pattern here.
//    Trigger 1 catches the API NAME; it cannot catch the name's absence.
// 4. THE CONTROLS BYPASS THE GLOB. They inject a synthetic file into the
//    corpus, so they prove the PREDICATE catches each shape — not that the
//    glob would have found the file. That half is covered separately by the
//    runtime-source-root case, which fails if a new source root appears.
// 5. NON-TS SURFACES ARE OUT OF SCOPE. A route or edge function written in
//    another language, or SQL that returns a URL, is not swept.
// 6. CLASSIFICATION IS A HUMAN ACT. Entering the corpus only forces a review;
//    nothing stops a future editor from adding a genuine minting site to
//    NON_SIGNING_REFERENCES. The "only two guarded sites can mint" case is
//    what makes that specific mistake fail loudly.
