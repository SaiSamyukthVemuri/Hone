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

  it("the append-only claim, where it appears, names an audited record type", () => {
    // §0.4 N1: migration 0086's trigger-written trail covers sterile items,
    // disinfectants, exposure incidents, the aftercare mark, and
    // session_blocks.probe_lot_number - THAT COLUMN ONLY. Every other charted
    // value is a plain UPDATE that keeps no prior value. So the claim must name
    // a covered record type AND must not widen the promise back out.
    let checked = 0;
    for (const { file, claim } of CLAIMS) {
      const verdict = judgeAppendOnlyClaim(claim);
      if (verdict.kind === "not-a-claim") continue;
      checked += 1;
      expect(
        verdict.kind,
        verdict.kind === "unscoped"
          ? `${file}: an append-only claim must name an audited record type (sterile items, disinfectants, exposure incidents, probe lots, record-keeping). Offending copy: "${claim}"`
          : `${file}: this append-only claim extends the promise beyond the audited records via "${
              verdict.kind === "overreaching" ? verdict.matched : ""
            }", which §0.4 N1 rejects. Offending copy: "${claim}"`,
      ).toBe("ok");
    }
    // Guard the guard: zero claims would pass by vacuity, and "no append-only
    // claim anywhere" is a different state, owned by the overcorrection block.
    expect(
      checked,
      "no append-only copy found; see the overcorrection block",
    ).toBeGreaterThan(0);
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
      expect(judgeAppendOnlyClaim(sentence!).kind).toBe("overreaching");
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

  it("judges scope, not the presence of a keyword", () => {
    // The old scope regex accepted any of lot|sterile|disinfectant|log|note, so
    // "charting log" satisfied it while promising what the product cannot keep,
    // and bare "a lot"/"noteworthy" satisfied it by accident. Both are now
    // rejected for naming no covered record type at all.
    for (const unscoped of [
      "Every charting log has an append-only edit history",
      "Every record has an append-only edit history",
      "a lot of noteworthy things have an append-only edit history",
    ]) {
      expect(judgeAppendOnlyClaim(unscoped).kind, unscoped).toBe("unscoped");
    }
    // Naming a covered type is not enough on its own: a claim that also widens
    // the promise back out is rejected for the widening.
    expect(
      judgeAppendOnlyClaim(
        "Every treatment record has an append-only edit history for sterile items",
      ).kind,
    ).toBe("overreaching");
  });

  it("leaves the supported, scoped wording green", () => {
    // The overcorrection counterpart: the shipped line must survive every rule
    // above. If a tightening makes a true claim unsayable, it fails here.
    const shipped =
      "Trace a probe lot to the areas that recorded it, and keep sterile-item and disinfectant logs with lot numbers, expiry, and replace-by dates, with an append-only edit history.";
    expect(judgeAppendOnlyClaim(shipped).kind).toBe("ok");
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
