/**
 * The marketing truth register, enforced.
 *
 * FIVE RULES, AND NO RENDERING MODEL
 * ----------------------------------
 * Owner ruling, 2026-09-20, after the convergence-stop law fired twice. Two
 * predecessors asked "what does this React tree render", and each produced a
 * finding every round — never a repeat, always a different SYNTACTIC ROUTE from
 * text to a screen: nested JSX, JSX expressions, arrays of fragments, imported
 * values, imported components, props, spread props, metadata helpers,
 * re-exports, convention files. Enumerating routes cannot terminate, because
 * the route set is the grammar of two languages.
 *
 * That question is not asked here. Text reaching a visitor has exactly two
 * origins — a LITERAL in some file, or a VALUE from another file — and both are
 * closed without interpreting anything:
 *
 *   R1 CLOSURE     the transitive first-party import/re-export closure of the
 *                  marketing routes and the framework's convention files. A
 *                  module outside it cannot be reached from a route, so it
 *                  cannot render. This is what makes the boundary COMPLETE:
 *                  there is no "undeclared module" left to import from.
 *   R2 FRAGMENTS   every literal and JSX text run in that closure, judged
 *                  unfiltered.
 *   R3 ADJACENCY   those fragments joined per file in source order and judged
 *                  again, which catches a claim assembled from harmless pieces
 *                  with no notion of element, array, spread or hole.
 *   R4 FREEZE      the prose inventory, shrink-only. An authoring rule.
 *   R5 HOLES       the one surviving shape rule: a sentence whose middle comes
 *                  from another file, which R3 cannot join across.
 *
 * Provenance (git only) is unchanged from the version that already worked.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { migrationState } from "../migrations/helpers/migration-state";
import * as marketingContent from "@/lib/marketing/content";
import * as marketingResources from "@/lib/marketing/resources";
import {
  REPO_ROOT,
  forbiddenWordings,
  judgeAppendOnlyClaim,
  sanctionedAppendOnlyWordings,
  citedEvidenceFiles,
  foldForMatching,
  isWatched,
  publicRouteFiles,
} from "./helpers/register-provenance";
import {
  CANONICAL_COPY_MODULES,
  POLICY_SOURCES,
  CONVENTION_ROUTES,
  pageCopySources,
  seedFiles,
  marketingClosure,
  frozenSurface,
  resolveSpecifier,
  textFragments,
  adjacentText,
  copyInventory,
  isSubstantiveProse,
  incompleteClaimViolations,
  assertDeclaredExist,
  outsideMarketingScope,
  publicRouteEntryPoints,
  isConventionFilename,
  walkStrings,
  type CopyViolation,
} from "./helpers/copy-inventory";

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

const REGISTER = read("docs/marketing/product-truth-register.md");

const PRODUCTION_BRANCH = "claude/build-hone-saas-hOex7";

const FORBIDDEN = forbiddenWordings(REGISTER);

/**
 * A forbidden rule matched against text a BROWSER would render identically.
 *
 * `foldForMatching` exists for exactly this and was only being used by the
 * append-only judgement. `synthetic‑twin` written with U+2011 renders as
 * `synthetic-twin` and walks straight through `synthetic[- ]twin` — and the
 * canonical modules, where such a value would live, are exempt from the freeze,
 * so nothing else would have caught it either.
 */
/**
 * A joined reading split into sentences.
 *
 * The append-only rules are an exact-match allow-list over a complete claim, so
 * they cannot be given a whole-file join: every file containing a sanctioned
 * sentence would read as unsanctioned the moment anything else was joined to it.
 * A sentence is the unit those rules were written for, and splitting on terminal
 * punctuation is text work with no notion of markup.
 */
const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

const forbiddenHits = (text: string): string[] => {
  const folded = foldForMatching(text);
  return FORBIDDEN.filter((rule) => rule.pattern.test(folded)).map((rule) => rule.id);
};
const SANCTIONED = sanctionedAppendOnlyWordings(REGISTER);

const CLOSURE = marketingClosure();
const FROZEN = frozenSurface();

/**
 * The one place sentence-splitting cannot separate a heading from the claim
 * below it: `Traceability and logs` has no terminal punctuation, so it merges
 * into the sanctioned sentence that follows and the pair reads as unsanctioned.
 *
 * Declared as an artefact of the SPLIT rather than a claim anybody made — the
 * sanctioned sentence itself is judged on its own by R2 and passes there.
 */
const APPEND_ONLY_JOIN_BASELINE = ["app/features/charting-records/page.tsx: Traceability and logs"];

/** R2. Every fragment the closure contains, plus the copy modules by value. */
const FRAGMENTS = [
  ...CLOSURE.flatMap((f) => textFragments(f)),
  // And by VALUE, which proves the static and runtime readings agree for a
  // plain data module.
  ...walkStrings(marketingContent),
  ...walkStrings(marketingResources),
];

/** R3. Each file's fragments as one string, for the phrase rules only. */
const ADJACENT = CLOSURE.flatMap((f) => adjacentText(f).map((text) => ({ file: f, text })));

/** The production head the register declares it was verified against. */
function declaredHead(): string {
  const m = REGISTER.match(/Built against production head \| `([0-9a-f]{40})`/);
  return m ? m[1] : "";
}

/**
 * The production head the register says it last COMPARED itself against.
 *
 * Distinct from the build head on purpose. Production moves for reasons that
 * have nothing to do with marketing copy, and bumping the build head each time
 * would claim a re-derivation nobody performed — the exact defect this register
 * exists to prevent.
 */
function checkedProductionHead(): string {
  const m = REGISTER.match(/Production head at last check \| `([0-9a-f]{40})`/);
  return m ? m[1] : "";
}

type Fixture = {
  inventory: Record<string, string[]>;
  exceptions: string[];
  outsideScope: string[];
};

const INVENTORY_PATH = "tests/docs/fixtures/copy-inventory.json";
// LET, not const: the regeneration block rewrites the file and the rest of this
// run must see what it wrote. Parsed once and never refreshed, the documented
// command could not complete — it updated the JSON and then failed its own
// equality assertions against the object it had replaced.
let INVENTORY = JSON.parse(read(INVENTORY_PATH)) as Fixture;

const currentInventory = (): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const file of FROZEN) {
    const items = copyInventory(file);
    if (items.length) out[file] = items;
  }
  return out;
};

const currentExceptions = (): CopyViolation[] =>
  CLOSURE.flatMap((f) => incompleteClaimViolations(f));

if (process.env.MARKETING_INVENTORY === "write") {
  const inventory = currentInventory();
  const exceptions = currentExceptions().map((v) => `${v.rule} ${v.file} ${v.detail}`).sort();
  // FILE-QUALIFIED AND WITH MULTIPLICITY, in BOTH halves. Flattening entries
  // into one set of text meant moving an existing sentence to another page, or
  // repeating it in the same file, counted as no addition at all; checking only
  // the inventory meant the exception list could be replaced wholesale.
  const additions = (current: string[], recorded: string[]): string[] => {
    const left = new Map<string, number>();
    for (const item of recorded) left.set(item, (left.get(item) ?? 0) + 1);
    const added: string[] = [];
    for (const item of current) {
      const remaining = left.get(item) ?? 0;
      if (remaining === 0) added.push(item);
      else left.set(item, remaining - 1);
    }
    return added;
  };
  const qualify = (entries: Record<string, string[]>): string[] =>
    Object.entries(entries).flatMap(([f, items]) => items.map((item) => `${f} :: ${item}`));
  const added = [
    ...additions(qualify(inventory), qualify(INVENTORY.inventory)),
    ...additions(exceptions, INVENTORY.exceptions),
  ];
  if (added.length) {
    throw new Error(
      `regeneration refuses ADDITIONS; ${added.length} new item(s) would be admitted ` +
        "without review, starting with: " +
        JSON.stringify(added.slice(0, 3)),
    );
  }
  writeFileSync(
    join(REPO_ROOT, INVENTORY_PATH),
    JSON.stringify(
      { inventory, exceptions, outsideScope: outsideMarketingScope() },
      null,
      2,
    ) + "\n",
  );
  INVENTORY = JSON.parse(read(INVENTORY_PATH)) as Fixture;
}

describe("R1. the boundary is CLOSED, not enumerated", () => {
  it("the closure is the transitive reach of the routes and the conventions", () => {
    // The step both predecessors refused. They followed imports one level, then
    // two, then argued about `.ts` versus `.tsx`, because every file they
    // admitted had to carry a frozen prose baseline. It is affordable here
    // because the closure feeds JUDGEMENT, which has no per-file baseline.
    expect(CLOSURE.length).toBeGreaterThan(40);
    expect(CLOSURE.length).toBeLessThan(200);
    for (const seed of seedFiles()) expect(CLOSURE).toContain(seed);
    assertDeclaredExist(CLOSURE);
  });

  it("the closure is closed: every first-party import of a member is a member", () => {
    // THE COMPLETENESS PROPERTY, asserted directly rather than argued. If this
    // holds, a value rendered by a marketing route came from a module in the
    // closure — so every literal it can produce is judged by R2, whatever syntax
    // carried it there. All ten bypass families reduce to this one line.
    const members = new Set(CLOSURE);
    const escapes: string[] = [];
    for (const file of CLOSURE) {
      const source = read(file);
      for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const resolved = resolveSpecifier(match[1], file);
        if (resolved !== null && !members.has(resolved)) escapes.push(`${file} -> ${resolved}`);
      }
    }
    expect(escapes, "a marketing module reaches a first-party module outside the closure").toEqual([]);
  });

  it("the authenticated application is NOT in the closure", () => {
    // The boundary has to be a boundary in both directions, or "closed" is just
    // "everything".
    expect(CLOSURE.filter((f) => f.startsWith("app/(app)/"))).toEqual([]);
    expect(CLOSURE.filter((f) => f.includes("/(app)/"))).toEqual([]);
  });

  it("the seeds are the registry plus the framework's own conventions", () => {
    // Next wires these from their FILENAME, so no import names them and no
    // registry lists them; `app/opengraph-image.tsx` renders the card every
    // social preview shows. Seeds, not special cases: what they import follows
    // by closure like any route.
    expect(pageCopySources().sort()).toEqual(
      publicRouteFiles().filter((f) => !POLICY_SOURCES.includes(f)).sort(),
    );
    for (const convention of CONVENTION_ROUTES) {
      if (existsSync(join(REPO_ROOT, convention))) expect(CLOSURE).toContain(convention);
    }
    expect(CLOSURE).toContain("app/opengraph-image.tsx");
  });

  it("every public route is either inside the closure or declared outside it", () => {
    // THE SEED COMPLETENESS PROPERTY. A closure is only as complete as what it
    // starts from, and the seeds come from a registry a person maintains — so
    // the routes it does NOT reach are frozen too. A new public page is then
    // either registered as marketing, in which case closure covers it, or it
    // shows up here and somebody decides. What cannot happen is a public route
    // quietly belonging to neither.
    //
    // The 32 recorded today are the booking journey, the admin console and the
    // API handlers: public, but product surfaces rather than marketing ones.
    // That is a scope limit of the register, and it is declared rather than
    // assumed.
    expect(outsideMarketingScope()).toEqual(INVENTORY.outsideScope);
    const closure = new Set(CLOSURE);
    const unaccounted = publicRouteEntryPoints().filter(
      (f) => !closure.has(f) && !INVENTORY.outsideScope.includes(f),
    );
    expect(unaccounted, "a public route belongs to neither the closure nor the declared scope limit").toEqual([]);
    // Non-vacuous: the two sets really do partition the public routes.
    expect(INVENTORY.outsideScope.length).toBeGreaterThan(20);
    expect(publicRouteEntryPoints().length).toBe(
      publicRouteEntryPoints().filter((f) => closure.has(f)).length + INVENTORY.outsideScope.length,
    );
  });

  it("the canonical copy modules are judged but not frozen", () => {
    for (const module of CANONICAL_COPY_MODULES) {
      expect(CLOSURE).toContain(module);
      expect(FROZEN).not.toContain(module);
    }
  });
});

describe("truth register: provenance is declared, not assumed", () => {
  // WHAT A SHALLOW CLONE CAN AND CANNOT PROVE
  // -----------------------------------------
  // CI's validate lane checks out at depth 1. An ANCESTOR commit is simply not
  // an object there: `git cat-file -e` returns 128 and `merge-base` cannot
  // answer. That is not a stale register, it is a truncated clone, and failing
  // on it is a false red — the first version of this guard did exactly that and
  // reported "declares head a946a983…, which is not a commit in this
  // repository" on a register that was correct.
  //
  // The fix is NOT to soften the check to a shape match everywhere. Absence is
  // excused only where absence is EXPLAINED: the tests below establish whether
  // the object is present, and if it is not, the clone being shallow is
  // asserted as the reason. In a full clone — every developer machine,
  // `verify:prepush`, any lane that fetches history — absence is a hard
  // failure, and the ancestry checks below are strictly stronger than the ones
  // this guard shipped with.
  //
  // This repo has been bitten by the converse too: history-derived docs rules
  // that silently never executed in CI. So the skip is an explicit, visible
  // assertion about the clone rather than an early `return` that looks green.
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  const gitOk = (args: string[]) => git(args).status === 0;

  const shallowClone = (): boolean =>
    git(["rev-parse", "--is-shallow-repository"]).stdout?.trim() === "true";

  /**
   * A remote-tracking ref is only as fresh as the last fetch.
   *
   * `origin/<production>` exists in any full clone and can lag production by
   * weeks, so the comparison below ran against a cached commit and stayed green
   * while production moved over the cited evidence. Nothing in the test or in
   * `verify:prepush` fetched.
   *
   * ONLY IN A FULL CLONE, deliberately. Fetching here would also arm the
   * comparison in CI's depth-1 checkouts, and the skip below records that
   * arming it is an operator decision about repo-wide CI rather than one a docs
   * lane takes on its own. This changes nothing about where the guard runs; it
   * makes the data it runs on current.
   */
  let refreshed: boolean | undefined;
  const refreshProductionRef = (): boolean => {
    if (refreshed === undefined) {
      refreshed =
        shallowClone() ||
        gitOk([
          "fetch",
          "--quiet",
          "--no-tags",
          "origin",
          `+refs/heads/${PRODUCTION_BRANCH}:refs/remotes/origin/${PRODUCTION_BRANCH}`,
        ]);
    }
    return refreshed;
  };

  const headObjectPresent = (): boolean =>
    gitOk(["cat-file", "-e", `${declaredHead()}^{commit}`]);

  /**
   * Files the register rests on that changed across a range.
   *
   * The watch set is the DECLARED copy sources plus §0's OWN citations, so a row
   * that starts resting on a new file starts watching it. Production may run
   * ahead freely — it may not run over the evidence without §0 being re-derived.
   *
   * It used to be the transitively-discovered import graph. Narrowing it to the
   * declared sources is the same change as everywhere else in this commit: the
   * scan's universe is stated, not inferred.
   */
  const WATCHED = [
    ...pageCopySources(),
    ...POLICY_SOURCES,
    ...CANONICAL_COPY_MODULES,
    // The whole declared surface, not just the routes. It feeds `JUDGED` and
    // the frozen inventory, so production could put unsupported copy in
    // `SiteFooter` while this branch still holds the old text: the diff
    // intersection would be empty and the local judgement would only ever
    // inspect what is here.
    ...CLOSURE,
    ...citedEvidenceFiles(REGISTER),
  ];
  // `--no-renames` is load-bearing. With rename detection on — Git's default —
  // a 100% rename emits ONLY the destination path, so renaming a cited file
  // away produced a diff in which the cited path never appears and the filter
  // found no evidence change. Turning detection off makes a rename what it
  // physically is here: a delete of the old path and an add of the new one, so
  // the citation the register actually names is the one that shows up.
  const evidenceTouchedBetween = (from: string, to: string): string[] =>
    git(["diff", "--no-renames", "--name-only", `${from}..${to}`])
      .stdout.split("\n")
      .map((l) => l.trim())
      .filter((f) => f && isWatched(f, WATCHED));

  it("names the production head it was built against, as a full SHA", () => {
    expect(
      declaredHead(),
      "the register must declare the 40-character production head it was verified against",
    ).toMatch(/^[0-9a-f]{40}$/);
  });

  it("records HOW that head was resolved, naming the production branch", () => {
    // A bare SHA is a number somebody typed. The row has to say which ref it
    // came from, so the declaration is a derivation record rather than an
    // assertion — and so a reader can re-run it.
    expect(
      REGISTER,
      `the provenance table must name ${PRODUCTION_BRANCH} as the ref the head was resolved from`,
    ).toMatch(
      new RegExp(`Head resolved \\|[^|\\n]*${PRODUCTION_BRANCH.replace("/", "\\/")}`),
    );
  });

  it("the declared head is a commit that actually exists in this repository", () => {
    if (headObjectPresent()) return;
    // The object is not here. That is acceptable ONLY because the clone cannot
    // hold it — which is a fact about the checkout, asserted, not assumed.
    expect(
      shallowClone(),
      `the register declares head ${declaredHead()}, which is not a commit in this repository ` +
        "and this clone is NOT shallow — the declared provenance is wrong, not truncated",
    ).toBe(true);
  });

  it("the declared head is an ancestor of the branch under test", () => {
    if (!headObjectPresent()) {
      expect(
        shallowClone(),
        "ancestry is unprovable here and the clone is not shallow",
      ).toBe(true);
      return;
    }
    expect(
      gitOk(["merge-base", "--is-ancestor", declaredHead(), "HEAD"]),
      `the register declares head ${declaredHead()}, which is not an ancestor of HEAD`,
    ).toBe(true);
  });

  it("the declared head is an ancestor of production, where production is fetched", () => {
    // Stronger than ancestry-of-HEAD, and newly enforced: it catches a head
    // that exists on this branch but was never on the production line. Gated on
    // the ref being present, because a depth-1 PR checkout has no remote
    // branches at all.
    if (!headObjectPresent()) return;
    if (!gitOk(["rev-parse", "--verify", `origin/${PRODUCTION_BRANCH}`])) return;
    expect(
      gitOk([
        "merge-base",
        "--is-ancestor",
        declaredHead(),
        `origin/${PRODUCTION_BRANCH}`,
      ]),
      `the register declares head ${declaredHead()}, which is not an ancestor of origin/${PRODUCTION_BRANCH}`,
    ).toBe(true);
  });

  it("the build head is not ahead of the production head it was compared against", () => {
    // The register records two heads: what §0 was derived at, and how far
    // production had run when that was last checked. The first must never be
    // ahead of the second, or the register is classifying code production has
    // not got.
    expect(
      checkedProductionHead(),
      "the register must record the production head it was last compared against",
    ).toMatch(/^[0-9a-f]{40}$/);
    if (!headObjectPresent()) return;
    if (!gitOk(["cat-file", "-e", `${checkedProductionHead()}^{commit}`])) {
      expect(
        shallowClone(),
        `the register names production head ${checkedProductionHead()}, which is not a commit here and this clone is NOT shallow`,
      ).toBe(true);
      return;
    }
    expect(
      gitOk([
        "merge-base",
        "--is-ancestor",
        declaredHead(),
        checkedProductionHead(),
      ]),
      `the register's build head ${declaredHead()} is not an ancestor of the production head it claims to have been checked against, ${checkedProductionHead()}`,
    ).toBe(true);
  });

  it("every file the judgement reads is watched for production drift", () => {
    // The watch set decides which production changes can make the register
    // stale, so anything the corpus READS but the set omits is a blind spot:
    // production could put unsupported copy in `SiteFooter` while this branch
    // keeps the old text, the diff intersection would be empty, and the local
    // judgement would only ever inspect what is here.
    const judged = [
      ...pageCopySources(),
      ...POLICY_SOURCES,
      ...CANONICAL_COPY_MODULES,
      ...CLOSURE,
    ];
    expect(judged.length).toBeGreaterThan(30);
    expect(judged.filter((f) => !isWatched(f, WATCHED))).toEqual([]);
  });

  it("nothing the register rests on has changed since the head it was checked against", () => {
    // Review's objection was exact: the row records a HISTORICAL value, and
    // ancestry to it says nothing about where production is now. Production
    // could move past it — over the very files §0 cites — and this guard would
    // stay green indefinitely.
    //
    // Requiring the row to EQUAL the live production ref would be the wrong
    // repair: it reds every branch the moment anything merges, which is how
    // canonical-production-facts came to carry three permanent failures. So the
    // check is on the DIFF, not the distance. Production may run ahead freely;
    // it may not run over the evidence without the register being re-derived.
    // Current, or not compared at all. A stale cached ref is worse than no
    // comparison: it looks like evidence.
    if (!refreshProductionRef()) {
      expect(
        shallowClone(),
        `origin/${PRODUCTION_BRANCH} could not be fetched and this clone is NOT shallow — ` +
          "the comparison would run against a cached ref of unknown age, which looks like " +
          "evidence and is not",
      ).toBe(true);
      return;
    }
    // Pins the refresh to THIS test rather than to a helper nobody calls:
    // delete the guard above and `refreshed` stays undefined.
    expect(
      refreshed,
      "the production ref was compared without being refreshed",
    ).toBe(true);
    if (!gitOk(["rev-parse", "--verify", `origin/${PRODUCTION_BRANCH}`])) {
      // WHERE THIS RUNS, AND WHERE IT DOES NOT. A depth-1 PR checkout has no
      // remote branches at all, so this comparison cannot run in CI's validate
      // lane - nor in nightly, whose checkout is also depth-1. It runs on every
      // developer machine and in `npm run verify:prepush`, which CLAUDE.md
      // requires before every push.
      //
      // That gap is REAL and is not papered over: arming it needs a fetch step
      // in `.github/workflows/ci.yml`, which is a workflow change, which puts
      // any PR carrying it into the full matrix. That is an operator decision
      // about repo-wide CI, not something a docs lane should take on its own,
      // so the skip asserts its own reason rather than returning green in
      // silence. See MARKETING-01a-FOLLOWUP in the register.
      expect(
        shallowClone(),
        `origin/${PRODUCTION_BRANCH} is not fetched and this clone is NOT shallow — ` +
          "fetch it, or the live-production comparison silently does not run",
      ).toBe(true);
      return;
    }
    const checked = checkedProductionHead();
    if (!gitOk(["cat-file", "-e", `${checked}^{commit}`])) {
      expect(
        shallowClone(),
        `the register names production head ${checked}, which is not a commit here and this clone is NOT shallow`,
      ).toBe(true);
      return;
    }
    const live = git(["rev-parse", `origin/${PRODUCTION_BRANCH}`]).stdout.trim();
    const touched = evidenceTouchedBetween(checked, live);
    expect(
      touched,
      `production has moved from ${checked} to ${live} and has changed ${touched.length} file(s) this register rests on. ` +
        "§0 must be re-derived against the new head and the provenance rows updated in the same change — " +
        "the classification no longer describes the code production runs",
    ).toEqual([]);
  });

  it("a branch that changes cited evidence re-derives the register in the same change", () => {
    // Both existing comparisons look at PRODUCTION: checked-head to live head.
    // Neither endpoint includes THIS branch, so a PR editing a watched evidence
    // file — `lib/sessions/before-today.ts`, say — left `touched` empty and the
    // documented invariant unenforced. The register's own rule is that a change
    // touching cited evidence re-derives the affected rows in the same change,
    // and that is checkable here: the diff of this branch against the head the
    // register was built on.
    if (!headObjectPresent()) {
      expect(shallowClone(), "the declared head is absent and this clone is NOT shallow").toBe(true);
      return;
    }
    const changedBetween = (from: string, to: string): string[] =>
      git(["diff", "--no-renames", "--name-only", `${from}..${to}`])
        .stdout.split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

    const touched = evidenceTouchedBetween(declaredHead(), "HEAD");
    if (touched.length > 0) {
      expect(
        changedBetween(declaredHead(), "HEAD"),
        `this branch changes ${touched.length} file(s) the register cites (${touched.join(", ")}) ` +
          "without re-deriving it; §0 and the provenance rows must move in the same change",
      ).toContain("docs/marketing/product-truth-register.md");
    }

    // NON-VACUITY, because the arm above is inert whenever a branch happens to
    // touch no cited file — which is the common case and is exactly how a rule
    // comes to look armed while testing nothing. This repo has been bitten by
    // history-derived checks that silently never ran, so the machinery is proven
    // on a range that DID move evidence rather than assumed from a quiet branch.
    const before = "a1639a84e33c0aed618c41ab63f589f7cb33678a";
    const after = "25c066abaaa8a64e16952371ec4db28c85904d2c";
    if (!gitOk(["cat-file", "-e", `${before}^{commit}`])) return;
    expect(
      evidenceTouchedBetween(before, after).length,
      "the branch-side comparison cannot see a change to cited evidence at all",
    ).toBeGreaterThan(0);
    expect(changedBetween(before, after).length).toBeGreaterThan(0);
  });

  it("the same comparison re-proves the register's own claim, and is not vacuous", () => {
    // The check above is silent whenever production happens to sit exactly on
    // the checked head, which is the common case on a fresh branch and would
    // make it look armed while testing nothing. These two run unconditionally.
    if (!gitOk(["rev-parse", "--verify", `origin/${PRODUCTION_BRANCH}`])) return;
    if (!headObjectPresent()) return;

    // 1. The register's prose says production has advanced past the BUILD head
    //    without touching anything §0 cites. That is now re-derived, not read.
    expect(
      evidenceTouchedBetween(declaredHead(), `origin/${PRODUCTION_BRANCH}`),
      "the register claims nothing it rests on moved since the build head; the diff disagrees",
    ).toEqual([]);

    // 2. A range that DID touch the evidence must come back non-empty, or the
    //    comparison above is passing because it can never see anything.
    const before = "a1639a84e33c0aed618c41ab63f589f7cb33678a";
    const after = "25c066abaaa8a64e16952371ec4db28c85904d2c";
    if (!gitOk(["cat-file", "-e", `${before}^{commit}`])) return;
    expect(
      evidenceTouchedBetween(before, after).length,
      "a production range that changed app/page.tsx and lib/export/resource-registry.ts registered as touching no evidence",
    ).toBeGreaterThan(0);
  });

  it("a renamed cited file still shows up as an evidence change", () => {
    // Git's default rename detection emits only the DESTINATION path, so
    // renaming a cited file away produced a diff in which the cited path never
    // appeared and the comparison reported no evidence change. Proved on a real
    // rename in this repository's history: `app/_fonts/` arrived by renaming
    // files, and with detection ON the old paths vanish from the listing.
    if (!headObjectPresent()) return;
    const renameCommit = git([
      "log",
      "--diff-filter=R",
      "--format=%H",
      "-1",
      "--find-renames",
      declaredHead(),
    ]).stdout.trim();
    if (!renameCommit) return;
    const withDetection = git([
      "diff",
      "--name-only",
      `${renameCommit}~1..${renameCommit}`,
    ]).stdout.trim().split("\n").filter(Boolean);
    const withoutDetection = git([
      "diff",
      "--no-renames",
      "--name-only",
      `${renameCommit}~1..${renameCommit}`,
    ]).stdout.trim().split("\n").filter(Boolean);
    expect(
      withoutDetection.length,
      `${renameCommit} is a rename commit, but --no-renames listed no more paths than rename detection did; the flag is not doing what this guard relies on`,
    ).toBeGreaterThan(withDetection.length);
  });

  it("the evidence it watches is derived from the register's own citations", () => {
    // Guard the guard above: if the citation scrape silently returned nothing,
    // the diff check would pass on any production move at all.
    const cited = citedEvidenceFiles(REGISTER);
    expect(cited.length, "no §0 evidence citation resolved to a real file").toBeGreaterThan(5);
    for (const file of [
      "lib/sessions/before-today.ts",
      "lib/dashboard/missing-records-assistant.ts",
      "app/features/charting-records/page.tsx",
    ]) {
      expect(cited, `${file} is cited by §0 but is not watched`).toContain(file);
    }
  });

  it("a well-formed but fabricated head is rejected by the object check", () => {
    // Negative control for the check above. Review's objection to the original
    // was that it accepted any 40 hex characters, so a fabricated SHA passed
    // both it and the staleness check. This proves the difference: the shape
    // test accepts this value and the object test does not.
    const fabricated = `${"0".repeat(39)}1`;
    expect(fabricated).toMatch(/^[0-9a-f]{40}$/);
    expect(
      gitOk(["cat-file", "-e", `${fabricated}^{commit}`]),
      "a non-existent commit passed `git cat-file -e`; the existence check proves nothing",
    ).toBe(false);
  });

  it("does not still claim the superseded head", () => {
    // The stale revision declared `325b124` / migration max 0133 in its header.
    // It may be NAMED as superseded; it may not be the declared build head.
    expect(REGISTER).not.toMatch(/Built against production head \| `325b124/);
  });

  it("records which copy deck revision it classifies", () => {
    expect(REGISTER).toMatch(/hone-marketing-copy-deck-v2-2\.md/);
  });
});

describe("truth register: migration state is DERIVED, never hand-typed", () => {
  const state = migrationState();

  it("the declared repository migration max equals the derived one", () => {
    const m = REGISTER.match(/Repository migration max \| \*\*(\d{4})\*\*/);
    expect(m, "the register must state a repository migration max").not.toBeNull();
    expect(
      m![1],
      "register repo max has drifted from supabase/migrations; re-derive it with `npm run migration:state -- --json`",
    ).toBe(state.repo_migration_max);
  });

  it("the declared hosted migration max equals the canonical declaration", () => {
    const m = REGISTER.match(/Hosted migration max \| \*\*(\d{4})\*\*/);
    expect(m, "the register must state a hosted migration max").not.toBeNull();
    expect(
      m![1],
      "register hosted max has drifted from docs/production/migration-state.json, which is the ONLY place hosted state is declared",
    ).toBe(state.hosted_migration_max);
  });

  it("states repo/hosted parity consistently with the derived state", () => {
    const claimsParity = /Repo\/hosted parity \| yes/.test(REGISTER);
    expect(
      claimsParity,
      `register claims parity=${claimsParity} but derived repo_equals_hosted=${state.repo_equals_hosted}`,
    ).toBe(state.repo_equals_hosted);
  });
});

describe("truth register: the operative section is present and well-formed", () => {
  it("carries the operative v2.2 classification section", () => {
    expect(REGISTER).toMatch(/## 0\. v2\.2 copy-deck claim classification — OPERATIVE/);
  });

  it("defines every classification status it uses", () => {
    for (const status of [
      "VERIFIED_CURRENT",
      "VERIFIED_WITH_QUALIFIER",
      "NOT_CURRENTLY_SUPPORTABLE",
      "NEEDS_EXTERNAL_DECISION",
      "NEEDS_CUSTOMER_EVIDENCE",
    ]) {
      expect(REGISTER, `status ${status} must be defined in §0`).toMatch(
        new RegExp(`\`${status}\``),
      );
    }
  });

  it("states that code wins over the register", () => {
    expect(REGISTER).toMatch(/code wins/i);
  });

  it("states that a database capability is not a public product capability", () => {
    expect(REGISTER).toMatch(
      /database capability is not a public product capability/i,
    );
  });
});

describe("the register's cited evidence stays watched", () => {
  it("keeps watching a cited file whose extension no list would guess", () => {
    // §0's V13 row cites `.env.local.example`. An extension list dropped it;
    // falling back to "does it exist" dropped it again the moment production
    // deleted it, which is exactly the change the comparison must report. Both
    // halves are pinned here: it is watched today, AND it stays watched when
    // the citation names something no longer on disk.
    const cited = citedEvidenceFiles(REGISTER);
    expect(cited, ".env.local.example is cited by §0 but is not watched").toContain(
      ".env.local.example",
    );
    expect(cited).toContain("package.json");

    // Both a multi-component name and a plain one-component dotfile. The first
    // shape regex consumed the leading dot and then REQUIRED another component,
    // so `.env`, `.npmrc` and `.gitignore` failed it - and a deleted one fell
    // out of the watch set exactly as before.
    for (const deleted of [".env.local.example.gone", ".npmrc", ".gitignore-gone"]) {
      expect(existsSync(join(REPO_ROOT, deleted))).toBe(false);
      const afterDeletion = citedEvidenceFiles(
        REGISTER.replace("`.env.local.example`", `\`${deleted}\``),
      );
      expect(
        afterDeletion,
        `${deleted}: a cited dotfile that production deleted fell out of the watch set, so its deletion could never be reported`,
      ).toContain(deleted);
    }
  });

  it("keeps watching a cited path that production deleted or renamed", () => {
    // Filtering citations through the working tree dropped exactly the change
    // this must catch: a file §0 cites, deleted upstream, is absent from the
    // branch carrying that deletion, so it fell out of the watch set and the
    // deletion `git diff` reports matched nothing. Classification is by SHAPE
    // now, so a cited path stays watched whether or not it exists today.
    const invented = "lib/record-keeping/a-file-that-does-not-exist.ts";
    expect(existsSync(join(REPO_ROOT, invented))).toBe(false);
    const cited = citedEvidenceFiles(
      REGISTER.replace(
        "`lib/record-keeping/expiry.ts`",
        `\`${invented}\``,
      ),
    );
    expect(
      cited,
      "a cited file that no longer exists was dropped from the watch set",
    ).toContain(invented);
  });

  it("rejects prose tokens that are not paths at all", () => {
    // The counterweight: dropping the existence filter must not let §0's prose
    // - column names, status labels, enum values - into the watch set.
    const cited = citedEvidenceFiles(REGISTER);
    for (const token of [
      "probe_lot_number",
      "VERIFIED_CURRENT",
      "apilus_modality",
      "machine_frequency",
    ]) {
      expect(cited, `${token} is prose, not a path`).not.toContain(token);
    }
  });

  it("watches a cited directory by prefix, not by equality", () => {
    // `git diff --name-only` returns `lib/record-keeping/expiry.ts`, never the
    // bare directory, so reducing a `lib/record-keeping/**` citation to
    // `lib/record-keeping` and comparing for equality watched nothing.
    const cited = citedEvidenceFiles(REGISTER);
    const dirs = cited.filter((c) => c.endsWith("/"));
    expect(dirs.length, "§0 cites directory globs; none survived").toBeGreaterThan(0);
    for (const dir of dirs) {
      expect(
        isWatched(`${dir}some-new-file.ts`, cited),
        `${dir} does not match its own descendants`,
      ).toBe(true);
    }
    // A bare top-level directory is prose, not evidence: §0 says "across
    // `app/` + `lib/`", and watching whole trees would red on every production
    // merge - the failure this guard exists to avoid.
    for (const coarse of ["app/", "lib/", "components/"]) {
      expect(cited, `${coarse} is too coarse to be evidence`).not.toContain(coarse);
    }
    expect(isWatched("components/ui/button.tsx", cited)).toBe(false);
    expect(isWatched("components/before-today-card.tsx", cited)).toBe(true);
  });
});

describe("R2. JUDGEMENT: every fragment in the closure, against the register", () => {
  it("the corpus is the whole closure, not a chosen part of it", () => {
    expect(FRAGMENTS.length).toBeGreaterThan(2000);
    expect(FRAGMENTS.join(" ¶ ")).toMatch(/electrolysis/i);
    // Non-vacuous at three different origins: a component, a page and the
    // framework's social card. A corpus covering only the copy modules would
    // pass a size check and miss all three.
    expect(FRAGMENTS).toContain("Treatment memory for electrologists.");
    expect(FRAGMENTS.some((c) => /\bprivacy policy\b/i.test(c))).toBe(true);
    expect(
      FRAGMENTS.some((c) => c.startsWith("Hone. Treatment memory for electrologists:")),
    ).toBe(true);
  });

  it("no forbidden wording appears anywhere in the closure", () => {
    const offenders = FRAGMENTS.flatMap((claim) =>
      forbiddenHits(claim).map((id) => `${id}: ${claim}`),
    );
    expect(offenders, "public copy carries wording the register forbids").toEqual([]);
  });

  it("every append-only claim is one the register sanctions", () => {
    // Judged on COMPLETE VALUES only, never on joined text. These rules are an
    // exact-match allow-list, so a joined window is not a claim: judging R3's
    // output here reported nine sanctioned sentences as unsanctioned purely for
    // having a heading in front of them.
    const verdicts = FRAGMENTS.map((c) => ({ c, v: judgeAppendOnlyClaim(c, SANCTIONED) })).filter(
      ({ v }) => v.kind === "unsanctioned",
    );
    expect(
      verdicts.map(({ c }) => c),
      "an append-only promise is made that §0.4 N1 does not support",
    ).toEqual([]);
  });

  it("judgement has NO length or prose gate", () => {
    // Four plain words, no terminal punctuation, below every authoring
    // threshold — and the exact wording that escaped the first architecture.
    const probe = "export const A = () => <p>Every change is tracked</p>;";
    expect(copyInventory("app/probe/page.tsx", probe)).toEqual([]);
    expect(
      textFragments("app/probe/page.tsx", probe).some((t) => forbiddenHits(t).length > 0),
    ).toBe(true);
  });
});

describe("R3. ADJACENCY: a claim assembled from harmless pieces", () => {
  it("no file's fragments join into forbidden wording", () => {
    const offenders = ADJACENT.flatMap(({ file, text }) =>
      forbiddenHits(text).map((id) => `${file}: ${id}`),
    );
    expect(
      offenders,
      "text that is harmless fragment by fragment renders as wording the register forbids",
    ).toEqual([]);
  });

  it("an append-only promise split across fragments is judged too", () => {
    // R3 applied only the forbidden phrases, so a trigger split across fragments
    // bypassed the allow-list entirely: `['All disinfectant ', 'logs use an ',
    // 'append', '-', 'only timeline.']` renders an unsanctioned promise while
    // every fragment is harmless and below the inventory threshold.
    //
    // At SENTENCE granularity, because these rules match a complete claim
    // exactly — handed a whole-file join, every file holding a sanctioned
    // sentence would read as unsanctioned.
    const offenders = ADJACENT.flatMap(({ file, text }) =>
      sentencesOf(text)
        .filter((sentence) => judgeAppendOnlyClaim(sentence, SANCTIONED).kind === "unsanctioned")
        .map((sentence) => `${file}: ${sentence}`),
    );
    expect(
      offenders.filter((o) => !APPEND_ONLY_JOIN_BASELINE.some((b) => o.startsWith(b))),
      "text that is harmless fragment by fragment renders an append-only promise §0.4 N1 does not support",
    ).toEqual([]);

    // POSITIVE CONTROL, because the assertion above is silent while the closure
    // is clean and would have shipped unpinned otherwise. This is the exact
    // shape the finding described: a trigger split across five fragments, every
    // one of them harmless and below the inventory threshold.
    const split = adjacentText(
      "app/probe/page.tsx",
      "export const A = () => <p>{[\"All disinfectant \", \"logs use an \", \"append\", \"-\", \"only timeline.\"]}</p>;",
    );
    expect(
      split.flatMap(sentencesOf).some((s) => judgeAppendOnlyClaim(s, SANCTIONED).kind === "unsanctioned"),
      "a split append-only trigger is not judged",
    ).toBe(true);
    // And a sanctioned sentence joined to a heading is NOT reported twice over:
    // it is judged whole by R2 and passes there.
    expect(
      judgeAppendOnlyClaim(
        "Trace a probe lot to the areas that recorded it, and keep sterile-item and disinfectant logs with lot numbers, expiry, and replace-by dates, with an append-only edit history.",
        SANCTIONED,
      ).kind,
    ).toBe("sanctioned");
  });

  it("the joined text is real, and longer than any single fragment", () => {
    const longest = ADJACENT.reduce((a, b) => (a.text.length > b.text.length ? a : b));
    expect(longest.text.length).toBeGreaterThan(1000);
    // THREE readings per file: rendered text space-joined, every fragment
    // space-joined, and rendered text with NOTHING between. They fail in
    // different directions — interleaving breaks a match, restricting to
    // rendered text loses the non-JSX cases, and a space where React renders
    // none breaks a hyphenated one — so the union is strictly more coverage
    // than any of them.
    expect(ADJACENT.length).toBe(CLOSURE.length * 3);
  });
});

describe("R4. FREEZE: prose outside the copy modules can only shrink", () => {
  it("the recorded inventory is exactly what the surface holds", () => {
    expect(currentInventory()).toEqual(INVENTORY.inventory);
  });

  it("no file gains prose, by identity rather than by count", () => {
    const known = new Set(Object.values(INVENTORY.inventory).flat());
    const unknown = FROZEN.flatMap((f) =>
      copyInventory(f).filter((item) => !known.has(item)).map((item) => `${f}: ${item}`),
    );
    expect(
      unknown,
      "new marketing copy was authored outside the canonical copy modules; " +
        "move it into lib/marketing/content.ts, where it is judged",
    ).toEqual([]);
    expect(known.size, "the recorded inventory is not empty").toBeGreaterThan(400);
    // Identities are recorded WHOLE, so a long line cannot be edited past a
    // truncation point while comparing equal.
    expect([...known].some((item) => item.length > 120)).toBe(true);
  });

  it("the inventory can only shrink, and shrinks by copy moving where it is judged", () => {
    const total = FROZEN.reduce((n, f) => n + copyInventory(f).length, 0);
    expect(total).toBeLessThanOrEqual(Object.values(INVENTORY.inventory).flat().length);
  });
});

describe("R5. HOLES: a sentence whose middle comes from another file", () => {
  it("the declared exceptions are recorded, by identity, and shrink-only", () => {
    // Pre-existing sentences with a value in the middle — `© {year} Hone.`,
    // `Published {date}` — which the owner ruling says are not to be moved.
    // Declaring them makes the cost of that ruling visible and shrink-only.
    const recorded = currentExceptions().map((v) => `${v.rule} ${v.file} ${v.detail}`).sort();
    expect(recorded).toEqual(INVENTORY.exceptions);
    expect(recorded.length, "holes in authored sentences grew").toBeLessThanOrEqual(13);
    // Two of the thirteen are `{PAYMENT_QUALIFIER} {REPLACES_STATEMENT}` on the
    // pricing page: two canonical copy values rendered as one run of text. Each
    // is judged on its own; what is not judged is the sentence they make
    // together, which is the whole reason the rule looks at this shape.
    expect(recorded.filter((r) => r.includes("app/pricing/page.tsx")).length).toBe(3);
  });
});

describe("NEGATIVE CONTROLS: each rule is red on the defect it claims to catch", () => {
  const probe = (body: string, head = "") => `${head}export const A = () => ${body};\n`;
  const joined = (src: string) =>
    adjacentText("app/probe/page.tsx", src).some((text) => forbiddenHits(text).length > 0);
  const incomplete = (body: string) =>
    incompleteClaimViolations("app/_components/marketing/P.tsx", probe(body)).map((v) => v.rule);

  // --- R3 replaces six shape rules. One control per family it retired. -------

  it("REFUSED — every composition family, by adjacency alone", () => {
    // Each of these needed its own rule in the previous architecture, and each
    // rule arrived one review round after the last. None of them is recognised
    // here: they are all adjacent authored strings in source order.
    const families: [string, string][] = [
      ["nested markup", "<p>Every change <strong>is tracked</strong></p>"],
      ["deeper nesting", "<p>Every <span><em><b>change is</b></em></span> tracked</p>"],
      ["a fragment", "<p>Every <>change is</> tracked</p>"],
      ["a literal array", '<p>{["Every change ", "is tracked"]}</p>'],
      ["JSX inside an expression", "<p>Every {<strong>change</strong>} is tracked</p>"],
      ["a literal in an expression", '<p>Every change {"is tracked"}</p>'],
    ];
    for (const [name, body] of families) {
      expect(joined(probe(body)), name).toBe(true);
    }
    // And outside JSX entirely, which used to be three more rules.
    for (const [name, src] of [
      ["concatenation", 'const s = "Every change" + " is tracked";'],
      ["a template", "const s = `Every change ${x} is tracked`;"],
      ["a join call", 'const s = ["Every change", "is tracked"].join(" ");'],
      ["a concat call", 'const s = "Every change".concat(" is tracked");'],
    ] as [string, string][]) {
      expect(joined(src), name).toBe(true);
    }
  });

  it("REFUSED — two values running together, which source order cannot join", () => {
    // Source order is not render order once literals are bound to names:
    // declaring `tail` before `head` and rendering `<p>{head} {tail}</p>` gives
    // the forbidden sentence while R3 joins the file as "is tracked Every
    // change". R5 catches the SHAPE instead of resolving the names.
    expect(incomplete("<p>{head} {tail}</p>")).toEqual([
      "copy/incomplete-claim",
      "copy/incomplete-claim",
    ]);
    expect(incomplete("<p>{head}{tail}</p>")).toEqual([
      "copy/incomplete-claim",
      "copy/incomplete-claim",
    ]);
  });

  it("REFUSED — a claim assembled by two adjacent COMPONENTS", () => {
    // Cross-module composition: `<p><Head /><Tail /></p>` renders the sentence
    // those two return while each module holds a harmless fragment and the
    // closure judges them separately. Recognised by JSX's own rule for what a
    // component is — a capital initial — not by a guess about what it does.
    expect(incomplete("<p><Head /><Tail /></p>")).toEqual(["copy/incomplete-claim"]);
    expect(incomplete("<p><Head /> <Tail /></p>")).toEqual(["copy/incomplete-claim"]);
    // Words on the same line as one component complete a sentence out of this
    // file and another.
    expect(incomplete("<p>Every <Head /> tracked</p>")).toEqual(["copy/incomplete-claim"]);
    // A component beside a hole is the same shape once more.
    expect(incomplete("<p><Head />{tail}</p>")).toEqual(["copy/incomplete-claim"]);
  });

  it("ACCEPTED — a lone component, and a lowercase element", () => {
    // Treating every component inside a text element as a hole flagged 436
    // places. What makes the rule affordable is the same whitespace rule as
    // everywhere else: only things running together on ONE rendered line.
    expect(incomplete("<p><Head /></p>")).toEqual([]);
    expect(incomplete("<div>\n  <Section />\n  <Section />\n</div>")).toEqual([]);
    expect(incomplete("<p><strong>Every change is tracked</strong></p>")).toEqual([]);
  });

  it("REFUSED — an attribute literal no longer pushes a sentence apart", () => {
    // Joining every literal in source order let a class name land between two
    // text runs: `<p>Every change <strong className="font-bold">is
    // tracked</strong></p>` joined as "Every change font-bold is tracked".
    expect(joined(probe('<p>Every change <strong className="font-bold">is tracked</strong></p>'))).toBe(true);
    expect(joined(probe('<p>Every change <strong className="a" id="b" style={{}}>is tracked</strong></p>'))).toBe(true);
  });

  it("REFUSED — a claim React renders with nothing between the parts", () => {
    // React puts no separator between children, so
    // `<p><span>synthetic</span>-<span>twin</span></p>` renders `synthetic-twin`
    // while a space-joined reading says `synthetic - twin` and matches no
    // pattern. Which separator is right depends on the markup, so both are read.
    expect(joined(probe("<p><span>synthetic</span>-<span>twin</span></p>"))).toBe(true);
    // And the space-joined reading still does its own job.
    expect(joined(probe("<p>Every change <strong>is tracked</strong></p>"))).toBe(true);
  });

  it("REFUSED — values adjacent inside ordinary lowercase wrappers", () => {
    // `<p><span>{head}</span><span>{tail}</span></p>` renders the sentence those
    // two hold, and a span is not a component — so opacity propagates through a
    // wrapper that carries nothing but a value.
    expect(incomplete("<p><span>{head}</span><span>{tail}</span></p>")).toEqual([
      "copy/incomplete-claim",
      "copy/incomplete-claim",
    ]);
  });

  it("ACCEPTED — a wrapper with words of its own, and wrappers on separate lines", () => {
    // A wrapper carrying authored words is a sentence in its own right, and its
    // text is already judged where it sits. Only a wrapper that merely passes a
    // value through is transparent.
    expect(incomplete("<p><span>Every change is tracked</span><span>{x}</span></p>")).toEqual([]);
    // But a wrapper that has words AND a value names BOTH values, because both
    // sit in the sentence a visitor reads. An earlier draft excluded such a
    // wrapper from transparency and named only the first.
    expect(incomplete("<p><span>Every {a}</span><span>{b}</span></p>")).toEqual([
      "copy/incomplete-claim",
      "copy/incomplete-claim",
    ]);
    expect(incomplete("<div>\n  <span>{head}</span>\n  <span>{tail}</span>\n</div>")).toEqual([]);
    expect(incomplete("<p><span>{head}</span></p>")).toEqual([]);
  });

  it("REFUSED — a claim computed into a single hole", () => {
    // `const claim = head + tail` rendered as `<p>{claim}</p>` presents one hole
    // with no authored words beside it, which reads as consumption — and R3
    // cannot join the literals because they sit behind `head` and `tail` in
    // whatever order those were declared.
    expect(
      incompleteClaimViolations(
        "app/_components/marketing/P.tsx",
        'const tail = "is tracked";\nconst head = "Every change ";\nconst claim = head + tail;\nexport const A = () => <p>{claim}</p>;\n',
      ).map((v) => v.rule),
    ).toEqual(["copy/incomplete-claim"]);
    // Every spelling of an assembly, and a template too.
    for (const initializer of [
      "head + tail",
      "`${head}${tail}`",
      '[head, tail].join(" ")',
      "head.concat(tail)",
    ]) {
      expect(
        incompleteClaimViolations(
          "app/_components/marketing/P.tsx",
          `const claim = ${initializer};\nexport const A = () => <p>{claim}</p>;\n`,
        ).map((v) => v.rule),
        initializer,
      ).toEqual(["copy/incomplete-claim"]);
    }
  });

  it("ACCEPTED — a hole naming a value that was written as one", () => {
    // The distinction is how the thing was AUTHORED, not what it holds. One
    // lookup, same file, by name: nothing is evaluated and nothing is followed
    // across a module.
    expect(
      incompleteClaimViolations(
        "app/_components/marketing/P.tsx",
        'const claim = "Every treated area keeps its own history.";\nexport const A = () => <p>{claim}</p>;\n',
      ),
    ).toEqual([]);
    expect(
      incompleteClaimViolations("app/_components/marketing/P.tsx", "export const A = () => <p>{children}</p>;\n"),
    ).toEqual([]);
  });

  it("the convention set knows the metadata files Next publishes", () => {
    // `manifest.ts` publishes application names and descriptions without being
    // imported. `sitemap` and `robots` join it for the same reason.
    for (const filename of ["manifest.ts", "sitemap.ts", "robots.ts"]) {
      expect(isConventionFilename(filename), filename).toBe(true);
    }
  });

  it("REFUSED — a JSON import that carries its own extension", () => {
    // The documented form. Appending to a specifier that already ends in
    // `.json` produced `copy.json.ts`, `copy.json.tsx` and `copy.json.json`, so
    // the import read as a package — and the previous control tested an
    // EXTENSIONLESS specifier, which masked exactly this.
    expect(resolveSpecifier("./fixtures/copy-inventory.json", "tests/docs/probe.ts")).toBe(
      "tests/docs/fixtures/copy-inventory.json",
    );
    expect(resolveSpecifier("@/tests/docs/fixtures/copy-inventory.json", "app/page.tsx")).toBe(
      "tests/docs/fixtures/copy-inventory.json",
    );
    expect(resolveSpecifier("./does-not-exist.json", "tests/docs/probe.ts")).toBe(null);
  });

  it("the route scan knows every filename Next renders without an import", () => {
    // `loading` was missing: Next shows `app/pricing/loading.tsx` during
    // navigation, so it is visitor-facing, and it was neither a closure seed nor
    // part of the scan — which meant even the outside-scope list did not move
    // when one appeared.
    for (const filename of [
      "page.tsx", "route.ts", "layout.tsx", "template.tsx", "default.tsx",
      "loading.tsx", "not-found.tsx", "error.tsx", "global-error.tsx",
      "forbidden.tsx", "unauthorized.tsx", "opengraph-image.tsx",
      "twitter-image.tsx", "apple-icon.tsx", "icon.tsx",
    ]) {
      expect(isConventionFilename(filename), `${filename} is rendered without an import`).toBe(true);
    }
    // And not everything, or "convention" would mean "every file".
    for (const ordinary of ["helpers.ts", "Button.tsx", "page.test.tsx", "loading.css"]) {
      expect(isConventionFilename(ordinary), ordinary).toBe(false);
    }
  });

  it("ACCEPTED — children on separate lines, which JSX does not run together", () => {
    // JSX DROPS a whitespace run containing a newline, so formatted children are
    // separate lines of a page rather than one sentence. Reading any two holes
    // as a claim instead flagged 118 places, nearly all of them a container
    // holding a header and a list.
    expect(incomplete("<div>\n  {header}\n  {list}\n</div>")).toEqual([]);
    expect(incomplete("<div>{children}</div>")).toEqual([]);
  });

  it("REFUSED — a JSON module is a local module, not a package", () => {
    // `resolveJsonModule` is enabled here, so `import copy from "./copy.json"`
    // is ordinary — and a resolver that only knew TypeScript returned null for
    // it, which reads as "a package" and dropped the file out of the closure
    // entirely.
    expect(resolveSpecifier("@/lib/marketing/content", "app/page.tsx")).toBe(
      "lib/marketing/content.ts",
    );
    const helper = "tests/docs/fixtures/copy-inventory.json";
    expect(resolveSpecifier("@/tests/docs/fixtures/copy-inventory", "app/page.tsx")).toBe(helper);
    // And its strings are read as DATA: parsing JSON as TSX yields nothing, so
    // admitting the file without this would have left it invisible anyway.
    const fragments = textFragments("probe.json", '{"claim": "Every change is tracked"}');
    expect(fragments).toEqual(["Every change is tracked"]);
    expect(forbiddenHits(fragments[0]).length).toBeGreaterThan(0);
  });

  it("REFUSED — wording a browser renders identically but the bytes do not", () => {
    // `foldForMatching` existed for exactly this and only the append-only
    // judgement was using it. A U+2011 non-breaking hyphen renders as a hyphen
    // and walked straight through a `[- ]` pattern — and the canonical modules,
    // where such a value would live, are exempt from the freeze, so nothing else
    // would have caught it.
    const straight = "synthetic-twin";
    const nonBreaking = "synthetic\u2011twin";
    expect(straight).not.toEqual(nonBreaking);
    expect(forbiddenHits(straight)).toEqual(forbiddenHits(nonBreaking));
    expect(forbiddenHits(nonBreaking).length).toBeGreaterThan(0);
  });

  it("ACCEPTED — ordinary copy that happens to share a file", () => {
    // Over-joining can only ADD a candidate, so the question is whether it adds
    // one that MATCHES. Measured across the real closure: zero. These are the
    // shapes that would have been most likely to.
    expect(joined(probe("<p>Hone carries <strong>the details</strong> forward.</p>"))).toBe(false);
    expect(
      joined(probe("<div><h2>Every studio</h2><p>Records are kept for each client.</p></div>")),
    ).toBe(false);
    expect(joined('const c = "flex flex-col rounded-[12px] border bg-white";')).toBe(false);
  });

  // --- R1 replaces four more. -----------------------------------------------

  it("the closure is what retires the import families", () => {
    // Imported values, imported components, props, spread props, metadata
    // helpers, re-exports and convention files were seven separate rules, each
    // asking WHERE an import appeared. None of that is asked now: the module is
    // either in the closure, in which case its literals are judged, or it is not
    // reachable from a route at all.
    const members = new Set(CLOSURE);
    // Every module the previous architecture had to name explicitly is simply a
    // member now.
    for (const reached of [
      "lib/marketing/metadata.ts",
      "lib/rate-limit/public.ts",
      "app/actions/demo.ts",
      "app/_components/MarketingFooter.tsx",
      "app/_components/marketingNav.ts",
    ]) {
      expect(members.has(reached), `${reached} should be reached by closure`).toBe(true);
    }
    // And a module nothing imports is not in the closure, which is what makes it
    // a boundary rather than a list of everything.
    expect(members.has("lib/supabase/admin.ts")).toBe(false);
  });

  it("a specifier resolves without the file being opened", () => {
    // NOT DISCOVERY-BY-READING: a first-party path that does not exist resolves
    // to null and is simply not a closure member, so nothing is followed into
    // the void. The closure grows only through files that are really there.
    expect(resolveSpecifier("@/lib/marketing/content", "app/page.tsx")).toBe(
      "lib/marketing/content.ts",
    );
    expect(resolveSpecifier("next/link", "app/page.tsx")).toBe(null);
    expect(resolveSpecifier("@/lib/does-not-exist-anywhere", "app/page.tsx")).toBe(null);
  });

  // --- R5, the one shape rule left. -----------------------------------------

  it("REFUSED — a sentence whose middle comes from another file", () => {
    expect(incomplete("<p>Every {NOUN} is tracked</p>")).toEqual(["copy/incomplete-claim"]);
    expect(incomplete("<p>Every <strong>{NOUN}</strong> is tracked</p>")).toEqual([
      "copy/incomplete-claim",
    ]);
    expect(incomplete("<p>Every <><strong>{NOUN}</strong></> is tracked</p>")).toEqual([
      "copy/incomplete-claim",
    ]);
    expect(incomplete("<p>Every change is {STATE}.</p>")).toEqual(["copy/incomplete-claim"]);
  });

  it("ACCEPTED — a hole alone, a literal hole, and a layout container", () => {
    // A hole ALONE is consumption, not a claim built around a gap.
    expect(incomplete("<p>{children}</p>")).toEqual([]);
    expect(incomplete("<p>{POSITIONING.corePromise}</p>")).toEqual([]);
    // A literal in an expression is spelled out here, so R3 already has it.
    expect(incomplete('<p>Every change {"is tracked"}</p>')).toEqual([]);
    expect(incomplete("<p>Every {<strong>change</strong>} is tracked</p>")).toEqual([]);
    // Words on a heading are not the words of the list beside it.
    expect(incomplete("<div><h2>Pricing</h2>{PLANS.map((p) => <Card key={p.id} />)}</div>")).toEqual([]);
  });

  // --- R4, and the guards around the fixture. -------------------------------

  it("REFUSED — new prose in a file outside the canonical copy modules", () => {
    const known = new Set(Object.values(INVENTORY.inventory).flat());
    const added = copyInventory(
      "app/_components/marketing/Probe.tsx",
      probe("<p>Hone keeps every treated area and its settings for the next appointment.</p>"),
    );
    expect(added.length, "the probe sentence is not substantive prose").toBeGreaterThan(0);
    expect(added.filter((item) => known.has(item))).toEqual([]);
  });

  it("the addition guard is file-qualified, counts occurrences, and covers both halves", () => {
    const source = read("tests/docs/marketing-truth-register.test.ts");
    const block = source.slice(
      source.indexOf('if (process.env.MARKETING_INVENTORY === "write")'),
      source.indexOf('describe("R1.'),
    );
    expect(block).toContain("qualify(");
    expect(block).toContain("remaining - 1");
    expect(block).toContain("INVENTORY.exceptions");
    // And the documented command can complete: the baseline is re-read.
    expect(block).toContain("INVENTORY = JSON.parse(read(INVENTORY_PATH))");
    expect(source).toContain("let INVENTORY");
  });

  it("a declared source that disappears fails loudly, not silently", () => {
    expect(() => assertDeclaredExist(["lib/rate-limit/public.ts"])).not.toThrow();
    expect(() => assertDeclaredExist(["lib/rate-limit/moved-away.ts"])).toThrow(/no longer exist/);
  });

  it("the prose heuristic still separates copy from class names", () => {
    expect(isSubstantiveProse("Hone carries the details from one appointment into the next.")).toBe(true);
    expect(isSubstantiveProse("inline-flex items-center justify-center rounded-md border")).toBe(false);
    expect(isSubstantiveProse("Maya R. · 30 min")).toBe(false);
  });
});
