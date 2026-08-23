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
