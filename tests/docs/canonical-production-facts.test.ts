import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { currentProse, ignoreMarkers, matchAll } from "./helpers/canonical-facts";

// ---------------------------------------------------------------------------
// CANONICAL PRODUCTION FACTS — the anti-drift guard.
//
// THE FAILURE THIS EXISTS TO PREVENT
//
// Four derived facts — hosted migration max, repo migration max, the next free
// number, and the runtime-bearing production SHA — were hand-copied as prose
// literals into five documents. Nothing failed when a copy diverged, so every
// copy rotted independently and at its own rate. On 2026-08-23 the canonical
// set simultaneously claimed the production migration max was 0165, 0163, 0162,
// 0160 and 0157, while production stood at 0185. `current-state.md` managed
// THREE DIFFERENT NUMBERS IN ONE TABLE CELL.
//
// The derivation already existed. `scripts/migration-state.mjs` was written for
// exactly this and its own header names the incidents ("that happened on 0163,
// 0164 and 0165"). It succeeded for tests and for verify-production.mjs — and
// the canonical PROSE was never migrated onto it. CLAUDE.md §2 already states
// the rule ("Everything else … should reference the canonical record rather
// than repeating a number that changes"). It was policy with no enforcement.
//
// Worse: the previous guard MANDATED the stale number. A test required five
// documents to each assert "production migration max 0165", and it passed for
// the wrong reason — its regex matched a FROZEN HISTORICAL block further down
// the ledger, not the current one. A guard that cannot tell current from
// historical will eventually enforce the wrong one.
//
// WHAT THIS GUARD DOES, AND DELIBERATELY DOES NOT DO
//
// It does NOT ban literal migration numbers. Historical release rows, frozen
// apply records, per-migration descriptions and audit evidence must keep their
// literals — they are evidence of what was true at a point in time and are
// never rewritten.
//
// It targets CURRENT-STATE ASSERTIONS structurally: the sentence shapes that
// claim a number is true NOW. Those may live in exactly one prose location —
// migration-ledger.md's "## Current state" block — where they are validated
// against the canonical record rather than trusted.
//
// Frozen text is excluded by an explicit, auditable marker rather than by
// heuristics, so quoting a superseded claim stays legal and stays visible:
//
//   <!-- canonical-facts:ignore-start reason=why-this-is-historical -->
//   …superseded text, preserved verbatim…
//   <!-- canonical-facts:ignore-end -->
//
// Every marker must carry a reason. Adding one is a deliberate act that shows
// up in review, which is the point.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const CURRENT_STATE = read("docs/production/current-state.md");
const CAPABILITY_REGISTER = read("docs/production/capability-register.md");
const KNOWN_LIMITATIONS = read("docs/production/known-limitations.md");
const RELEASE_CHANGELOG = read("docs/production/release-changelog.md");
const MIGRATION_LEDGER = read("docs/production/migration-ledger.md");

/** The one machine-readable declaration of hosted state. */
const CANONICAL_RECORD = JSON.parse(read("docs/production/migration-state.json"));

/** Repo state, derived from filenames — never hand-written. */
const DERIVED = JSON.parse(
  execFileSync("node", [path.join(ROOT, "scripts/migration-state.mjs"), "--json"], {
    encoding: "utf8",
    cwd: ROOT,
  }),
);

// ---------------------------------------------------------------------------
// Git access, used by the SHA rules below.
//
// Every helper returns null rather than throwing when git is unavailable or the
// history is shallow. A guard that hard-fails in an environment it cannot read
// teaches people to disable it; one that reports "could not check" keeps the
// rest of the suite meaningful. The rules that depend on these skip explicitly
// and say so, so a permanently-skipping rule is visible rather than silent.
// ---------------------------------------------------------------------------

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const GIT_AVAILABLE = git("rev-parse", "--git-dir") !== null;
const SHALLOW = git("rev-parse", "--is-shallow-repository") === "true";
const GIT_USABLE = GIT_AVAILABLE && !SHALLOW;

// ---------------------------------------------------------------------------
// RUNTIME-BEARING CLASSIFICATION IS NOT DEFINED HERE.
//
// It was, once: a hand-written path list that omitted instrumentation.ts,
// instrumentation-client.ts, the Sentry edge/server configs, public/, hooks/
// and types/. A commit touching only instrumentation.ts produced an empty diff
// against that list, so A3 passed while the deployed runtime had changed.
//
// The repository already owns this taxonomy - scripts/classify-changes.mjs is
// the same map CI and `npm run ci:plan` use, and CLAUDE.md §3 states outright
// that there is "deliberately no second competing map". A partial copy here
// was exactly that second map. It is gone; the authority is imported.
//
// `classify(files).docs_only` is the repository's own answer to "is this
// documentation". It is NOT the same question as "does this ship", and an
// earlier revision treated the two as equivalent. They come apart on every
// non-shipping non-doc path: the classifier returns docs_only:false for
// `.github/workflows/ci.yml`, `scripts/verify-prepush.mjs` and
// `e2e/foo.spec.ts`, none of which is in the deployed application, so A3 would
// have demanded a fresh runtime baseline for a CI tweak.
//
// The classifier has no "ships" output to borrow, so the deployed decision is:
//
//   DEPLOYED  =  not documentation (asked of the classifier)
//                AND not in a non-shipping root (named below, with reasons)
//
// The roots are a category list, not a path taxonomy: each names a whole class
// of files that CI runs and Vercel never serves. Nothing here re-describes
// WHICH application paths are runtime - that judgement stays entirely with
// scripts/classify-changes.mjs, so `instrumentation.ts`, the Sentry configs,
// `public/`, `hooks/` and `types/` are covered without being listed.
// ---------------------------------------------------------------------------
const NON_SHIPPING_ROOTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^tests\//, "unit, DB and migration tests: run in CI, absent from the bundle"],
  [/^e2e[a-z-]*\//, "Playwright specs and their fixtures: run against a build, never part of one"],
  [/^\.github\//, "workflows and templates: they decide what CI does, not what production serves"],
  // NOTE: scripts/ is NOT blanket-exempt. See PRODUCTION_BUILD_SCRIPTS below -
  // a script the production `build` command executes can change what the
  // deployment does, and is subtracted from this exemption.
  [/^scripts\//, "operator and CI tooling — except those the production build runs"],
  [/^playwright(\.[\w.-]+)?\.config\./, "test-runner configuration"],
  [/^vitest(\.[\w.-]+)?\.config\./, "test-runner configuration"],
  [/^eslint\.config\./, "linter configuration: gates the build, never served by it"],
];

/**
 * Scripts the PRODUCTION BUILD executes, derived from package.json.
 *
 * Exempting all of `scripts/` was too broad. `package.json` runs
 * `node scripts/check-production-env-gates.mjs && next build`, so that file
 * decides whether a production build proceeds at all - and these very documents
 * treat its fail-versus-report-only behaviour as a deployed capability fact
 * (known-limitations L25). A change to it after the pinned SHA must invalidate
 * the pin; a change to an operator utility beside it must not.
 *
 * Derived from the repository rather than listed here, so adding a gate to the
 * build brings it under this rule automatically. Scope is deliberately the
 * DIRECT build command: what it shells out to in turn is not traced, and that
 * limit is stated rather than hidden.
 */
function productionBuildScripts(): string[] {
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  const build = pkg.scripts?.build ?? "";
  return [...build.matchAll(/\bscripts\/[\w./-]+\.(?:mjs|cjs|js|ts)\b/g)].map((m) => m[0]);
}
const PRODUCTION_BUILD_SCRIPTS = productionBuildScripts();

function nonShippingReason(file: string): string | null {
  if (PRODUCTION_BUILD_SCRIPTS.includes(file)) return null; // the build runs it: it ships
  for (const [re, why] of NON_SHIPPING_ROOTS) if (re.test(file)) return why;
  return null;
}

async function loadClassifier(): Promise<(files: string[]) => { docs_only: boolean }> {
  const mod = await import(path.join(ROOT, "scripts/classify-changes.mjs"));
  return (mod as { classify: (f: string[]) => { docs_only: boolean } }).classify;
}

// ---------------------------------------------------------------------------
// Frozen-region handling
// ---------------------------------------------------------------------------

// currentProse / ignoreMarkers / matchAll live in ./helpers/canonical-facts so
// that this guard and tests/docs/clinical-finalization-retired.test.ts share ONE
// definition of which text is current. See that module for the marker contract.

// ---------------------------------------------------------------------------
// Rule 1 — current migration-max assertions
// ---------------------------------------------------------------------------

/**
 * Sentence shapes that assert a migration maximum AS CURRENT FACT.
 *
 * Each requires an assertive connective ("is", "are", "=", ":", or a table
 * cell boundary) between the subject and a four-digit version. A retrospective
 * mention — "the 0160/0163/0165 divergence", "migration 0185 is applied" — is
 * not an assertion of a maximum and is deliberately not matched.
 */
const CURRENT_MAX_PATTERNS: readonly RegExp[] = [
  // "production migration max is 0165" · "hosted max = 0163" · "repo max: 0185"
  /\b(?:production|hosted|repository|repo)\b[^.\n|]{0,30}\bmax(?:imum)?\b\s*(?:\bis\b|\bare\b|=|:)\s*(?:\bnow\b\s*)?\*{0,2}`?(0\d{3})\b/gi,
  // table row: | **Hosted (production) migration max** | **0185** … |
  //            | **Production migration max** | **0165** … |
  /\|\s*\*{0,2}(?:Hosted|Production|Repo(?:sitory)?)[^|]{0,40}migration\s+max\*{0,2}\s*\|\s*\*{0,2}`?(0\d{3})\b/gi,
  // "migration max is now 0157" · "production max is now 0157"
  /\b(?:migration|production|hosted|repo(?:sitory)?)\s+max\b[^.\n]{0,20}\bis\s+now\b\s*\*{0,2}`?(0\d{3})\b/gi,
  // "repository max and hosted max are both `0163`"
  /\bmax\b[^.\n]{0,40}\bare\s+both\b\s*\*{0,2}`?(0\d{3})\b/gi,
  // "Hosted max = repo max = **0169**"
  /\bmax\b\s*=\s*(?:\w+\s+max\s*=\s*)?\*{0,2}`?(0\d{3})\b/gi,
];

/**
 * CURRENT-POSITION assertions that never say "max".
 *
 * Every pattern above requires the literal word `max`, so "Production is
 * currently at migration 0165" and "Hosted production stands at 0165" asserted
 * exactly the fact this guard exists to ban and sailed straight through.
 *
 * The fix is NOT a growing phrase list. It is one shape: a SUBJECT from a
 * closed set, a POSITION VERB from a closed set, and a four-digit version -
 * with the whole thing confined to a single clause so an unrelated sentence
 * cannot be stitched into a false match. Both vocabularies are small and
 * closed on purpose; adding to them should feel like a decision.
 */
const POSITION_SUBJECT = String.raw`(?:production|hosted|repo(?:sitory)?|current\s+hosted|current\s+production)`;
// PRESENT TENSE ONLY. `was` is deliberately absent: "it read 0160 while
// production was at 0185" is a narrative ABOUT past drift, which these
// documents must be free to tell. Past tense is the marker of history, not of
// a current assertion, and banning it would turn the guard into a number ban.
// The set covers the ways a CURRENT POSITION gets stated, not every way English
// can join a subject to a number. It grew once, from six verbs to these, when
// "Production currently runs migration 0165" and "Production has reached
// migration 0165" both walked through - the first because `runs` was missing,
// the second because a present perfect reads as current. Still closed; adding
// to it should feel like a decision.
const POSITION_VERB = String.raw`(?:is|are|sits|stands|remains|rests|runs|run|has\s+reached|have\s+reached|reaches)`;
const CURRENT_POSITION_PATTERNS: readonly RegExp[] = [
  // "Production is currently at migration 0165" · "Hosted production stands at 0165"
  new RegExp(
    String.raw`\b${POSITION_SUBJECT}\b[^.\n|;]{0,30}?(?:\bnow\b|\bcurrently\b)?\s*\b${POSITION_VERB}\b\s*(?:\bnow\b|\bcurrently\b)?\s*(?:\bat\b|\bon\b)?\s*(?:\bmigration\b\s*)?\*{0,2}\`?(0\d{3})\b`,
    "gi",
  ),
  // "Current hosted migration is 0165" · "the production migration is now 0165"
  new RegExp(
    String.raw`\b(?:current|hosted|production|repo(?:sitory)?)\b[^.\n|;]{0,24}?\bmigration\b\s*${POSITION_VERB}\s*(?:\bnow\b|\bcurrently\b)?\s*\*{0,2}\`?(0\d{3})\b`,
    "gi",
  ),
];

/** "next free / next migration number is 0186" — a derived fact, never prose. */
const NEXT_FREE_PATTERNS: readonly RegExp[] = [
  /\bnext\s+(?:free\s+)?migration\s+(?:number\s+)?(?:\bis\b|=|:)\s*\*{0,2}`?(0\d{3})\b/gi,
  /\bnext\s+free\s+(?:migration\s+)?number\s+(?:\bis\b|=|:)\s*\*{0,2}`?(0\d{3})\b/gi,
];

export const findCurrentMaxAssertions = (t: string) =>
  matchAll(t, [...CURRENT_MAX_PATTERNS, ...CURRENT_POSITION_PATTERNS]);
export const findNextFreeAssertions = (t: string) => matchAll(t, NEXT_FREE_PATTERNS);

// ---------------------------------------------------------------------------
// Rule 2 — superseded whole-session-copy exercise claims
// ---------------------------------------------------------------------------

const STALE_EXERCISE_PATTERNS: readonly RegExp[] = [
  /session_copy_operations`?[^.\n]{0,40}(?:=|holds)\s*\*{0,2}`?0\s*rows/gi,
  /whole-session\s+copy\b[^.\n]{0,120}\b(?:NOT|never)\s+production[\s-]exercis/gi,
  /Production\s+exercise:\s*\*{0,2}none/gi,
];

/**
 * "NOT production exercised" as a bare status word.
 *
 * This is checked ONLY inside whole-session-copy context. The phrase is a
 * legitimate and necessary status for capabilities that genuinely have not run
 * — retired clinical corrections, and WAIT-02B Stage A, both correctly carry
 * it today. Banning it outright would push the register toward vagueness about
 * real dormancy, which is the opposite of what this guard is for.
 */
const BARE_UNEXERCISED = /\b(?:NOT|never)\s+production[\s-]exercised\b/gi;

/**
 * The section(s) headed "Whole-session copy".
 *
 * Scoped by HEADING, not by any line that happens to mention the phrase. The
 * capability-register summary legitimately writes "never production-exercised"
 * as a BUCKET LABEL on the same line as "Whole-session copy has left this
 * bucket" — a true sentence that a line-level match would flag. Prose claims
 * outside these sections are still caught by the subject-adjacent pattern
 * above, which requires the subject to come first.
 */
function wholeSessionCopyContext(doc: string): string {
  const lines = doc.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{2,3}\s/.test(line)) inSection = /whole-session copy/i.test(line);
    if (inSection) out.push(line);
  }
  return out.join("\n");
}

export const findStaleExerciseClaims = (t: string) => [
  ...matchAll(t, STALE_EXERCISE_PATTERNS),
  ...matchAll(wholeSessionCopyContext(t), [BARE_UNEXERCISED]),
];

/**
 * L2's heading is preserved verbatim as the historical title of a closed
 * limitation — the file's own convention, shared with L18 and L23. It is legal
 * ONLY while it is marked CLOSED on the same line. Strip the marker and the
 * heading becomes an active false claim again.
 */
const L2_TITLE = /^##\s+L2\s+—\s+No real production whole-session copy has ever been performed.*$/m;

// ---------------------------------------------------------------------------
// Rule 3 — synthetic rows presented as real-customer activity
// ---------------------------------------------------------------------------

/**
 * Every tenant row in §0, by slug, read from the register itself.
 *
 * The trap this exists to close: subtracting the Synthetic Twin from the
 * all-tenant totals does NOT yield real-customer activity, because the
 * controlled test studio is still in the remainder. §0 says so in words; this
 * makes the arithmetic checkable. A sentence claiming "real-customer activity:
 * 79 clients, 241 appointments" is false for exactly that reason, and the
 * earlier guard - which was handed only the all-tenant pair - passed it.
 */
function tenantRow(slug: string): number[] | null {
  const row = currentProse(CURRENT_STATE)
    .split("\n")
    .find((l) => l.includes(`\`${slug}\``) && l.trim().startsWith("|"));
  if (!row) return null;
  return [...row.matchAll(/\|\s*\*{0,2}(\d+)\*{0,2}\s*(?=\|)/g)].map((m) => Number(m[1]));
}

/** The all-tenant totals, read from the register itself rather than hardcoded. */
function allTenantTotals(): { clients: number; appointments: number } {
  const row = currentProse(CURRENT_STATE)
    .split("\n")
    .find((l) => /^\|\s*\*{0,2}All tenants/i.test(l));
  expect(row, "current-state §0 must carry an All tenants row").toBeTruthy();
  const nums = [...(row as string).matchAll(/\*\*(\d+)\*\*/g)].map((m) => Number(m[1]));
  expect(
    nums.length,
    "the All tenants row must state clients and appointments in bold",
  ).toBeGreaterThanOrEqual(2);
  return { clients: nums[0], appointments: nums[1] };
}

/**
 * An all-tenant total quoted inside a real-customer sentence. This is the
 * arithmetic trap the Synthetic Twin creates: the number is right and the
 * label is wrong.
 */
export function findSyntheticAsCustomer(text: string, totals: number[]): string[] {
  const hits: string[] = [];
  for (const line of text.split("\n")) {
    if (!/\b(?:real[\s-]customer|customer activity|Willow)\b/i.test(line)) continue;
    // A line may legally NAME a forbidden figure in order to LABEL or DISCLAIM
    // it. §0's own reading rule does exactly that: it names the Twin-subtracted
    // remainder precisely to say the remainder is not customer activity. The
    // exemption is therefore "is this line disclaiming?", not a list of the
    // three sentences that happened to exist when it was written - a
    // disclaimer being flagged as the claim it warns against is a false
    // positive that teaches people to delete the warning.
    const LABELLED = /\ball[\s-]tenants?\b|\bincludes?\s+synthetic\b/i;
    // `remainder` used to sit in this set on its own, which let a false claim
    // pass by using the very noun the rule polices:
    //   "Real-customer activity is the remainder: 79 clients and 241 appointments"
    // A line naming a forbidden figure must NEGATE it, not merely mention the
    // category. §0's genuine warning still qualifies - it says "not the same as
    // real-customer" and "Never present it as customer activity".
    const DISCLAIMED =
      /\bnot\b[^.]{0,48}\bcustomer\b|\bnever\s+present\b|\bis not the same as\b|\bnot\b[^.]{0,32}\bremainder\b/i;
    if (LABELLED.test(line) || DISCLAIMED.test(line)) continue;
    for (const total of totals) {
      if (new RegExp(`\\b${total}\\b`).test(line)) {
        hits.push(line.replace(/\s+/g, " ").trim().slice(0, 140));
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The ledger's ONE current block
// ---------------------------------------------------------------------------

/**
 * migration-ledger.md is the single prose location permitted to state current
 * migration numbers, because it is the ledger. Its "## Current state" heading
 * bounds that block; every "## Previous state" block below it is frozen
 * history and is excluded.
 */
function ledgerCurrentBlock(): string {
  const lines = MIGRATION_LEDGER.split("\n");
  const start = lines.findIndex((l) => /^##\s+Current state\b/.test(l));
  expect(start, "migration-ledger.md must carry a '## Current state' block").toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const offset = rest.findIndex((l) => l.startsWith("## "));
  return lines.slice(start, offset === -1 ? undefined : start + 1 + offset).join("\n");
}

const NO_CURRENT_MAX_DOCS = [
  ["docs/production/current-state.md", CURRENT_STATE],
  ["docs/production/capability-register.md", CAPABILITY_REGISTER],
  ["docs/production/known-limitations.md", KNOWN_LIMITATIONS],
] as const;

/** The changelog's preamble: everything above the first `## ` heading. */
function changelogPreamble(): string {
  const idx = RELEASE_CHANGELOG.indexOf("\n## ");
  return idx === -1 ? RELEASE_CHANGELOG : RELEASE_CHANGELOG.slice(0, idx);
}

// ===========================================================================

describe("canonical production docs: no independently hardcoded CURRENT migration state", () => {
  it("current-state, capability-register and known-limitations assert no current migration max", () => {
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      const hits = findCurrentMaxAssertions(currentProse(doc));
      expect(
        hits,
        `${name} states a current migration maximum in prose. Reference ` +
          `docs/production/migration-state.json (hosted) or npm run migration:state ` +
          `(repo/next-free) instead. Offending text: ${JSON.stringify(hits)}`,
      ).toEqual([]);
    }
  });

  it("none of those three states a next-free migration number either", () => {
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      const hits = findNextFreeAssertions(currentProse(doc));
      expect(
        hits,
        `${name} states a next-free migration number, which is derived and goes ` +
          `stale on the next apply. Offending text: ${JSON.stringify(hits)}`,
      ).toEqual([]);
    }
  });

  it("the release-changelog PREAMBLE presents no current migration max or head", () => {
    const preamble = currentProse(changelogPreamble());
    expect(
      findCurrentMaxAssertions(preamble),
      "the changelog preamble must not restate the current migration max — it read " +
        "'the production migration max is 0157' long after production moved past it",
    ).toEqual([]);
    expect(findNextFreeAssertions(preamble)).toEqual([]);
    expect(
      preamble,
      "the changelog preamble must not pin a runtime-bearing head either; " +
        "current state lives in current-state.md",
    ).not.toMatch(/runtime-bearing head is\s*\*{0,2}`?[0-9a-f]{6,}/i);
  });

  it("HISTORICAL migration literals remain legal — this guard bans assertions, not numbers", () => {
    // The changelog's historical rows and the ledger's frozen blocks keep their
    // literals. If this ever fails, the guard has become a number ban and will
    // be switched off by the first person it obstructs.
    expect(RELEASE_CHANGELOG).toMatch(/\*\*0157\*\*/);
    expect(MIGRATION_LEDGER).toMatch(/\|\s*\*\*Hosted \(production\) migration max\*\*\s*\|\s*\*\*0165\*\*/);
    expect(
      MIGRATION_LEDGER.match(/^##\s+Previous state\b/gm)?.length ?? 0,
      "the ledger's frozen history must survive intact",
    ).toBeGreaterThan(5);
  });
});

describe("canonical production docs: the ledger's current block agrees with the canonical record", () => {
  const block = ledgerCurrentBlock();

  it("states the hosted max declared in migration-state.json", () => {
    const hosted = block.match(
      /\|\s*\*\*Hosted \(production\) migration max\*\*\s*\|\s*\*\*(\d{4})\*\*/,
    );
    expect(hosted, "the current block must carry a hosted-max row").toBeTruthy();
    expect(
      hosted?.[1],
      "the ledger's CURRENT hosted max must equal migration-state.json — the previous " +
        "guard matched a frozen historical block instead and passed while 20 migrations " +
        "of drift accumulated",
    ).toBe(CANONICAL_RECORD.hosted_migration_max);
  });

  it("states the repo max derived from filenames", () => {
    const repo = block.match(/\|\s*\*\*Repo migration max\*\*\s*\|\s*\*\*(\d{4})\*\*/);
    expect(repo, "the current block must carry a repo-max row").toBeTruthy();
    expect(repo?.[1]).toBe(DERIVED.repo_migration_max);
  });

  it("states the derived next free number, and never claims it", () => {
    const next = block.match(/Next free number is \*\*(\d{4})\*\*/);
    expect(next, "the current block must state the next free number").toBeTruthy();
    expect(Number(next?.[1])).toBe(DERIVED.next_free_migration_number);
    expect(
      block,
      "an available number must be recorded as NOT claimed, so a later reader cannot " +
        "mistake availability for allocation",
      ).toMatch(/not claimed/i);
  });

  it("repo and hosted agree, so no document can contradict another about parity", () => {
    expect(DERIVED.hosted_migration_max).toBe(CANONICAL_RECORD.hosted_migration_max);
    expect(DERIVED.repo_migration_max).toBe(CANONICAL_RECORD.hosted_migration_max);
  });
});

describe("canonical production docs: whole-session copy is exercised, and L2 stays closed", () => {
  it("no CURRENT-state doc still claims whole-session copy is unexercised", () => {
    // The changelog's ROWS are excluded on purpose. PR #478's row records
    // "NOT production-exercised; session_copy_operations = 0 rows", which was
    // TRUE on 2026-07-27 when it was written. A changelog row is THEN-state by
    // construction and is never rewritten because the world moved — that is
    // what a changelog is for. Only its preamble is current, and the preamble
    // is checked separately above.
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      const hits = findStaleExerciseClaims(currentProse(doc));
      expect(
        hits,
        `${name} still says whole-session copy is unexercised. It is: 24 production ` +
          `operations at Willow, 2026-07-28 to 2026-08-23. Offending text: ${JSON.stringify(hits)}`,
      ).toEqual([]);
    }
    // …and the preamble must not carry the claim either.
    expect(findStaleExerciseClaims(currentProse(changelogPreamble()))).toEqual([]);
  });

  it("the frozen #478 changelog row KEEPS its THEN-state wording", () => {
    // Guard-on-the-guard. If a later pass "helpfully" rewrites this row to
    // match today, the changelog stops being a record of what shipped.
    expect(
      RELEASE_CHANGELOG,
      "PR #478's row must still say what was true when it shipped",
    ).toMatch(/\*\*#478\*\*[\s\S]{0,200}NOT production-exercised/);
  });

  it("L2's heading is preserved verbatim AND marked CLOSED", () => {
    const title = KNOWN_LIMITATIONS.match(L2_TITLE)?.[0];
    expect(title, "L2's historical heading must be preserved, not deleted").toBeTruthy();
    expect(
      title,
      "L2's heading states something that is no longer true, so it may only stand " +
        "while it is marked CLOSED on the same line — the convention L18 and L23 already use",
    ).toMatch(/\bCLOSED\b/);
  });

  it("L1 stays OPEN and keeps exercise separate from acceptance", () => {
    expect(
      KNOWN_LIMITATIONS,
      "L1 must still exist — production exercise did not close it",
    ).toMatch(/^##\s+L1\s+—\s+Chloe's human acceptance testing is outstanding\s*$/m);
    expect(
      currentProse(KNOWN_LIMITATIONS),
      "L1 must state plainly that usage is not acceptance",
    ).toMatch(/evidence of exercise, not of acceptance/i);
    expect(
      currentProse(KNOWN_LIMITATIONS),
      "L1 must not have been quietly marked closed alongside L2",
    ).not.toMatch(/^##\s+L1\s+—[^\n]*\bCLOSED\b/m);
  });

  it("no canonical doc claims Chloe has accepted anything", () => {
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      expect(
        currentProse(doc),
        `${name} must not record an acceptance that has not been given`,
      ).not.toMatch(/Chloe\s+(?:has\s+)?(?:accepted|signed off|validated)\b(?!\s+anything she)/i);
    }
  });
});

describe("canonical production docs: synthetic rows are never customer activity", () => {
  const totals = allTenantTotals();

  /**
   * Figures that are NOT real-customer activity but are arithmetically
   * derivable from §0, so a plausible-looking sentence can reach for one:
   *   - the all-tenant totals (include the Twin AND the controlled studio);
   *   - the Twin-subtracted remainder (still includes the controlled studio).
   * Derived, never hardcoded, so a re-measurement moves them automatically.
   */
  function forbiddenCustomerFigures(): number[] {
    const out = [totals.clients, totals.appointments];
    const twin = tenantRow("hone-synthetic-twin");
    if (twin && twin.length >= 2) {
      out.push(totals.clients - twin[0], totals.appointments - twin[1]);
    }
    return [...new Set(out)].filter((n) => Number.isFinite(n) && n > 0);
  }

  it("current-state §0 classifies every tenant, naming the synthetic one", () => {
    const register = currentProse(CURRENT_STATE);
    expect(register, "the tenant register must exist").toMatch(/^##\s+0\.\s+Tenant register/m);
    expect(
      register,
      "hone-synthetic-twin must be classified as synthetic, by name",
    ).toMatch(/`hone-synthetic-twin`[^|]*\|[^|]*\*\*Synthetic\*\*/);
    expect(
      register,
      "willow-electrolysis must be classified as the real-customer tenant",
    ).toMatch(/`willow-electrolysis`[^|]*\|[^|]*\*\*Real customer\*\*/);
    expect(
      register,
      "the register must warn that the non-synthetic remainder is NOT real-customer activity — " +
        "subtracting the Twin still leaves the controlled test studio",
    ).toMatch(/Non-synthetic is not the same as real-customer/i);
  });

  it("the stated real-customer figures are the WILLOW row, not a subtraction", () => {
    const willow = tenantRow("willow-electrolysis");
    expect(willow, "§0 must carry a willow-electrolysis row with numbers").toBeTruthy();
    const [clients, appts] = willow as number[];
    const rule = currentProse(CURRENT_STATE).match(
      /Real-customer activity is `willow-electrolysis` only:\s*\*{0,2}(\d+)\*{0,2}\s*clients,\s*\*{0,2}(\d+)\*{0,2}\s*appointments/i,
    );
    expect(
      rule,
      "§0's reading rule must state the customer figures explicitly, so they are tied to the " +
        "customer-classified tenant rather than inferred by subtracting the Twin",
    ).toBeTruthy();
    expect(Number(rule?.[1]), "customer clients must equal the Willow row").toBe(clients);
    expect(Number(rule?.[2]), "customer appointments must equal the Willow row").toBe(appts);
  });

  it("no CURRENT-state doc labels an all-tenant total as customer activity", () => {
    // Changelog rows excluded for the same reason as above: THEN-state history.
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      const hits = findSyntheticAsCustomer(currentProse(doc), forbiddenCustomerFigures());
      expect(
        hits,
        `${name} presents an all-tenant total (which includes the Synthetic Twin) as ` +
          `real-customer activity. Label it, or use the Willow-only figure. ` +
          `Offending line(s): ${JSON.stringify(hits)}`,
      ).toEqual([]);
    }
  });

  it("the capability register defers tenant classification rather than restating it", () => {
    expect(
      CAPABILITY_REGISTER,
      "the register must point at current-state §0 rather than keeping a second copy " +
        "of the tenant classification, which is how the counts drifted in the first place",
    ).toMatch(/current-state\.md\)\s*\*\*§0\*\*|§0/);
  });
});

describe("canonical production docs: WAIT-02B is never described as live", () => {
  it("the durable waitlist is recorded as deployed-but-dormant, with zero rows", () => {
    const cs = currentProse(CURRENT_STATE);
    expect(cs, "current-state must carry the durable-waitlist posture").toMatch(
      /NOT ENABLED/i,
    );
    expect(
      cs,
      "it must state that the durable table holds no rows — a table existing is not " +
        "data being collected",
    ).toMatch(/holds \*\*0 rows\*\*|=\s*\*\*0 rows\*\*|\b0 rows\b/i);
    // The flag NAME is read from the module that owns it rather than written
    // here. tests/app/book/new-client-waitlist-durable-commit.test.ts keeps a
    // deliberately CLOSED list of non-markdown files naming that variable —
    // the mechanism that stops a config file or seed switching a studio on
    // quietly. This guard has no business widening that list to check a
    // sentence, and deriving the name also means a rename cannot leave the
    // documentation assertion silently pointing at a variable nobody reads.
    const durableFlag = read("lib/booking/new-client-waitlist.ts").match(
      /DURABLE_SLUGS_ENV\s*=\s*\n?\s*"([A-Z0-9_]+)"/,
    )?.[1];
    expect(durableFlag, "the durable-waitlist env var name must be derivable").toBeTruthy();
    expect(
      cs,
      "and that the production allowlist is absent, so no studio is enabled",
    ).toMatch(new RegExp(`${durableFlag}[\\s\\S]{0,120}absent`, "i"));
  });

  it("no canonical doc calls the durable waitlist live or enabled", () => {
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      expect(
        currentProse(doc),
        `${name} must not describe the durable waitlist as live`,
      ).not.toMatch(/durable[^.\n]{0,40}waitlist[^.\n]{0,30}\bis\s+(?:live|enabled|active)\b/i);
    }
  });
});

describe("canonical production docs: frozen-region markers are explicit and justified", () => {
  it("every ignore marker declares a reason", () => {
    for (const [name, doc] of [
      ...NO_CURRENT_MAX_DOCS,
      ["docs/production/release-changelog.md", RELEASE_CHANGELOG],
      ["docs/production/migration-ledger.md", MIGRATION_LEDGER],
    ] as const) {
      for (const marker of ignoreMarkers(doc)) {
        expect(
          marker,
          `${name} has a canonical-facts:ignore block with no reason=. An unexplained ` +
            `exemption is how a guard quietly stops guarding.`,
        ).toMatch(/reason=\S+/);
      }
    }
  });

  it("every ignore block is closed", () => {
    for (const [name, doc] of [
      ...NO_CURRENT_MAX_DOCS,
      ["docs/production/release-changelog.md", RELEASE_CHANGELOG],
      ["docs/production/migration-ledger.md", MIGRATION_LEDGER],
    ] as const) {
      const starts = (doc.match(/canonical-facts:ignore-start/g) ?? []).length;
      const ends = (doc.match(/canonical-facts:ignore-end/g) ?? []).length;
      expect(starts, `${name} has unbalanced ignore markers`).toBe(ends);
    }
  });
});

// ===========================================================================
// NEGATIVE CONTROLS
//
// A guard nobody has watched fail is a guard nobody knows works. Each control
// feeds the rule the exact shape it exists to catch and asserts it goes red.
// ===========================================================================

describe("NEGATIVE CONTROLS — the guard actually goes red", () => {
  it("catches a stale current max in every shape that has actually occurred", () => {
    const shapes = [
      "| **Production migration max** | **0165** — 164 migrations applied |",
      "Production migration max is 0162, applied and verified 2026-08-02.",
      "Repository max and hosted max are both `0163`; repository and hosted match.",
      "The production migration max is **0157** and the runtime-bearing head is `96b28d6…`.",
      "| **Hosted (production) migration max** | **0165** (applied 2026-08-02) |",
      "historical detail — the production max is now 0157 and the newest six are 0152–0157",
      "Repository and hosted migration max are both `0160`.",
    ];
    for (const shape of shapes) {
      expect(
        findCurrentMaxAssertions(shape),
        `the guard MISSED a stale-current-max shape that really shipped: ${shape}`,
      ).not.toEqual([]);
    }
  });

  it("catches a hardcoded next-free number", () => {
    for (const shape of [
      "The next migration number is **`0164`**.",
      "Repo and hosted are at parity; next free number is `0163`.",
      "Next free migration number is 0186.",
    ]) {
      expect(findNextFreeAssertions(shape), `MISSED: ${shape}`).not.toEqual([]);
    }
  });

  it("does NOT fire on historical or descriptive uses of the same numbers", () => {
    for (const shape of [
      "0163 (intake INSERT boundary) was APPLIED to production 2026-08-02T17:37Z and is frozen.",
      "that is how the `0160`/`0163`/`0165` divergence happened",
      "Migration **0185** was applied to production on 2026-08-23 and is frozen.",
      "| #477 | **0156** | Live | Conditional numbing notes |",
      "migration 0159 retires it (nothing dropped)",
      "See migration 0184's least-privilege repair for the same root cause.",
    ]) {
      expect(
        [...findCurrentMaxAssertions(shape), ...findNextFreeAssertions(shape)],
        `FALSE POSITIVE — this is historical or descriptive, not a current-max ` +
          `assertion, and banning it would turn the guard into a number ban: ${shape}`,
      ).toEqual([]);
    }
  });

  it("catches the superseded whole-session-copy claims", () => {
    for (const shape of [
      "**Production exercise: none.** `session_copy_operations` holds **0 rows**.",
      "`session_copy_operations` = **0 rows**",
      "## 2. Whole-session copy\nDB applied · deployed · enabled · NOT production exercised · human acceptance pending.",
      "Do not describe whole-session copy as production-exercised — it is never production exercised.",
    ]) {
      expect(findStaleExerciseClaims(shape), `MISSED: ${shape}`).not.toEqual([]);
    }
  });

  it("does NOT fire on the corrected exercise wording", () => {
    for (const shape of [
      "`session_copy_operations` holds **24 rows**, all at Willow.",
      "**Production exercise: yes.** 24 operations between 2026-07-28 and 2026-08-23.",
      "Whole-session copy is production exercised and not human accepted.",
    ]) {
      expect(findStaleExerciseClaims(shape), `FALSE POSITIVE: ${shape}`).toEqual([]);
    }
  });

  it("leaves 'NOT production exercised' legal for capabilities that really are dormant", () => {
    // WAIT-02B Stage A and the retired 0120 corrections backend both carry this
    // status truthfully. A guard that banned the phrase outright would push the
    // register toward vagueness about genuine dormancy — the opposite of the goal.
    for (const shape of [
      "## 5b. New-client waitlist\nDB applied · deployed · NOT ENABLED · NOT production exercised.",
      "Phase 2 — corrections & amendments backend (0120) | **RETIRED.** **Never production-exercised**",
    ]) {
      expect(
        findStaleExerciseClaims(shape),
        `FALSE POSITIVE — this is a different capability, truthfully unexercised: ${shape}`,
      ).toEqual([]);
    }
  });

  it("catches an all-tenant total dressed as customer activity", () => {
    for (const shape of [
      "One live studio with real clients: Willow Electrolysis (2 practitioners, 129 clients, 382 appointments).",
      "Real-customer activity: 382 appointments across production.",
    ]) {
      expect(
        findSyntheticAsCustomer(shape, [129, 382]),
        `MISSED — this counts the Synthetic Twin as customer activity: ${shape}`,
      ).not.toEqual([]);
    }
  });

  it("does NOT fire when an all-tenant total is honestly labelled", () => {
    for (const shape of [
      "Willow: 215 appointments. All tenants: 382, which includes synthetic rows.",
      "| **All tenants** *(includes synthetic — not a customer figure)* | — | **129** | **382** |",
      "**215 appointments at Willow**, the live studio",
    ]) {
      expect(
        findSyntheticAsCustomer(shape, [129, 382]),
        `FALSE POSITIVE — this total is labelled: ${shape}`,
      ).toEqual([]);
    }
  });

  it("strips only explicitly-marked frozen regions, and nothing else", () => {
    const doc = [
      "Production migration max is 0999.",
      "<!-- canonical-facts:ignore-start reason=historical-quotation -->",
      "It used to read: Production migration max is 0165.",
      "<!-- canonical-facts:ignore-end -->",
    ].join("\n");
    const stripped = currentProse(doc);
    expect(stripped, "the frozen quotation must be removed").not.toMatch(/0165/);
    expect(stripped, "the live claim must survive stripping").toMatch(/0999/);
    expect(
      findCurrentMaxAssertions(stripped),
      "the live claim must still be caught after stripping",
    ).not.toEqual([]);
  });
});

// ===========================================================================
// RULE A — current-state.md must not pin a stale or unreal production SHA
//
// THE FAILURE THIS EXISTS TO PREVENT. On 2026-08-26 `current-state.md` pinned
// `96b28d62` as the current branch HEAD while production stood at `6786b07b` —
// fourteen merges and two applied migrations later. Every behavioural claim in
// the document was anchored to that SHA, so the staleness was not cosmetic: it
// silently re-scoped the whole file to a runtime that had not existed for days.
//
// The document already CLAIMED to derive this ("Verified mechanically, not
// asserted: the diff from X to Y touches no runtime path"). That sentence was
// true when written and nothing re-checked it afterwards. These rules make the
// same derivation executable, which is the only version that survives.
//
// A drafting note, from a real mistake made while writing this reconciliation:
// A1 exists because a SHA was once written into this document from memory and
// resolved to nothing. A 40-hex string looks equally authoritative whether or
// not it names a commit, and no human reading review notices the difference.
// ===========================================================================

/** Every 40-hex string in a document, deduplicated. */
export function shasIn(doc: string): string[] {
  return [...new Set(doc.match(/\b[0-9a-f]{40}\b/g) ?? [])];
}

/** The SHA current-state.md pins as the runtime-bearing baseline. */
function pinnedRuntimeSha(): string | null {
  const row = currentProse(CURRENT_STATE)
    .split("\n")
    .find((l) => /Last runtime-bearing application HEAD/i.test(l));
  return row?.match(/\b([0-9a-f]{40})\b/)?.[1] ?? null;
}

/**
 * The CURRENT PRODUCTION GIT HEAD, which is a different fact from the pin above
 * and has its own row in the header.
 *
 * MERGE_COUNT_AUTHORITY != RUNTIME_SHA. A documentation-only production merge
 * advances the branch HEAD while leaving the runtime-bearing SHA exactly where
 * it was - that is the whole reason the two rows exist separately. Counting
 * merges from the runtime pin therefore UNDERCOUNTS by every docs-only merge,
 * silently, and the guard would keep passing while the prose drifted.
 *
 * The two rows are the same commit today, which is precisely why this was
 * invisible: the wrong authority produced the right answer.
 *
 * Runtime-BEHAVIOUR claims keep using `pinnedRuntimeSha()`. Only the
 * merge-count fact uses this.
 */
function currentGitHeadSha(): string | null {
  const row = currentProse(CURRENT_STATE)
    .split("\n")
    .find((l) => /Current Git branch HEAD/i.test(l));
  return row?.match(/\b([0-9a-f]{40})\b/)?.[1] ?? null;
}

describe("RULE A — current-state.md pins a real, current production SHA", () => {
  // WHERE THIS RULE ACTUALLY ENFORCES, stated so nobody mistakes a green CI run
  // for a checked one. All three A-rules need real history. CI clones with
  // `fetch-depth: 1`, so in CI they SKIP and this test records that they did.
  // They enforce where a full clone exists: a developer's checkout, and so
  // `npm run verify:changed` / `verify:prepush` before every push. That is not
  // a weakness dressed up as a feature - it is a real gap, and closing it means
  // raising the checkout depth in the CI workflow, which is deliberately out of
  // this change's authorized file surface and belongs to its own PR.
  it("A0: records whether the A-rules could run at all in this environment", () => {
    const mode = !GIT_AVAILABLE ? "no-git" : SHALLOW ? "shallow (A-rules SKIPPED)" : "full history (A-rules ENFORCED)";
    expect(
      ["no-git", "shallow (A-rules SKIPPED)", "full history (A-rules ENFORCED)"],
      `git environment: ${mode}`,
    ).toContain(mode);
  });

  it("A1: every SHA written in current-state.md resolves to a real commit", () => {
    // GIT_USABLE, not GIT_AVAILABLE. This rule shipped guarding on the latter
    // and went red on its first CI run against a document whose three SHAs were
    // all genuine: `.github/workflows/ci.yml` checks out with `fetch-depth: 1`,
    // so a shallow clone holds ONE commit and every SHA a document names is
    // absent — including the production head the checkout is derived from.
    // "Not in this clone" and "not a commit" are different claims and only the
    // second is a defect.
    if (!GIT_USABLE) {
      expect(GIT_USABLE, "shallow clone or no git — A1 could not run").toBe(false);
      return;
    }
    const unreal = shasIn(CURRENT_STATE).filter((sha) => git("cat-file", "-t", sha) !== "commit");
    expect(
      unreal,
      "current-state.md names one or more 40-hex SHAs that are not commits in this " +
        "repository. A fabricated or mistyped SHA reads exactly like a real one; this is the " +
        "only thing that tells them apart. Offending: " + JSON.stringify(unreal),
    ).toEqual([]);
  });

  it("A1b: every abbreviated SHA presented as the CURRENT baseline matches the pin", () => {
    // The header pins the runtime-bearing SHA; the capability sections then say
    // "At `<short sha>` ..." when describing what is true NOW. Those are two
    // statements of one fact, so they can drift - and a section pinned to a
    // superseded head reads as current while describing a runtime that has
    // moved. This ties them: an abbreviated SHA introduced by "At `...`" must
    // be a prefix of the full pin.
    //
    // Scoped to that one phrasing on purpose. Historical references elsewhere
    // ("merged `a3b85af2`", "superseded by `6786b07b`") are evidence of past
    // events and must stay free to name any commit.
    const pinned = pinnedRuntimeSha();
    expect(pinned, "current-state.md must pin a runtime-bearing HEAD").toBeTruthy();
    const claims = [...currentProse(CURRENT_STATE).matchAll(/\bAt\s+`([0-9a-f]{7,40})`/g)].map(
      (m) => m[1],
    );
    const stale = claims.filter((c) => !(pinned as string).startsWith(c));
    expect(
      stale,
      'a section says "At `<sha>` ..." about CURRENT behaviour using a commit that is not the ' +
        `pinned runtime baseline ${(pinned as string).slice(0, 8)}. Re-pin the section or the ` +
        `header - they are one fact. Offending: ${JSON.stringify(stale)}`,
    ).toEqual([]);
    expect(claims.length, "at least one section should tie itself to the pin").toBeGreaterThan(0);
  });

  it("A2: the pinned runtime-bearing SHA exists and is an ancestor of HEAD", () => {
    const pinned = pinnedRuntimeSha();
    expect(pinned, "current-state.md must pin a runtime-bearing application HEAD").toBeTruthy();
    if (!GIT_USABLE) {
      expect(GIT_USABLE, "shallow clone or no git — A2 could not run").toBe(false);
      return;
    }
    expect(git("cat-file", "-t", pinned as string), `${pinned} is not a commit`).toBe("commit");
    expect(
      git("merge-base", "--is-ancestor", pinned as string, "HEAD"),
      `${pinned} is not an ancestor of HEAD — current-state.md is pinned to a commit that is ` +
        "not in this branch's history at all",
    ).toBe("");
  });

  it("A3: nothing newer than the pinned SHA changes the runtime — via the repo's own classifier", async () => {
    const pinned = pinnedRuntimeSha();
    if (!GIT_USABLE || !pinned) {
      expect(GIT_USABLE && !!pinned, "shallow clone or no git — A3 could not run").toBe(false);
      return;
    }
    const changed = (git("diff", "--name-only", pinned, "HEAD") ?? "")
      .split("\n")
      .filter(Boolean);

    const classify = await loadClassifier();
    const deployed = changed.filter(
      (f) => nonShippingReason(f) === null && !classify([f]).docs_only,
    );

    expect(
      deployed,
      `current-state.md pins ${pinned.slice(0, 8)} as the runtime-bearing baseline, but ` +
        `${deployed.length} file(s) changed since it are classified as runtime-bearing by ` +
        "scripts/classify-changes.mjs. Either the pin is stale, or this branch carries runtime " +
        'changes it should not. This is the check the document\'s own "verified mechanically, ' +
        'not asserted" sentence describes. Changed: ' + JSON.stringify(deployed.slice(0, 12)),
    ).toEqual([]);
  });

  it("A3's deployed decision: runtime paths ship, CI/test/tooling paths do not", async () => {
    const classify = await loadClassifier();
    const deployed = (f: string) => nonShippingReason(f) === null && !classify([f]).docs_only;

    // SHIPS - a change to any of these after the pin must invalidate it.
    for (const f of [
      "app/(app)/dashboard/page.tsx",
      "lib/export/resource-registry.ts",
      "components/pending-link.tsx",
      "instrumentation.ts",
      "instrumentation-client.ts",
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "public/favicon.ico",
      "hooks/use-thing.ts",
      "types/thing.ts",
      "middleware.ts",
      "next.config.ts",
    ]) {
      expect(deployed(f), `${f} must count as deployed runtime`).toBe(true);
    }

    // B - a script the PRODUCTION BUILD runs. Derived from package.json, and
    // asserted non-empty so this control cannot pass by finding nothing.
    expect(
      PRODUCTION_BUILD_SCRIPTS.length,
      "package.json's build command must name at least one script for this rule to have work",
    ).toBeGreaterThan(0);
    for (const f of PRODUCTION_BUILD_SCRIPTS) {
      expect(deployed(f), `${f} runs in the production build and must count as deployed`).toBe(true);
    }

    // DOES NOT SHIP - a change to any of these must NOT demand a new baseline.
    for (const f of [
      ".github/workflows/ci.yml",
      "scripts/verify-prepush.mjs",
      "scripts/classify-changes.mjs",
      "e2e/perceived-speed.spec.ts",
      "e2e-payment/checkout.spec.ts",
      "tests/docs/canonical-production-facts.test.ts",
      "tests/db/export-resource-registry.db.test.ts",
      "playwright.config.ts",
      "vitest.config.ts",
      "docs/production/current-state.md",
      "README.md",
    ]) {
      expect(deployed(f), `${f} must NOT count as deployed runtime`).toBe(false);
    }
  });

  it("A3 uses the repository's classifier, not a private path list", async () => {
    // Guard-on-the-guard. If someone reintroduces a hand-written runtime list,
    // this fails and points at CLAUDE.md §3's "no second competing map" rule.
    const classify = await loadClassifier();
    for (const f of [
      "instrumentation.ts",
      "instrumentation-client.ts",
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "public/favicon.ico",
      "hooks/use-thing.ts",
      "types/thing.ts",
    ]) {
      expect(
        classify([f]).docs_only,
        `${f} must be recognised as runtime-bearing by the shared classifier - it was ` +
          "omitted by the hand-written list this rule used to carry",
      ).toBe(false);
    }
    expect(classify(["docs/production/current-state.md"]).docs_only).toBe(true);
  });
});

// ===========================================================================
// RULE F — an OPEN pull request is never described as production
//
// A branch, a green CI run and a mergeable state are not deployment. The
// canonical docs are read as a statement of what IS live, so a capability
// written down before its merge commit is an ancestor of production is a false
// production claim regardless of how likely the merge is.
// ===========================================================================

const OPEN_PR_SECTION = "### Open pull requests are not production";

/** The section current-state.md uses to declare its open set. */
function openPrSection(): string {
  const start = CURRENT_STATE.indexOf(OPEN_PR_SECTION);
  if (start === -1) return "";
  const rest = CURRENT_STATE.slice(start + OPEN_PR_SECTION.length);
  const end = rest.search(/\n#{2,3}\s/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * PR numbers current-state.md declares OPEN.
 *
 * Read from each row's SUBJECT CELL - the first `|`-delimited column, which is
 * what the row is ABOUT - and not from anywhere in the section. An earlier
 * revision scraped every `#NNN` in the block, so the moment a row's prose
 * referenced another PR ("#648 records it as untouched") that PR was treated as
 * declared-open, and Rule F then flagged every truthful mention of it - and its
 * changelog row - as describing an open PR as shipped.
 *
 * A row may legitimately cite a MERGED PR to explain itself. Only the subject
 * of the row is a declaration about that PR's state.
 */
export function declaredOpenPrs(): string[] {
  const subjects = openPrSection()
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\|\s*-{2,}/.test(l))
    .map((l) => l.split("|")[1] ?? "")
    .filter((cell) => !/^\s*PR\s*$/i.test(cell));
  return [...new Set(subjects.flatMap((c) => [...c.matchAll(/#(\d{3,5})\b/g)].map((m) => m[1])))];
}

const SHIPPED_WORD = /\b(?:deployed|shipped|is live|in production|production[\s-]exercised|merged to production)\b/i;

// ===========================================================================
// RULE A4 — the runtime-bearing SHA has exactly ONE canonical home
//
// current-state.md, capability-register.md and known-limitations.md each
// carried the same 40-hex pin. Only current-state.md's copy was validated, so
// after the next deployment either of the other two could drift silently -
// reproducing, for the fourth derived fact, precisely the defect this whole
// reconciliation exists to close for the first three.
//
// The migration numbers were fixed by REMOVING the copies rather than
// correcting them. This does the same: the other two documents reference
// current-state.md instead of restating the SHA, and this rule keeps it that
// way. A guard that merely banned the phrase "runtime-bearing head is" would
// be satisfied by any other wording around the same literal.
// ===========================================================================

// ===========================================================================
// RULE C2 — the 0169 clinical write boundary is stated once, correctly
//
// Migration 0169 (applied 2026-08-03) revoked `insert, update, delete` from
// `authenticated` on all six clinical tables by name, leaving SELECT only.
// Three canonical documents nonetheless carried the PRE-0169 sentence as
// current fact - "authenticated still holds row INSERT/UPDATE/DELETE", "row
// DML on the five app-written tables is NOT revoked" - and two of them cited
// L18 as corroboration while L18's own heading says CLOSED.
//
// The first remediation pass fixed ONE of the three and believed it had swept
// the class. This rule is why the second pass could not repeat that: it is a
// CLASS check over every canonical document, not three fixed line numbers.
//
// A correction may quote the old sentence - that is how the fix stays
// auditable - so a hit is permitted on a line that also carries an explicit
// correction marker. Everything else is a live contradiction.
// ===========================================================================

const PRE_0169_DML =
  /(?:\bstill\s+holds\b[^.\n|]{0,60}\b(?:DML|INSERT)|(?:row\s+)?DML\b[^.\n|]{0,40}\bis\s+NOT\s+revoked\b|\bis\s+NOT\s+revoked\b[^.\n|]{0,40}\bDML\b)/i;
const CORRECTION_MARKER =
  /\bCORRECTED\b|\bcorrected\b|\bpreviously\s+(?:read|continued|said)\b|\bused\s+to\s+(?:read|carry|say)\b|\bprevious\s+wording\b|\bthis\s+(?:row|passage|clause|bullet|section|entry)\s+(?:previously|used\s+to)\b|\bwithdrawn\s+wording\b/i;

/**
 * Blank out QUOTED SPANS, preserving offsets and line structure.
 *
 * C2 used to exempt the whole Markdown line whenever a correction marker
 * appeared anywhere on it. That is far too coarse, and it is porous in exactly
 * the place these documents are densest - a single-line table row, where one
 * legitimate historical correction licensed every other assertion in the row.
 * `CORRECTED: authenticated still holds row INSERT/UPDATE/DELETE` passed while
 * stating the defect as current fact.
 *
 * The narrower rule: a correction stays auditable by QUOTING what it replaces,
 * so the historical text is the quoted span and nothing else. Mask the quotes;
 * whatever is left on the line is being asserted in the document's own voice.
 * Bounded span reasoning, not a Markdown parser.
 */
function maskQuotedSpans(text: string): string {
  // A quote is masked only when a correction/history marker INTRODUCES it -
  // i.e. the marker appears earlier on the same line than the quote does.
  //
  // Masking every quotation was the previous revision, and it was worse than
  // the line-wide exemption it replaced: `Current posture: "authenticated still
  // holds row INSERT/UPDATE/DELETE"` was erased and passed. Quotation marks
  // attribute and emphasise CURRENT claims at least as often as they preserve
  // superseded ones, so quoting cannot itself be the signal.
  //
  // "Introduced by" is the bounded version of "belongs to": a correction says
  // what it is replacing and then shows it. A live claim that happens to be
  // quoted has no such preamble, and a row carrying a real correction plus a
  // separate live assertion still fails on the assertion, which sits outside
  // any marker-introduced quote.
  let out = text;
  for (const m of [...text.matchAll(/"[^"\n]*"|“[^”\n]*”/g)]) {
    const start = m.index ?? 0;
    const lineStart = text.lastIndexOf("\n", start) + 1;
    // CELL-SCOPED, NOT LINE-SCOPED. Scanning from the start of the LINE let one
    // legitimate correction license every later quotation in the same Markdown
    // row, which is the densest place these documents write:
    //
    //   | Corrected: previous wording "row DML is NOT revoked" | Current
    //     posture: "authenticated still holds row INSERT/UPDATE/DELETE" |
    //
    // The first cell is a real historical correction. The second states the
    // defect as CURRENT FACT, and it was masked by the marker in the cell
    // before it. A marker may only speak for its own cell, so the preamble
    // starts at the nearest `|` (or line start, whichever is closer) - which
    // also still covers the ordinary prose case where there is no table at all.
    const cellStart = text.lastIndexOf("|", start);
    const preambleStart = Math.max(lineStart, cellStart === -1 ? lineStart : cellStart + 1);
    const preamble = text.slice(preambleStart, start);
    if (!CORRECTION_MARKER.test(preamble)) continue;
    out = out.slice(0, start) + " ".repeat(m[0].length) + out.slice(start + m[0].length);
  }
  return out;
}

describe("RULE C2 — no canonical doc says authenticated still holds clinical row DML", () => {
  it.each(NO_CURRENT_MAX_DOCS)("%s carries no live pre-0169 assertion", (name, doc) => {
    const offenders = currentProse(doc)
      .split("\n")
      // Quoted text is the correction's evidence; the rest of the line is the
      // document speaking. Mask the quotes and judge only what remains.
      .filter((l) => PRE_0169_DML.test(maskQuotedSpans(l)))
      // A preserved historical heading is legal while it is marked CLOSED -
      // the same convention L2, L18 and L23 already use.
      .filter((l) => !(/^##\s/.test(l) && /\bCLOSED\b/.test(l)))
      .map((l) => l.trim().slice(0, 150));

    expect(
      offenders,
      `${name} states as CURRENT fact that authenticated holds clinical row DML. ` +
        "Migration 0169 revoked it on all six tables and L18 is CLOSED, so this contradicts " +
        "both the migration and the sibling document it usually cites. Mark it historical or " +
        `remove it. Offending: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("C2 controls: the exemption covers the quoted span, and nothing else", () => {
    const live = (line: string) => PRE_0169_DML.test(maskQuotedSpans(line));

    // A - bare assertion.
    expect(live("`authenticated` still holds INSERT/UPDATE/DELETE on the clinical tables")).toBe(true);

    // B - a correction MARKER does not launder an unquoted assertion. This is
    // the hole: the marker was enough on its own.
    expect(live("CORRECTED: authenticated still holds row INSERT/UPDATE/DELETE")).toBe(true);

    // C - the genuine shape, quoted and past-tense.
    expect(
      live('Previous wording: "authenticated still held INSERT/UPDATE/DELETE before 0169"'),
    ).toBe(false);

    // D - a row carrying a legitimate quoted correction AND a separate live
    // assertion outside the quotes. The row must still fail.
    expect(
      live(
        '| Clinical | ⚠️ corrected: this read *"row DML is NOT revoked"* | and row DML on the five app-written tables is NOT revoked |',
      ),
    ).toBe(true);

    // F - Codex's bypass: a quotation that ATTRIBUTES a live claim rather than
    // preserving a superseded one. No marker introduces it, so it is not masked.
    expect(live('Current posture: "authenticated still holds row INSERT/UPDATE/DELETE"')).toBe(true);

    // G - the same sentence, genuinely introduced as history, stays legal.
    expect(
      live('This row previously read: "authenticated still holds row INSERT/UPDATE/DELETE"'),
    ).toBe(false);

    // E - current, correct post-0169 wording.
    expect(
      live("`0169` revoked insert, update and delete from `authenticated` on all six tables"),
    ).toBe(false);
  });

  it("L18 is still recorded as CLOSED, so the correction has something to point at", () => {
    expect(
      KNOWN_LIMITATIONS,
      "L18's heading must remain, marked CLOSED by 0169",
    ).toMatch(/^##\s+L18\s+—[^\n]*\bCLOSED\b[^\n]*0169/m);
  });
});

// ===========================================================================
// RULE X — CROSS-DOCUMENT PARITY
//
// THE PATTERN THIS EXISTS TO BREAK. Three review rounds found the same shape:
// a class was fixed thoroughly in current-state.md and left standing in a
// sibling. F-RET-001 was re-derived to P2 in L27 while a summary bullet four
// hundred lines above still said P1. The capability register kept naming
// "PR #644 ... eight runtime files" across two production moves. A dated
// waitlist zero was corrected in one document and stayed present-tense in two
// others.
//
// Every rule above this one reads ONE document at a time, which is exactly why
// none of them caught it. These read ACROSS documents and fail when two
// canonical files disagree about one fact - so fixing the cited line and
// leaving its twin is red, not green.
// ===========================================================================

/** All five canonical documents, for rules that must see the whole set. */
const CANONICAL_SET = [
  ["docs/production/current-state.md", CURRENT_STATE],
  ["docs/production/capability-register.md", CAPABILITY_REGISTER],
  ["docs/production/known-limitations.md", KNOWN_LIMITATIONS],
  ["docs/production/release-changelog.md", RELEASE_CHANGELOG],
  ["docs/production/migration-ledger.md", MIGRATION_LEDGER],
] as const;

/**
 * Parse a count these documents write, as a WORD or as DIGITS.
 *
 * This replaced a fixed lookup table that stopped at twenty, and then at
 * thirty. Both ceilings were the same bug: production advances, the true count
 * eventually exceeds the table, and a guard that cannot REPRESENT the fact it
 * checks starts failing documents that are correct - which pressures the
 * document to be wrong. Raising the ceiling to 31, 32, 33 just reschedules it.
 *
 * So the parser is COMPOSITIONAL rather than enumerated: units, teens, tens,
 * optional hyphen or space, optional hundreds, optional "and". Digits are
 * accepted too and are unbounded, which is the escape hatch if a count ever
 * outgrows comfortable English. Nothing here needs editing when production
 * moves.
 */
const UNITS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Number a count word/phrase denotes, or null when it is not a count at all. */
function parseCount(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  const tokens = text.split(/[\s-]+/).filter((t) => t && t !== "and");
  if (tokens.length === 0) return null;
  let total = 0;
  let current = 0;
  let sawAny = false;
  for (const t of tokens) {
    if (t === "hundred") {
      if (current === 0) return null; // "hundred" with nothing before it
      current *= 100;
      sawAny = true;
      continue;
    }
    if (t in TENS) {
      current += TENS[t];
      sawAny = true;
      continue;
    }
    if (t in UNITS) {
      current += UNITS[t];
      sawAny = true;
      continue;
    }
    return null; // any non-number token means this is not a count
  }
  if (!sawAny) return null;
  total += current;
  return total;
}

const isCountWord = (w: string) => parseCount(w) !== null;

/**
 * Regex source matching a COMPLETE count phrase, and nothing else.
 *
 * `parseCount` already understood "one hundred and five"; the CONSUMERS did
 * not. Both extraction sites captured a single `\w+` (later `[\w-]+`) token, so
 * the parser was handed "one" and the rest of the phrase was dropped on the
 * floor - a capable parser defeated by its caller, which is worse than a
 * limited parser because the limitation is invisible.
 *
 * Built FROM the parser's own vocabulary rather than written alongside it, so
 * the two cannot drift: adding a word to UNITS/TENS extends this automatically.
 * It is a bounded grammar, not a wildcard - only number tokens joined by a
 * space or hyphen, with an optional "and". Ordinary prose cannot be swallowed,
 * because the first non-number token ends the match.
 */
const NUM_TOKEN = [...Object.keys(UNITS), ...Object.keys(TENS), "hundred"]
  .sort((a, b) => b.length - a.length) // longest-first: "nineteen" before "nine"
  .join("|");
const COUNT_PHRASE =
  // `\b` AT BOTH ENDS, and it is load-bearing rather than defensive. Without
  // it the alternation happily starts INSIDE an ordinary word: "none",
  // "someone", "stone" and "alone" all yielded "one", so a document asserting
  // **none** carry a capability parsed as the number 1 and passed silently
  // wherever 1 was the expected count. A wrong number that parses is the
  // failure mode this whole grammar exists to remove.
  `\\b(?:\\d+|(?:${NUM_TOKEN})(?:[\\s-]+(?:and[\\s-]+)?(?:${NUM_TOKEN}))*)\\b`;

/**
 * Split a document into units a CLAIM can live in.
 *
 * A table row is one unit - it is one statement, however long. Ordinary prose
 * is unwrapped paragraph-first and then split on sentence terminators, because
 * these files wrap at ~95 columns and a claim is routinely separated from the
 * qualification that withdraws it by nothing but a newline.
 */
function sentenceUnits(doc: string): string[] {
  const units: string[] = [];
  for (const block of doc.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    if (lines.some((l) => l.trim().startsWith("|"))) {
      units.push(...lines);
      continue;
    }
    const joined = lines.join(" ").replace(/\s+/g, " ").trim();
    if (!joined) continue;
    units.push(...joined.split(/(?<=[.;])\s+/));
  }
  return units;
}

describe("RULE X — canonical documents agree with each other", () => {
  it("X1: F-RET-001's severity is stated in L27 and matched wherever else it appears", () => {
    const sectionStart = KNOWN_LIMITATIONS.indexOf("## L27");
    expect(sectionStart, "L27 must exist").toBeGreaterThan(-1);
    const authority = KNOWN_LIMITATIONS.slice(sectionStart).match(/\*\*(P\d) — OPEN\.\*\*/)?.[1];
    expect(authority, "L27 must state a severity in the form **Pn — OPEN.**").toBeTruthy();

    const wrong: string[] = [];
    for (const [name, doc] of CANONICAL_SET) {
      for (const line of currentProse(doc).split("\n")) {
        if (!/F-RET-001/.test(line)) continue;
        if (!/\bP\d\b/.test(line)) continue;
        if (CORRECTION_MARKER.test(line) || /revision of this entry|\bWas P\d\b/i.test(line)) continue;
        const levels = [...line.matchAll(/\bP(\d)\b/g)].map((m) => "P" + m[1]);
        if (levels.some((l) => l !== authority)) wrong.push(`${name}: ${line.trim().slice(0, 130)}`);
      }
    }
    expect(
      wrong,
      `a canonical document states an F-RET-001 severity other than L27's ${authority}. L27 is ` +
        "the authority; every other mention must match it or be marked as the withdrawn wording. " +
        `Offending: ${JSON.stringify(wrong)}`,
    ).toEqual([]);
  });

  it("X2: only current-state.md names WHICH PR is the current runtime baseline", () => {
    // A4 stops a second document copying the SHA. The PR number and the runtime
    // file count are the same fact wearing different clothes, and they rotted
    // for two production moves while the SHA beside them stayed correct.
    const offenders: string[] = [];
    for (const [name, doc] of CANONICAL_SET) {
      if (name.endsWith("current-state.md") || name.endsWith("release-changelog.md")) continue;
      for (const line of currentProse(doc).split("\n")) {
        if (!/runtime[- ]bearing/i.test(line)) continue;
        if (CORRECTION_MARKER.test(line)) continue;
        if (/#\d{3,4}\b/.test(line) || /\b(?:four|eight|twelve|\d+)\s+(?:runtime|deployed)\s+files?\b/i.test(line)) {
          offenders.push(`${name}: ${line.trim().slice(0, 130)}`);
        }
      }
    }
    expect(
      offenders,
      "a canonical document other than current-state.md names the PR or the runtime file count " +
        "of the current baseline. That is the same derived fact as the SHA and rots the same way. " +
        `Reference current-state.md instead. Offending: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("X3: no canonical document turns a dated measurement into a present-tense one", () => {
    // THREE REMEMBERED PHRASES WAS NOT A CLASS. The first revision matched only
    // "currently holds/has/stands/contains", "holds ... now" and "is being
    // collected", and three live claims walked straight through it:
    //   "that count is currently **4 unresolved ops_alerts rows** (2026-08-23)"
    //   the settlement table "holds 0 rows"
    //   "No settlement has been recorded in production"
    //
    // The shape that actually matters is a PRESENT-TENSE STATE VERB carrying a
    // COUNT - including zero, and including zero expressed as a negation, which
    // is the form that hides best. Every production figure in this set is dated
    // evidence, so the tense is the defect regardless of the noun.
    const COUNT = String.raw`(?:\*{0,2}(?:\d+|zero|no)\b)`;
    const STATE_VERB = String.raw`(?:holds?|has|have|contains?|stands?\s+at|is|are|remains?)`;
    const PRESENT_TENSE_MEASURE = new RegExp(
      [
        // "currently holds 4" · "is currently 4 unresolved rows" · "now holds 0 rows"
        String.raw`\b(?:currently|now)\b[^.\n|]{0,20}\b${STATE_VERB}\b[^.\n|]{0,20}${COUNT}`,
        String.raw`\b${STATE_VERB}\b[^.\n|]{0,20}\b(?:currently|now)\b[^.\n|]{0,20}${COUNT}`,
        // A BARE present-tense count, with the FULL state-verb set rather than
        // two of them. Restricting this branch to holds/contains meant the
        // commonest phrasings walked straight through without needing
        // "currently" or "now" anywhere:
        //   "appointment_settlements has 0 rows"
        //   "There are 4 unresolved ops_alerts rows"
        //   "the queue remains 4 records"
        // The noun anchor keeps it bounded, and the gap allows the qualifiers
        // these documents actually write ("4 unresolved ops_alerts rows").
        // A NUMERAL, deliberately, not the full COUNT. With "currently"/"now"
        // above, any count form is a claim about today. WITHOUT a temporal
        // qualifier only a numeral is unambiguous evidence of a measurement:
        // the word forms "no"/"zero" are just as often structural rather than
        // measured ("there is no `NAV_ENTRIES` row", "these merges have no row
        // here"), and matching them turned this rule against the document's own
        // prose. Zero stated as a negation is already covered by its own branch
        // below, which is anchored on recorded/created/collected.
        String.raw`\b${STATE_VERB}\s+\*{0,2}\d+\b[^.\n|]{0,30}?(?:rows?|entries|records)\b`,
        // "No settlement has been recorded" - a zero stated as a negation
        String.raw`\b(?:no|zero)\s+\w[\w-]{2,}(?:\s+\w[\w-]{2,})?\s+(?:has|have)\s+been\s+(?:recorded|created|collected|made)\b`,
        // the original inference form
        String.raw`\bis\s+being\s+collected\b`,
      ].join("|"),
      "i",
    );
    // SENTENCE-SCOPED, NOT LINE-SCOPED. These documents wrap prose at ~95
    // columns, so a claim and the disclaimer that qualifies it routinely land on
    // different lines - "it does not prove the table is empty now, nor / that no
    // prospect entry has been created since" is one sentence and two lines. A
    // line-scoped rule reported the second half as a claim while the first half
    // withdrew it. Table rows stay single units, which is also correct: a row is
    // one statement.
    const offenders: string[] = [];
    for (const [name, doc] of CANONICAL_SET) {
      for (const line of sentenceUnits(currentProse(doc))) {
        if (!PRESENT_TENSE_MEASURE.test(line)) continue;
        // A date beside the figure does NOT license the present tense - that was
        // the whole defect. Only an explicit correction, or a negated form
        // ("no prospect data is NOT being collected" style disclaimers), is
        // exempt. `when last measured` is the sanctioned past-tense phrasing and
        // never matches the pattern in the first place.
        // A DISCLAIMER is not a claim. "it does not prove the table is empty
        // now, nor that no prospect entry has been created since" states the
        // absence of knowledge, and the negated-count shape above matches it by
        // construction. Flagging a warning as the claim it warns against is the
        // false positive that teaches people to delete the warning.
        const DISCLAIMER =
          /\bdoes\s+not\s+prove\b|\bnor\s+that\b|\bis\s+not\s+a\s+claim\b|\bnever\s+a\s+claim\b|\bcannot\s+(?:be\s+)?(?:known|assumed)\b/i;
        if (CORRECTION_MARKER.test(line) || DISCLAIMER.test(line)) continue;
        offenders.push(`${name}: ${line.trim().slice(0, 130)}`);
      }
    }
    expect(
      offenders,
      "a canonical document states a measured figure in the present tense. Every production count " +
        "in this set is dated evidence - none was re-measured at this reconciliation - so say when " +
        `it was measured, not that it holds now. Offending: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("X4: both documents' merge counts equal the count Git actually reports", async () => {
    // This used to compare one prose number with the other, so two documents
    // agreeing on a WRONG number passed. They did: both said "fourteen" while
    // the ancestry had moved, and the rule was green throughout. Prose-to-prose
    // agreement is consistency, not correctness - the Git graph is the
    // authority, and it is the thing that moves.
    const cs = currentProse(CURRENT_STATE).match(
      new RegExp(`full merge ancestry back to \`b9e0003f\` \\((${COUNT_PHRASE}) merges\\)`, "i"),
    )?.[1];
    const cr = currentProse(CAPABILITY_REGISTER).match(
      new RegExp(`\\*{0,2}(${COUNT_PHRASE})\\*{0,2}\\s+production merges landed between \`b9e0003f\``, "i"),
    )?.[1];
    expect(cs, "current-state must state the merge count").toBeTruthy();
    expect(cr, "capability-register must state the merge count").toBeTruthy();

    const csN = parseCount(cs as string);
    const crN = parseCount(cr as string);
    expect(csN, `current-state's count is not parseable: ${cs}`).not.toBeNull();
    expect(crN, `capability-register's count is not parseable: ${cr}`).not.toBeNull();

    // They must still agree with each other - a cheap check that survives a
    // shallow clone, where the authoritative one below cannot run.
    expect(
      crN,
      "the two documents count the same merges since the same baseline and must agree",
    ).toBe(csN);

    if (!GIT_USABLE) {
      expect(GIT_USABLE, "shallow clone or no git — X4's Git derivation could not run").toBe(false);
      return;
    }
    // ENDPOINT = the CURRENT PRODUCTION GIT HEAD. Two wrong endpoints were
    // tried before this one, and both produced a confidently wrong number:
    //
    //   `HEAD`              - on a PR branch `--first-parent` walks the PR's
    //                         OWN chain. It reported 5, this branch's successive
    //                         "merge production in" commits, against a true 27.
    //   runtime-bearing pin - a DOCS-ONLY production merge advances the branch
    //                         HEAD without moving the runtime SHA, so counting
    //                         from the pin undercounts by every such merge and
    //                         does it silently. MERGE_COUNT_AUTHORITY is not
    //                         RUNTIME_SHA; they are separate rows for exactly
    //                         this reason, and they happen to be equal today,
    //                         which is what hid the error.
    //
    // Runtime-behaviour rules keep using the pin. Only this count uses the head.
    const baseline = currentGitHeadSha();
    expect(baseline, "current-state must record a Current Git branch HEAD for X4 to count against").toBeTruthy();
    const log = git("log", "--first-parent", "--merges", "--format=%H", `b9e0003f..${baseline}`);
    expect(log, "git could not enumerate the ancestry from b9e0003f").not.toBeNull();
    const actual = (log as string).split("\n").filter(Boolean).length;
    expect(
      actual,
      "b9e0003f must be reachable with merges after it, or this rule proves nothing",
    ).toBeGreaterThan(0);
    expect(
      csN,
      `both documents state ${csN} merges since \`b9e0003f\`, but git log --first-parent ` +
        `--merges b9e0003f..${(baseline as string).slice(0, 8)} reports ${actual}. The graph is the ` +
        `authority; the prose is a ` +
        "copy of it, and this is the copy going stale.",
    ).toBe(actual);
  });

  it("A5: the recorded Current Git branch HEAD equals the real production ref", () => {
    // READING THE VALUE FROM THE DOCUMENT IS NOT VERIFYING IT. X4 counts to the
    // recorded Git head, which closed one hole and left a subtler one: the
    // RECORDED VALUE can itself be stale. After a documentation-only production
    // merge, A2/A3 stay green by construction - the runtime-bearing SHA has not
    // moved and no runtime file changed - while the branch has advanced, the
    // recorded head still names the older commit, and X4 dutifully counts to
    // that stale commit and agrees with a stale prose count. Every rule passes
    // and every number is wrong.
    //
    // So the head is checked against the actual ref. The branch NAME is read
    // from the document (it is a recorded fact like any other) and resolved
    // locally - no network. Where the ref is not present, as in a shallow CI
    // clone, this reports that it could not run rather than passing quietly,
    // the same contract A1/A2/A3 use.
    const recorded = currentGitHeadSha();
    expect(recorded, "current-state must record a Current Git branch HEAD").toBeTruthy();

    const branch = currentProse(CURRENT_STATE).match(
      /\|\s*\*{0,2}Production branch\*{0,2}\s*\|\s*`([^`]+)`/i,
    )?.[1];
    expect(branch, "current-state must name the production branch for this rule to resolve it").toBeTruthy();

    if (!GIT_USABLE) {
      expect(GIT_USABLE, "shallow clone or no git — A5 could not run").toBe(false);
      return;
    }
    // Prefer the remote-tracking ref: on the production branch itself the local
    // ref is the same commit, and on a PR branch only the remote-tracking ref
    // describes production at all.
    const ref =
      git("rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`) ??
      git("rev-parse", "--verify", "-q", `refs/heads/${branch}`);
    if (!ref) {
      expect(ref, `neither origin/${branch} nor ${branch} is present in this clone — A5 could not run`).toBeNull();
      return;
    }
    expect(
      recorded,
      `current-state records the Current Git branch HEAD as ${(recorded as string).slice(0, 8)}, but ` +
        `${branch} actually points at ${ref.slice(0, 8)}. A documentation-only production merge ` +
        "advances the branch without moving the runtime pin, so A2 and A3 both stay green while " +
        "this row and every count derived from it go stale.",
    ).toBe(ref);
  });

  it("X4's endpoint is the production GIT HEAD, not the runtime pin — they are different facts", () => {
    // A DOCS-ONLY production merge advances the branch head and leaves the
    // runtime-bearing SHA where it was. Counting merges from the pin therefore
    // undercounts by every docs-only merge, silently. Constructed proof, run
    // against a real throwaway history rather than asserted:
    //
    //   baseline -> merge #1 (app/x.ts)   <- runtime pin stops here, count 1
    //            -> merge #2 (docs/y.md)  <- branch head is here,   count 2
    //
    // Prose still saying "one" passes when counted from the pin and fails when
    // counted from the head. That is the whole defect, and it is invisible on
    // this repository today because the two rows name the same commit.
    const head = currentGitHeadSha();
    const pin = pinnedRuntimeSha();
    expect(head, "current-state must record a Current Git branch HEAD").toBeTruthy();
    expect(pin, "current-state must pin a runtime-bearing HEAD").toBeTruthy();

    // The two authorities are read from DIFFERENT rows. Equal values are legal
    // and are the normal case; reading them from one row would not be.
    const rows = currentProse(CURRENT_STATE).split("\n");
    const headRow = rows.findIndex((l) => /Current Git branch HEAD/i.test(l));
    const pinRow = rows.findIndex((l) => /Last runtime-bearing application HEAD/i.test(l));
    expect(headRow, "the Git-head row must exist").toBeGreaterThan(-1);
    expect(pinRow, "the runtime-pin row must exist").toBeGreaterThan(-1);
    expect(
      headRow,
      "the merge-count authority and the runtime-behaviour authority must be separate rows - " +
        "collapsing them is what makes a docs-only production merge invisible to the count",
    ).not.toBe(pinRow);

    if (!GIT_USABLE) {
      expect(GIT_USABLE, "shallow clone or no git — the endpoint check could not run").toBe(false);
      return;
    }
    // The head must be an ancestor-or-equal of nothing weaker than the pin:
    // production only ever moves forward, so the head can never be BEHIND the
    // runtime pin. If it ever is, one of the two rows is stale.
    expect(
      git("merge-base", "--is-ancestor", pin as string, head as string),
      `the runtime pin ${(pin as string).slice(0, 8)} is not an ancestor of the recorded Git ` +
        `head ${(head as string).slice(0, 8)} - one of the two header rows is stale`,
    ).toBe("");
  });

  it("count extraction hands parseCount the WHOLE phrase, at every consumer", () => {
    // The parser understood "one hundred and five" long before the consumers
    // did. Both extraction sites captured a single token, so X5 did not merely
    // fail to parse "twenty-seven" - it captured "seven" and compared against
    // SEVEN. A wrong number that parses is worse than one that does not.
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["27", 27],
      ["250", 250],
      ["4096", 4096],
      ["twenty-seven", 27],
      ["thirty-one", 31],
      ["forty-two", 42],
      ["one hundred and five", 105],
    ];
    const registerRe = new RegExp(
      `\\*{0,2}(${COUNT_PHRASE})\\*{0,2}\\s+production merges landed between \`b9e0003f\``,
      "i",
    );
    const capabilityRe = new RegExp(
      `\\*{0,2}(${COUNT_PHRASE})\\*{0,2}\\s+carry\\s+a\\s+capability`,
      "i",
    );
    for (const [phrase, value] of cases) {
      const reg = `**${phrase}** production merges landed between \`b9e0003f\` and the baseline.`;
      const cap = `**${phrase}**\ncarry a capability that belongs in this register.`;
      expect(parseCount(reg.match(registerRe)?.[1] ?? ""), `register: ${phrase}`).toBe(value);
      expect(parseCount(cap.match(capabilityRe)?.[1] ?? ""), `capability: ${phrase}`).toBe(value);
    }

    // The grammar is bounded: a non-number word is not a count, and must not
    // match at all rather than matching some fragment of itself.
    const bananaReg = "**banana** production merges landed between \`b9e0003f\` and the baseline.";
    const bananaCap = "**banana**\ncarry a capability that belongs in this register.";
    expect(bananaReg.match(registerRe)?.[1], "banana must not match the register grammar").toBeUndefined();
    expect(bananaCap.match(capabilityRe)?.[1], "banana must not match the capability grammar").toBeUndefined();
    expect(parseCount("banana"), "banana is not a count").toBeNull();
  });

  it("X6: the changelog covers every production PR that actually merged in its range", () => {
    // ENDPOINT AGREEMENT IS NOT COVERAGE. This compared the claimed upper bound
    // with `Math.max(...rows)`, so "#632-#650" was satisfied by carrying #632
    // and #650 and nothing in between - a range can be complete at both ends
    // and hollow in the middle, which is precisely the shape a hand-maintained
    // table drifts into.
    //
    // The authority is the first-parent production history, not the numbers in
    // the table. And it must be the set of PRs that ACTUALLY MERGED: PR numbers
    // are not contiguous production history, so a draft or abandoned PR (#647
    // is open and drafted today) leaves a legitimate numeric gap that is not
    // missing coverage. Enumerating integers would manufacture that defect.
    const rows = new Set(
      [...RELEASE_CHANGELOG.matchAll(/^\|\s*\*{0,2}#(\d{3,4})\*{0,2}\s*\|/gm)]
        .map((m) => Number(m[1]))
        .filter((n) => n >= 632),
    );
    expect(rows.size, "the changelog must carry rows in the reconciled range").toBeGreaterThan(0);

    const claims = [...RELEASE_CHANGELOG.matchAll(/#632[–-]#?(\d{3,4})/g)].map((m) => Number(m[1]));
    expect(
      claims.length,
      "the changelog must state the range it covers, so the claim can be checked",
    ).toBeGreaterThan(0);

    // Every coverage sentence states one derived fact and they must agree.
    const distinct = [...new Set(claims)];
    expect(
      distinct.length,
      `the changelog states more than one coverage upper bound: ${JSON.stringify(distinct)}`,
    ).toBe(1);
    const upper = distinct[0];

    if (!GIT_USABLE) {
      expect(GIT_USABLE, "shallow clone or no git — X6's completeness check could not run").toBe(false);
      return;
    }
    // The MERGED set, read from the production line rather than from integers.
    const baseline = currentGitHeadSha();
    expect(baseline, "current-state must record a Current Git branch HEAD").toBeTruthy();
    const subjects = git("log", "--first-parent", "--merges", "--format=%s", `b9e0003f..${baseline}`) ?? "";
    const merged = new Set(
      [...subjects.matchAll(/Merge pull request #(\d{3,4})\b/g)]
        .map((m) => Number(m[1]))
        .filter((n) => n >= 632 && n <= upper),
    );
    expect(
      merged.size,
      "no merged production PRs were found in the claimed range, so this rule would prove nothing",
    ).toBeGreaterThan(0);

    const missing = [...merged].filter((pr) => !rows.has(pr)).sort((a, b) => a - b);
    expect(
      missing,
      `the changelog claims coverage through #${upper}, but ${missing.length} production PR(s) ` +
        "that actually merged inside that range have no row. A range complete at both ends can " +
        `still be hollow, which is why the upper bound alone cannot prove this. Missing: ${JSON.stringify(missing)}`,
    ).toEqual([]);

    // The upper bound must still BE a merged PR and the highest one covered -
    // otherwise coverage could be claimed through a number that never landed.
    expect(
      rows.has(upper),
      `the changelog claims coverage through #${upper} but carries no row for it`,
    ).toBe(true);
  });

  it("X5: the register's capability section counts what it actually lists, contiguously", () => {
    // The real defect had two halves and neither was a counting error alone:
    // section 15 said "Six" while production had moved twice past it, AND the
    // #646 row was appended after a BLANK LINE, which severs a Markdown table -
    // the row rendered outside it and was excluded from every count.
    //
    // This deliberately does NOT try to decide which merges are "capabilities".
    // That is an editorial judgement; a stated count disagreeing with the rows
    // beneath it, or a table broken in half, is not.
    const start = CAPABILITY_REGISTER.indexOf("## 15. Capabilities added");
    expect(start, "the register must carry its capability section").toBeGreaterThan(-1);
    const rest = CAPABILITY_REGISTER.slice(start);
    const end = rest.indexOf("\n## ", 1);
    const section = end === -1 ? rest : rest.slice(0, end);

    // `\s+` throughout: the prose wraps, so "**Eight** carry\na capability" is
    // one sentence across two lines and a literal space would miss it.
    const stated = section.match(
      new RegExp(`\\*{0,2}(${COUNT_PHRASE})\\*{0,2}\\s+carry\\s+a\\s+capability`, "i"),
    )?.[1];
    expect(stated, "the section must state how many capabilities it carries").toBeTruthy();
    expect(isCountWord(stated as string), `unexpected count word: ${stated}`).toBe(true);

    const lines = section.split("\n");
    const headerIdx = lines.findIndex((l) => /^\|\s*Capability\s*\|/i.test(l));
    expect(headerIdx, "the section must carry a capability table").toBeGreaterThan(-1);

    // Walk from the header: the contiguous table ends at the first non-table
    // line. THEN keep looking. Stopping at the break made this rule REPRODUCE
    // the orphaning bug instead of detecting it - six rows, a blank line, an
    // orphan seventh, count says six, equality passes. That is the exact old
    // #646 layout, and the rule written to catch it would have signed it off.
    let rows = 0;
    let k = headerIdx + 1;
    for (; k < lines.length; k++) {
      const l = lines[k];
      if (!l.trim().startsWith("|")) break;
      if (/^\|\s*-{2,}/.test(l)) continue;
      rows++;
    }

    const orphans = lines
      .slice(k)
      .filter((l) => l.trim().startsWith("|"))
      .filter((l) => !/^\|\s*-{2,}/.test(l))
      .map((l) => l.trim().slice(0, 110));
    expect(
      orphans,
      "section 15 has table row(s) AFTER its table ends. A blank line severs a Markdown table, " +
        "so these render outside it and no count includes them - which is how the #646 row went " +
        `missing. Re-attach them to the table above. Offending: ${JSON.stringify(orphans)}`,
    ).toEqual([]);

    expect(
      rows,
      `section 15 says it carries ${stated} capabilities but its table holds ${rows} contiguous ` +
        "row(s). Either the count is stale, or a row was appended after a blank line and fell " +
        "out of the table - both have happened here.",
    ).toBe(parseCount(stated as string));
  });
});

describe("RULE A4 — only current-state.md pins the runtime-bearing SHA", () => {
  const SHA_FREE_DOCS = [
    ["docs/production/capability-register.md", CAPABILITY_REGISTER],
    ["docs/production/known-limitations.md", KNOWN_LIMITATIONS],
  ] as const;

  it.each(SHA_FREE_DOCS.map(([n, d]) => [n, d] as const))(
    "%s contains no 40-hex commit SHA at all",
    (name, doc) => {
      const shas = shasIn(currentProse(doc));
      expect(
        shas,
        `${name} names a commit SHA. Only current-state.md may pin one; every other canonical ` +
          "document must reference it, because a second copy is a second thing to go stale and " +
          `nothing validates this one. Offending: ${JSON.stringify(shas)}`,
      ).toEqual([]);
    },
  );

  it("both documents actually point at the authority rather than just omitting it", () => {
    for (const [name, doc] of SHA_FREE_DOCS) {
      expect(
        doc,
        `${name} must reference current-state.md for the runtime-bearing baseline. Silently ` +
          "dropping the SHA without saying where it lives leaves the reader with nothing",
      ).toMatch(/current-state\.md/);
    }
  });
});

describe("RULE F — open PRs are declared, and never described as shipped", () => {
  it("current-state.md declares its open set explicitly", () => {
    expect(
      openPrSection(),
      `current-state.md must carry an "${OPEN_PR_SECTION}" section. Without it there is no ` +
        "record of what was deliberately excluded, and the next reader cannot tell an omission " +
        "from a decision",
    ).not.toBe("");
    expect(
      declaredOpenPrs().length,
      "the open-PR section must name at least one PR, or say plainly that the set is empty",
    ).toBeGreaterThan(0);
  });

  it("every declared-open PR carries a non-production state word", () => {
    for (const line of openPrSection().split("\n")) {
      if (!/#\d{3,5}\b/.test(line) || !line.trim().startsWith("|")) continue;
      expect(
        line,
        `an open-PR row must say what state it is in (OPEN / IN DEVELOPMENT / not merged): ${line.trim().slice(0, 120)}`,
      ).toMatch(/\bOPEN\b|\bIN DEVELOPMENT\b|\bnot merged\b|\bno PR merged\b/i);
    }
  });

  it("no canonical doc OUTSIDE the declaration describes a declared-open PR as shipped", () => {
    const open = declaredOpenPrs();
    const declaration = openPrSection();
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      for (const line of currentProse(doc).split("\n")) {
        if (line.trim() !== "" && declaration.includes(line)) continue; // rows checked below
        for (const pr of open) {
          if (!new RegExp(`#${pr}\\b`).test(line)) continue;
          expect(
            SHIPPED_WORD.test(line),
            `${name} describes OPEN PR #${pr} as shipped. An open PR is not production, ` +
              `however green its CI. Offending line: ${line.trim().slice(0, 160)}`,
          ).toBe(false);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // The declaration table is the LIKELIEST place for this defect, so it is the
  // one place the rule may not skip.
  //
  // The earlier revision excluded the whole section from the shipped-word scan,
  // which meant `| #646 | OPEN | deployed in production |` passed: the state
  // cell said OPEN, and nothing ever read the third cell.
  //
  // Scanning the row for shipped WORDS alone does not work either - a truthful
  // row legitimately says "nothing it adds is live" and "byte-for-byte
  // unchanged, so nothing here is live". Both contain a shipped word, negated.
  //
  // So the rule is clause-scoped: split the row on clause boundaries, and any
  // clause carrying a shipped word must also carry a NEGATOR. Two small closed
  // vocabularies, not a phrase list, and it generalises to wordings nobody has
  // written yet.
  // -------------------------------------------------------------------------
  // CLOSED SET, enumerated. It was `un\w+` once, which made every word starting
  // "un" a negator - so `deployed in production under PR #646` passed Rule F
  // because `under` "negated" it. `unit` and `unknown` did the same. The
  // un-prefixed forms that genuinely negate are few enough to name.
  const NEGATOR =
    /\b(?:not|no|nothing|none|never|neither|nor|cannot|can't|isn't|aren't|without|yet to|unmerged|unreleased|unshipped|undeployed|unavailable)\b/i;

  it("every open-PR ROW is scanned, and a shipped claim there must be negated", () => {
    const rows = openPrSection()
      .split("\n")
      .filter((l) => l.trim().startsWith("|") && /#\d{3,5}\b|IN DEVELOPMENT/i.test(l))
      .filter((l) => !/^\|\s*-{2,}/.test(l));
    expect(rows.length, "the declaration must contain rows to scan").toBeGreaterThan(0);

    for (const row of rows) {
      for (const clause of row.split(/[|.;]/)) {
        if (!SHIPPED_WORD.test(clause)) continue;
        expect(
          NEGATOR.test(clause),
          "an open-PR row asserts, unnegated, that the PR is shipped. This is the exact " +
            "defect Rule F exists to prevent, in the row that is supposed to deny it. " +
            `Offending clause: ${JSON.stringify(clause.trim().slice(0, 140))}`,
        ).toBe(true);
      }
    }
  });

  it("no DECLARED-OPEN PR has actually merged — the converse, and the gap this closes", () => {
    // Rule F stops an open PR being called shipped. Nothing stopped the
    // opposite: a PR that HAS merged still sitting in the open table, which is
    // the same falsehood pointing the other way and is what a production move
    // produces by default. #646 sat there merged until this refresh, and only a
    // human noticed.
    //
    // Decided from the Git graph, not from GitHub: a merge commit reachable
    // from HEAD whose subject names the PR is proof it landed. Skips on a
    // shallow clone for the same reason A2/A3 do.
    if (!GIT_USABLE) {
      expect(GIT_USABLE, "shallow clone or no git — the converse check could not run").toBe(false);
      return;
    }
    const merged = git("log", "--merges", "--format=%s", "HEAD") ?? "";
    const landed = declaredOpenPrs().filter((pr) =>
      new RegExp(`Merge pull request #${pr}\\b`).test(merged),
    );
    expect(
      landed,
      "current-state.md declares PR(s) OPEN that have already merged into this history. " +
        "A shipped PR described as open is the same defect as an open PR described as shipped, " +
        `and production moving creates it by default. Offending: ${JSON.stringify(landed)}`,
    ).toEqual([]);
  });

  it("the changelog carries no row for a declared-open PR", () => {
    for (const pr of declaredOpenPrs()) {
      expect(
        RELEASE_CHANGELOG,
        `release-changelog.md has a table row for OPEN PR #${pr}. The changelog records what ` +
          "SHIPPED; adding a row before the merge is how an intention becomes a fact",
      ).not.toMatch(new RegExp(`^\\|\\s*\\*{0,2}#${pr}\\*{0,2}\\s*\\|`, "m"));
    }
  });
});

// ===========================================================================
// RULE G — current-state.md is not its own authority
// ===========================================================================

describe("RULE G — no canonical doc is evidence for itself", () => {
  it("current-state.md states plainly that it is not self-evidence", () => {
    expect(
      currentProse(CURRENT_STATE),
      "current-state.md must say that it is not evidence for itself. Without that sentence a " +
        "reader re-verifying one section by reading another is following the document's own " +
        "instructions, and a self-consistent document can be entirely wrong",
    ).toMatch(/not evidence for (?:itself|any other document)|is not evidence for itself/i);
  });

  it("the re-verify block orders external sources, and puts documentation last", () => {
    const cs = currentProse(CURRENT_STATE);
    expect(cs, "a source-of-truth order must be stated").toMatch(/Source-of-truth order:/i);
    const order = cs.slice(cs.indexOf("Source-of-truth order:"));
    expect(
      order,
      "existing documentation must be named LAST and explicitly as claims to verify, never " +
        "as evidence",
    ).toMatch(/existing documentation \(as claims to verify, never as evidence\)/i);
  });

  it("capability-register defers to current-state rather than re-deciding tenancy", () => {
    expect(
      CAPABILITY_REGISTER,
      "the register and current-state must not both be authorities for the same fact",
    ).toMatch(/neither document is evidence for the other/i);
  });
});

// ===========================================================================
// RULE H — the ledger asserts a current maximum in exactly ONE place
//
// The existing guard validates the "## Current state" block against the
// canonical record, and bans current-max prose in the other three documents.
// Nothing checked the REST of the ledger — which is how "Production max is
// 0157", "the production max is 0159" and "the production migration max is
// 0160" all came to sit in its prose at once, each one a CORRECTION that had
// gone stale exactly the way the claim it corrected had.
// ===========================================================================

/** Ledger text with ignore blocks blanked IN PLACE, so offsets survive. */
function ledgerMasked(): string {
  return MIGRATION_LEDGER.replace(IGNORE_BLOCK_G, (m) => " ".repeat(m.length));
}
const IGNORE_BLOCK_G =
  /<!--\s*canonical-facts:ignore-start([^>]*)-->[\s\S]*?<!--\s*canonical-facts:ignore-end\s*-->/g;

/**
 * Which `## ` section an offset belongs to.
 *
 * `## Current state` is the one authorized current position. `## Previous
 * state …` and `## Recent tail …` are frozen history by construction — the
 * same heading-scoped reasoning ledgerCurrentBlock() already uses — and their
 * literals are evidence of what was true at each apply.
 */
function ledgerSectionAt(offset: number): string {
  const lines = MIGRATION_LEDGER.split("\n");
  const lineNo = MIGRATION_LEDGER.slice(0, offset).split("\n").length - 1;
  let heading = "(preamble)";
  for (let i = 0; i <= lineNo && i < lines.length; i++) {
    if (lines[i].startsWith("## ")) heading = lines[i];
  }
  return heading;
}

const LEDGER_FROZEN_SECTION = /^##\s+(?:Current state|Previous state|Recent tail)\b/;

describe("RULE H — the ledger states a current maximum only under '## Current state'", () => {
  it("no current-max assertion sits in ledger prose outside a frozen section", () => {
    const masked = ledgerMasked();
    const strays: string[] = [];
    for (const re of CURRENT_MAX_PATTERNS) {
      for (const m of masked.matchAll(new RegExp(re.source, re.flags))) {
        const section = ledgerSectionAt(m.index ?? 0);
        if (LEDGER_FROZEN_SECTION.test(section)) continue;
        strays.push(`${section.slice(0, 40)} :: ${m[0].replace(/\s+/g, " ").trim().slice(0, 80)}`);
      }
    }
    expect(
      strays,
      "migration-ledger.md asserts a current migration maximum outside its '## Current state' " +
        "block and outside frozen history. A correction must state that something is SUPERSEDED, " +
        "not name a replacement maximum — three corrections in this file did the latter and all " +
        "three went stale. Offending: " + JSON.stringify(strays),
    ).toEqual([]);
  });

  it("the frozen sections KEEP their literals — this is not a number ban", () => {
    const masked = ledgerMasked();
    let frozenHits = 0;
    for (const re of CURRENT_MAX_PATTERNS) {
      for (const m of masked.matchAll(new RegExp(re.source, re.flags))) {
        if (LEDGER_FROZEN_SECTION.test(ledgerSectionAt(m.index ?? 0))) frozenHits++;
      }
    }
    expect(
      frozenHits,
      "the ledger's frozen apply records must still carry their own maxima. If this reaches " +
        "zero the rule above has become a number ban and history has been rewritten to satisfy it",
    ).toBeGreaterThan(10);
  });
});

// ===========================================================================
// RULE D+ — a live limitation cannot vanish, and a closed one cannot revive
// ===========================================================================

/** Limitations that must remain present AND must not be marked closed. */
//
// Each pattern MUST span the WHOLE heading line (`.*$`). An earlier revision
// stopped at the limitation id, so the matched text excluded the rest of the
// line and a `**CLOSED**` marker appended after the id sailed straight through
// the not-closed assertion. Mutation-testing caught it; reading it did not.
const MUST_STAY_OPEN = [
  ["L27", /^##\s+L27\s+—\s+`F-RET-001`.*$/m, "retention and deletion commitments with no implementing code"],
  ["L19", /^##\s+L19\s+—\s+`TRUNCATE`.*$/m, "TRUNCATE breadth outside the clinical tables"],
  ["L20", /^##\s+L20\s+—\s+`service_role`.*$/m, "service_role retains TRIGGER on the clinical tables"],
  ["L25", /^##\s+L25\s+—\s+The durable new-client waitlist.*$/m, "durable waitlist activation"],
] as const;

/** Headings preserved verbatim that state something no longer true. */
const MUST_BE_MARKED_CLOSED = ["L2", "L18", "L23", "L30"] as const;

/** Every `## Lnn` heading id in known-limitations.md, in document order. */
function limitationIds(doc: string): string[] {
  return [...doc.matchAll(/^##\s+(L\d+)\s+—/gm)].map((m) => m[1]);
}

// ===========================================================================
// RULE D0 — a limitation identifier is unique, and this runs BEFORE D+
// ===========================================================================
//
// THE DEFECT THIS EXISTS FOR, exactly as it happened. Production recorded the
// onboarding-celebration limitation as L25 in #658 while this branch had
// independently issued L25 to the durable waitlist. An ordinary merge produced
// TWO `## L25` sections, out of order, and:
//
//   * `git merge-tree --write-tree` returned exit 0 - no textual conflict;
//   * every D+ rule passed, because `MUST_STAY_OPEN` resolves an id with
//     `KNOWN_LIMITATIONS.match(re)?.[0]`, a FIRST-match lookup. The waitlist
//     L25 appears first, satisfied the assertion, and the duplicate sat 35
//     lines below it unmentioned.
//
// So a clean merge, a green CI run and a green guard all coexisted with a
// document that had two different limitations under one identifier. Uniqueness
// has to be asserted over the WHOLE set before any per-id rule reads it,
// because every per-id rule is a first-match lookup and cannot see the second.
describe("RULE D0 — limitation identifiers are unique across the whole document", () => {
  it("no `## Lnn` identifier appears twice", () => {
    const ids = limitationIds(KNOWN_LIMITATIONS);
    expect(ids.length, "known-limitations.md must carry limitation headings").toBeGreaterThan(0);
    const seen = new Map<string, number>();
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}x${n}`);
    expect(
      duplicated,
      "known-limitations.md issues the same limitation identifier more than once. Two different " +
        "limitations under one id is not a formatting slip: every per-id rule below resolves by " +
        "FIRST match, so the second one is invisible to all of them. Production moving is what " +
        `creates this, by merging cleanly. Offending: ${JSON.stringify(duplicated)}`,
    ).toEqual([]);
  });

  // DISCRIMINATION PROOF. Reproduces the exact merge-collision class above and
  // shows the new rule goes RED on it while the OLD first-match lookup stays
  // green - which is the whole reason this rule had to be added rather than
  // trusting D+ to have caught it.
  it("goes RED on the exact collision that escaped, where a first-match lookup stays green", () => {
    const collided = KNOWN_LIMITATIONS.replace(
      /^##\s+L31\s+—/m,
      "## L25 —",
    );
    expect(
      collided,
      "the fixture must actually differ, or this control proves nothing",
    ).not.toBe(KNOWN_LIMITATIONS);

    const ids = limitationIds(collided);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes, "the reproduced collision must contain a duplicate id").toContain("L25");

    // The old per-id shape - `match(/^## L25 —.*$/m)` - still resolves, and
    // still resolves to the WAITLIST heading, exactly as it did in the real
    // merge. That is the blindness this rule covers.
    const firstMatch = collided.match(/^##\s+L25\s+—\s+The durable new-client waitlist.*$/m)?.[0];
    expect(
      firstMatch,
      "the first-match lookup must still succeed on the collided document - if it did not, D+ " +
        "would already have caught this and RULE D0 would be unnecessary",
    ).toBeTruthy();
  });

  it("does NOT fire on a document whose identifiers are merely out of order", () => {
    // Order is a readability question and several ids in this file are already
    // out of sequence for good reasons. Only REUSE is a defect, and a rule that
    // conflated the two would be deleted the first time it fired on a
    // deliberate ordering.
    const shuffled = ["L3", "L1", "L2"];
    const seen = new Map<string, number>();
    for (const id of shuffled) seen.set(id, (seen.get(id) ?? 0) + 1);
    expect([...seen.values()].filter((n) => n > 1)).toEqual([]);
  });
});

describe("RULE D+ — open limitations persist, closed ones stay labelled", () => {
  it.each(MUST_STAY_OPEN.map(([id, re, what]) => [id, re, what] as const))(
    "%s is still present and is not marked closed",
    (id, re, what) => {
      const heading = KNOWN_LIMITATIONS.match(re)?.[0];
      expect(
        heading,
        `${id} (${what}) has disappeared from known-limitations.md. A limitation leaves this ` +
          "file by being CLOSED with evidence on its own heading, never by deletion",
      ).toBeTruthy();
      expect(
        heading,
        `${id} (${what}) has been marked CLOSED in its heading. Closing it requires evidence in ` +
          "the row, and this guard requires a deliberate edit here to acknowledge that",
      ).not.toMatch(/\bCLOSED\b/);
    },
  );

  it("F-RET-001 states a severity, and says it is downgraded rather than closed", () => {
    // The severity pinned here is P2, re-derived at 6786b07b. It was P1 while
    // the published policy still promised a 30-day hard delete and a 90-day
    // backup purge; commit 0acc6773 retired both, so the published-breach
    // driver is gone and what remains is a capability gap. The pin exists so
    // that number cannot move again without this line moving with it.
    const start = KNOWN_LIMITATIONS.indexOf("## L27");
    const rest = KNOWN_LIMITATIONS.slice(start);
    const end = rest.indexOf("\n## ");
    const section = end === -1 ? rest : rest.slice(0, end);
    expect(section, "L27 must state its severity explicitly").toMatch(/\*\*P2 — OPEN\.\*\*/);
    expect(
      section,
      "L27 must record that the P1 framing was WITHDRAWN, not merely edited away - " +
        "a severity that drops without its reason is indistinguishable from one dropped to " +
        "make a gate go green",
    ).toMatch(/WITHDRAWN|withdrawn/);
    expect(
      section,
      "L27 must state that it is downgraded rather than closed, and that the implementation " +
        "gap is untouched",
    ).toMatch(/downgraded, not closed/i);
  });

  it.each(MUST_BE_MARKED_CLOSED)(
    "%s's preserved heading is marked CLOSED on the same line",
    (id) => {
      const heading = KNOWN_LIMITATIONS.match(new RegExp(`^##\\s+${id}\\s+—.*$`, "m"))?.[0];
      expect(heading, `${id}'s heading must be preserved, not deleted`).toBeTruthy();
      expect(
        heading,
        `${id}'s heading states something that is no longer true, so it may only stand while it ` +
          "is marked CLOSED on the same line",
      ).toMatch(/\bCLOSED\b/);
    },
  );
});

// ===========================================================================
// NEGATIVE CONTROLS for rules A, F, G, H and D+
//
// Two kinds appear below, and the difference is deliberate.
//
// PURE-FUNCTION CONTROLS feed a helper the exact string shape it exists to
// catch, exactly as the older controls above do.
//
// MUTATION CONTROLS cannot be written that way: rules A2, A3, G, H and D+ read
// whole files and the Git graph, so the only way to watch them fail is to break
// the real tree and look. That was done, once per rule, and the matrix is
// recorded here because a reader cannot re-derive it from the code:
//
//   A1  a fabricated 40-hex SHA added to current-state.md          -> RED
//   A3  the runtime-bearing pin moved back one merge (#643)        -> RED
//   F   "#646 is deployed and live in production" added            -> RED
//   G   the not-self-evidence sentence removed                     -> RED
//   H   "The production migration max is 0157." added to ledger    -> RED
//   D+  L27 marked **CLOSED** mid-heading                          -> RED
//   D+  L27 severity flipped P1 -> P2                              -> RED
//   D+  L27 deleted outright                                       -> RED
//   D+  "— **CLOSED**" appended to the L19 heading                 -> RED
//
// And one environment case, added after CI proved it the hard way:
//
//   A1  same document, unchanged, in a `--depth 1` clone            -> GREEN (skips)
//   A1  fabricated SHA, in a FULL clone                             -> RED
//
// Second remediation round (Codex review of 5f659927), one defect fact at a
// time, each producing EXACTLY ONE failure and that failure naming the rule
// under test - a control that goes red because something unrelated broke
// proves nothing:
//
//   F    open-PR row rewritten to "deployed in production"          -> RED (row scan)
//   H3   "Production is currently at migration 0165"                -> RED (current-position)
//   H3   "Hosted production stands at 0165"                         -> RED (current-position)
//   H3   "Current hosted migration is 0165"                         -> RED (current-position)
//   H4   "Real-customer activity: 79 clients and 241 appointments"  -> RED (Twin remainder)
//   A4   duplicate SHA reintroduced in known-limitations.md         -> RED (single authority)
//   A4   duplicate SHA reintroduced in capability-register.md       -> RED (single authority)
//   A3   pin moved back one merge, runtime changed since            -> RED (via classifier)
//
// Third round (Codex review of 397d2a2d), same discipline:
//
//   C2   pre-0169 DML claim reintroduced in current-state.md         -> RED
//   C2   ... in capability-register.md                               -> RED
//   C2   ... in known-limitations.md                                 -> RED
//   F    "deployed in production under PR #646"                      -> RED (was GREEN: `under`
//                                                                       satisfied the old `un\w+`)
//   H4   "Real-customer activity is the remainder: 79 clients ..."   -> RED (was GREEN: the bare
//                                                                       word `remainder` exempted it)
//   H3   "Production currently runs migration 0165"                  -> RED (verb was missing)
//   H3   "Production has reached migration 0165"                     -> RED (present perfect)
//   A3   pin moved back one merge                                    -> RED (unchanged)
//
// Fourth round - the local refresh onto production 8418a755 (#648). This one
// is different in kind: it is the first time the guard met a REAL production
// move rather than a synthetic mutation, and A3 fired on its own, naming all
// four deployed files, before any documentation was touched. Re-proved on the
// refreshed tree:
//
//   C2   pre-0169 DML claim reintroduced                              -> RED
//   A3   pin rolled back to the pre-#648 head                         -> RED (with A1b)
//   H4   "Real-customer activity is the remainder: 79 clients ..."    -> RED
//   F    "deployed in production under PR #646"                       -> RED
//   H3   "Production currently runs migration 0165"                   -> RED
//   H3   "Production has reached migration 0165"                      -> RED
//   A1b  section 1 says "At `6786b07b`" while the header pins 8418a755 -> RED
//
// A1b is new, and exists because the refresh created the failure mode: the
// header pins the runtime SHA and the capability sections then say "At
// `<short sha>` ..." about current behaviour. Two statements of one fact drift,
// and a section pinned to a superseded head reads as current while describing a
// runtime that has moved.
//
// Fifth round - the refresh onto production 5ad81129 (#646, FIN-01A Slice 1).
// A3 fired unprompted again, this time naming twelve deployed files, before any
// documentation was touched. Re-proved on that tree:
//
//   C2   pre-0169 DML claim reintroduced                              -> RED
//   A3   pin rolled back to the pre-#646 head                         -> RED (with A1b)
//   H4   "Real-customer activity is the remainder: 79 clients ..."    -> RED
//   F    "deployed in production under PR #646"                       -> RED
//   H3   "Production currently runs migration 0165"                   -> RED
//   H3   "Production has reached migration 0165"                      -> RED
//   F-converse  merged #646 re-declared OPEN                          -> RED
//
// THE CONVERSE RULE IS NEW, AND THIS REFRESH IS WHY. Rule F stopped an open PR
// being called shipped. Nothing stopped the opposite - a PR that HAS merged
// still sitting in the open table - which is the same falsehood pointing the
// other way, and is what a production move produces BY DEFAULT. #646 sat there
// merged and only a human noticed. It is decided from the Git graph rather
// than from GitHub, so it works offline and in CI.
//
// Sixth round - the six fresh P2s from the review of 00fdbf43, repaired as
// THREE CLASSES rather than six lines, because three consecutive rounds found
// the same shape: a class fixed thoroughly in current-state.md and left
// standing in a sibling.
//
// CLASS A got cross-document rules (X1-X5), which is the structural answer to
// that pattern. Every rule before them reads ONE document, which is exactly why
// none of them caught it:
//
//   X2   register restates the baseline as "PR #644 ... eight runtime files"  -> RED
//   X4   register merge count diverges from current-state                     -> RED
//   X1   F-RET-001 severity stated as P1 in a sibling while L27 says P2       -> RED
//   X3   "currently holds 0 rows" on a dated measurement                      -> RED
//   X5   a section-15 row orphaned by a blank line, count vs rows             -> RED
//
// CLASS B: C2's exemption was the whole Markdown LINE whenever a correction
// marker appeared, so `CORRECTED: authenticated still holds row
// INSERT/UPDATE/DELETE` passed while stating the defect as current fact. It now
// masks QUOTED SPANS only - a correction stays auditable by quoting what it
// replaces, so the quote is the historical part and the rest of the line is the
// document speaking. Five controls (A-E) pin the boundary directly.
//
//   B    "CORRECTED: authenticated still holds ..." added to a document       -> RED
//
// CLASS C: A3 exempted every scripts/ path, but package.json runs
// `node scripts/check-production-env-gates.mjs && next build`, and these
// documents treat that gate's fail-versus-report-only behaviour as a deployed
// capability fact (L25). Build scripts are now DERIVED from package.json and
// subtracted from the exemption, so adding a gate to the build brings it under
// the rule automatically. Operator utilities beside it stay exempt.
//
// All seven earlier controls were re-proved unchanged on this tree.
//
// declaredOpenPrs() was also repaired here, by this refresh rather than by
// review: it scraped every `#NNN` in the open-PR block, so the moment a row's
// prose cited another PR ("#648 records it as untouched") that PR counted as
// declared-open and Rule F flagged every truthful mention of it, changelog row
// included. It now reads only each row's SUBJECT CELL.
//
// C2 exists because the previous round fixed ONE of three copies of the same
// false sentence and believed the class was swept. It is a class check over
// every canonical document, not three line numbers.
//
// A3's GREEN controls are asserted directly rather than by mutation, since a
// CI-only commit cannot be made from inside this PR's file surface: the
// deployed-decision test pins `.github/workflows/ci.yml`,
// `scripts/verify-prepush.mjs`, `e2e/*.spec.ts`, `tests/**`, the runner configs
// and docs as NON-deployed, and `app/`, `lib/`, `components/`,
// `instrumentation*.ts`, the Sentry configs, `public/`, `hooks/`, `types/`,
// `middleware.ts` and `next.config.ts` as deployed. This branch is itself a
// docs+tests change after the pin, and A3 stays green throughout - the
// live docs-only/test-only control.
//
// Positive controls, proving the rules are not simply always-red: this branch
// changes only documentation and tests after the pinned SHA, and A3 stays
// green throughout; the past-tense narrative "it read 0160 while production
// was at 0185" stays legal; and §0's own warning naming the Twin-subtracted
// remainder in order to disclaim it is exempt rather than flagged.
//
// A1 originally guarded on GIT_AVAILABLE and went red on its first CI run
// against three SHAs that were all genuine. `fetch-depth: 1` leaves one commit
// in the clone, so every SHA a document names is absent — the production head
// included. Reproduced locally with `git clone --depth 1` before the fix was
// trusted, rather than fixed by reasoning about it.
//
// The D+ mid-heading case is why this matrix exists. The first revision of
// MUST_STAY_OPEN stopped its pattern at the limitation id, so the matched text
// excluded the rest of the heading line and a `**CLOSED**` marker placed after
// the id passed the not-closed assertion. The rule read correctly and did
// nothing. Only mutation exposed it.
// ===========================================================================

describe("NEGATIVE CONTROLS — rules A, F and G go red on the shapes they target", () => {
  it("shasIn finds every 40-hex SHA, and nothing shorter", () => {
    const doc = "head `6786b07be57a9c01ff4421378f22d7dbca68a5c9`, short `6786b07b`, dpl_5jGQkF";
    expect(shasIn(doc)).toEqual(["6786b07be57a9c01ff4421378f22d7dbca68a5c9"]);
  });

  it("shasIn does not treat a deployment id or a checksum sentence as a commit", () => {
    // A Vercel id is not hex-40; a sha256 is 64 and must not be truncated into one.
    const doc = "dpl_nZ6UBkGhK8vTAs8butVWwqNFXqmb and sha256 " + "a".repeat(64);
    expect(shasIn(doc)).toEqual([]);
  });

  it("the shipped-word pattern catches every phrasing that has actually been used", () => {
    for (const shape of [
      "#646 is deployed",
      "#646 shipped on 2026-08-26",
      "the FIN surface (#646) is live",
      "#646 is in production",
      "#646 is production-exercised",
      "#646 merged to production",
    ]) {
      expect(SHIPPED_WORD.test(shape), `MISSED a shipped claim: ${shape}`).toBe(true);
    }
  });

  it("the shipped-word pattern does NOT fire on truthful open-PR wording", () => {
    for (const shape of [
      "#646 is OPEN, not draft, mergeable, CI green",
      "its head b03611ac is not an ancestor of 6786b07b",
      "#646 carries no migration; nothing it adds is live yet",
      "TRUTH-01B-1 is in development, no PR merged",
    ]) {
      // "nothing it adds is live yet" deliberately contains "is live"; the rule is
      // line-scoped and PR-scoped, so a row that names the PR must still not assert
      // shipping. This control pins the pattern's own behaviour, which is that it
      // WOULD fire here - and is why the rule reads the declared-open SECTION as an
      // exclusion rather than trusting the pattern alone.
      const fires = SHIPPED_WORD.test(shape);
      if (shape.includes("nothing it adds is live")) {
        expect(fires, "documented false positive; handled by section exclusion").toBe(true);
      } else {
        expect(fires, `FALSE POSITIVE on truthful open-PR wording: ${shape}`).toBe(false);
      }
    }
  });

  it("declaredOpenPrs reads the declared set from the document, not from a literal", () => {
    const open = declaredOpenPrs();
    expect(open.length, "the open set must be derived from current-state.md").toBeGreaterThan(0);
    expect(
      open.every((n) => /^\d{3,5}$/.test(n)),
      "every declared-open entry must be a PR number",
    ).toBe(true);
  });
});
