/**
 * The marketing truth register, enforced.
 *
 * FOUR RULES, AND NO RENDERING MODEL
 * ----------------------------------
 * Owner ruling, 2026-09-20. The predecessor asked "what does this React tree
 * render?" Answering that needs a TypeScript compiler and a React renderer, and
 * approximating both produced a finding every round for twenty-two rounds: `+`,
 * then `.join()`, then `.concat()`, then a template, then a chained method, then
 * a bare identifier, then a property access, then a short label prefix, then a
 * callback parameter, then an array element, then a server action, then a
 * constant two modules away. Every repair was correct. The sequence had no end.
 *
 * That question is not asked here. These are:
 *
 *   R1 DECLARE — which files carry public copy. Lists and directories, never a
 *      discovered import graph.
 *   R2 JUDGE — every string on the declared surface against the register's own
 *      rules. No length gate, no prose gate: a phrase match costs nothing.
 *   R3 FREEZE — the prose inventory of every file OUTSIDE the canonical copy
 *      modules, by identity, shrink-only. New copy has to be new text somewhere,
 *      and new text is what is refused.
 *   R4 REFUSE — three shapes that put words in front of a visitor without
 *      leaving text in the file: an assembly, an unproven rendered array, and a
 *      dynamic text-bearing attribute. Refusals, not inferences: they do not ask
 *      what a value renders, they refuse a shape that cannot be read.
 *
 * R3 and R2 divide the work deliberately. The inventory holds substantive prose
 * only, so it stays stable and a CSS tweak does not redden the build — but that
 * gate needs five plain words or a full stop, and `Every change is tracked` is
 * four words with neither. Judgement has no threshold and sees it. Neither rule
 * is asked to do the other's job.
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
  isWatched,
  publicRouteFiles,
} from "./helpers/register-provenance";
import {
  CANONICAL_COPY_MODULES,
  POLICY_SOURCES,
  DECLARED_COPY_DIRS,
  DECLARED_COPY_FILES,
  pageCopySources,
  frozenSurface,
  copyInventory,
  judgeableText,
  moduleLiterals,
  walkStrings,
  isSubstantiveProse,
  assembledCopyViolations,
  unprovenArrayViolations,
  dynamicTextAttributeViolations,
  isProvenStatic,
  undeclaredCopyImportViolations,
  incompleteClaimViolations,
  assertDeclaredExist,
  TEXT_BEARING_ATTRIBUTES,
  type CopyViolation,
} from "./helpers/copy-inventory";

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

const REGISTER = read("docs/marketing/product-truth-register.md");

const PRODUCTION_BRANCH = "claude/build-hone-saas-hOex7";

const FORBIDDEN = forbiddenWordings(REGISTER);
const SANCTIONED = sanctionedAppendOnlyWordings(REGISTER);

const FROZEN = frozenSurface();
const DECLARED = [...FROZEN, ...CANONICAL_COPY_MODULES];

/**
 * R2. Every string the declared surface carries, plus the copy modules by value.
 *
 * UNFILTERED, deliberately and at some cost in size. Using an authoring
 * heuristic to decide what gets judged is how `export const title = "Every
 * change is tracked"` — four words, no full stop, the exact forbidden wording —
 * reached no rule at all in the predecessor. Short technical strings are free:
 * the register's rules are specific phrases and match no class name.
 */
const JUDGED = [
  ...DECLARED.flatMap((f) => judgeableText(f)),
  ...CANONICAL_COPY_MODULES.flatMap((f) => moduleLiterals(f)),
  // And by VALUE, which proves the static and runtime readings agree for a
  // plain data module.
  ...walkStrings(marketingContent),
  ...walkStrings(marketingResources),
];

/**
 * R3. The frozen prose inventory.
 *
 * Regenerate deliberately with `MARKETING_INVENTORY=write`, never as a reflex:
 * the script refuses ADDITIONS, so growth cannot arrive this way. The
 * predecessor regenerated its baselines by hand four times; once that silently
 * carried a stale entry for two heads, and once it wrote a wrong baseline that
 * had to be restored from git.
 */
const INVENTORY_PATH = "tests/docs/fixtures/copy-inventory.json";
type Fixture = { inventory: Record<string, string[]>; exceptions: string[] };

// LET, not const, because the regeneration block below rewrites the file and
// the rest of this run must see what it wrote. Parsed once and never refreshed,
// the documented `MARKETING_INVENTORY=write` command could not complete: it
// updated the JSON correctly and then failed its own equality assertions
// against the object it had replaced, so a legitimate shrink needed a second
// run to look green.
let INVENTORY = JSON.parse(read(INVENTORY_PATH)) as Fixture;

const currentInventory = (): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const file of FROZEN) {
    const items = copyInventory(file);
    if (items.length) out[file] = items;
  }
  return out;
};

const currentExceptions = (): CopyViolation[] => [
  ...DECLARED.flatMap((f) => dynamicTextAttributeViolations(f)),
  ...DECLARED.flatMap((f) => unprovenArrayViolations(f)),
  ...DECLARED.flatMap((f) => incompleteClaimViolations(f)),
];

if (process.env.MARKETING_INVENTORY === "write") {
  const inventory = currentInventory();
  const exceptions = currentExceptions().map((v) => `${v.rule} ${v.file} ${v.detail}`).sort();
  // BOTH HALVES, and this is the half that was missing. The first draft checked
  // additions in the prose inventory and then replaced `exceptions`
  // unconditionally — so removing the one placeholder exception and introducing
  // a different dynamic attribute would have written the new identity, and both
  // the equality check and the `length <= 1` ceiling would then have passed. A
  // set that calls itself shrink-only has to refuse growth everywhere it is
  // written, not only where it is convenient.
  const additions = (current: string[], recorded: string[]): string[] => {
    const known = new Set(recorded);
    return current.filter((x) => !known.has(x));
  };
  const added = [
    ...additions(Object.values(inventory).flat(), Object.values(INVENTORY.inventory).flat()),
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
    JSON.stringify({ inventory, exceptions }, null, 2) + "\n",
  );
  INVENTORY = JSON.parse(read(INVENTORY_PATH)) as Fixture;
}

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
 * would claim a re-derivation nobody performed — which is the exact defect this
 * register exists to prevent. So the two are recorded separately: what §0 was
 * derived at, and how far production has run since.
 */
function checkedProductionHead(): string {
  const m = REGISTER.match(/Production head at last check \| `([0-9a-f]{40})`/);
  return m ? m[1] : "";
}

describe("R1. the surface is DECLARED, not discovered", () => {
  it("the declared surface is lists and directories, with no import walk", () => {
    // The predecessor derived its component set by following imports, and spent
    // four rounds on where that walk stopped: one level, then transitive, then
    // `.ts` as well as `.tsx`, then layouts Next applies without an import, then
    // re-exports. A directory does not have that question.
    expect(DECLARED_COPY_DIRS).toEqual(["app/_components", "app/actions", "app/_fonts"]);
    // `app/layout.tsx` is no longer listed here: it is an app-root CONVENTION
    // route and arrives with the rest of them, so naming it twice would let the
    // two disagree.
    expect(DECLARED_COPY_FILES).toEqual(["lib/rate-limit/public.ts", "lib/marketing/metadata.ts"]);
    expect(CANONICAL_COPY_MODULES.length).toBe(3);
    expect(POLICY_SOURCES).toEqual(["app/privacy/page.tsx", "app/terms/page.tsx"]);
  });

  it("every declared file exists, and the route list comes from the registry", () => {
    for (const file of DECLARED) {
      expect(existsSync(join(REPO_ROOT, file)), `${file} is declared but absent`).toBe(true);
    }
    // Not a second hand-kept list: the routes are whatever the registry says.
    expect(pageCopySources().sort()).toEqual(
      publicRouteFiles().filter((f) => !POLICY_SOURCES.includes(f)).sort(),
    );
  });

  it("a new component file is covered the moment it exists", () => {
    // The property a directory buys and a file list does not. Every `.tsx` in
    // the declared directories is in the frozen surface, so a component added
    // tomorrow arrives already inventoried.
    for (const known of [
      "app/_components/DemoForm.tsx",
      "app/_components/MarketingFooter.tsx",
      "app/_components/marketing/SiteFooter.tsx",
      "app/_components/marketing/visuals/CalendarPreview.tsx",
      "app/actions/demo.ts",
      "app/layout.tsx",
      "lib/rate-limit/public.ts",
    ]) {
      expect(FROZEN, `${known} is not covered`).toContain(known);
    }
    // And the canonical modules are NOT frozen: authoring copy there is the law.
    for (const module of CANONICAL_COPY_MODULES) expect(FROZEN).not.toContain(module);
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
    ...frozenSurface(),
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
      ...frozenSurface(),
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

describe("R2. JUDGEMENT: every string on the declared surface, against the register", () => {
  it("the corpus is real, and large enough to be the whole surface", () => {
    expect(JUDGED.length).toBeGreaterThan(1000);
    expect(JUDGED.join(" ¶ ")).toMatch(/electrolysis/i);
    // Non-vacuous at a sentence only a COMPONENT authors, and one only a page
    // does: a corpus that quietly covered the copy modules alone would pass a
    // size check and miss both.
    expect(JUDGED).toContain("Treatment memory for electrologists.");
    expect(JUDGED.some((c) => /\bprivacy policy\b/i.test(c))).toBe(true);
  });

  it("no forbidden wording appears anywhere on the declared surface", () => {
    const offenders = JUDGED.flatMap((claim) =>
      FORBIDDEN.filter((rule) => rule.pattern.test(claim)).map(
        (rule) => `${rule.id}: ${claim}`,
      ),
    );
    expect(offenders, "public copy carries wording the register forbids").toEqual([]);
  });

  it("every append-only claim is one the register sanctions", () => {
    const verdicts = JUDGED.map((c) => ({ c, v: judgeAppendOnlyClaim(c, SANCTIONED) })).filter(
      ({ v }) => v.kind === "unsanctioned",
    );
    expect(
      verdicts.map(({ c }) => c),
      "an append-only promise is made that §0.4 N1 does not support",
    ).toEqual([]);
  });

  it("judgement has NO length or prose gate", () => {
    // The exact wording that escaped the predecessor: four plain words, no
    // terminal punctuation, and therefore below every authoring threshold. It is
    // not inventory-worthy prose and it must still be judged.
    const probe = "export const A = () => <p>Every change is tracked</p>;";
    expect(copyInventory("app/probe/page.tsx", probe)).toEqual([]);
    expect(
      judgeableText("app/probe/page.tsx", probe).some((t) =>
        FORBIDDEN.some((r) => r.pattern.test(t)),
      ),
      "a four-word forbidden sentence fell through the gap between freeze and judgement",
    ).toBe(true);
  });
});

describe("R3. FREEZE: prose outside the copy modules can only shrink", () => {
  it("the recorded inventory is exactly what the surface holds", () => {
    expect(currentInventory()).toEqual(INVENTORY.inventory);
  });

  it("no file gains prose, by identity rather than by count", () => {
    // A count alone lets one line be swapped for another. The predecessor was
    // bitten by exactly that twice, and by a 70-character truncation that made
    // two different sentences compare equal.
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

  it("the inventory shrinks when copy moves into a canonical module, and only then", () => {
    // The cost this architecture accepts is stated and monotonic: prose outside
    // the copy modules is not judged claim-by-claim, but it cannot grow, and the
    // only way it falls is by moving somewhere that IS judged.
    const total = FROZEN.reduce((n, f) => n + copyInventory(f).length, 0);
    const recorded = Object.values(INVENTORY.inventory).flat().length;
    expect(total).toBeLessThanOrEqual(recorded);
  });
});

describe("R4. REFUSAL: shapes that put words on the page without leaving text", () => {
  it("no assembly of authored words with something dynamic", () => {
    expect(
      DECLARED.flatMap((f) => assembledCopyViolations(f)).map((v) => `${v.file}:${v.line} ${v.detail}`),
      "a claim is assembled from fragments; author it as one complete copy value",
    ).toEqual([]);
  });

  it("no copy is imported from a module outside the declared surface", () => {
    // The escape is ordinary refactoring: a declared component imports `CLAIM`
    // from a new `lib/…` helper and renders `{CLAIM}`. The component holds no
    // text for the inventory, the helper is on no declared list so nothing
    // judges it, and a bare identifier is not an assembly, an array or an
    // attribute. ZERO today, so it is asserted as zero rather than baselined.
    expect(
      DECLARED.flatMap((f) => undeclaredCopyImportViolations(f, DECLARED)).map(
        (v) => `${v.file}: ${v.detail}`,
      ),
      "copy is rendered from a module the register never sees; move it into " +
        "lib/marketing/content.ts",
    ).toEqual([]);
  });

  it("the declared exceptions are recorded, by identity, and shrink-only", () => {
    // ONE today: `placeholder={placeholder}` in the demo form, a prop passed
    // through a field component. It is visitor-facing text that this file does
    // not contain, so it is declared rather than tolerated silently.
    const recorded = currentExceptions().map((v) => `${v.rule} ${v.file} ${v.detail}`).sort();
    expect(recorded).toEqual(INVENTORY.exceptions);
    // 13, and the number is the point rather than an embarrassment. Twelve are
    // pre-existing sentences with a value in the middle — `© {year} Hone.`,
    // `Published {date}` — which the owner ruling says are not to be moved.
    // Declaring them makes the cost of that ruling visible and shrink-only,
    // which is what the predecessor's silent filtering did not.
    expect(recorded.length, "refusals grew").toBeLessThanOrEqual(13);
    // Every rule that can produce one is represented in the recorded set, or a
    // rule could be switched off without the count noticing.
    expect(new Set(recorded.map((r) => r.split(" ")[0]))).toEqual(
      new Set(["copy/dynamic-text-attribute", "copy/incomplete-claim"]),
    );
    // The convention routes are covered, which is what carries the social card.
    expect(FROZEN).toContain("app/opengraph-image.tsx");
    expect(Object.values(INVENTORY.inventory).flat()).toContain(
      "Hone. Treatment memory for electrologists: before-today prep, charting, and procedure records.",
    );
  });
});

describe("NEGATIVE CONTROLS: each refusal is red on the defect it claims to catch", () => {
  const probe = (body: string, head = "") =>
    `${head}export const A = () => ${body};\n`;
  const arrays = (src: string) =>
    unprovenArrayViolations("app/probe/page.tsx", src).map((v) => v.rule);
  const attrs = (src: string) =>
    dynamicTextAttributeViolations("app/probe/page.tsx", src).map((v) => v.rule);
  const assembled = (src: string) =>
    assembledCopyViolations("app/probe/page.tsx", src).map((v) => v.rule);

  // --- P2 class 1: inline arrays whose members are not statically proven ------

  it("REFUSED — an inline array containing a dynamic member", () => {
    expect(
      arrays(probe('<ul>{["Every change is", status].map((line) => <li key={line}>{line}</li>)}</ul>')),
    ).toEqual(["copy/unproven-array-element"]);
  });

  it("REFUSED — an inline array containing a function-returned member", () => {
    expect(
      arrays(probe('<ul>{["Intro", getClaim()].map((line) => <li key={line}>{line}</li>)}</ul>')),
    ).toEqual(["copy/unproven-array-element"]);
  });

  it("REFUSED — every unproven member is named, not just the first", () => {
    expect(
      arrays(probe('<ul>{[getOne(), "static", getTwo()].map((l) => <li key={l}>{l}</li>)}</ul>')),
    ).toEqual(["copy/unproven-array-element", "copy/unproven-array-element"]);
  });

  it("REFUSED — a spread hides its source", () => {
    expect(
      arrays(probe('<ul>{[...lines, "tail"].map((l) => <li key={l}>{l}</li>)}</ul>')),
    ).toEqual(["copy/unproven-array-element"]);
  });

  it("ACCEPTED — an inline array of complete literals", () => {
    expect(
      arrays(probe('<ul>{["Every change", "is tracked"].map((l) => <li key={l}>{l}</li>)}</ul>')),
    ).toEqual([]);
  });

  it("ACCEPTED — an array of literal objects, and of JSX", () => {
    expect(
      arrays(probe('<ul>{[{ id: 1, label: "Solo" }].map((p) => <li key={p.id}>{p.label}</li>)}</ul>')),
    ).toEqual([]);
    expect(arrays(probe("<div>{[<span key=\"a\">A</span>]}</div>"))).toEqual([]);
  });

  it("ACCEPTED — a dynamic array that is DATA, not rendered text", () => {
    // `<Chart data={[1, 2, load()]} />` is not copy, and refusing it would be
    // noise. The rule is scoped to arrays written in text position or iterated,
    // which is why it asks what POSITION the array occupies rather than what it
    // contains.
    expect(arrays(probe("<Chart data={[1, 2, load()]} />"))).toEqual([]);
  });

  // --- P2 class 2: dynamic visitor-facing text attributes --------------------

  it("REFUSED — a dynamic alt", () => {
    expect(attrs(probe("<img src={src} alt={describe(photo)} />"))).toEqual([
      "copy/dynamic-text-attribute",
    ]);
  });

  it("REFUSED — a dynamic aria-label", () => {
    expect(attrs(probe("<button aria-label={label}>x</button>"))).toEqual([
      "copy/dynamic-text-attribute",
    ]);
  });

  it("REFUSED — a dynamic title", () => {
    expect(attrs(probe("<abbr title={expand(term)}>RF</abbr>"))).toEqual([
      "copy/dynamic-text-attribute",
    ]);
  });

  it("REFUSED — the remaining text-bearing attributes, each one", () => {
    for (const attribute of TEXT_BEARING_ATTRIBUTES) {
      expect(
        attrs(probe(`<span ${attribute}={value}>x</span>`)),
        `${attribute} carries words a visitor reads and must be refused when dynamic`,
      ).toEqual(["copy/dynamic-text-attribute"]);
    }
  });

  it("ACCEPTED — the static equivalents, which must keep working", () => {
    expect(attrs(probe('<img src={src} alt="Hone calendar, week view" />'))).toEqual([]);
    expect(attrs(probe('<button aria-label="Close">x</button>'))).toEqual([]);
    expect(attrs(probe('<abbr title="Radio frequency">RF</abbr>'))).toEqual([]);
    // Braced literals are the same value written differently.
    expect(attrs(probe('<img src={src} alt={"Hone calendar"} />'))).toEqual([]);
  });

  it("ACCEPTED — an empty alt, which is the decorative case and is correct", () => {
    expect(attrs(probe('<img src={src} alt="" />'))).toEqual([]);
    expect(attrs(probe("<img src={src} alt />"))).toEqual([]);
  });

  it("ACCEPTED — an id reference is not text", () => {
    // `aria-labelledby` holds element ids, not words. Refusing it would be
    // wrong and would push authors toward the dynamic `aria-label` this rule
    // exists to prevent.
    expect(attrs(probe("<div aria-labelledby={headingId}>x</div>"))).toEqual([]);
    expect(attrs(probe("<div aria-describedby={noteId}>x</div>"))).toEqual([]);
  });

  it("ACCEPTED — a non-text attribute carrying a dynamic value", () => {
    expect(attrs(probe("<img src={src} className={cls} width={w} />"))).toEqual([]);
  });

  // --- R4 assembly, both spellings and the negative -------------------------

  it("REFUSED — an assembly of authored words with something dynamic", () => {
    for (const source of [
      'const state = "Every change is " + status;',
      "const state = `Every change is ${status}`;",
      'const state = ["Every change is", status].join(" ");',
      'const state = "Every change is ".concat(status);',
    ]) {
      expect(assembled(source), source).toEqual(["copy/assembled-from-fragments"]);
    }
  });

  it("ACCEPTED — a class string, which is tokens rather than prose", () => {
    // Measured: the only mixed assemblies on the real surface are two Tailwind
    // templates. Counting plain words alone flagged both — `flex` and `border`
    // are two words — so the rule also requires the literal to be MOSTLY plain
    // words, which a class list is not. No length gate, because that is what the
    // four-word forbidden wording walks through.
    expect(
      assembled("const c = `flex flex-col rounded-[12px] border bg-white ${extra}`;"),
    ).toEqual([]);
    expect(assembled('const c = "px-4 py-2 " + size;')).toEqual([]);
  });

  it("REFUSED — a fully static assembly, because the fragments are not the claim", () => {
    // This one surfaced while writing the controls, and the first expectation
    // was wrong. `"Every change" + " is tracked"` is entirely literal, so it
    // looks harmless — but it renders the forbidden sentence while each fragment
    // is below the prose threshold and matches no rule alone. The predecessor
    // answered this by FOLDING, which is how it ended up chasing `.join()`,
    // `.concat()`, templates and chained methods one round at a time. Refusing
    // the shape needs no fold: author it as one complete value.
    expect(assembled('const s = "Every change" + " is tracked";')).toEqual([
      "copy/assembled-from-fragments",
    ]);
  });

  // --- the freeze itself ----------------------------------------------------

  it("REFUSED — new prose in a file outside the canonical copy modules", () => {
    const known = new Set(Object.values(INVENTORY.inventory).flat());
    const added = copyInventory(
      "app/_components/marketing/Probe.tsx",
      probe("<p>Hone keeps every treated area and its settings for the next appointment.</p>"),
    );
    expect(added.length, "the probe sentence is not substantive prose").toBeGreaterThan(0);
    expect(added.filter((item) => known.has(item))).toEqual([]);
  });

  it("ACCEPTED — the same prose in a canonical copy module is not frozen at all", () => {
    // Because that is where it belongs, and there it is judged instead.
    expect(FROZEN).not.toContain("lib/marketing/content.ts");
  });

  // --- the readability primitive the refusals share -------------------------

  it("isProvenStatic fails closed on everything it cannot read", () => {
    const expr = (src: string): boolean => {
      const sf = require("typescript").createSourceFile(
        "p.tsx",
        `const x = ${src};`,
        99,
        true,
        4,
      );
      return isProvenStatic(sf.statements[0].declarationList.declarations[0].initializer);
    };
    for (const readable of ['"text"', "`text`", "1", "true", "null", '["a", "b"]', '{ a: "b" }']) {
      expect(expr(readable), readable).toBe(true);
    }
    for (const unreadable of [
      "getClaim()",
      "claim",
      "claim.text",
      "`a ${b}`",
      '"a" + b',
      "[...rest]",
      '{ ...base, a: "b" }',
      "cond ? a : b",
    ]) {
      expect(expr(unreadable), unreadable).toBe(false);
    }
  });

  // --- P1: a sentence split by markup ---------------------------------------

  it("REFUSED — a claim split across nested JSX is judged as the whole sentence", () => {
    // `<p>Every change <strong>is tracked</strong></p>` emitted "Every change"
    // and "is tracked": neither fragment matches a rule, neither reaches the
    // prose threshold, and no shape check rejects ordinary nested markup. The
    // sentence a visitor reads existed nowhere in the corpus.
    const texts = judgeableText(
      "app/probe/page.tsx",
      probe("<p>Every change <strong>is tracked</strong></p>"),
    );
    expect(texts).toContain("Every change is tracked");
    expect(texts.some((t) => FORBIDDEN.some((r) => r.pattern.test(t)))).toBe(true);
  });

  it("REFUSED — split by a link, by a fragment, and across three levels", () => {
    const caught = (body: string) =>
      judgeableText("app/probe/page.tsx", probe(body)).some((t) =>
        FORBIDDEN.some((r) => r.pattern.test(t)),
      );
    expect(caught('<p>Every change <a href="/x">is tracked</a></p>')).toBe(true);
    expect(caught("<p>Every <>change is</> tracked</p>")).toBe(true);
    expect(caught("<div><span>Every <em>change <b>is</b></em></span> tracked</div>")).toBe(true);
    // A literal in an expression container is text too.
    expect(caught('<p>Every change {"is tracked"}</p>')).toBe(true);
  });

  it("ACCEPTED — joining adds candidates, it does not invent a violation", () => {
    // Concatenation can only ADD strings, never hide one, and an extra candidate
    // fails closed. Ordinary split markup that says nothing forbidden stays
    // clean, which is what keeps the asymmetry usable.
    const texts = judgeableText(
      "app/probe/page.tsx",
      probe("<p>Hone carries <strong>the details</strong> forward.</p>"),
    );
    expect(texts).toContain("Hone carries the details forward.");
    expect(texts.some((t) => FORBIDDEN.some((r) => r.pattern.test(t)))).toBe(false);
  });

  // --- P1: copy imported from an undeclared module ---------------------------

  it("REFUSED — a value rendered from a module on no declared list", () => {
    const escape = (from: string) =>
      undeclaredCopyImportViolations(
        "app/_components/marketing/P.tsx",
        DECLARED,
        `import { CLAIM } from "${from}";\nexport const A = () => <p>{CLAIM}</p>;\n`,
      ).map((v) => v.rule);
    expect(escape("@/lib/copy-helper")).toEqual(["copy/undeclared-copy-import"]);
    expect(escape("@/lib/marketing/extra-claims")).toEqual(["copy/undeclared-copy-import"]);
    // A property access on such an import is the same escape one step along.
    expect(
      undeclaredCopyImportViolations(
        "app/_components/marketing/P.tsx",
        DECLARED,
        'import { COPY } from "@/lib/copy-helper";\nexport const A = () => <p>{COPY.claim}</p>;\n',
      ).map((v) => v.rule),
    ).toEqual(["copy/undeclared-copy-import"]);
  });

  it("ACCEPTED — a canonical module, and another declared file", () => {
    const from = (spec: string, expr: string) =>
      undeclaredCopyImportViolations(
        "app/_components/marketing/P.tsx",
        DECLARED,
        `import { X } from "${spec}";\nexport const A = () => <p>{${expr}}</p>;\n`,
      );
    expect(from("@/lib/marketing/content", "X.corePromise")).toEqual([]);
    // Declared but not canonical: its text is frozen and judged where it lives.
    expect(from("@/app/_components/marketingNav", "X.label")).toEqual([]);
    // A local binding is not an import and is not this rule's business.
    expect(
      undeclaredCopyImportViolations(
        "app/_components/marketing/P.tsx",
        DECLARED,
        "const X = 1;\nexport const A = () => <p>{X}</p>;\n",
      ),
    ).toEqual([]);
  });

  it("the import rule reads the specifier and never opens the file", () => {
    // NOT DISCOVERY. A module that does not exist on disk still resolves to a
    // path, and the only question asked is whether that path is already
    // declared. Nothing is followed, so the walk this architecture dropped
    // cannot come back this way.
    expect(
      undeclaredCopyImportViolations(
        "app/_components/marketing/P.tsx",
        DECLARED,
        'import { C } from "@/lib/does-not-exist-anywhere";\nexport const A = () => <p>{C}</p>;\n',
      ).map((v) => v.rule),
    ).toEqual(["copy/undeclared-copy-import"]);
  });

  // --- the regeneration path -------------------------------------------------

  it("regeneration refuses additions in BOTH halves, not just the inventory", () => {
    // The first draft checked the prose inventory and then replaced `exceptions`
    // unconditionally, so swapping the one placeholder exception for a different
    // dynamic attribute would have written the new identity and passed both the
    // equality check and the `length <= 1` ceiling.
    const source = readFileSync(join(REPO_ROOT, "tests/docs/marketing-truth-register.test.ts"), "utf8");
    const block = source.slice(
      source.indexOf('if (process.env.MARKETING_INVENTORY === "write")'),
      source.indexOf("describe(\"R1."),
    );
    expect(block).toContain("INVENTORY.exceptions");
    expect(block.match(/additions\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  // --- P1: a sentence whose middle is a value --------------------------------

  it("REFUSED — authored words wrapped around a hole", () => {
    // `<p>Every {TRACKING_NOUN} is tracked</p>` renders the forbidden claim while
    // the joined candidate reads "Every is tracked" and every fragment is
    // harmless. Concatenation cannot close this: the missing word is not in the
    // file, and the value may come from a canonical module the import rule
    // allows. Reading it would mean resolving a binding, so it is refused.
    const incomplete = (body: string) =>
      incompleteClaimViolations("app/_components/marketing/P.tsx", probe(body)).map((v) => v.rule);
    expect(incomplete("<p>Every {NOUN} is tracked</p>")).toEqual(["copy/incomplete-claim"]);
    expect(incomplete("<p>Every change is {STATE}.</p>")).toEqual(["copy/incomplete-claim"]);
    expect(incomplete("<p>{PREFIX} change is tracked</p>")).toEqual(["copy/incomplete-claim"]);
    // Each hole is named, so a two-gap sentence reports both.
    expect(incomplete("<p>Every {A} is {B}</p>")).toEqual([
      "copy/incomplete-claim",
      "copy/incomplete-claim",
    ]);
  });

  it("ACCEPTED — a hole ALONE, which is consumption rather than a gap", () => {
    const incomplete = (body: string) =>
      incompleteClaimViolations("app/_components/marketing/P.tsx", probe(body)).map((v) => v.rule);
    expect(incomplete("<p>{children}</p>")).toEqual([]);
    expect(incomplete("<p>{POSITIONING.corePromise}</p>")).toEqual([]);
    expect(incomplete("<div>{items.map((i) => <span key={i}>{i}</span>)}</div>")).toEqual([]);
    // A complete literal in an expression container is not a hole at all.
    expect(incomplete('<p>Every change {"is tracked"}</p>')).toEqual([]);
  });

  // --- P1: an undeclared import reaching a custom component prop -------------

  it("REFUSED — an undeclared import passed as a component prop", () => {
    // `<Hero headline={CLAIM} />` renders whatever `Hero` does with it, and no
    // fixed list of DOM text attributes can know that `headline` is copy.
    // Checking the SOURCE of the value rather than the NAME of the attribute
    // needs no such knowledge.
    const escape = (body: string) =>
      undeclaredCopyImportViolations(
        "app/_components/marketing/P.tsx",
        DECLARED,
        `import { CLAIM } from "@/lib/copy-helper";\nexport const A = () => ${body};\n`,
      ).map((v) => v.rule);
    expect(escape("<Hero headline={CLAIM} />")).toEqual(["copy/undeclared-copy-import"]);
    expect(escape("<p>{CLAIM}</p>")).toEqual(["copy/undeclared-copy-import"]);
    // Nested inside a wrapper expression, where a root-only test reads the
    // wrapper instead of the value.
    expect(escape("<Hero headline={pick(CLAIM)} />")).toEqual(["copy/undeclared-copy-import"]);
    expect(escape("<Hero headline={`${CLAIM} today`} />")).toEqual(["copy/undeclared-copy-import"]);
  });

  it("ACCEPTED — a prop whose value comes from a declared module", () => {
    const from = (spec: string) =>
      undeclaredCopyImportViolations(
        "app/_components/marketing/P.tsx",
        DECLARED,
        `import { X } from "${spec}";\nexport const A = () => <Hero headline={X.label} />;\n`,
      );
    expect(from("@/lib/marketing/content")).toEqual([]);
    expect(from("@/app/_components/marketingNav")).toEqual([]);
    expect(from("@/app/actions/demo")).toEqual([]);
  });

  // --- P2: a declaration that names a file which is gone ---------------------

  it("a declared copy source that disappears fails loudly, not silently", () => {
    // Filtering missing files out made the declaration self-healing in the worst
    // way: move `lib/rate-limit/public.ts`, the stale entry vanishes, and its
    // replacement sits outside the declared directories carrying visitor-facing
    // text. The test that checks existence then iterates an already-filtered
    // list and can never notice.
    for (const declaredFile of DECLARED_COPY_FILES) {
      expect(existsSync(join(REPO_ROOT, declaredFile))).toBe(true);
      expect(FROZEN, `${declaredFile} is declared and must be in the surface`).toContain(declaredFile);
    }
    for (const dir of DECLARED_COPY_DIRS) {
      expect(existsSync(join(REPO_ROOT, dir)), `${dir} is declared but absent`).toBe(true);
    }

    // And it is RED when a declaration really is stale. Proven with a path that
    // is genuinely missing, because the alternative is deleting a real source
    // file — so left inline this would have shipped unpinned, and a guard that
    // cannot be shown red is not yet a guard.
    expect(() => assertDeclaredExist(["lib/rate-limit/public.ts"])).not.toThrow();
    expect(() => assertDeclaredExist(["lib/rate-limit/moved-away.ts"])).toThrow(
      /no longer exist/,
    );
  });

  // --- P1: a hole one level below the words ---------------------------------

  it("REFUSED — a hole nested inside inline markup within a sentence", () => {
    // `<p>Every <strong>{NOUN}</strong> is tracked</p>` puts the words on the
    // outer element and the hole on the inner one, so a direct-children test saw
    // a sentence with no hole and a hole with no sentence.
    const incomplete = (body: string) =>
      incompleteClaimViolations("app/_components/marketing/P.tsx", probe(body)).map((v) => v.rule);
    expect(incomplete("<p>Every <strong>{NOUN}</strong> is tracked</p>")).toEqual([
      "copy/incomplete-claim",
    ]);
    expect(incomplete('<p>Every <a href="/x">{NOUN}</a> is tracked</p>')).toEqual([
      "copy/incomplete-claim",
    ]);
    expect(incomplete("<p>Every <em>change</em> is {STATE}</p>")).toEqual([
      "copy/incomplete-claim",
    ]);

    // AT ANY DEPTH, and through a fragment, which is not even an element. One
    // level of descent left `<p>Every <><strong>{NOUN}</strong></> is
    // tracked</p>` green: the outer element had the words and no hole, and every
    // wrapper between had a hole and no words.
    expect(incomplete("<p>Every <><strong>{NOUN}</strong></> is tracked</p>")).toEqual([
      "copy/incomplete-claim",
    ]);
    expect(incomplete("<p>Every <span><em><b>{NOUN}</b></em></span> is tracked</p>")).toEqual([
      "copy/incomplete-claim",
    ]);
  });

  it("ACCEPTED — a heading and an unrelated list simply sharing a container", () => {
    // A wrapper that contains other ELEMENTS starts a structure of its own, so
    // its words are not part of this sentence. Measured: reading the whole
    // subtree instead flagged 158 such places, which is a census rather than a
    // guard.
    const incomplete = (body: string) =>
      incompleteClaimViolations("app/_components/marketing/P.tsx", probe(body)).map((v) => v.rule);
    expect(incomplete("<div><h2>Pricing</h2>{PLANS.map((p) => <Card key={p.id} />)}</div>")).toEqual([]);

    expect(incomplete("<section><p>A complete sentence here.</p><div>{widget}</div></section>")).toEqual([]);

    // What keeps this allowed is the WORD side, not the hole side: the outer
    // element has no authored text of its own, so there is no sentence for the
    // list to be inside. The descent itself is unconditional; an earlier draft
    // also stopped at wrappers carrying their own words, measured identical at
    // twelve, and that branch is gone.
    expect(
      incomplete("<div><h2>Pricing plans for every studio</h2><ul>{PLANS.map((p) => <li key={p.id} />)}</ul></div>"),
    ).toEqual([]);

    // A hole inside a wrapper that has words of its own is caught either way —
    // the stop only decided which element it was reported against. Reported
    // ONCE, which is what the dedupe is for: without it this hole belongs to two
    // sentences at once and is counted twice.
    expect(incomplete("<p>Intro <span>Heading {hole}</span></p>")).toEqual([
      "copy/incomplete-claim",
    ]);
  });

  // --- P1: an imported component used as a TAG ------------------------------

  it("REFUSED — a component imported from an undeclared module and rendered", () => {
    // The visitor-facing import need not be a value at all: `<Hero />` renders
    // whatever text that component holds, its module is outside the declared
    // surface, and the route itself carries no text.
    const escape = (body: string, spec = "@/components/hero") =>
      undeclaredCopyImportViolations(
        "app/_components/marketing/P.tsx",
        DECLARED,
        `import { Hero } from "${spec}";\nexport const A = () => ${body};\n`,
      ).map((v) => v.rule);
    expect(escape("<Hero />")).toEqual(["copy/undeclared-copy-import"]);
    expect(escape("<Hero>child</Hero>")).toEqual(["copy/undeclared-copy-import"]);
    // A namespaced tag is the same binding one dot along.
    expect(escape("<Hero.Title />")).toEqual(["copy/undeclared-copy-import"]);
  });

  it("ACCEPTED — a declared component, and a third-party tag", () => {
    const tag = (spec: string) =>
      undeclaredCopyImportViolations(
        "app/_components/marketing/P.tsx",
        DECLARED,
        `import { T } from "${spec}";\nexport const A = () => <T />;\n`,
      );
    expect(tag("@/app/_components/marketing/primitives")).toEqual([]);
    // Bare specifiers are packages, not first-party copy, and resolve to no path.
    expect(tag("next/link")).toEqual([]);
    expect(tag("react")).toEqual([]);
  });

  // --- P1: framework convention routes --------------------------------------

  it("the app-root convention routes are declared, and not the authenticated app", () => {
    // Next wires these from their FILENAME, so no import names them and no
    // registry lists them. `app/opengraph-image.tsx` renders the card every
    // social preview shows.
    for (const convention of [
      "app/opengraph-image.tsx",
      "app/apple-icon.tsx",
      "app/icon.tsx",
      "app/global-error.tsx",
      "app/robots.ts",
      "app/sitemap.ts",
      "app/layout.tsx",
    ]) {
      expect(FROZEN, `${convention} is a public convention route`).toContain(convention);
    }
    // And the metadata BUILDER, whose titles and descriptions every route sets
    // through `export const metadata = marketingMetadata("/")`. An imported
    // identifier consumed outside JSX is not something the import rule can see,
    // so the module is declared instead of a rule being stretched to reach it.
    expect(FROZEN).toContain("lib/marketing/metadata.ts");
    // Non-recursive: the authenticated application stays out.
    expect(FROZEN.filter((f) => f.startsWith("app/(app)/"))).toEqual([]);
  });

  it("the documented regeneration command can actually complete", () => {
    // `INVENTORY` is parsed once at module load and the write block replaces the
    // file, so a legitimate shrink used to update the JSON correctly and then
    // fail its own equality assertions against the object it had replaced — only
    // a SECOND run looked green. The baseline is re-read after writing.
    const source = read("tests/docs/marketing-truth-register.test.ts");
    const block = source.slice(
      source.indexOf('if (process.env.MARKETING_INVENTORY === "write")'),
      source.indexOf('describe("R1.'),
    );
    expect(block).toContain("INVENTORY = JSON.parse(read(INVENTORY_PATH))");
    expect(source).toContain("let INVENTORY");
  });

  it("the prose heuristic still separates copy from class names", () => {
    expect(isSubstantiveProse("Hone carries the details from one appointment into the next.")).toBe(true);
    expect(isSubstantiveProse("inline-flex items-center justify-center rounded-md border")).toBe(false);
    expect(isSubstantiveProse("Maya R. · 30 min")).toBe(false);
  });
});
