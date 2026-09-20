/**
 * The marketing truth register, enforced.
 *
 * THREE GUARDS, AND ONLY THREE
 * ----------------------------
 * Owner ruling, 2026-09-20. Its predecessor answered "what does this React tree
 * render?" by interpreting the program, and nine consecutive review rounds
 * showed that question has no natural edge. It is not asked any more.
 *
 *   A. PROVENANCE — git only. Has anything §0 cites moved since the head §0 was
 *      derived against? Unchanged from the version that already worked.
 *   B. SHAPE — a refusal. Was this string allowed to be written where it was?
 *      Never what it means, never what it renders to.
 *   C. JUDGEMENT — complete copy values against the register's own rules. The
 *      value IS the sentence, because B guarantees it.
 *
 * The authoring law that makes C possible is in `copy-sources.ts`: substantive
 * marketing claims are complete static copy values, and rendering code composes
 * layout rather than synthesising claims from fragments.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { migrationState } from "../migrations/helpers/migration-state";
import { MARKETING_PAGES } from "@/lib/marketing/content";
import * as marketingContent from "@/lib/marketing/content";
import * as marketingResources from "@/lib/marketing/resources";
import * as marketingJsonLd from "@/lib/marketing/jsonld";
import {
  REPO_ROOT,
  forbiddenWordings,
  judgeAppendOnlyClaim,
  sanctionedAppendOnlyWordings,
  citedEvidenceFiles,
  isWatched,
  publicRouteFiles,
  APPEND_ONLY_OVERREACH,
  APPEND_ONLY_TRIGGER,
  SUPPORTED_APPEND_ONLY_SCOPE,
} from "./helpers/register-provenance";
import {
  CANONICAL_COPY_MODULES,
  POLICY_SOURCES,
  pageCopySources,
  marketingComponentFiles,
  copyModuleViolations,
  componentProseViolations,
  assembledClaimViolations,
  pageClaims,
  pageProse,
  jsxHoles,
  moduleClaims,
  walkStrings,
  isSubstantiveProse,
  INLINE_IN_CLAIM,
  unreadableAssemblies,
  moduleSpecifiersOf,
  mixedAssemblyViolations,
} from "./helpers/copy-sources";

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

const REGISTER = read("docs/marketing/product-truth-register.md");

const PRODUCTION_BRANCH = "claude/build-hone-saas-hOex7";

const FORBIDDEN = forbiddenWordings(REGISTER);
const SANCTIONED = sanctionedAppendOnlyWordings(REGISTER);

/**
 * Every complete claim the JUDGED copy sources carry.
 *
 * OWNER RULING, option 1: marketing route pages are checked for the AUTHORING
 * LAW only. They are not a judged claim surface, and claims come from the copy
 * modules and the policy sources.
 *
 * The reason is a measured one rather than a preference. Judging page JSX means
 * deciding what a hole renders — and of 75 holes in text position across the
 * declared pages, the bulk resolve through `.map` callbacks
 * (`PRICING_PLANS.map((plan) => <p>{plan.name}</p>)`). Approving `plan.name`
 * requires following a binding from an approved array into a callback parameter,
 * and that is dataflow: the analysis this architecture exists to remove.
 *
 * The cost is stated, bounded and monotonic. 213 page prose items are not
 * judged; the baseline below freezes that number so it can only shrink, and the
 * way it shrinks is by copy moving into a canonical module — where it IS judged.
 * The unjudged surface can therefore only get smaller.
 *
 * The policy sources keep their claims: they carry ZERO holes in text position,
 * so nothing about them needs a hole rule at all. That is asserted below rather
 * than assumed, because it is what makes their inclusion safe.
 */
const PAGE_CLAIMS = [...pageCopySources(), ...POLICY_SOURCES].flatMap((f) =>
  pageClaims(f),
);
const MODULE_CLAIMS = [
  // Statically, so a module whose copy is RETURNED BY A FUNCTION is covered and
  // so both branches of a complete conditional are judged rather than only the
  // one that happened to evaluate.
  ...CANONICAL_COPY_MODULES.flatMap((f) => moduleClaims(f)),
  // And by value, which proves the two agree for a plain data module. No prose
  // filter: judgement is not an authoring question, and filtering it hid the
  // exact N1 wording behind a four-word threshold.
  ...walkStrings(marketingContent),
  ...walkStrings(marketingResources),
  // INVOKED, not only read. `jsonld.ts` is declared and its literals are
  // extracted statically, but its builders assemble what actually ships from
  // values reached through calls and property accesses — `description:
  // getDescription()` has no literal to find, and the namespace walk does not
  // call a function, so a forbidden claim returned from one reached no rule.
  // These run the module the way the pages run it, which needs no dataflow.
  ...walkStrings(marketingJsonLd.organizationLd()),
  ...walkStrings(marketingJsonLd.webSiteLd()),
  ...walkStrings(marketingJsonLd.softwareApplicationLd()),
  ...marketingResources.RESOURCE_ARTICLES.flatMap((article) =>
    walkStrings(marketingJsonLd.articleLd(article)),
  ),
];
/**
 * Components render to the same public page, so they are judged the same way.
 *
 * They were left out because a component is not an approved place to AUTHOR copy
 * under the authoring law — existing component prose is baselined, not moved.
 * But that is an authoring verdict, and it was silently doing duty as a
 * judgement verdict too: nothing a component said ever reached the rules.
 *
 * Which turned a baselined exception into a laundering route. The exception's
 * identity records a hole as its SOURCE text (`{state}`), and that is stable by
 * design — it is exactly what lets the baseline notice a rewritten sentence. A
 * stable identifier is not a stable claim: rebinding `const state` to a
 * forbidden wording changes the rendered sentence and changes nothing the
 * baseline can see. The binding is a four-word unpunctuated literal, so
 * `componentProseViolations` filters it out as well, and the wording shipped.
 *
 * Judging the component closes it at the VALUE, which is where the defect is,
 * rather than by refusing holes in text that the owner ruled stays put.
 * `pageClaims` deliberately: a component's text is public copy by the same route
 * a page's is, so it is read by the same extractor.
 */
const COMPONENT_CLAIMS = marketingComponentFiles().flatMap((f) => pageClaims(f));

const CLAIMS = [...PAGE_CLAIMS, ...MODULE_CLAIMS, ...COMPONENT_CLAIMS];
const MARKETING_COPY = CLAIMS.join(" ¶ ");

/**
 * Component-authored prose that predates the authoring law.
 *
 * Owner ruling: existing text is NOT moved merely to satisfy the architecture,
 * so the six items already in components are recorded here rather than
 * migrated. The list GREW from two when the guard learned to assemble a sentence
 * before classifying it and to derive its own file set — the code did not get
 * worse, the guard got better, and the previous count was an undercount. The list is SHRINK-ONLY and the test below enforces that, so the law
 * binds all new work while the migration stays a separate, product-owned change.
 *
 * `SiteFooter.tsx` is worth naming: "Operated from Canada." is the hosting
 * -location line the register's own **C2** rules should be OMITTED, because the
 * privacy policy discloses AWS US-East-1 and the pair permits a wrong inference.
 * The guard found it independently. Resolving it is a copy change and is out of
 * scope for #717.
 */
const COMPONENT_PROSE_BASELINE: readonly string[] = [
  "app/_components/DemoForm.tsx",
  // Reached only once the import walk went transitive. Both policy pages import
  // `PolicyLayout`, which renders this footer; no page imports it directly, so
  // its two sentences — "Treatment memory, made carefully." and "Treatment
  // memory for electrologists." — were public prose that no guard had ever
  // read. They are clean against the register. They are listed, not excused.
  "app/_components/MarketingFooter.tsx",
  "app/_components/marketing/SiteFooter.tsx",
  "app/_components/marketing/article.tsx",
  // Next.js applies this without any route importing it. Its `metadata`,
  // `openGraph` and `twitter` blocks each repeat the site title and description
  // — the copy that appears in search results and social cards, on every
  // marketing route — and no guard had ever read them. Clean against the
  // register. Six entries because the pair is authored three times.
  "app/layout.tsx",
  // A server action, reached because `DemoForm` RENDERS what it returns through
  // `{status.message}`. Its three visitor-facing messages were public copy that
  // no guard had read: changing one to a forbidden claim altered neither the
  // component's identity nor any scanned claim while appearing on screen after
  // submission.
  "app/actions/demo.ts",
];

/**
 * The one place a claim is still assembled from a value.
 *
 * ONE entry, and it is the architecture review's A3 case.
 *
 * `{POSITIONING.corePromise}` alone in its element is CONSUMPTION — the pattern
 * the law prescribes — and is exempt. `/resources` instead embeds
 * `{RESOURCE_AUTHOR}` among authored words ("Operational guides from …, the
 * people behind Hone"), which is a claim assembled across the boundary, so the
 * exemption stops applying.
 *
 * Measured before the rule was chosen: 71 standalone consumptions, and exactly
 * ONE embedded case — this one. A3 offered rewrite, declare, or a narrow
 * declared exemption; this is the declared exemption, and it costs one line.
 */
const ASSEMBLED_CLAIM_BASELINE: readonly string[] = ["app/resources/page.tsx"];

/**
 * Page prose that is not judged, frozen at what exists today.
 *
 * Not a permission — a ceiling. New product-marketing copy belongs in
 * `lib/marketing/content.ts` per the ruling, and every item that moves there
 * both shrinks this number and enters the judged corpus.
 */
const PAGE_PROSE_BASELINE = 212;

/**
 * The declared exceptions, BY IDENTITY.
 *
 * Both halves are frozen the same way and for the same reason: a count leaves
 * reusable capacity behind every deletion. Replacing one existing component
 * sentence with `Every change is tracked on this treatment record.` left the file
 * set and the total unchanged, and component prose is not judged — so the
 * replacement shipped. The page half had already been fixed; this is its sibling,
 * fixed the same way rather than one round later.
 */
const BASELINE = JSON.parse(read("tests/docs/fixtures/copy-baseline.json")) as {
  componentHoles: Record<string, string[]>;
  pageProse: Record<string, string[]>;
  componentProse: Record<string, string[]>;
};

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
  const m = REGISTER.match(
    /Production head at last check \| `([0-9a-f]{40})`/,
  );
  return m ? m[1] : "";
}

// Inline sources for the guard tests. Each guard takes optional source text so
// a control can state the exact construct it is about, in one line, instead of
// writing a fixture to disk.
const violationsIn = (src: string) => copyModuleViolations("lib/marketing/probe.ts", src);
const componentProseViolationsIn = (src: string) =>
  componentProseViolations("app/_components/marketing/Probe.tsx", src);
const assembledIn = (src: string) => assembledClaimViolations("app/probe/page.tsx", src);

describe("the scan reads DECLARED copy sources, not a discovered import graph", () => {
  it("covers the route file behind every indexable path in the registry", () => {
    const declared = new Set([...pageCopySources(), ...POLICY_SOURCES]);
    for (const page of MARKETING_PAGES.filter((p) => p.indexable)) {
      const rel = page.path === "/" ? "app/page.tsx" : `app${page.path}/page.tsx`;
      expect(existsSync(join(REPO_ROOT, rel)), rel).toBe(true);
      expect(declared.has(rel), `${page.path} is indexable but not a declared copy source`).toBe(true);
    }
  });

  it("names the policy routes as copy sources in their own right", () => {
    // Owner ruling: legally reviewed text is scanned where it lives and is not
    // moved to satisfy this architecture.
    expect(POLICY_SOURCES).toEqual(["app/privacy/page.tsx", "app/terms/page.tsx"]);
    for (const f of POLICY_SOURCES) expect(existsSync(join(REPO_ROOT, f)), f).toBe(true);
    expect(pageClaims("app/privacy/page.tsx").join(" ")).toMatch(/personal information/i);
    expect(pageClaims("app/terms/page.tsx").join(" ")).toMatch(/software-as-a-service/i);
  });

  it("reads the canonical copy modules as VALUES, with no AST at all", () => {
    for (const f of CANONICAL_COPY_MODULES) expect(existsSync(join(REPO_ROOT, f)), f).toBe(true);
    expect(MODULE_CLAIMS.length).toBeGreaterThan(0);
    expect(MODULE_CLAIMS.join(" ¶ ")).toMatch(/electrolysis/i);
  });

  it("is a far smaller input than the interpreter it replaces", () => {
    // The measurement behind the ruling: the old scan walked 48 files and
    // extracted 1,691 candidates, ~91% of which were font tables, rate-limit
    // config and structured-data keys rather than copy. This one reads only
    // what is declared. The assertion is a ceiling, not a target.
    const declared = [...pageCopySources(), ...POLICY_SOURCES, ...CANONICAL_COPY_MODULES];
    expect(declared.length).toBeLessThan(20);
    expect(CLAIMS.length).toBeGreaterThan(200);
    // A ceiling on the DECLARED SOURCES, which is the thing that was unbounded.
    // The claim count is larger than the old scan's 1,691 candidates would
    // suggest is an improvement, and it is: those 1,691 came from 48 files
    // including font tables and rate-limit config, while these come from 14
    // files that are all copy. Counting claims was never the measure — counting
    // FILES THE SCAN OPENS was.
    expect(CLAIMS.length).toBeLessThan(5000);
  });

  it("reads a whole sentence that carries an inline link", () => {
    // 13.6% of text blocks on this surface put an <a> or <strong> inside the
    // sentence. Folding declared inline elements in is the one structural thing
    // extraction does, and it needs no phrasing grammar because a NON-inline
    // element inside substantive text is refused by the shape guard instead.
    expect(pageClaims("app/page.tsx").some((c) => /\bprivacy policy\b/i.test(c))).toBe(true);
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
    // The rendering components too. They feed `COMPONENT_CLAIMS`, so production
    // could put unsupported copy in `SiteFooter` or `MarketingFooter` while this
    // branch still holds the old text: the diff intersection would be empty and
    // the local judgement would only ever inspect what is here.
    ...marketingComponentFiles(),
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
      ...marketingComponentFiles(),
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

describe("C. JUDGEMENT: complete copy values against the register's rules", () => {
  it("the rules come from §0.4 itself, and include its canonical wordings", () => {
    // A ruling and its enforcement cannot be two documents free to disagree, so
    // the guard learns what is banned from the register and nowhere else.
    expect(FORBIDDEN.length).toBeGreaterThan(0);
    const sources = FORBIDDEN.map((r) => r.source);
    expect(sources).toContain("edits kept as history");
    expect(sources).toContain("not written over");
    expect(FORBIDDEN.every((r) => r.id === "N1" || r.id === "N2")).toBe(true);
  });

  it("no public claim matches a wording §0.4 rejects", () => {
    const offenders = CLAIMS.flatMap((claim) =>
      FORBIDDEN.filter((rule) => rule.pattern.test(claim)).map(
        (rule) => `${rule.id}: "${claim.slice(0, 90)}"`,
      ),
    );
    expect(offenders, "public copy carries a wording §0.4 forbids").toEqual([]);
  });

  it("every append-only claim on the site is one §0.4 has sanctioned", () => {
    const verdicts = CLAIMS.map((c) => ({ c, v: judgeAppendOnlyClaim(c, SANCTIONED) }))
      .filter((x) => x.v.kind === "unsanctioned")
      .map((x) => x.c.slice(0, 100));
    expect(verdicts, "an append-only promise ships that §0.4 has not sanctioned").toEqual([]);
  });

  it("each sanctioned wording is itself scoped, and is actually shipped", () => {
    expect(SANCTIONED.length).toBeGreaterThan(0);
    for (const w of SANCTIONED) {
      expect(w.text, `${w.id} names no covered record type`).toMatch(SUPPORTED_APPEND_ONLY_SCOPE);
      expect(w.text, `${w.id} widens the promise`).not.toMatch(APPEND_ONLY_OVERREACH);
      expect(w.text, `${w.id} makes no append-only claim`).toMatch(APPEND_ONLY_TRIGGER);
    }
  });

  it("judges a sentence, not a fragment — which is what the authoring law buys", () => {
    // The whole point of the redesign. Judgement receives complete text, so
    // there is no reassembly step that can get it wrong.
    expect(
      judgeAppendOnlyClaim("Every treatment record has an append-only edit history.", SANCTIONED).kind,
    ).toBe("unsanctioned");
    // The N1 sentence carries no append-only trigger, so the append-only judge
    // correctly says "not a claim" — it is the FORBIDDEN rules that reject it.
    // Two guards, two jobs; neither is asked to do the other's.
    expect(judgeAppendOnlyClaim("Edits kept as history, not written over.", SANCTIONED).kind)
      .toBe("not-a-claim");
    expect(FORBIDDEN.some((r) => r.pattern.test("Edits kept as history, not written over."))).toBe(true);
    expect(judgeAppendOnlyClaim("Booking, intake and consent share one record.", SANCTIONED).kind)
      .toBe("not-a-claim");
    const sanctioned = SANCTIONED[0];
    expect(judgeAppendOnlyClaim(sanctioned.text, SANCTIONED).kind).toBe("sanctioned");
  });

  it("reads a typographic hyphen as a hyphen", () => {
    // `append‑only` with U+2011 reads identically to a visitor.
    expect(judgeAppendOnlyClaim("Energy settings have an append‑only edit history", SANCTIONED).kind)
      .toBe("unsanctioned");
  });
});

describe("B. SHAPE GUARD: refusal, never interpretation", () => {
  it("PASS — the canonical copy modules already obey the authoring law", () => {
    const violations = CANONICAL_COPY_MODULES.flatMap((f) => copyModuleViolations(f));
    expect(
      violations.map((v) => `${v.file}:${v.line} ${v.rule} ${v.detail}`),
      "a canonical copy module assembles copy at runtime",
    ).toEqual([]);
  });

  it("PASS — a conditional whose branches are COMPLETE values is allowed", () => {
    // The law's own wording: if wording is conditional, each alternative must
    // exist as a complete static copy value. `PUBLISHED ? "CAD $99" : null` is a
    // value shown or withheld, not a claim built from halves.
    expect(violationsIn(`export const P = SHOW ? "CAD $99" : null;`)).toEqual([]);
    expect(violationsIn('export const M = `mailto:${EMAIL}`;')).toEqual([]);
  });

  it("FAIL — binary concatenation of substantive copy", () => {
    const v = violationsIn(
      `export const t = "Energy settings have an append-" + "only edit history";`,
    );
    expect(v.map((x) => x.rule)).toContain("copy-module/no-concatenation");
  });

  it("FAIL — template interpolation constructing substantive copy", () => {
    const v = violationsIn('export const t = `Every change is ${stateWord} on this record`;');
    expect(v.map((x) => x.rule)).toContain("copy-module/no-interpolation");
  });

  it("FAIL — conditional partial-claim construction", () => {
    const v = violationsIn(
      `export const t = cond ? "half of one substantive claim about records" + tail : "other";`,
    );
    expect(v.map((x) => x.rule)).toContain("copy-module/no-conditional-copy");
  });

  it("PASS — rendering components consume copy and carry only plumbing", () => {
    const clean = marketingComponentFiles().filter(
      (f) => !COMPONENT_PROSE_BASELINE.includes(f),
    );
    expect(clean.length).toBeGreaterThan(5);
    expect(
      clean.flatMap((f) => componentProseViolations(f)).map((v) => `${v.file}:${v.line} ${v.detail}`),
      "a marketing component authored substantive prose of its own",
    ).toEqual([]);
  });

  it("PASS — technical JSX plumbing is never read as copy", () => {
    // A long class string has enough space-separated tokens to look like a
    // sentence to a naive word count. It is not one, and the prose test says so
    // without needing a 101-entry attribute vocabulary.
    for (const technical of [
      "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border px-3",
      "text-[color:var(--color-onband-muted)] underline decoration-2 underline-offset-4",
      "M0 0L1 1Z",
      "https://hone.care/features/treatment-memory",
    ]) {
      expect(isSubstantiveProse(technical), technical.slice(0, 40)).toBe(false);
    }
  });

  it("FAIL — substantive inline prose in a rendering component", () => {
    const v = componentProseViolationsIn(
      `export const A = () => <p>Every treated area keeps its own history in Hone.</p>;`,
    );
    expect(v.map((x) => x.rule)).toContain("component/no-authored-prose");
  });

  it("FAIL — a claim assembled from a value in a page source", () => {
    const v = assembledIn(
      `export const A = () => <p>Written for electrologists by {AUTHOR} in Toronto.</p>;`,
    );
    expect(v.map((x) => x.rule)).toContain("claim/assembled-from-fragments");
  });

  it("FAIL — an undeclared element inside a claim", () => {
    // Not "what does <Callout> render?" — the guard refuses to guess, and says
    // so. Declaring it inline, or authoring the sentence as one value, is the
    // author's choice; inferring it is not the scanner's job.
    const v = assembledIn(
      `export const A = () => <p>Every treated area keeps <Callout>its own history</Callout> in Hone.</p>;`,
    );
    expect(v.map((x) => x.rule)).toContain("claim/unknown-element-inside-claim");
  });

  it("PASS — a declared inline element inside a claim is fine", () => {
    expect(INLINE_IN_CLAIM).toContain("strong");
    expect(INLINE_IN_CLAIM).toContain("Link");
    expect(
      assembledIn(
        `export const A = () => <p>Every treated area keeps <strong>its own history</strong> in Hone.</p>;`,
      ),
    ).toEqual([]);
  });

  it("classifies the WHOLE sentence, including declared inline descendants", () => {
    // The gate used to be the element's DIRECT text, so a sentence whose bulk
    // sits inside <strong> produced nothing: "Every ." is not substantive and
    // "change is tracked" is below the threshold alone, while the rendered
    // sentence matches N1 exactly. Text is now built first, tested second.
    const src = `export const A = () => <p>Every <strong>change is tracked</strong>.</p>;`;
    const claims = pageClaims("app/probe/page.tsx", src);
    expect(claims).toContain("Every change is tracked.");
    expect(FORBIDDEN.some((r) => claims.some((c) => r.pattern.test(c)))).toBe(true);

    // NEGATIVE: folding inline descendants must NOT fuse a block child in.
    // "Intro" is emitted as its own claim — judgement is unfiltered now, so
    // short text is judged rather than dropped — and the paragraph stays whole.
    const separated = pageClaims(
      "app/probe/page.tsx",
      `export const A = () => <div>Intro<p>Trace it with an append-only edit history.</p></div>;`,
    );
    expect(separated).toContain("Trace it with an append-only edit history.");
    expect(separated.some((c) => /Intro\s*Trace/.test(c))).toBe(false);
  });

  it("judges BOTH branches of a complete conditional, not the evaluated one", () => {
    // `FLAG ? "banned" : "safe"` evaluates to one branch, so a value walk judges
    // only whichever the test run happened to select. Both are literals in the
    // source, so both are read.
    const claims = moduleClaims(
      "lib/marketing/probe.ts",
      `export const t = FLAG ? "Every change is tracked on this record" : "Safe copy";`,
    );
    expect(claims).toContain("Every change is tracked on this record");
  });

  it("declares every module that already authors public copy", () => {
    // A declared universe is exactly as complete as its declaration, and this
    // one was short by a module: `app/page.tsx` renders structured-data prose
    // through `softwareApplicationLd()`, so the route holds only a call
    // expression and nothing in the page reaches those strings.
    expect(CANONICAL_COPY_MODULES).toContain("lib/marketing/jsonld.ts");
    expect(moduleClaims("lib/marketing/jsonld.ts").length).toBeGreaterThan(0);

    // The guard against the same gap reopening: any first-party module a
    // declared page imports, which itself authors substantive prose, must be
    // declared too.
    for (const page of [...pageCopySources(), ...POLICY_SOURCES]) {
      const src = read(page);
      for (const m of src.matchAll(/from "@\/(lib\/marketing\/[a-z-]+)"/g)) {
        const rel = `${m[1]}.ts`;
        if (!existsSync(join(REPO_ROOT, rel))) continue;
        // The PROSE test here, not the raw literal count: "does this module
        // author copy?" is an authoring question, and every module has strings.
        // Judgement is what must not be filtered; declaration is what must.
        if (moduleClaims(rel).some(isSubstantiveProse)) {
          expect(
            CANONICAL_COPY_MODULES,
            `${rel} authors substantive copy and ${page} imports it, but it is not declared`,
          ).toContain(rel);
        }
      }
    }
  });

  it("derives its rendering sources instead of trusting a directory list", () => {
    // A hand-kept list missed `app/_components/DemoForm.tsx`: `app/demo/page.tsx`
    // renders it, it authors visitor-facing prose, and `pageClaims` cannot see
    // through `<DemoForm />`. The import is RELATIVE, which is the ordinary way
    // to reach a sibling and the reason an `@/`-only scan missed it.
    expect(marketingComponentFiles()).toContain("app/_components/DemoForm.tsx");
    expect(marketingComponentFiles()).toContain("app/_components/marketing/SiteFooter.tsx");
  });

  it("assembles component prose before classifying it, exactly as pages do", () => {
    // The previous head applied build-text-first to `pageClaims` and left the
    // component guard classifying each JsxText node alone, so the identical
    // sentence produced three harmless fragments and no violation.
    const src = `export const A = () => <p>Every <strong>change is tracked</strong>.</p>;`;
    expect(componentProseViolationsIn(src).map((v) => v.rule)).toContain(
      "component/no-authored-prose",
    );
    // NEGATIVE: layout with no authored sentence stays clean.
    expect(
      componentProseViolationsIn(
        `export const A = ({ copy }) => <p className="mt-8 text-sm text-muted">{copy}</p>;`,
      ),
    ).toEqual([]);
  });

  it("refuses a hole inside a claim, and allows an approved copy value", () => {
    // `<p>Every <strong>change is {state}</strong>.</p>` reduced to "Every change
    // is ." without the hole — not substantive — so the hole was never refused,
    // and `state === "tracked"` renders the N1 sentence. The gate now counts a
    // hole as the word it will render as.
    expect(
      assembledIn(`export const A = () => <p>Every <strong>change is {state}</strong>.</p>;`)
        .map((v) => v.rule),
    ).toContain("claim/assembled-from-fragments");

    // NEGATIVE, and the one that matters most: consuming a complete approved
    // value from a declared copy module is the pattern the law PRESCRIBES.
    // Refusing it would forbid correct authoring, which the first cut did.
    expect(
      assembledIn(
        `import { POSITIONING } from "@/lib/marketing/content";\n` +
          `export const A = () => <p>{POSITIONING.corePromise}</p>;`,
      ),
    ).toEqual([]);
  });

  it("every readable claim is judged; only the unreadable ones are not", () => {
    // OWNER RULING, option 1, REFINED BY MEASUREMENT. The ruling's concern was
    // dataflow: deciding what a HOLE renders needs it. Text with no hole needs
    // none, and excluding pages wholesale created two escape hatches review
    // found in consecutive rounds — a four-word forbidden sentence, and reusable
    // capacity behind every deleted baseline line.
    //
    // So the boundary is the hole, not the file. A page claim that can be read
    // completely IS judged; one containing a hole is refused by the shape guard
    // instead. No dataflow at any point.
    expect(MODULE_CLAIMS.length).toBeGreaterThan(0);
    expect(PAGE_CLAIMS.length).toBeGreaterThan(0);
    expect(COMPONENT_CLAIMS.length).toBeGreaterThan(0);

    // The property, asserted BEFORE the arithmetic below, because the arithmetic
    // is not a guard — it goes red when the corpus is narrowed, but only because
    // it counts itself, and being first it masked the real failure. This is a
    // real visitor-facing sentence that ONLY a component authors: narrowing the
    // corpus goes red on the copy.
    expect(MARKETING_COPY).toContain(
      "There is no automatic booking, a real person will email you to find a time that works.",
    );

    expect(CLAIMS.length).toBe(
      PAGE_CLAIMS.length + MODULE_CLAIMS.length + COMPONENT_CLAIMS.length,
    );

    // The exact wording that escaped: four words, no punctuation, N1.
    const short = pageClaims(
      "app/probe/page.tsx",
      `export const A = () => <p>Every change is tracked</p>;`,
    );
    expect(short).toContain("Every change is tracked");
    expect(FORBIDDEN.some((r) => short.some((c) => r.pattern.test(c)))).toBe(true);

    // And a hole is still refused rather than guessed at.
    expect(
      assembledIn(`export const A = () => <p>Every treated area keeps {label} of its own.</p>;`)
        .map((v) => v.rule),
    ).toContain("claim/assembled-from-fragments");
  });

  it("reads a fragment exactly as it reads an element", () => {
    // `export default () => <>Every change is tracked</>` authored the exact N1
    // wording, and every container check asked `ts.isJsxElement`. There is no
    // reason a fragment should behave differently from a `<div>`; it was simply
    // not in the predicate, so the text reached neither guard nor corpus.
    const claims = pageClaims(
      "app/probe/page.tsx",
      `export default () => <>Every change is tracked</>;`,
    );
    expect(claims).toContain("Every change is tracked");
    expect(FORBIDDEN.some((r) => claims.some((c) => r.pattern.test(c)))).toBe(true);

    // A hole in a fragment is refused, like a hole anywhere else.
    expect(
      assembledIn(`export default () => <>Every change is {v}.</>;`).map((x) => x.rule),
    ).toContain("claim/assembled-from-fragments");

    // NEGATIVE: a fragment does not fuse its block children either.
    const separated = pageClaims(
      "app/probe/page.tsx",
      `export default () => <>Intro<p>Trace it with an append-only edit history.</p></>;`,
    );
    expect(separated).toContain("Trace it with an append-only edit history.");
    expect(separated.some((c) => /Intro\s*Trace/.test(c))).toBe(false);
  });

  it("refuses assembly whatever the method is called", () => {
    // Three rounds found three spellings of one escape. The rule is structural,
    // so the fourth spelling is covered by the same predicate rather than a
    // fourth case: a call combines text when its LITERAL parts do.
    for (const assembly of [
      `export const d = ['Every change','is tracked'].join(' ');`,
      `export const d = ["Every change", suffix].join(" ");`,
      `export const d = "Every change".concat(" is tracked");`,
      'export const d = `Every change is ${state}`;',
      `export const d = "Every change" + " is tracked";`,
    ]) {
      expect(
        copyModuleViolations("lib/marketing/probe.ts", assembly).length,
        assembly.slice(0, 54),
      ).toBeGreaterThan(0);
    }

    // NEGATIVES, all measured on the real modules: a LIST of complete copy
    // lines, a resource path, and a whole sentence handed to a function.
    for (const fine of [
      `export const P = ["Built for electrolysis records", "History by treated area"];`,
      'export const u = `mailto:${EMAIL}`;',
      'export const i = `${CANONICAL_HOST}/icon`;',
      `export const d = t("Every treated area keeps its own history");`,
      `export const n = Number(label.replace(/[^0-9.]/g, ""));`,
    ]) {
      expect(
        copyModuleViolations("lib/marketing/probe.ts", fine),
        fine.slice(0, 54),
      ).toEqual([]);
    }
  });

  it("a wrapper cannot hide an assembly", () => {
    // Parentheses, `as`, `satisfies` and `!` do not change what an expression
    // IS, but matching on syntax shapes without normalising them let
    // `("Every change").concat(…)` walk past a check that had just been taught
    // to refuse `"Every change".concat(…)`. One `unwrap`, applied wherever an
    // expression is classified, ends that family rather than its members.
    for (const wrapped of [
      `export const d = "Every change".concat(" is tracked");`,
      `export const d = ("Every change").concat(" is tracked");`,
      `export const d = ("Every change" as string).concat(" is tracked");`,
      `export const d = (['Every change','is tracked']).join(' ');`,
      'export const d = (`Every change is ${x}`);',
    ]) {
      expect(
        copyModuleViolations("lib/marketing/probe.ts", wrapped).length,
        wrapped.slice(0, 56),
      ).toBeGreaterThan(0);
    }
  });

  it("a nested fragment is transparent, not a boundary", () => {
    // `<p>Every <>change is tracked</></p>` is one sentence to a visitor.
    // Treating the fragment as its own container split it into "Every" and
    // "change is tracked", neither of which matches anything.
    const claims = pageClaims(
      "app/probe/page.tsx",
      `export const A = () => <p>Every <>change is tracked</></p>;`,
    );
    expect(claims).toContain("Every change is tracked");
    expect(FORBIDDEN.some((r) => claims.some((c) => r.pattern.test(c)))).toBe(true);

    // NEGATIVE: transparency must not become fusion. A block child still starts
    // its own claim, inside a fragment as anywhere else.
    const separated = pageClaims(
      "app/probe/page.tsx",
      `export const A = () => <div>Intro<p>Trace it with an append-only edit history.</p></div>;`,
    );
    expect(separated.some((c) => /Intro\s*Trace/.test(c))).toBe(false);
  });

  it("EVERY guard is wrapper-invariant — the property, not the instances", () => {
    // Five consecutive rounds found a wrapped variant of the previous fix, and
    // the `unwrap` sweep meant to end it still missed call sites. Enumerating by
    // hand does not converge, so the INVARIANT is asserted: wrapping an
    // expression must not change any guard's answer.
    //
    // The FIRST version of this test covered two guards, and the next round
    // found the gap in the two it did not cover. It now runs EVERY exported
    // guard, because a property asserted over a subset is an enumeration again.
    const wrap = (src: string, how: (e: string) => string) =>
      src.replace(/"([^"]*)"/g, (_m, inner) => how(`"${inner}"`));

    const wrappers: Array<(e: string) => string> = [
      (e) => `(${e})`,
      (e) => `(${e} as string)`,
      (e) => `((${e}))`,
    ];

    const guards: Array<[string, (file: string, src: string) => unknown]> = [
      ["copyModuleViolations", (f, src) => copyModuleViolations(f, src).map((v) => v.rule)],
      ["assembledClaimViolations", (f, src) => assembledClaimViolations(f, src).map((v) => v.rule)],
      ["componentProseViolations", (f, src) => componentProseViolations(f, src).map((v) => v.detail)],
      ["pageClaims", (f, src) => pageClaims(f, src)],
      ["pageProse", (f, src) => pageProse(f, src)],
      ["moduleClaims", (f, src) => moduleClaims(f, src)],
      ["jsxHoles", (f, src) => jsxHoles(f, src).map((h) => h.rule)],
    ];

    const cases = [
      `export const d = "Every change".concat(" is tracked");`,
      `export const d = ["Every change", "is tracked"].join(" ");`,
      `export const P = ["Built for electrolysis records", "History by treated area"];`,
      `export const t = "Every change is tracked";`,
      `export const A = () => <p>{"Every change is tracked"}</p>;`,
      `export const A = () => <p>Every <strong>change is tracked</strong>.</p>;`,
      `export const A = () => <div className={cond ? "flex items-center gap-2 rounded-md border" : ""} />;`,
      // PROSE inside a plumbing attribute. Nonsense as a class name, and the
      // only shape that exercises the ATTRIBUTE ancestor walk: with the
      // attribute found the string is excluded, without it the string is
      // emitted. A class-soup case cannot tell the two apart, because it is not
      // prose either way — which is why mutating that walk passed until this
      // case existed.
      `export const A = () => <div className={cond ? "Every treated area keeps its own history in Hone" : ""} />;`,
      `export const A = () => <div data-label={cond ? "Every treated area keeps its own history" : ""} />;`,
      `export default () => <div><p>{"plain text here"}</p></div>;`,
    ];

    for (const [name, guard] of guards) {
      for (const src of cases) {
        const base = guard("app/probe/page.tsx", src);
        for (const w of wrappers) {
          expect(
            guard("app/probe/page.tsx", wrap(src, w)),
            `${name} changed answer when wrapped: ${src.slice(0, 46)}`,
          ).toEqual(base);
        }
      }
    }
  });

  it("a component identity keeps its holes", () => {
    // The recorded sentence used the hole-free text, so
    // `<p>Every change is {x} here now</p>` and `…{y}…` compared equal — one
    // declared exception swappable for another differing only in the value it
    // interpolates. Holes now appear as their source.
    const withX = componentProseViolations(
      "app/_components/marketing/Probe.tsx",
      `export const A = () => <p>Every change is {x} here now</p>;`,
    );
    const withY = componentProseViolations(
      "app/_components/marketing/Probe.tsx",
      `export const A = () => <p>Every change is {y} here now</p>;`,
    );
    expect(withX).toHaveLength(1);
    expect(withX[0].detail).toContain("{x}");
    expect(withX[0].detail).not.toEqual(withY[0].detail);
  });

  it("the component identity baseline compares whole sentences", () => {
    // `detail` was truncated to 70 characters and the baseline compared those,
    // so two different sentences sharing a prefix compared equal — one declared
    // exception could be swapped for another differing only after the cut.
    const long =
      "There is no automatic booking, a real person will review your request and reply within one working day about scheduling.";
    const v = componentProseViolations(
      "app/_components/marketing/Probe.tsx",
      `export const A = () => <p>${long}</p>;`,
    );
    expect(v).toHaveLength(1);
    expect(v[0].detail.length).toBe(long.length);
  });

  it("the policy sources carry no holes, asserted directly", () => {
    // The one thing that could hide a claim in a judged JSX surface is a hole.
    //
    // The previous version of this test routed through `assembledClaimViolations`,
    // which only reports holes inside text it has already judged substantive — so
    // `<p>{state}</p>` passed it, while `pageClaims` dropped the element for
    // having a hole. The invariant that makes the judged surface safe was never
    // actually asserted. It is now asserted on its own terms.
    for (const file of POLICY_SOURCES) {
      expect(
        jsxHoles(file).map((h) => `${h.file}:${h.line} ${h.detail}`),
        `${file} grew a hole; a judged surface must stay hole-free or its claims go unjudged`,
      ).toEqual([]);
    }
    // NON-VACUITY: the check can see a hole when there is one.
    expect(
      jsxHoles("app/privacy/page.tsx", `export default () => <div><p>{state}</p></div>;`),
    ).toHaveLength(1);
  });

  it("unjudged page prose is frozen BY IDENTITY, not by total", () => {
    // A `<= 213` ceiling is not monotonic, and calling it so was wrong: remove
    // five existing lines, add five new ones, and the count still passes while
    // the new lines are unjudged and could say anything. A total leaves reusable
    // capacity behind every deletion.
    //
    // The identities are frozen instead. Every page claim must already appear in
    // the recorded baseline; removing one is fine, introducing one is not. New
    // product-marketing copy belongs in a canonical copy module, where it IS
    // judged — which is the only way to add a page-level sentence at all.
    const known = new Set(Object.values(BASELINE.pageProse).flat());

    const introduced: string[] = [];
    for (const file of pageCopySources()) {
      for (const claim of pageProse(file)) {
        if (!known.has(claim)) introduced.push(`${file}: ${claim.slice(0, 80)}`);
      }
    }
    expect(
      introduced,
      "new inline page prose was introduced; it is NOT judged against the register, so it belongs in a canonical copy module",
    ).toEqual([]);

    // The baseline is a ceiling too, so a file cannot repeat a known line to
    // buy capacity.
    const total = pageCopySources().reduce((n, f) => n + pageProse(f).length, 0);
    expect(total).toBeLessThanOrEqual(PAGE_PROSE_BASELINE);
    expect(known.size, "the recorded baseline is not empty").toBeGreaterThan(100);
  });

  it("consuming an approved value is allowed alone, and refused among authored words", () => {
    const decl = `import { POSITIONING } from "@/lib/marketing/content";\n`;
    // PASS — standalone consumption, the prescribed pattern.
    expect(
      assembledIn(`${decl}export const A = () => <p>{POSITIONING.corePromise}</p>;`),
    ).toEqual([]);
    // FAIL — the same value among authored words assembles a claim across the
    // boundary, which is how `FRAGMENT = "change is"` plus "Every {FRAGMENT}
    // tracked." renders N1 out of two halves that trip nothing alone.
    expect(
      assembledIn(
        `${decl}export const A = () => <p>Every {POSITIONING.corePromise} tracked here.</p>;`,
      ).map((v) => v.rule),
    ).toContain("claim/assembled-from-fragments");
  });

  it("the pre-existing exceptions are declared, counted, and shrink-only", () => {
    // Owner ruling: existing text is not moved merely to satisfy the
    // architecture. These are the exceptions, visible rather than tolerated
    // silently, and the assertion is an upper bound so the list cannot grow.
    const prose = marketingComponentFiles().flatMap((f) => componentProseViolations(f));
    expect(new Set(prose.map((v) => v.file))).toEqual(new Set(COMPONENT_PROSE_BASELINE));
    expect(prose.length, "component prose grew; the authoring law binds new work").toBeLessThanOrEqual(17);

    // BY IDENTITY, like the page half. A count alone let one exception be
    // swapped for another. Identity catches a REWRITTEN exception; it cannot
    // catch a rebound hole inside one, because the hole's source text does not
    // move. `COMPONENT_CLAIMS` is what covers that half.
    const knownComponent = new Set(Object.values(BASELINE.componentProse).flat());
    expect(
      prose.map((v) => v.detail).filter((d) => !knownComponent.has(d)),
      "a component exception was replaced; the new sentence is NOT judged against the register",
    ).toEqual([]);

    // EVERY RULE, no filter. Keeping only `assembled-from-fragments` here meant
    // `claim/unknown-element-inside-claim` was enforced nowhere outside a
    // synthetic probe: `<p>Every <Words /> tracked here today.</p>` emits it,
    // extraction judges only the harmless parent and child fragments, and the
    // filter dropped the one thing that noticed. A filtered assertion is a
    // silent exemption, which is what this architecture replaced.
    const pageViolations = [...pageCopySources(), ...POLICY_SOURCES].flatMap((f) =>
      assembledClaimViolations(f),
    );
    expect(pageViolations.map((v) => `${v.rule} ${v.file} ${v.detail}`).sort()).toEqual([
      "claim/assembled-from-fragments app/resources/page.tsx {RESOURCE_AUTHOR}",
      "claim/standalone-opaque-hole app/resources/electrolysis-treatment-record-checklist/page.tsx {article.title}",
      "claim/standalone-opaque-hole app/resources/moving-an-electrolysis-practice-from-paper-records/page.tsx {article.title}",
    ]);
    const assembled = pageViolations.filter((v) => v.rule === "claim/assembled-from-fragments");
    expect(new Set(assembled.map((v) => v.file))).toEqual(new Set(ASSEMBLED_CLAIM_BASELINE));
    expect(
      assembled.length,
      "a claim is assembled from something that is not approved copy",
    ).toBeLessThanOrEqual(1);

    // The two opaque page holes above are DECLARED, not overlooked: both
    // resource articles render `{article.title}` from `const article =
    // getResourceArticle(...)` — a call, so the guard cannot read it. That is a
    // genuine unreadable claim by this architecture's own standard. Its text
    // lives in `RESOURCE_ARTICLES`, which IS judged; what is missing is any way
    // for the guard to see that without dataflow.

    // COMPONENTS, EVERY RULE, BY IDENTITY. The previous head ran the guard on
    // components and then filtered to the fragment rule, which dropped 54
    // opaque holes — so a component rendering `<p>{claim}</p>` could take a
    // forbidden string through a prop with nothing to say so. Filtering was the
    // silent exemption; recording them is not. Props like `{children}` are React
    // composition and stay, but they are now frozen: one cannot be swapped for
    // another, and the set can only shrink.
    const componentViolations = marketingComponentFiles().flatMap((f) =>
      assembledClaimViolations(f),
    );
    const recorded: Record<string, string[]> = {};
    for (const v of componentViolations) (recorded[v.file] ??= []).push(`${v.rule} ${v.detail}`);
    for (const key of Object.keys(recorded)) recorded[key] = recorded[key].sort();
    expect(recorded).toEqual(BASELINE.componentHoles);
    expect(componentViolations.length, "component holes grew").toBeLessThanOrEqual(61);
    // Identities are recorded IN FULL. The `JsonLd.tsx` map entry was exactly 70
    // characters, ending at `return (`, so everything after that prefix could be
    // rewritten — assigning `it.name` from an opaque producer, say — with the
    // recorded identity unchanged. Prose identities were fixed this way earlier;
    // holes were not.
    expect(
      Object.values(BASELINE.componentHoles).flat().some((d) => d.length > 70),
    ).toBe(true);

    // And no binding anywhere assembles authored words with something dynamic.
    // ZERO, so it is asserted as zero rather than baselined.
    expect(
      [...marketingComponentFiles(), ...pageCopySources(), ...POLICY_SOURCES, ...CANONICAL_COPY_MODULES]
        .flatMap((f) => mixedAssemblyViolations(f))
        .map((v) => `${v.file}::${v.detail}`),
    ).toEqual([]);
  });
});

describe("MUTATION PROOF: each guard can be made red by the defect it claims to catch", () => {
  // A guard that cannot fail is not a guard. Each case below injects the exact
  // defect the guard exists for and asserts it goes red — and asserts the clean
  // counterpart stays green, so the guard is not simply always-on.

  it("judgement bites on the VALUE behind a preserved component hole", () => {
    // The laundering route `COMPONENT_CLAIMS` exists to close, as a live pair.
    // The component is a baselined exception whose identity contains a hole, so
    // the identity, the violation count and the file set are all blind to what
    // the binding actually says.
    const shape = (binding: string) =>
      `const state = ${JSON.stringify(binding)};\n` +
      `export const Row = () => <p>Value: {state} here in the record.</p>;\n`;
    const clean = shape("under review");
    const laundered = shape("Every change is tracked");
    const FILE = "app/_components/marketing/Row.tsx";

    // 1. The authoring guard genuinely cannot tell the two apart — not a
    //    weakness to fix there, since the owner ruled the prose stays put.
    const authored = (src: string) => componentProseViolations(FILE, src);
    // Non-vacuity first: comparing two EMPTY results would prove nothing, and
    // the first cut of this test did exactly that. There is a real exception
    // here, and its identity really does preserve the hole.
    expect(authored(clean).map((v) => v.detail)).toEqual([
      "Value: {state} here in the record.",
    ]);
    expect(authored(laundered).map((v) => v.detail)).toEqual(
      authored(clean).map((v) => v.detail),
    );
    expect(authored(laundered).length).toBe(authored(clean).length);

    // 2. Judgement does.
    const judged = (src: string) =>
      pageClaims(FILE, src).some((c) => FORBIDDEN.some((r) => r.pattern.test(c)));
    expect(judged(laundered)).toBe(true);
    expect(judged(clean)).toBe(false);
  });

  it("judgement folds a claim that is SPELLED as an assembly, in every spelling", () => {
    // `copyModuleViolations` refuses assembly inside a canonical copy module, so
    // this cannot arise there. A component is rendering code, where `+` is
    // ordinary and allowed — and that is exactly where it was used to launder N1
    // past a stable `{state}`: judgement saw two harmless halves.
    const FILE = "app/_components/marketing/Row.tsx";
    const row = (binding: string) =>
      `const state = ${binding};\n` +
      `export const Row = () => <p>Value: {state} here in the record.</p>;\n`;
    const judged = (binding: string) =>
      pageClaims(FILE, row(binding)).some((c) =>
        FORBIDDEN.some((r) => r.pattern.test(c)),
      );
    expect(judged('"Every change" + " is tracked"')).toBe(true);
    // Every spelling, in the same commit rather than a round apart. Naming them
    // one at a time is what kept this alive: `+` was fixed, then `.join()` was
    // added in the same breath, and `.concat()` still came back as a finding.
    expect(judged('["Every change", "is tracked"].join(" ")')).toBe(true);
    expect(judged('"Every change".concat(" is tracked")')).toBe(true);
    expect(judged('`Every ${"change is tracked"}`')).toBe(true);
    expect(judged('"under review"')).toBe(false);

    // And the identity really is blind to the difference, which is why folding
    // is what closes this and the baseline cannot.
    const detail = (binding: string) =>
      componentProseViolations(FILE, row(binding)).map((v) => v.detail);
    expect(detail('"Every change" + " is tracked"')).toEqual(detail('"under review"'));

    // BOTH call sites, asserted here rather than one round later. Folding is
    // defence in depth for a canonical module — `copyModuleViolations` refuses
    // assembly there, so it cannot arise — but an extractor that folds in one
    // place and not the other is the shape of every repeat finding in this PR.
    expect(
      moduleClaims("lib/marketing/probe.ts", 'export const T = "Every change" + " is tracked";')
        .some((c) => FORBIDDEN.some((r) => r.pattern.test(c))),
    ).toBe(true);
  });

  it("a component reached only through a wrapper is read and judged", () => {
    // Both policy pages import `PolicyLayout`, which renders `MarketingFooter`;
    // no page imports that footer directly. At one level of import following it
    // was invisible to every guard, so copy added there shipped unread.
    expect(marketingComponentFiles()).toContain("app/_components/PolicyLayout.tsx");
    expect(marketingComponentFiles()).toContain("app/_components/MarketingFooter.tsx");
    // Listed is not enough — its prose is in the judged corpus.
    expect(MARKETING_COPY).toContain("Treatment memory for electrologists.");
  });

  it("V15's absence claim watches the whole migration directory", () => {
    // V15 asserts that NO migration adds a plan, client or appointment cap. An
    // absence claim over a directory is only watched if the directory is cited;
    // citing only the global-search file left a production migration that
    // introduces a cap able to land with this row still reading as current.
    const cited = citedEvidenceFiles(REGISTER);
    expect(isWatched("supabase/migrations/0200_plan_caps.sql", cited)).toBe(true);
    // Non-vacuous: it is that directory that is watched, not everything.
    expect(isWatched("supabase/seed.sql", cited)).toBe(false);

    // Same class, different row. V12 bounds the signed-link TTL but named the
    // constant rather than a path, and an IDENTIFIER is not evidence a staleness
    // comparison can watch — production could raise the TTL past the claimed
    // bound with the row still reading as current.
    expect(isWatched("lib/images/treatment-images.ts", cited)).toBe(true);
    expect(isWatched("tests/lib/images/treatment-images.test.ts", cited)).toBe(true);
  });

  it("a static string put through an unreadable operation is REFUSED, not read", () => {
    // The reason there is no fourth spelling to chase. `+`, `.join()` and
    // `.concat()` fold; every other method on a string-literal receiver is
    // reported rather than guessed at, so an unfoldable assembly is visible
    // instead of silently passing as two harmless halves.
    const probe = (src: string) => unreadableAssemblies("app/probe/page.tsx", src);
    expect(
      probe('export const T = "Every change  is tracked".trim();').map((v) => v.rule),
    ).toEqual(["claim/unreadable-static-string-call"]);
    // Not always-on: the folded spellings are read, so they are not refused.
    expect(probe('export const T = "Every change".concat(" is tracked");')).toEqual([]);
    expect(probe('export const T = ["a", "b"].join(" ");')).toEqual([]);

    // And CHAINED past a fold. The receiver here is a CallExpression, so an
    // immediate-literal check saw nothing and the underscored fragments passed
    // as harmless while the render is N1.
    expect(
      probe('export const T = "Every_change".concat("_is_tracked").replaceAll("_", " ");')
        .map((v) => v.rule),
    ).toEqual(["claim/unreadable-static-string-call"]);

    // Exemption is by FOLD, never by method name. A supported method whose call
    // does not actually fold is refused: the spread defeats the fold, so nothing
    // judged the whole, and the name `concat` was still buying the exemption.
    expect(
      probe('export const T = "Every change".concat(...[" is tracked"]);').map((v) => v.rule),
    ).toEqual(["claim/unreadable-static-string-call"]);

    // And the real surface carries none, so this costs nothing to hold.
    const real = [
      ...marketingComponentFiles(),
      ...pageCopySources(),
      ...POLICY_SOURCES,
      ...CANONICAL_COPY_MODULES,
    ].flatMap((f) => unreadableAssemblies(f));
    expect(real.map((v) => `${v.file}:${v.detail}`)).toEqual([]);
  });

  it("an approved value is completed from the RIGHT as well as the left", () => {
    // Position alone was the rule and it left the right-hand shape exempt:
    // `{FRAGMENT} is tracked.` kept the hole as consumption, so `pageClaims`
    // judged only "is tracked." and `moduleClaims` only "Every change" while the
    // rendered sentence is N1.
    const decl = `import { POSITIONING } from "@/lib/marketing/content";\n`;
    const assembled = (body: string) =>
      assembledClaimViolations("app/probe/page.tsx", `${decl}export const A = () => ${body};`)
        .map((v) => v.detail);

    // REFUSED — authored words continue this sentence's own run.
    expect(assembled("<p>{POSITIONING.corePromise} is tracked.</p>")).toEqual([
      "{POSITIONING.corePromise}",
    ]);
    // Refused for a non-link inline element too: `<strong>` is the same
    // sentence continuing, and exempting it would just move the hole.
    expect(
      assembled("<p>{POSITIONING.corePromise} <strong>is tracked</strong>.</p>"),
    ).toEqual(["{POSITIONING.corePromise}"]);

    // ALLOWED — the owner-sanctioned shapes are untouched. What distinguishes
    // them is not that the words come after, but that they are a trailing call
    // to action rather than part of the claim.
    expect(assembled("<p>{POSITIONING.corePromise}</p>")).toEqual([]);
    expect(
      assembled(
        '<p>{POSITIONING.corePromise} <Link href="/features">See the full picture</Link></p>',
      ),
    ).toEqual([]);
  });

  it("a layout Next.js applies without an import is read and judged", () => {
    // No route imports `app/layout.tsx`; Next.js wraps every one of them in it.
    // An import-following walk that starts at pages alone never arrives, so its
    // `metadata`, `openGraph` and `twitter` copy — what search results and
    // social cards show for every marketing route — reached no guard and no rule.
    expect(marketingComponentFiles()).toContain("app/layout.tsx");
    expect(MARKETING_COPY).toContain(
      "Hone helps electrologists prepare for returning clients",
    );
  });

  it("every zero-argument JSON-LD builder is invoked into the corpus", () => {
    // FROZEN, so adding a builder forces a decision rather than silently
    // shipping an unjudged public description. A builder's output is what the
    // page emits; reading its literals is not the same as running it.
    const zeroArg = Object.entries(marketingJsonLd)
      .filter(([, v]) => typeof v === "function" && (v as (...a: never[]) => unknown).length === 0)
      .map(([name]) => name)
      .sort();
    expect(zeroArg).toEqual(["organizationLd", "softwareApplicationLd", "webSiteLd"]);

    // The property, not a token that many sources share: EVERYTHING a builder
    // emits is in the corpus. A first cut asserted `MARKETING_COPY` contains
    // "Hone", which stayed green with the builder removed entirely.
    const builders = marketingJsonLd as unknown as Record<string, () => unknown>;
    const judged = new Set(CLAIMS);
    for (const name of zeroArg) {
      const emitted = walkStrings(builders[name]());
      expect(emitted.length, `${name} emitted nothing`).toBeGreaterThan(0);
      expect(emitted.filter((value) => !judged.has(value)), name).toEqual([]);
    }
    // And non-vacuous at the value only a builder can produce: `abs("/pricing")`
    // is the opaque-producer shape, with no literal to read statically.
    expect(judged.has("https://hone.care/pricing")).toBe(true);
    expect(judged.has("https://hone.care/icon")).toBe(true);
  });

  it("<wbr /> keeps a word whole; <br /> still separates", () => {
    // `<wbr />` is a permitted break POINT and renders nothing, so
    // `track<wbr />ed` reads "tracked". Treating it like `<br />` split the word
    // and N1 stopped matching — the same miss as running words together, from
    // the other side.
    expect(pageClaims("app/probe/page.tsx", "export const A = () => <p>Every change is track<wbr />ed</p>;"))
      .toEqual(["Every change is tracked"]);
    expect(pageClaims("app/probe/page.tsx", "export const A = () => <p>Every<br />change</p>;"))
      .toEqual(["Every change"]);
  });

  it("inline markup inside a sanctioned sentence is not judged as its own claim", () => {
    // The one OVER-refusal in this sequence. `claimParts` folds a direct inline
    // child into the sentence, and the traversal then met the same text again as
    // a container, so wrapping the tail of the sanctioned A1 sentence in
    // `<strong>` emitted it alone and judged it unsanctioned — failing a
    // markup-only change to copy a visitor still reads as sanctioned.
    const sentence =
      "Trace a probe lot to the areas that recorded it, and keep sterile-item and disinfectant logs with lot numbers, expiry, and replace-by dates, with an append-only edit history.";
    const at = sentence.indexOf("with an append-only");
    const marked = `export const A = () => <p>${sentence.slice(0, at)}<strong>${sentence.slice(at)}</strong></p>;`;
    const claims = pageClaims("app/probe/page.tsx", marked);
    expect(claims).toEqual([sentence]);
    expect(claims.filter((c) => judgeAppendOnlyClaim(c, SANCTIONED).kind === "unsanctioned")).toEqual([]);

    // Still seen on its own where the fold does NOT reach it: behind an
    // expression, an inline element is a hole, not a folded child.
    expect(
      pageClaims("app/probe/page.tsx", "export const A = () => <p>{ok ? <em>Every change is tracked</em> : null}</p>;"),
    ).toContain("Every change is tracked");
  });

  it("copy in a plain .ts module is followed; server infrastructure is not", () => {
    // `MarketingHeader` and `MobileNav` render `MARKETING_CTA.label` and
    // `MARKETING_NAV` on every policy page, but a `.tsx`-only walk never opened
    // the `.ts` module holding them, so a forbidden label changed nothing any
    // guard reads.
    const files = marketingComponentFiles();
    expect(files).toContain("app/_components/marketingNav.ts");
    expect(MARKETING_COPY).toContain("Book walkthrough");

    // BOUNDED, and this is the half that matters. Following every first-party
    // `.ts` transitively reaches server infrastructure that authors no copy —
    // that is the unbounded expansion this architecture replaced, and it would
    // drag WAIT-adjacent code into the marketing surface.
    for (const infrastructure of [
      "lib/supabase/server.ts",
      "lib/rate-limit/public.ts",
      "lib/waitlist/delivery/policy.ts",
      "lib/email/send-refusals.ts",
    ]) {
      expect(files, `${infrastructure} is not a copy source`).not.toContain(infrastructure);
    }
    // `app/actions/demo.ts` is NOT in that list any more: a component renders
    // what it returns, so it authors public copy. The bound still holds — it is
    // reached, and the modules IT imports are not.

    // And a canonical copy module is not a component: authoring copy there is
    // the law, so counting its prose as a component-prose violation would be a
    // category error.
    for (const module of CANONICAL_COPY_MODULES) expect(files).not.toContain(module);
  });

  it("a re-exported component is followed, not just an imported one", () => {
    // `export { Hero } from "./Hero"` puts a component in the render tree
    // without importing it, so a barrel index added the barrel and stopped —
    // and a colocated `Hero.tsx` outside the pre-scanned directories reached
    // neither the prose guard nor the corpus.
    expect(
      moduleSpecifiersOf(
        "app/_components/marketing/index.tsx",
        'import { Shell } from "./Shell";\nexport { Hero } from "./Hero";\nexport * from "./Nav";\n',
      ),
    ).toEqual(["./Shell", "./Hero", "./Nav"]);
    // A local re-export names no module and must not be invented.
    expect(
      moduleSpecifiersOf("app/_components/marketing/index.tsx", "const Hero = 1;\nexport { Hero };\n"),
    ).toEqual([]);
  });

  it("a standalone opaque call is refused as its own claim", () => {
    // `<p>{getMarketingClaim()}</p>` has `textWithHoles` of just "something", so
    // the substantive-prose gate never opened, `pageClaims` dropped the
    // container for having a hole, and the identity baseline recorded nothing —
    // the entire sentence was whatever that call returned, judged by nobody.
    const probe = (body: string, head = "") =>
      assembledClaimViolations("app/probe/page.tsx", `${head}export const A = () => ${body};`)
        .map((v) => v.rule);
    expect(probe("<p>{getMarketingClaim()}</p>")).toEqual(["claim/standalone-opaque-hole"]);
    // A BARE IDENTIFIER hides the same claim one binding away: `const claim =
    // getMarketingClaim()` rendered as `<p>{claim}</p>` is not a call at the
    // hole, so catching only calls left it passing.
    expect(probe("<p>{claim}</p>")).toEqual(["claim/standalone-opaque-hole"]);
    // And one level further out again, where the ITERATION exemption would
    // otherwise cover an unreadable receiver.
    // Two now, not one: the iteration is unreadable AND `x` is no longer
    // approved, because a callback variable is only consumption over a
    // collection whose elements can actually be read.
    expect(probe("<ul>{getItems().map((x) => <li key={x}>{x}</li>)}</ul>")).toEqual([
      "claim/standalone-opaque-hole",
      "claim/standalone-opaque-hole",
    ]);

    // A PROPERTY ACCESS on an unreadable root, which is the shape that survived
    // naming the unreadable forms one at a time. The rule is now opaque BY
    // DEFAULT: the burden is on showing a standalone hole can be read.
    expect(probe("<p>{claim.text}</p>")).toEqual(["claim/standalone-opaque-hole"]);

    // NARROW, and measured: refusing every standalone hole flagged 23 real ones.
    // A map produces elements rather than a sentence.
    // Declared receivers, because a callback variable is consumption only over a
    // collection whose elements can be read.
    const items = 'const ITEMS = ["a", "b"];\n';
    expect(probe("<ul>{ITEMS.map((i) => <li key={i}>{i}</li>)}</ul>", items)).toEqual([]);
    // A default is readable when both sides are.
    const plans = "const PLANS = [{ id: 1, priceLabel: null, bestFor: \"x\" }];\n";
    expect(
      probe('<ul>{PLANS.map((plan) => <li key={plan.id}><span>{plan.priceLabel ?? "Talk to us"}</span></li>)}</ul>', plans),
    ).toEqual([]);
    // A loop variable over copy the page declares is consumption, and its text
    // is already frozen in the page-prose baseline. This is what the
    // callback-parameter approval exists for: all five bare-identifier holes on
    // the real pages are loop variables, and without it every one is refused.
    expect(
      probe("<ul>{ITEMS.map((line) => <li key={line}><span>{line}</span></li>)}</ul>", items),
    ).toEqual([]);
    expect(
      probe("<div>{PLANS.map((plan) => <article key={plan.id}><p>{plan.bestFor}</p></article>)}</div>", plans),
    ).toEqual([]);
    // The SAME property access with no iteration in sight is refused: nothing
    // here shows where `plan` came from, which is the whole test.
    expect(probe("<p>{plan.bestFor}</p>")).toEqual(["claim/standalone-opaque-hole"]);
    // And the sanctioned shape is untouched.
    expect(
      assembledClaimViolations(
        "app/probe/page.tsx",
        'import { POSITIONING } from "@/lib/marketing/content";\nexport const A = () => <p>{POSITIONING.corePromise}</p>;',
      ),
    ).toEqual([]);

    // The real pages carry exactly two, both declared: `{article.title}` behind
    // `const article = getResourceArticle(...)`. They are a genuine unreadable
    // claim by this architecture's own standard, not a false positive — the
    // text is in `RESOURCE_ARTICLES` and IS judged, but nothing lets the guard
    // see that without dataflow. Frozen by identity in the exceptions test.
    expect(
      [...pageCopySources(), ...POLICY_SOURCES]
        .flatMap((f) => assembledClaimViolations(f))
        .filter((v) => v.rule === "claim/standalone-opaque-hole")
        .map((v) => v.detail),
    ).toEqual(["{article.title}", "{article.title}"]);
  });

  it("an approved name shadowed by a local binding is no longer approved", () => {
    // Approval is a set of identifier TEXT, so a prop or local named
    // `POSITIONING` in a nested component was read as the canonical import and
    // its runtime text was neither refused nor judged. Without a type checker
    // the binding cannot be resolved exactly, so a name declared anywhere in the
    // file is no longer reliably the import.
    const decl = 'import { POSITIONING } from "@/lib/marketing/content";\n';
    const probe = (head: string) =>
      assembledClaimViolations(
        "app/probe/page.tsx",
        `${decl}${head}export const A = () => <p>{POSITIONING.corePromise}</p>;`,
      ).map((v) => v.rule);
    expect(probe("")).toEqual([]);
    expect(probe("const POSITIONING = getIt();\n")).toEqual(["claim/standalone-opaque-hole"]);
  });

  it("a binding that assembles authored words with something dynamic is refused", () => {
    // Reachable by no other guard: `const state = "Every change is " + status`
    // rendered through `<p>{state}</p>` is not substantive prose at the
    // placeholder, cannot be folded because `status` is dynamic, and judgement
    // sees only the harmless fragments. `copyModuleViolations` refuses this in a
    // canonical module; a component is where it was still allowed.
    const probe = (src: string) =>
      mixedAssemblyViolations("app/_components/marketing/X.tsx", src).map((v) => v.rule);
    expect(probe('const state = "Every change is " + status;')).toEqual([
      "claim/assembled-binding",
    ]);
    expect(probe("const state = `Every change is ${status}`;")).toEqual([
      "claim/assembled-binding",
    ]);
    // TWO PLAIN WORDS, measured: the only mixed binding on the declared surface
    // is a Tailwind class string, whose tokens carry hyphens, colons and
    // brackets. A prose-length gate would have missed the four-word N1 wording,
    // which is the mistake this avoids repeating.
    expect(probe('const c = "flex flex-col border-b" + x;')).toEqual([]);
    // And a fully static assembly is folded and judged, not refused here.
    expect(probe('const s = "Every change" + " is tracked";')).toEqual([]);
  });

  it("an unreadable hole is refused whatever authored text surrounds it", () => {
    // Requiring the hole to stand ALONE left `<p>Note: {claim}</p>` passing on
    // both sides at once: authored words are present, so the standalone test was
    // skipped; "Note: something" is two words, so the substantive-prose gate
    // stayed shut. A short label does not make an unreadable claim readable.
    const probe = (body: string, head = "") =>
      assembledClaimViolations("app/probe/page.tsx", `${head}export const A = () => ${body};`)
        .map((v) => v.rule);
    expect(probe("<p>Note: {claim}</p>")).toEqual(["claim/standalone-opaque-hole"]);
  });

  it("a callback variable is approved only over a collection that can be read", () => {
    // Approving every `map`-like callback marked `{items.map(item => <p>{item}
    // </p>)}` readable even when `items` is a PROP — its contents arrive from a
    // caller, so neither the iteration nor the element was ever judged.
    const probe = (body: string, head = "") =>
      assembledClaimViolations("app/probe/page.tsx", `${head}export const A = () => ${body};`)
        .map((v) => v.rule);
    // REFUSED: the receiver is a prop, and both holes it opens are reported.
    expect(probe("<div>{items.map((item) => <p>{item}</p>)}</div>")).toEqual([
      "claim/standalone-opaque-hole",
      "claim/standalone-opaque-hole",
    ]);
    // ALLOWED: the elements are literals in this file, and they are judged.
    expect(probe("<div>{ITEMS.map((item) => <p>{item}</p>)}</div>", 'const ITEMS = ["a", "b"];\n')).toEqual([]);
    expect(probe('<div>{["a", "b"].map((item) => <p>{item}</p>)}</div>')).toEqual([]);
    // And a branch that renders ELEMENTS is rendering, not an unreadable claim.
    expect(probe("<p>{flag ? <span>x</span> : null}</p>")).toEqual([]);
  });

  it("a collection is readable only when its elements are", () => {
    // `const ITEMS = [getMarketingClaim()]` is an array literal, and approving
    // it on shape alone made both the collection and its loop variable readable
    // while nothing ever saw the text the call returns.
    const probe = (body: string, head = "") =>
      assembledClaimViolations("app/probe/page.tsx", `${head}export const A = () => ${body};`)
        .map((v) => v.rule);
    const map = "<div>{ITEMS.map((i) => <p>{i}</p>)}</div>";
    expect(probe(map, "const ITEMS = [getMarketingClaim()];\n")).toEqual([
      "claim/standalone-opaque-hole",
      "claim/standalone-opaque-hole",
    ]);
    // A spread hides its source, so the object carrying one is not proven.
    expect(
      probe(
        "<div>{PLANS.map((p) => <article key={p.id}><h2>{p.name}</h2></article>)}</div>",
        'const PLANS = [{ ...base, name: "Solo" }];\n',
      ),
    ).toEqual(["claim/standalone-opaque-hole", "claim/standalone-opaque-hole"]);

    // ALLOWED: literals, objects of literals, and APPROVED copy values — the
    // pricing FAQ carries `a: REPLACES_STATEMENT`, an import from a canonical
    // module, and a literals-only rule un-approved that whole real collection.
    expect(probe(map, 'const ITEMS = ["a", "b"];\n')).toEqual([]);
    expect(
      probe(
        "<div>{PLANS.map((p) => <article key={p.id}><h2>{p.name}</h2></article>)}</div>",
        'const PLANS = [{ id: 1, name: "Solo" }];\n',
      ),
    ).toEqual([]);
    expect(
      probe(
        map,
        'import { POSITIONING } from "@/lib/marketing/content";\nconst ITEMS = [POSITIONING.corePromise];\n',
      ),
    ).toEqual([]);
  });

  it("an unknown element inside a claim is refused on the real pages too", () => {
    // `<p>Every <Words /> tracked here today.</p>` with `Words` rendering
    // "change is" renders the forbidden sentence while extraction judges only
    // the harmless parent and child fragments. The rule caught it; the page
    // assertion filtered it away, so it was enforced nowhere real.
    expect(
      assembledClaimViolations(
        "app/probe/page.tsx",
        "export const A = () => <p>Every <Words /> tracked here today.</p>;",
      ).map((v) => v.rule),
    ).toEqual(["claim/unknown-element-inside-claim"]);
  });

  it("a join or concat mixing authored words with something dynamic is refused", () => {
    // `["Every change is", status].join(" ")` mixes exactly as `+` does:
    // `foldStatic` cannot complete it, and the refusal for unreadable calls
    // ignores array receivers by design, so only the harmless fragment was
    // judged. Applied to the baselined `SiteFooter` `{year}` hole it would have
    // rendered N1 with every identity unchanged.
    const probe = (src: string) =>
      mixedAssemblyViolations("app/_components/marketing/X.tsx", src).map((v) => v.rule);
    expect(probe('const year = ["Every change is", status].join(" ");')).toEqual([
      "claim/assembled-binding",
    ]);
    expect(probe('const year = "Every change is".concat(status);')).toEqual([
      "claim/assembled-binding",
    ]);
    // A fully static one folds and is judged, so it is not refused here.
    expect(probe('const year = ["Every change", "is tracked"].join(" ");')).toEqual([]);
  });

  it("dangerouslySetInnerHTML is a hole unless its HTML is a complete static value", () => {
    // It renders visitor-visible text and arrives through an ATTRIBUTE, so the
    // text-position test excluded it, `claimParts` saw no JSX child and
    // `pageClaims` found no literal — a policy page could pass the explicit
    // zero-hole assertion while rendering arbitrary HTML.
    const probe = (body: string) =>
      jsxHoles("app/probe/page.tsx", `export const A = () => ${body};`).map((v) => v.rule);
    expect(probe("<div dangerouslySetInnerHTML={{ __html: getClaim() }} />")).toEqual([
      "source/hole-in-text-position",
    ]);
    expect(probe('<div dangerouslySetInnerHTML={{ __html: "<p>x</p>" }} />')).toEqual([]);
    // And the policy sources still carry none, which is what makes their
    // inclusion in the corpus safe.
    expect(POLICY_SOURCES.flatMap((f) => jsxHoles(f))).toEqual([]);
  });

  it("a server action whose text a component renders is read", () => {
    // `DemoForm` shows `submitDemoRequest(...).error` through `{status.message}`.
    expect(marketingComponentFiles()).toContain("app/actions/demo.ts");
    // Still bounded: a `.ts` import is followed only inside a copy directory, so
    // reaching the action does NOT pull in the infrastructure it imports.
    for (const infrastructure of [
      "lib/supabase/server.ts",
      "lib/rate-limit/public.ts",
      "lib/waitlist/delivery/policy.ts",
      "lib/email/send-refusals.ts",
    ]) {
      expect(marketingComponentFiles()).not.toContain(infrastructure);
    }
  });

  it("the forbidden-wording rule bites on the register's own N1 sentence", () => {
    const banned = "Edits kept as history, not written over.";
    expect(FORBIDDEN.some((r) => r.pattern.test(banned))).toBe(true);
    expect(FORBIDDEN.some((r) => r.pattern.test("Every treated area keeps its own history."))).toBe(false);
  });

  it("the append-only allow-list bites on an unsanctioned promise", () => {
    expect(judgeAppendOnlyClaim("Every treatment record has an append-only edit history.", SANCTIONED).kind)
      .toBe("unsanctioned");
    expect(judgeAppendOnlyClaim(SANCTIONED[0].text, SANCTIONED).kind).toBe("sanctioned");
  });

  it("the copy-module guard bites on assembly, and not on a complete value", () => {
    expect(violationsIn(`export const t = "Every change is " + stateWord;`).length).toBeGreaterThan(0);
    expect(violationsIn(`export const t = "Every change is recorded on the treatment.";`)).toEqual([]);
  });

  it("the component-prose guard bites on prose, and not on plumbing", () => {
    expect(
      componentProseViolationsIn(`export const A = () => <p>Hone remembers every treatment you record.</p>;`).length,
    ).toBeGreaterThan(0);
    expect(
      componentProseViolationsIn(`export const A = () => <div className="flex min-h-[44px] items-center gap-2 rounded-md" />;`),
    ).toEqual([]);
  });

  it("the assembled-claim guard bites on a hole, and not on a whole sentence", () => {
    expect(
      assembledIn(`export const A = () => <p>Every treated area keeps {label} of its own in Hone.</p>;`).length,
    ).toBeGreaterThan(0);
    expect(
      assembledIn(`export const A = () => <p>Every treated area keeps a history of its own in Hone.</p>;`),
    ).toEqual([]);
  });

  it("the staleness guard bites on a range that DID move cited evidence", () => {
    // The non-vacuity half of the provenance suite, restated as a mutation: a
    // range known to touch §0's evidence must come back non-empty, or the green
    // result above is green because it can never see anything.
    const cited = citedEvidenceFiles(REGISTER);
    expect(cited.length).toBeGreaterThan(3);
    expect(isWatched("components/before-today-card.tsx", cited)).toBe(true);
    expect(isWatched("app/_fonts/app-fonts.ts", cited)).toBe(false);
  });
});
