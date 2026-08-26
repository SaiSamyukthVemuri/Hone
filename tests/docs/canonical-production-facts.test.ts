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

/** Paths whose change means the deployed RUNTIME changed. */
const RUNTIME_PATHS = [
  "app", "lib", "components", "supabase", "scripts",
  "middleware.ts", "next.config.ts", "vercel.json",
  "package.json", "package-lock.json", "tsconfig.json",
];

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

/** "next free / next migration number is 0186" — a derived fact, never prose. */
const NEXT_FREE_PATTERNS: readonly RegExp[] = [
  /\bnext\s+(?:free\s+)?migration\s+(?:number\s+)?(?:\bis\b|=|:)\s*\*{0,2}`?(0\d{3})\b/gi,
  /\bnext\s+free\s+(?:migration\s+)?number\s+(?:\bis\b|=|:)\s*\*{0,2}`?(0\d{3})\b/gi,
];

export const findCurrentMaxAssertions = (t: string) => matchAll(t, CURRENT_MAX_PATTERNS);
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
    // A line may legally NAME a total while labelling it as all-tenant.
    if (/\ball[\s-]tenants?\b|\bincludes?\s+synthetic\b|\bnot\s+a\s+customer\b/i.test(line)) {
      continue;
    }
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

  it("no CURRENT-state doc labels an all-tenant total as customer activity", () => {
    // Changelog rows excluded for the same reason as above: THEN-state history.
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      const hits = findSyntheticAsCustomer(currentProse(doc), [
        totals.clients,
        totals.appointments,
      ]);
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

  it("A3: nothing newer than the pinned SHA changes the runtime — the derivation, executed", () => {
    const pinned = pinnedRuntimeSha();
    if (!GIT_USABLE || !pinned) {
      expect(GIT_USABLE && !!pinned, "shallow clone or no git — A3 could not run").toBe(false);
      return;
    }
    const changed = git("diff", "--name-only", `${pinned}`, "HEAD", "--", ...RUNTIME_PATHS);
    const files = (changed ?? "").split("\n").filter(Boolean);
    expect(
      files,
      `current-state.md pins ${pinned.slice(0, 8)} as the runtime-bearing baseline, but ` +
        `${files.length} runtime file(s) have changed since it. Either the pin is stale, or this ` +
        "branch carries runtime changes it should not. This is the check the document's own " +
        '"verified mechanically, not asserted" sentence describes. Changed: ' +
        JSON.stringify(files.slice(0, 12)),
    ).toEqual([]);
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

/** PR numbers current-state.md declares OPEN. */
export function declaredOpenPrs(): string[] {
  return [...new Set([...openPrSection().matchAll(/#(\d{3,5})\b/g)].map((m) => m[1]))];
}

const SHIPPED_WORD = /\b(?:deployed|shipped|is live|in production|production[\s-]exercised|merged to production)\b/i;

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

  it("no canonical doc describes a declared-open PR as shipped", () => {
    const open = declaredOpenPrs();
    const excluded = openPrSection();
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      for (const line of currentProse(doc).split("\n")) {
        if (excluded.includes(line) && line.trim() !== "") continue;
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

  it("F-RET-001 is recorded as P1 and OPEN, in words, not just by absence of CLOSED", () => {
    const section = KNOWN_LIMITATIONS.slice(KNOWN_LIMITATIONS.indexOf("## L27"));
    expect(section, "L27 must state its severity").toMatch(/\*\*P1\b[^|]*OPEN\*\*|\*\*P1 — OPEN\.\*\*/i);
    expect(
      section.slice(0, section.indexOf("\n## ") === -1 ? undefined : section.indexOf("\n## ")),
      "L27 must state that this reconciliation did not close, narrow or downgrade it",
    ).toMatch(/remains OPEN and is not closed, narrowed or downgraded/i);
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
