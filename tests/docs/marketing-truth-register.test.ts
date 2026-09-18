import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { migrationState } from "../migrations/helpers/migration-state";
import { MARKETING_PAGES } from "@/lib/marketing/content";
import {
  REPO_ROOT,
  claimsBySource,
  collectClaims,
  forbiddenWordings,
  judgeAppendOnlyClaim,
  publicMarketingSources,
  publicRouteFiles,
  sanctionedAppendOnlyWordings,
  citedEvidenceFiles,
  isWatched,
  unreconstructableSentences,
  unreconstructableIn,
  APPEND_ONLY_OVERREACH,
  APPEND_ONLY_TRIGGER,
  SUPPORTED_APPEND_ONLY_SCOPE,
} from "./helpers/marketing-scan";

// MARKETING-01a. Governance guard for docs/marketing/product-truth-register.md.
//
// WHY THIS EXISTS
// ---------------
// The register is the authority every marketing copy PR cites for what may be
// said. Before this guard it was prose, and prose goes stale silently: the
// previous revision was built against head `325b124` / migration max 0133 and
// was still being cited as authoritative ~65 migrations later. Nothing failed,
// because nothing checked. A stale authority is worse than no authority — it
// launders an old classification as a current fact, which is exactly how one
// withdrawn finding survived long enough to be re-derived twice.
//
// So this guard does three jobs, and deliberately not a fourth:
//   1. the register must DECLARE the head and migration state it was built
//      against, in a machine-readable form;
//   2. the migration numbers it declares must match the DERIVED repository
//      state and the DECLARED hosted state — never a hand-typed literal
//      (CLAUDE.md §2: migration state is derived, never hard-coded);
//   3. claims the register classifies NOT_CURRENTLY_SUPPORTABLE must not
//      appear in public marketing copy.
//
// It does NOT assert anything about public copy wording beyond (3). Copy is
// MARKETING-01's business; this PR is internal truth governance only.
//
// HOW (3) IS DONE, AND WHY IT LOOKS LIKE THIS
// -------------------------------------------
// The surface it scans and the way it reads copy both live in
// `helpers/marketing-scan.ts`, which carries the full history of why. In short:
// the file list is DERIVED (from MARKETING_PAGES, then by following imports),
// because four separate holes came from a hand-kept list; and copy is read with
// the TypeScript parser, because every regex approximation of JSX and string
// syntax bred the next hole. The rules themselves are read out of the register,
// because a ruling and its enforcement must not be two documents that are free
// to disagree.

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

const REGISTER = read("docs/marketing/product-truth-register.md");

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

const PRODUCTION_BRANCH = "claude/build-hone-saas-hOex7";

const SOURCES = publicMarketingSources();
const CLAIMS = claimsBySource(SOURCES);
/** Every claim on the public surface, as one corpus. */
const MARKETING_COPY = CLAIMS.map((c) => c.claim).join(" ¶ ");
const FORBIDDEN = forbiddenWordings(REGISTER);
const SANCTIONED = sanctionedAppendOnlyWordings(REGISTER);

describe("the scan covers what a visitor actually reads", () => {
  it("scans the route file behind every indexable path in the registry", () => {
    // MARKETING_PAGES drives the sitemap, per-page metadata and the middleware
    // public-route allowlist, so it is the registry of record for what is
    // public. The route list is now DERIVED from it rather than pinned against
    // it: a new indexable route is scanned because it is in the registry, not
    // because somebody remembered to add it here too.
    const indexable = MARKETING_PAGES.filter((p) => p.indexable);
    expect(publicRouteFiles()).toHaveLength(indexable.length);
    for (const route of publicRouteFiles()) expect(SOURCES).toContain(route);
  });

  it("scans the policy ROUTES, not only the shell they share", () => {
    // These two were explicitly filtered out, on the reasoning that scanning
    // PolicyLayout covered them. It does not: PolicyLayout is the wrapper, and
    // the entire policy text is `children`, authored in the route files.
    expect(SOURCES).toContain("app/privacy/page.tsx");
    expect(SOURCES).toContain("app/terms/page.tsx");
  });

  it("scans the shared components and copy modules those routes render", () => {
    // Derived by following imports, so this asserts the derivation REACHED the
    // files review used to demonstrate each hole — the shared footer whose
    // "Operated from Canada." is authored outside any page, the resource copy
    // module the article routes render their titles from, and the policy header
    // and footer, which are different components from the marketing ones.
    for (const file of [
      "app/_components/marketing/SiteFooter.tsx",
      "app/_components/marketing/SiteHeader.tsx",
      "app/_components/MarketingHeader.tsx",
      "app/_components/MarketingFooter.tsx",
      "app/_components/PolicyLayout.tsx",
      "lib/marketing/content.ts",
      "lib/marketing/resources.ts",
    ]) {
      expect(SOURCES).toContain(file);
    }
    expect(SOURCES.length).toBeGreaterThan(publicRouteFiles().length);
  });

  it("reads copy authored in a shared component", () => {
    // A live string that exists only in SiteFooter. If this disappears the
    // derivation has silently stopped reaching components.
    expect(MARKETING_COPY).toMatch(/Operated from Canada/);
  });

  it("reads the BODY of each policy route", () => {
    // Live strings authored inside app/privacy/page.tsx and app/terms/page.tsx
    // respectively — neither is reachable by scanning PolicyLayout.
    expect(MARKETING_COPY).toMatch(/TLS encryption for data in transit/);
    expect(MARKETING_COPY).toMatch(/Hone is provided as a software-as-a-service/);
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

  const headObjectPresent = (): boolean =>
    gitOk(["cat-file", "-e", `${declaredHead()}^{commit}`]);

  /**
   * Files the register rests on that changed across a range.
   *
   * The watch set is the public surface plus §0's OWN citations, so a row that
   * starts resting on a new file starts watching it. Production may run ahead
   * freely — it may not run over the evidence without §0 being re-derived.
   */
  const WATCHED = [...SOURCES, ...citedEvidenceFiles(REGISTER)];
  const evidenceTouchedBetween = (from: string, to: string): string[] =>
    git(["diff", "--name-only", `${from}..${to}`])
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
    if (!gitOk(["rev-parse", "--verify", `origin/${PRODUCTION_BRANCH}`])) return;
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

describe("NOT_CURRENTLY_SUPPORTABLE claims stay out of public copy", () => {
  it("the rules come from §0.4 itself, and include its canonical wordings", () => {
    // Review's objection was that the guard hard-coded a list, claimed to
    // enforce §0.4, and did not match the exact sentence §0.4 rejects. The list
    // now lives in the register; these assertions prove the block was parsed
    // and that the two wordings the ruling turns on are in it.
    expect(FORBIDDEN.length).toBeGreaterThan(0);
    expect(FORBIDDEN.map((r) => r.id)).toContain("N1");
    expect(FORBIDDEN.map((r) => r.id)).toContain("N2");
    for (const canonical of [
      "Edits kept as history, not written over",
      "Corrections are recorded, not written over.",
      "A treatment record keeps its edit history.",
    ]) {
      expect(
        FORBIDDEN.some((r) => r.pattern.test(canonical)),
        `§0.4 rejects "${canonical}" but no rule in the register's forbidden-public-wording block matches it`,
      ).toBe(true);
    }
  });

  it("no public claim matches a wording §0.4 rejects", () => {
    for (const rule of FORBIDDEN) {
      const offenders = CLAIMS.filter((c) => rule.pattern.test(c.claim)).map(
        (c) => `${c.file}: "${c.claim}"`,
      );
      expect(
        offenders,
        `forbidden by truth register §0.4 ${rule.id} — /${rule.source}/`,
      ).toEqual([]);
    }
  });

  it("every append-only claim on the site is one §0.4 has sanctioned", () => {
    // §0.4 N1: migration 0086's trigger-written trail covers sterile items,
    // disinfectants, exposure incidents, the aftercare mark, and
    // session_blocks.probe_lot_number - THAT COLUMN ONLY. Every other charted
    // value is a plain UPDATE that keeps no prior value.
    //
    // This used to ask whether the claim named a covered record type and
    // avoided a list of widening words. Review broke that with a conjunction:
    // "Energy settings and sterile items have an append-only edit history"
    // satisfied both halves while promising history for a field that keeps
    // none. That is not a missing word - no deny-list of the unsupported nouns
    // can be complete, because the unsupported set is every charted field the
    // product has or will have. So the register sanctions exact wordings and
    // everything else is rejected.
    let checked = 0;
    for (const { file, claim } of CLAIMS) {
      const verdict = judgeAppendOnlyClaim(claim, SANCTIONED);
      if (verdict.kind === "not-a-claim") continue;
      checked += 1;
      expect(
        verdict.kind,
        `${file}: this append-only claim is not one §0.4 sanctions. Re-word it to a sanctioned line, or classify it in the register's supportable-append-only-wording block first. Offending copy: "${claim}"`,
      ).toBe("sanctioned");
    }
    // Guard the guard: zero claims would pass by vacuity, and "no append-only
    // claim anywhere" is a different state, owned by the overcorrection block.
    expect(
      checked,
      "no append-only copy found; see the overcorrection block",
    ).toBeGreaterThan(0);
  });

  it("no public sentence sets a scope around a value this scan cannot read", () => {
    // Review's case: `<p>Every treatment record includes {it.body}</p>` in a
    // SHARED renderer. `it.body` is a prop on a .map callback, so its values
    // live in whichever page passes `items` - no same-file resolution reaches
    // them. The literal then passes on its own as a sanctioned wording, the
    // prose passes as a claim with no trigger, and a visitor reads the two
    // joined into a promise neither half made.
    //
    // Nothing static can reconstruct that sentence, so the ambiguity is
    // forbidden rather than resolved. Copy either says the whole thing in one
    // place, or holds the whole thing in one value.
    const offenders = unreconstructableSentences(SOURCES);
    expect(
      offenders.map((o) => `${o.file}: "${o.prose}" around {${o.expression}}`),
      "a sentence sets scope around a value this scan cannot resolve, so what a visitor reads cannot be judged. Inline the whole sentence, or move all of it into the value",
    ).toEqual([]);
  });

  it("each sanctioned wording is itself scoped, and is actually shipped", () => {
    // A guard on the guard. It cannot check that a sanctioned sentence is TRUE
    // - that is the classification work §0 exists for, done by a person against
    // code - but an entry that names no covered record type, or that plainly
    // widens the promise, is a careless entry and fails here.
    expect(SANCTIONED.length).toBeGreaterThan(0);
    for (const wording of SANCTIONED) {
      expect(
        wording.text,
        `${wording.id} is sanctioned but names no covered record type`,
      ).toMatch(SUPPORTED_APPEND_ONLY_SCOPE);
      expect(
        wording.text,
        `${wording.id} is sanctioned but widens the promise beyond the audited records`,
      ).not.toMatch(APPEND_ONLY_OVERREACH);
      expect(
        wording.text,
        `${wording.id} sits in the append-only block but makes no append-only claim`,
      ).toMatch(APPEND_ONLY_TRIGGER);
    }
    // A sanctioned wording nobody ships is a ruling with no subject, and lets
    // the block drift away from the copy it governs.
    const shipped = CLAIMS.map((c) => c.claim.replace(/\s+/g, " ").trim());
    for (const wording of SANCTIONED) {
      expect(
        shipped.includes(wording.text),
        `${wording.id} is sanctioned but appears nowhere in public copy`,
      ).toBe(true);
    }
  });
});

describe("negative controls: the guard bites", () => {
  // Every control feeds copy through the SAME scanner the real surface goes
  // through. Each one is a claim that must be REJECTED, so a future
  // simplification that quietly stops reading a surface or a syntax fails here
  // instead of reporting the site clean.
  const rulesHitBy = (src: string, name = "control.tsx") => {
    const claims = collectClaims(src, name);
    return FORBIDDEN.filter((r) => claims.some((c) => r.pattern.test(c)));
  };
  /** The real file, with a forbidden claim added — does the guard see it? */
  const realFileWith = (file: string, injected: string) =>
    rulesHitBy(`${read(file)}\n${injected}\n`, file);

  const JSX_SPLIT_CLAIM =
    'export function __Control() {\n  return <p>Edits kept as <em>history</em>, not written over.</p>;\n}';
  const LITERAL_CLAIM =
    'export const __CONTROL = "Edits kept as history, not written over";';

  it("rejects the register's own N1 wording", () => {
    expect(rulesHitBy(LITERAL_CLAIM).map((r) => r.id)).toContain("N1");
  });

  it("rejects the stronger deck wording the homepage line came from", () => {
    const deck =
      'export const __CONTROL = "Corrections are recorded, not written over. A treatment record keeps its edit history.";';
    expect(rulesHitBy(deck).map((r) => r.id)).toContain("N1");
    // and each sentence independently, so neither rule is carrying the other
    expect(
      rulesHitBy('export const __C = "A treatment record keeps its edit history.";')
        .length,
    ).toBeGreaterThan(0);
    expect(
      rulesHitBy('export const __C = "Corrections are recorded, not written over.";')
        .length,
    ).toBeGreaterThan(0);
  });

  it("rejects a claim split across JSX children", () => {
    // The rendered sentence is what a visitor reads; the inline <em> is not a
    // boundary. Scanning the fragments separately was how this passed before.
    expect(rulesHitBy(JSX_SPLIT_CLAIM).map((r) => r.id)).toContain("N1");
  });

  it("rejects a claim split by a JSX expression, whichever quote it uses", () => {
    for (const expression of [
      '{"an append-only edit history for sterile items"}',
      "{'an append-only edit history for sterile items'}",
      '{"an append-only edit history for sterile items that\'s permanent"}',
      "{'an append-only edit history for \"sterile items\"'}",
    ]) {
      const src = `export function __C() {\n  return <p>Every treatment record has ${expression}</p>;\n}`;
      const claims = collectClaims(src, "control.tsx");
      const sentence = claims.find((c) => /^Every treatment record has /.test(c));
      expect(
        sentence,
        `the expression ${expression} was not inlined into its sentence`,
      ).toBeTruthy();
      expect(judgeAppendOnlyClaim(sentence!, SANCTIONED).kind).toBe("unsanctioned");
    }
  });

  it("reads a sentence made only of inline elements as one sentence", () => {
    // Review's counter-example to the first structural rule. The container has
    // no text of its own, so "does it bear text" read <p> as layout and split
    // the sentence exactly where the unsupported promise and its qualifier fell
    // either side of the boundary. <p> cannot legally hold a block, so its
    // whole subtree is one sentence - a fact about HTML, not a heuristic.
    const src =
      "export function __C() {\n  return <p><span>Every treatment record has</span><strong> an append-only edit history for sterile items</strong></p>;\n}";
    const claims = collectClaims(src, "control.tsx");
    expect(claims).toContain(
      "Every treatment record has an append-only edit history for sterile items",
    );
    expect(
      rulesHitBy(src).map((r) => r.id),
      "the rejoined sentence is not caught by any §0.4 rule",
    ).toContain("N1");
  });

  it("reads an inline-only div as one sentence, and a component list as many", () => {
    // The same question one level out. A container holding only phrasing
    // elements is a sentence however it is tagged; a container holding
    // components is layout, and gluing a policy page's paragraphs together
    // would manufacture claims nobody wrote.
    const inlineDiv =
      "export function __C() {\n  return <div><span>Every treatment record has</span><strong> an append-only edit history for sterile items</strong></div>;\n}";
    expect(collectClaims(inlineDiv, "control.tsx")).toContain(
      "Every treatment record has an append-only edit history for sterile items",
    );

    const componentList =
      "export function __C() {\n  return <Layout><P>An append-only edit history for sterile items.</P><P>Every treatment record is editable.</P></Layout>;\n}";
    const claims = collectClaims(componentList, "control.tsx");
    expect(claims).toContain("An append-only edit history for sterile items.");
    expect(claims).toContain("Every treatment record is editable.");
    expect(
      claims.some((c) => /sterile items\.\s*Every treatment record/.test(c)),
      "two sibling paragraphs were glued into one claim",
    ).toBe(false);
  });

  it("rejects an unsupported field conjoined to a supported one", () => {
    // Review's counter-example to the deny-list. `sterile items` satisfied the
    // scope and neither `energy` nor `settings` was a listed widening term,
    // while energy edits keep no prior value at all.
    const conjunction =
      "Energy settings and sterile items have an append-only edit history";
    expect(SUPPORTED_APPEND_ONLY_SCOPE.test(conjunction)).toBe(true);
    expect(APPEND_ONLY_OVERREACH.test(conjunction)).toBe(false);
    expect(
      judgeAppendOnlyClaim(conjunction, SANCTIONED).kind,
      "a deny-list would have passed this; the allow-list must not",
    ).toBe("unsanctioned");
  });

  it("rejects an append-only claim written without the hyphen", () => {
    expect(
      judgeAppendOnlyClaim("Energy settings have an append only edit history", SANCTIONED)
        .kind,
    ).toBe("unsanctioned");
  });

  it("reads a typographic hyphen as a hyphen", () => {
    // `append‑only` with U+2011, and its &#8209; entity, are the same promise to
    // a reader. As an ASCII-only trigger they were classified "not-a-claim",
    // which sent them past the allow-list AND past the forbidden patterns.
    for (const dash of ["‐", "‑", "‒", "–", "—", "−"]) {
      expect(
        judgeAppendOnlyClaim(
          `Energy settings have an append${dash}only edit history`,
          SANCTIONED,
        ).kind,
        `U+${dash.codePointAt(0)!.toString(16)} was not read as a hyphen`,
      ).toBe("unsanctioned");
    }
    // and through the JSX entity, end to end
    const src =
      'export function __C() {\n  return <p>Energy settings have an append&#8209;only edit history</p>;\n}';
    const claims = collectClaims(src, "control.tsx");
    const claim = claims.find((c) => /Energy settings/.test(c));
    expect(claim, "the entity claim was not extracted").toBeTruthy();
    expect(judgeAppendOnlyClaim(claim!, SANCTIONED).kind).toBe("unsanctioned");
    // The sanctioned wording must still be sanctioned when spelled with U+2011.
    const sanctionedWithNbHyphen = SANCTIONED[0].text.replace(
      "append-only",
      "append‑only",
    );
    expect(judgeAppendOnlyClaim(sanctionedWithNbHyphen, SANCTIONED).kind).toBe(
      "sanctioned",
    );
  });

  it("flags prose that sets a scope around an unreadable value", () => {
    // Review's exact counter-example, run through the real detector.
    const renderer = (body: string) =>
      `export function __C({ items }) {\n  return <div>{items.map((it) => (\n    ${body}\n  ))}</div>;\n}`;

    const laundered = unreconstructableIn(
      renderer("<p>Every treatment record includes {it.body}</p>"),
      "sections.tsx",
    );
    expect(
      laundered.map((o) => o.prose),
      "the shared renderer laundered a scope around an unresolvable value",
    ).toEqual(["Every treatment record includes"]);

    // An append-only promise with a hole in it is unreconstructable by
    // definition, whatever the surrounding words are.
    expect(
      unreconstructableIn(
        renderer("<p>An append-only edit history for {it.scope}</p>"),
      ),
    ).toHaveLength(1);

    // The pass-through shape must stay green: the container contributes no
    // prose, so whatever the value holds IS the whole sentence.
    expect(unreconstructableIn(renderer("<p>{it.body}</p>"))).toEqual([]);
  });

  it("pairs prose with a hole across inline markup, and through a template", () => {
    // Direct children were not enough. Wrapping either half in ordinary inline
    // markup separated them, and a template literal handed over its static
    // fragments while swallowing the substitution - so the static half set the
    // scope and the value passed on its own as a sanctioned sentence.
    const cases: Array<[string, string]> = [
      [
        "scope wrapped in <strong>",
        "<p><strong>Every treatment record</strong> includes {it.body}</p>",
      ],
      [
        "hole wrapped in <span>",
        "<p>Every treatment record includes <span>{it.body}</span></p>",
      ],
      [
        "template substitution",
        "<p>{`Every treatment record has ${it.body}`}</p>",
      ],
      [
        "both halves wrapped",
        "<p><em>All edits</em> are kept in <span>{it.body}</span></p>",
      ],
    ];
    for (const [name, body] of cases) {
      const src = `export function __C({ items }) {\n  return <div>{items.map((it) => (\n    ${body}\n  ))}</div>;\n}`;
      expect(unreconstructableIn(src, "sections.tsx"), name).toHaveLength(1);
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

  it("leaves the live prose-beside-a-value cases sayable", () => {
    // Four containers on the shipped site mix prose with a value. None sets a
    // scope; if the rule were "no prose beside a hole" they would all have to be
    // rewritten, which is an overcorrection with no defect behind it.
    for (const live of [
      "export const C = () => (<p>© {year} Hone. {POSITIONING.category}.</p>);",
      "export const C = () => (<p>For {plan.seats}</p>);",
      "export const C = () => (<p>Guide · {a.readingTime}</p>);",
      "export const C = () => (<Lede>Operational guides from {RESOURCE_AUTHOR}, the people building Hone, on keeping good treatment records and moving a practice off paper.</Lede>);",
    ]) {
      expect(unreconstructableIn(live), live.slice(0, 60)).toEqual([]);
    }
  });

  it("rejects forbidden wording in a resource article route and its copy module", () => {
    for (const file of [
      "app/resources/electrolysis-treatment-record-checklist/page.tsx",
      "app/resources/moving-an-electrolysis-practice-from-paper-records/page.tsx",
      "lib/marketing/resources.ts",
    ]) {
      expect(SOURCES, `${file} is not in the scanned surface`).toContain(file);
      expect(
        realFileWith(file, LITERAL_CLAIM).length,
        `a forbidden claim added to ${file} was not detected`,
      ).toBeGreaterThan(0);
    }
  });

  it("rejects forbidden wording in shared header and footer copy", () => {
    for (const file of [
      "app/_components/marketing/SiteFooter.tsx",
      "app/_components/marketing/SiteHeader.tsx",
      "app/_components/MarketingHeader.tsx",
      "app/_components/MarketingFooter.tsx",
    ]) {
      expect(SOURCES, `${file} is not in the scanned surface`).toContain(file);
      expect(
        realFileWith(file, JSX_SPLIT_CLAIM).length,
        `a forbidden claim added to ${file} was not detected`,
      ).toBeGreaterThan(0);
    }
  });

  it("rejects forbidden wording in the privacy and terms bodies", () => {
    for (const file of ["app/privacy/page.tsx", "app/terms/page.tsx"]) {
      expect(SOURCES, `${file} is not in the scanned surface`).toContain(file);
      expect(
        realFileWith(file, JSX_SPLIT_CLAIM).length,
        `a forbidden claim added to ${file} was not detected`,
      ).toBeGreaterThan(0);
    }
  });

  it("sees copy the old comment-stripping order would have eaten", () => {
    // Both regex orders were wrong on some valid input. The parser has no
    // order: a comment is a comment and a string is a string.
    expect(
      rulesHitBy('/* explanation\n// example */\nexport const __C = "complete audit trail";')
        .length,
      "a block comment containing a // line hid the copy after it",
    ).toBeGreaterThan(0);
    expect(
      rulesHitBy('// see next/*\nexport const __C = "nothing is ever overwritten";')
        .length,
      "a line comment containing next/* hid the copy after it",
    ).toBeGreaterThan(0);
  });

  it("rejects every near-miss wording, however it is phrased", () => {
    // The old scope regex accepted any of lot|sterile|disinfectant|log|note, so
    // "charting log" satisfied it while promising what the product cannot keep,
    // and bare "a lot"/"noteworthy" satisfied it by accident. None of these is
    // in the sanctioned list, so the reason each is rejected is now the same
    // one: §0.4 has not classified it.
    for (const rejected of [
      "Every charting log has an append-only edit history",
      "Every record has an append-only edit history",
      "a lot of noteworthy things have an append-only edit history",
      "Every treatment record has an append-only edit history for sterile items",
      "Sterile items have an append-only edit history",
      "Energy settings and sterile items have an append-only edit history",
    ]) {
      expect(judgeAppendOnlyClaim(rejected, SANCTIONED).kind, rejected).toBe(
        "unsanctioned",
      );
    }
  });

  it("leaves the supported, sanctioned wording green", () => {
    // The overcorrection counterpart: the shipped line must survive every rule
    // above. If a tightening makes a true claim unsayable, it fails here.
    const shipped =
      "Trace a probe lot to the areas that recorded it, and keep sterile-item and disinfectant logs with lot numbers, expiry, and replace-by dates, with an append-only edit history.";
    expect(judgeAppendOnlyClaim(shipped, SANCTIONED).kind).toBe("sanctioned");
    expect(
      FORBIDDEN.filter((r) => r.pattern.test(shipped)).map((r) => r.source),
    ).toEqual([]);
  });
});

describe("no overcorrection", () => {
  // The guard above must not have made the legitimate, verified claims
  // unsayable. These are VERIFIED_CURRENT or VERIFIED_WITH_QUALIFIER in §0 and
  // must still be present on the shipped site, so a future tightening of the
  // bans shows up here instead of silently deleting a true claim.
  it("the scoped traceability + append-only line is still shippable", () => {
    expect(MARKETING_COPY).toMatch(/append-only edit history/i);
    expect(MARKETING_COPY).toMatch(/probe lot/i);
  });

  it("the verified privacy and isolation claims are still present", () => {
    expect(MARKETING_COPY).toMatch(/row-level security/i);
    expect(MARKETING_COPY).toMatch(/signed links/i);
    expect(MARKETING_COPY).toMatch(/does not train AI models/i);
  });
});
