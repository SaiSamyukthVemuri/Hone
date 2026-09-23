import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// ===========================================================================
// UX-02 — SECTION LABEL ADOPTION, PROVED FOR THIS BOUNDED SLICE.
//
// `components/ui/section-label.tsx` owns the uppercase section label. Twenty-one
// call sites across Settings → Availability spelled its class list out by hand;
// this slice replaced them with the primitive. `--color-fg-muted` is
// `oklch(55.6% 0 0)`, annotated "neutral-500" in app/globals.css, so the two
// render identically and the hand-rolled form carried no information.
//
// WHAT THIS PROVES, AND DELIBERATELY NOTHING MORE:
//
//   1. every converted file uses SectionLabel;
//   2. no converted file still contains the hand-rolled duplicate;
//   3. legacy occurrence counts do not INCREASE from the measured baseline;
//   4. SectionLabel remains the source of truth for the contract.
//
// WHAT THIS DOES NOT ATTEMPT, AND WHY THAT IS A DECISION RATHER THAN A GAP.
//
// It reads `className="…"` string literals from the AST. It does NOT interpret
// conditional expressions, nested templates, arbitrary `cx(...)` composition,
// cross-module values, or JavaScript generally.
//
// An earlier revision of this file did try. It grew constant resolution,
// lexical scope tracking and call-argument combination, and across six review
// rounds twelve findings landed — nine of them edges in THAT machinery rather
// than in the thing being protected, and one a false positive that would have
// failed correct code. The asymmetry is the argument: a missed duplicate costs
// one duplicated class list, while a false positive blocks work that was never
// wrong.
//
// Preventing every possible syntactic spelling requires a Tailwind/TypeScript
// interpreter. That is a tooling-architecture problem, recorded as debt, and
// not something a bounded primitive-adoption slice should carry.
//
// The failure this DOES prevent is the one that actually recurs: a duplicate
// copied from a neighbouring file during ordinary work, written as a plain
// literal.
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, "../..");
const PRIMITIVE = "components/ui/section-label.tsx";
const PRIMITIVE_SOURCE = readFileSync(path.join(REPO_ROOT, PRIMITIVE), "utf8");
/**
 * The files this slice actually converted.
 *
 * Named explicitly rather than derived from the directory: Settings →
 * Availability also contains page.tsx, PractitionerWeekEditor.tsx and
 * ScopeSelector.tsx, which carried no hand-rolled label and were correctly left
 * alone. A prefix match would have demanded the primitive from files that never
 * needed it.
 */
const CONVERTED: readonly string[] = [
  "app/(app)/settings/availability/AvailabilityClient.tsx",
  "app/(app)/settings/availability/RecurringBreaksSection.tsx",
  "app/(app)/settings/availability/ScopeField.tsx",
  "app/(app)/settings/availability/TimedBlocksSection.tsx",
];
const ROOTS = ["app", "components"];

/**
 * The contract, READ FROM THE PRIMITIVE (requirement 4).
 *
 * Restating it here would make this file a second source of truth: editing
 * section-label.tsx would leave the guard enforcing a contract the primitive no
 * longer has, green and protecting nothing.
 */
function contractFromPrimitive(): {
  typography: Set<string>;
  muted: Set<string>;
  sizes: Set<string>;
} {
  const shared = /"([^"]*\bfont-medium\b[^"]*\buppercase\b[^"]*\btracking-wider\b[^"]*)"/.exec(
    PRIMITIVE_SOURCE,
  );
  const tone = /tone === "muted" && "([a-z0-9-]+)"/.exec(PRIMITIVE_SOURCE);
  const sizeBlock = /const SIZE = \{([\s\S]*?)\} as const;/.exec(PRIMITIVE_SOURCE);
  expect(shared, `${PRIMITIVE} no longer states its shared class string`).toBeTruthy();
  expect(tone, `${PRIMITIVE} no longer states its muted tone class`).toBeTruthy();
  expect(sizeBlock, `${PRIMITIVE} no longer declares a SIZE map`).toBeTruthy();
  return {
    typography: new Set(shared![1].split(/\s+/).filter(Boolean)),
    // The token spelling is read from the primitive; `text-neutral-500` is the
    // raw spelling the legacy call sites use for the same colour.
    muted: new Set([tone![1], "text-neutral-500"]),
    sizes: new Set([...sizeBlock![1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1])),
  };
}

const CONTRACT = contractFromPrimitive();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * `className="…"` string literals, via the AST.
 *
 * The parser is used rather than a regex for one narrow reason: a comment is
 * never a JsxAttribute. A regex scan of this same pattern was corrupted by
 * matches sitting inside comments and reported two already-converted files as
 * the best remaining candidates. Expression containers are out of scope by
 * design — see the header.
 */
function classNameLiterals(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "className" &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      out.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/**
 * Hand-rolled duplicates of the primitive in `file`.
 *
 * A baseline file that no longer exists counts as ZERO, not as an error.
 * Deleting a legacy component is a legitimate way for its count to fall, and
 * reading it unconditionally made the shrink-only rule throw ENOENT on exactly
 * that — turning every listed path into permanent bookkeeping and failing the
 * guard for an adoption succeeding.
 */
function duplicates(file: string): string[] {
  const full = path.join(REPO_ROOT, file);
  let source: string;
  try {
    source = readFileSync(full, "utf8");
  } catch (error) {
    // ONLY "absent" becomes zero, and only because it is distinguishable.
    //
    // `existsSync` was the obvious spelling and is wrong twice over: it cannot
    // tell an absent file from an unreadable one, and it leaves a gap between
    // the check and the read. Catching ENOENT answers the exact question — did
    // the file go away? — and lets every other failure through. A file that
    // EXISTS but cannot be read must fail loudly rather than quietly count as
    // adopted.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  return classNameLiterals(source, file).filter((literal) => {
    const classes = [...new Set(literal.split(/\s+/).filter(Boolean))];
    const set = new Set(classes);
    if (![...CONTRACT.typography].every((c) => set.has(c))) return false;
    if (!classes.some((c) => CONTRACT.muted.has(c))) return false;
    if (classes.filter((c) => CONTRACT.sizes.has(c)).length !== 1) return false;
    // Anything else makes it a VARIANT — a caution colour, a layout class — and
    // the primitive does not own those.
    return !classes.some(
      (c) => !CONTRACT.typography.has(c) && !CONTRACT.muted.has(c) && !CONTRACT.sizes.has(c),
    );
  });
}

/**
 * THE SHRINK-ONLY RULE, as a pure function.
 *
 * For a baseline of N: 0..N are all valid and N+1 is not. Zero is a valid
 * destination, not a floor — a fully adopted file has no duplicates left, and a
 * deleted one has no file left.
 *
 * It lives here, separate from any file, because the rule and the counting are
 * different things. Asserting it through real file contents could only ever
 * exercise whichever count the tree happens to hold today, and an earlier
 * control did exactly that: it pinned the sample "> 0", quietly making a
 * successful adoption to zero a FAILURE of the rule that exists to permit it.
 */
function exceedsBaseline(actual: number, baseline: number): boolean {
  return actual > baseline;
}

/**
 * Did the path go away? Same question, and the same answer, as `duplicates`.
 *
 * Deliberately NOT `existsSync`, for the reasons recorded there: it cannot tell
 * an absent file from an unreadable one, and it leaves a gap between the check
 * and the read. Catching ENOENT answers the exact question and lets every other
 * failure through, so an unreadable file fails loudly instead of quietly reading
 * as "deleted, therefore adopted".
 */
function isAbsent(file: string): boolean {
  try {
    readFileSync(path.join(REPO_ROOT, file), "utf8");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    throw error;
  }
}

/**
 * The baseline has gone STALE: the file carries FEWER occurrences than recorded.
 *
 * WHY SHRINK-ONLY WAS NOT ENOUGH — the defect this closes. `actual > baseline`
 * alone makes the recorded number a permanent CEILING. Adopt a file from 5 to 4
 * without touching the table and the ceiling stays 5, so a later change may
 * reintroduce the fifth hand-rolled label and still pass. The adoption becomes
 * silently reversible, which is exactly what an anti-regression guard exists to
 * prevent. This was not hypothetical: `calendar/[id]/page.tsx` was recorded at
 * 15 and already measured 14 when this rule was added.
 *
 * THIS IS NOT THE EXACT-EQUALITY RULE THAT WAS TRIED AND REJECTED. That demanded
 * the table track a moving target on every unrelated edit. This fires only where
 * the table is PROVABLY out of date — the file really did shrink — and the fix is
 * one number, in the same change that earned it.
 *
 * A DELETED FILE IS NOT *STALE* IN THIS SENSE — it has no count to compare —
 * but its ENTRY is a different question, answered by `entryIsOrphaned` below.
 */
function baselineIsStale(file: string, actual: number, baseline: number): boolean {
  if (isAbsent(file)) return false;
  return actual < baseline;
}

/**
 * The entry outlived the file it describes.
 *
 * WHY DELETION ALONE WAS NOT A RETIREMENT. Treating an absent path as "zero
 * duplicates, nothing to report" let the ENTRY survive the file. The allowance
 * it grants survives with it, so recreating that exact path later — a revert, a
 * file moved back, a component restored — silently reinherits the historical
 * duplicate budget. Every retired duplicate could return and the rule would
 * still be green, because the table still says that path is allowed N of them.
 *
 * Deletion is a valid retirement only when the ALLOWANCE disappears too. So an
 * absent path makes its own entry stale, and the entry must be removed. A
 * recreated path then starts as what it actually is: a new, non-baselined file,
 * held to zero by rule 3b like any other.
 *
 * Absence is still ENOENT-only. An unreadable file is not absent and must not
 * quietly retire its own budget — `isAbsent` throws on anything else.
 */
function entryIsOrphaned(file: string): boolean {
  return isAbsent(file);
}

/**
 * The measured baseline: files still hand-rolling the label, and how many times.
 *
 * Counts may FALL as surfaces are adopted; they may not RISE. An exact-equality
 * rule was tried and rejected — it turned every partial adoption into
 * bookkeeping churn without protecting anything more, because the regression
 * being guarded against is growth.
 *
 * `calendar/QuickBookDrawer.tsx` and `records/page.tsx` are owned by another PR
 * and are not this lane's to convert.
 */
const LEGACY_BASELINE: ReadonlyArray<readonly [string, number]> = [
  ["app/(app)/calendar/AppointmentNotesEditor.tsx", 1],
  ["app/(app)/calendar/AppointmentOutcomeRepair.tsx", 1],
  ["app/(app)/calendar/PractitionerCancelForm.tsx", 1],
  ["app/(app)/calendar/QuickBookDrawer.tsx", 5],
  ["app/(app)/calendar/[id]/ManualFeeChargeCard.tsx", 1],
  ["app/(app)/calendar/[id]/page.tsx", 14],
  ["app/(app)/clients/[id]/BookAppointment.tsx", 6],
  ["app/(app)/clients/[id]/intake/page.tsx", 1],
  ["app/(app)/clients/[id]/page.tsx", 1],
  ["app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", 4],
  ["app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", 4],
  ["app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx", 1],
  ["app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form.tsx", 3],
  ["app/(app)/clients/[id]/sessions/new/page.tsx", 1],
  ["app/(app)/dashboard/practice-snapshot.tsx", 2],
  ["app/(app)/records/page.tsx", 2],
  ["app/(app)/settings/booking/BookingLinkCard.tsx", 1],
  ["app/(app)/settings/consent/ConsentTemplatesEditor.tsx", 1],
  ["app/(app)/settings/intake/page.tsx", 1],
  ["app/(app)/settings/services/page.tsx", 2],
  ["app/(app)/settings/tracking/TrackingProviderSelector.tsx", 2],
  ["components/appointment/postcare-section.tsx", 1],
  ["components/clinical-notes-section.tsx", 3],
  ["components/consultation-notes-card.tsx", 2],
  ["components/log-electrolysis-entry-form.tsx", 2],
  ["components/multi-area-editor.tsx", 1],
  ["components/payment/payment-summary-card.tsx", 1],
  ["components/portal-messages-card.tsx", 2],
  ["components/probe-picker.tsx", 3],
  ["components/profile-tab-bar.tsx", 1],
  ["components/selected-observations.tsx", 1],
  ["components/treatment-intelligence-card.tsx", 1],
  ["components/treatment-plans-card.tsx", 3],
];

/**
 * A discovered absolute path, as this file's canonical lists spell it.
 *
 * `path.relative` emits the PLATFORM separator: `app\foo.tsx` on Windows, while
 * `CONVERTED`, `PRIMITIVE` and `LEGACY_BASELINE` are all written with `/`. Every
 * membership test here is a string comparison against those lists, so on a
 * Windows runner or developer machine nothing matches: converted files look
 * missing, baseline exclusions stop excluding, and the guard reports failures
 * that are entirely an artefact of the separator.
 *
 * The canonical lists stay platform-independent — they describe the repository,
 * not the machine reading it — so the DISCOVERED side is what normalizes.
 *
 * `split(sep).join("/")` rather than a blanket backslash replace: on POSIX a
 * backslash is a legal filename character, and rewriting it would corrupt a real
 * path. Splitting on the platform's own separator is a no-op on POSIX (where it
 * is already "/") and correct on Windows.
 *
 * `sep` is a parameter so the Windows behaviour is provable on a POSIX runner.
 */
export function toRepoPath(relative: string, sep: string = path.sep): string {
  return sep === "/" ? relative : relative.split(sep).join("/");
}

/**
 * Which of these paths still carry an unnormalized separator?
 *
 * The downstream rule, as a function of the separator rather than of the machine
 * running it. Written this way for one reason: the assertion it replaces used
 * the LIVE `path.sep` even when simulating the OTHER platform's semantics, so a
 * fixture that is legal only under POSIX was read as a Windows separator on a
 * Windows runner and could never pass there.
 *
 * With the separator as a parameter, the live rule passes `path.sep` and each
 * semantic test states which platform it means. Nothing is skipped, and both
 * behaviours are proved on every runner.
 *
 * When the separator IS "/", nothing can be unnormalized — every path is
 * canonical by construction, and a backslash is just a legal filename character.
 */
export function unnormalizedUnder(
  files: readonly string[],
  sep: string = path.sep,
): string[] {
  return sep === "/" ? [] : files.filter((f) => f.includes(sep));
}

const BASELINE = new Map(LEGACY_BASELINE.map(([f, n]) => [f, n]));
const FILES = ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root))).map((f) =>
  toRepoPath(path.relative(REPO_ROOT, f)),
);
const ADOPTED = CONVERTED;

describe("UX-02: SectionLabel adoption on Settings → Availability", () => {
  it("4. the contract is read from the primitive, not restated here", () => {
    for (const c of ["font-medium", "uppercase", "tracking-wider"]) {
      expect(CONTRACT.typography.has(c), `contract lost ${c}`).toBe(true);
    }
    expect(CONTRACT.muted.has("text-fg-muted"), "the primitive's muted token went unread").toBe(
      true,
    );
    expect(CONTRACT.sizes.size, "the primitive's SIZE map went unread").toBeGreaterThan(0);
  });

  it("1. every converted file uses SectionLabel", () => {
    expect(ADOPTED.length, "the converted set disappeared").toBe(4);
    for (const file of ADOPTED) {
      expect(FILES, `${file} is no longer in the tree`).toContain(file);
    }
    const without = ADOPTED.filter(
      (file) => !readFileSync(path.join(REPO_ROOT, file), "utf8").includes("<SectionLabel"),
    );
    expect(without, "converted files must render the primitive").toEqual([]);
  });

  it("2. no converted file still hand-rolls the duplicate", () => {
    for (const file of ADOPTED) {
      expect(duplicates(file), `${file} still hand-rolls the label`).toEqual([]);
      expect(BASELINE.has(file), `${file} should not be on the legacy baseline`).toBe(false);
    }
  });

  it("2b. the conversion is complete — 21 sites across the four converted files", () => {
    // The slice's own claim, asserted rather than described: counting the
    // primitive's usages is what makes "21 exact conversions" checkable.
    const total = ADOPTED.reduce(
      (sum, file) =>
        sum +
        (readFileSync(path.join(REPO_ROOT, file), "utf8").match(/<SectionLabel[\s>]/g) ?? []).length,
      0,
    );
    expect(total, "the converted site count moved").toBe(21);
  });

  it("3. legacy occurrence counts never increase from the baseline", () => {
    const grown: string[] = [];
    for (const [file, baseline] of LEGACY_BASELINE) {
      const actual = duplicates(file).length;
      if (exceedsBaseline(actual, baseline)) {
        grown.push(`${file}: baseline ${baseline}, found ${actual}`);
      }
    }
    expect(grown, "a legacy file gained hand-rolled labels").toEqual([]);
  });

    it("3a. the baseline RATCHETS DOWN — a reduced file must record its reduction", () => {
      // Without this the recorded number is a permanent ceiling and an adoption is
      // silently reversible: shrink 5 -> 4 without editing the table and the fifth
      // label may return, still green. The number must follow the code DOWN so it
      // can never drift back up.
      const stale: string[] = [];
      for (const [file, baseline] of LEGACY_BASELINE) {
        const actual = duplicates(file).length;
        if (baselineIsStale(file, actual, baseline)) {
          stale.push(`${file}: baseline ${baseline}, found ${actual} — lower it to ${actual}`);
        }
      }
      expect(
        stale,
        "a legacy file has FEWER hand-rolled labels than its recorded baseline. " +
          "Lower the baseline in the same change that earned the reduction, or the " +
          "removed duplicate can be reintroduced later and still pass.",
      ).toEqual([]);
    });

    it("3a-bis. a DELETED path must RETIRE its entry, not keep its allowance", () => {
      // Deletion retires the FILE; without this it does not retire the BUDGET.
      // An absent path whose entry survives still says "this path may hold N
      // hand-rolled labels", so recreating it later — a revert, a move back, a
      // restored component — silently reinherits the whole historical allowance
      // and every retired duplicate can return while the rule stays green.
      //
      // A recreated path must start as what it actually is: a new, non-baselined
      // file, held to zero by 3b like any other.
      const orphaned = LEGACY_BASELINE.filter(([file]) => entryIsOrphaned(file)).map(
        ([file, baseline]) => `${file}: entry allows ${baseline} but the path is gone`,
      );
      expect(
        orphaned,
        "a baseline entry outlived its file. Remove the entry in the same change " +
          "that deleted the path — deletion is a retirement only when the allowance " +
          "goes with it, otherwise recreating the path reinherits the old budget.",
      ).toEqual([]);
    });

  describe("3c. the shrink-only rule's file-absence edge", () => {
    // A baseline entry must be retirable by DELETING the component, not only by
    // editing this list. Reading every path unconditionally threw ENOENT and
    // failed the rule for an adoption that had succeeded.
    const [sampleFile, sampleBaseline] = LEGACY_BASELINE[0];

    it("0..N all pass and only N+1 fails — including shrink to ZERO", () => {
      // Driven synthetically against the rule itself, so every count is
      // exercised rather than only the one today's tree happens to hold.
      const N = sampleBaseline;
      expect(N, "the sample entry needs a baseline above zero to be meaningful").toBeGreaterThan(0);
      for (let actual = 0; actual <= N; actual += 1) {
        expect(exceedsBaseline(actual, N), `${actual} of ${N} must be allowed`).toBe(false);
      }
      expect(exceedsBaseline(N + 1, N), "N+1 must be rejected").toBe(true);
    });

    it("a fully adopted file — zero left — is a PASS, not a floor violation", () => {
      // Stated on its own because it is the case the previous control forbade.
      expect(exceedsBaseline(0, sampleBaseline)).toBe(false);
      expect(exceedsBaseline(0, 0)).toBe(false);
    });

    it("the real sample is within its baseline", () => {
      // No lower bound asserted: the sample may legitimately reach zero.
      const actual = duplicates(sampleFile).length;
      expect(
        exceedsBaseline(actual, sampleBaseline),
        `${sampleFile}: baseline ${sampleBaseline}, found ${actual}`,
      ).toBe(false);
    });

    it("a deleted baseline file counts as zero", () => {
      expect(duplicates("app/(app)/settings/availability/__deleted__.tsx")).toEqual([]);
    });

    it("a read failure that is NOT absence still throws", () => {
      // A directory yields EISDIR, not ENOENT — a distinguishable failure that
      // must not be laundered into "zero duplicates, therefore adopted".
      expect(() => duplicates("app/(app)/settings/availability")).toThrow();
    });
  });

  it("3b. no file outside the baseline introduces the duplicate", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file === PRIMITIVE || BASELINE.has(file)) continue;
      const hits = duplicates(file);
      if (hits.length > 0) offenders.push(`${file}: ${hits.length}x "${hits[0]}"`);
    }
    expect(offenders, "use <SectionLabel> — this is exactly what it renders").toEqual([]);
  });

  it("reads literals from the AST, so a comment is not a call site", () => {
    const commented = `
      export function X() {
        // <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        return <div>{/* <span className="text-xs font-medium uppercase tracking-wider text-neutral-500" /> */}</div>;
      }
    `;
    expect(classNameLiterals(commented, "commented.tsx")).toEqual([]);
  });
});

// P2 (#746 exact-head review): discovered paths must be canonical before they
// are compared to the lists in this file.
//
// Every membership test here is a string comparison against CONVERTED,
// PRIMITIVE or LEGACY_BASELINE, all of which are written with "/". `path.relative`
// emits the PLATFORM separator, so on Windows a discovered "app\foo.tsx" matches
// none of them: converted files read as missing, baseline exclusions stop
// excluding, and the guard fails for a reason that has nothing to do with the
// code it is guarding.
describe("discovered paths are normalized before comparison", () => {
  it("a Windows-style discovered path becomes the canonical repository path", () => {
    // The control the repair exists for. `sep` is passed explicitly so this runs
    // identically on a POSIX runner, where path.sep would never reproduce it.
    expect(toRepoPath("app\\(app)\\settings\\availability\\page.tsx", "\\")).toBe(
      "app/(app)/settings/availability/page.tsx",
    );
    expect(toRepoPath("components\\probe-picker.tsx", "\\")).toBe(
      "components/probe-picker.tsx",
    );
  });

  it("a POSIX path is returned unchanged", () => {
    expect(toRepoPath("components/probe-picker.tsx", "/")).toBe(
      "components/probe-picker.tsx",
    );
  });

  it("a backslash in a POSIX filename is NOT rewritten", () => {
    // Why this is split(sep).join("/") and not a blanket replace: on POSIX a
    // backslash is a legal filename character, and rewriting it would invent a
    // directory boundary that does not exist.
    expect(toRepoPath("components/odd\\name.tsx", "/")).toBe(
      "components/odd\\name.tsx",
    );
  });

  it("normalized discovery actually matches the canonical lists", () => {
    // End-to-end rather than unit-only: a Windows-shaped path for a file that IS
    // on the baseline must land on its entry once normalized.
    const windowsShaped = "components\\probe-picker.tsx";
    expect(BASELINE.has(toRepoPath(windowsShaped, "\\"))).toBe(true);
    // And the un-normalized form must NOT — otherwise this proves nothing.
    expect(BASELINE.has(windowsShaped)).toBe(false);
  });

  it("the live discovery carries no UNNORMALIZED platform separator", () => {
    // A BACKSLASH IS NOT EVIDENCE OF A BAD PATH. An earlier revision of this
    // assertion rejected every discovered path containing one, which reproduced
    // on POSIX the very defect `toRepoPath` is careful to avoid: there, "\" is a
    // legal filename character, so `components/odd\name.tsx` is a real file the
    // repository may legitimately hold — and this rule would have failed it.
    //
    // What must be absent is the ACTIVE platform separator, and only where that
    // separator is not already "/". On POSIX there is nothing to check: path.sep
    // IS "/", every discovered path is canonical by construction, and a
    // backslash means only what it says.
    expect(FILES.length, "no files discovered — vacuous").toBeGreaterThan(0);
    expect(
      unnormalizedUnder(FILES),
      `a discovered path still carries the platform separator ${JSON.stringify(path.sep)}`,
    ).toEqual([]);
  });

  // THE SEMANTIC TESTS PIN THEIR OWN SEPARATOR, AND THAT IS THE WHOLE POINT.
  //
  // The previous revision wrote the POSIX case against the LIVE `path.sep`. On a
  // Windows runner that is "\", so the fixture — a filename legal only under
  // POSIX semantics — was read as containing the active separator and the
  // assertion could never pass there. The test meant to prove "POSIX backslashes
  // are legal" silently asserted Windows semantics instead, which is the same
  // class of mistake as the rule it was written to protect.
  //
  // Both cases now state which semantics they are testing, so each runs and
  // proves the same thing on every platform. Nothing is skipped.

  it("POSIX semantics: a legal backslash filename is normalized AND not rejected", () => {
    // Simulated rather than created on disk: writing a file whose name contains
    // a backslash to prove a path rule would leave it in the repository for the
    // lifetime of the test.
    const legal = "components/odd\\name.tsx";
    expect(toRepoPath(legal, "/"), "POSIX: the normalizer leaves it alone").toBe(legal);
    expect(
      unnormalizedUnder([legal], "/"),
      "POSIX: a legal filename was rejected as a bad path",
    ).toEqual([]);
  });

  it("WINDOWS semantics: an unnormalized separator is normalized AND caught", () => {
    const unnormalized = "app\\(app)\\settings\\availability\\page.tsx";
    expect(unnormalized.includes("\\"), "the fixture must be unnormalized").toBe(true);
    // Caught while it is still raw...
    expect(
      unnormalizedUnder([unnormalized], "\\"),
      "Windows: an unnormalized path was not caught",
    ).toEqual([unnormalized]);
    // ...and no longer caught once normalized, which is what discovery does.
    expect(toRepoPath(unnormalized, "\\")).toBe("app/(app)/settings/availability/page.tsx");
    expect(unnormalizedUnder([toRepoPath(unnormalized, "\\")], "\\")).toEqual([]);
  });

  it("neither semantic test depends on the runner's separator", () => {
    // THE P2 ITSELF IS NOT BEHAVIOURALLY DETECTABLE HERE. On POSIX `path.sep` is
    // already "/", so re-binding a semantic test to the live separator is a
    // no-op on this runner and every assertion still passes — the failure would
    // appear only on the Windows runner the repair exists for. That is exactly
    // how the defect survived its own fix once already.
    //
    // So the property is asserted structurally: a test that names a platform in
    // its title must state that platform's separator as a literal, never read it
    // from the machine.
    const self = readFileSync(__filename, "utf8");
    for (const title of ["POSIX semantics:", "WINDOWS semantics:"]) {
      const start = self.indexOf(title);
      expect(start, `could not locate the ${title} test`).toBeGreaterThan(-1);
      const body = self.slice(start, self.indexOf("\n  });", start));
      expect(
        body.includes("path.sep"),
        `${title} reads the runner's separator instead of stating its own`,
      ).toBe(false);
    }
  });

  it("the two semantics genuinely differ on the same input", () => {
    // Without this the pair above could both be passing for the same reason.
    const legal = "components/odd\\name.tsx";
    expect(unnormalizedUnder([legal], "/")).toEqual([]);
    expect(unnormalizedUnder([legal], "\\")).toEqual([legal]);
  });
});

// The WIRING, provable on a POSIX runner.
//
// On POSIX `path.sep` is already "/", so `toRepoPath` is a no-op and removing it
// from discovery changes nothing here — the behavioural tests above cannot catch
// that regression on this machine, and it would only surface on the Windows
// runner the repair exists for. This reads the discovery expression itself, so
// dropping the call is RED everywhere.
describe("the normalization is actually wired into discovery", () => {
  it("discovery passes its relative paths through toRepoPath", () => {
    const self = readFileSync(__filename, "utf8");
    const discovery = /const FILES = [\s\S]{0,200}?;/.exec(self)?.[0] ?? "";
    expect(discovery, "could not locate the discovery expression").toContain("path.relative");
    expect(
      discovery,
      "discovery compares raw platform paths against the canonical lists again",
    ).toContain("toRepoPath(");
  });
});
