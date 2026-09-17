import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { migrationState } from "../migrations/helpers/migration-state";
import { MARKETING_PAGES } from "@/lib/marketing/content";

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

const ROOT = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const REGISTER = read("docs/marketing/product-truth-register.md");

/** The production head the register declares it was verified against. */
function declaredHead(): string {
  const m = REGISTER.match(/Built against production head \| `([0-9a-f]{40})`/);
  return m ? m[1] : "";
}

const MARKETING_ROUTES = [
  "app/page.tsx",
  "app/pricing/page.tsx",
  "app/demo/page.tsx",
  "app/electrolysis-software/page.tsx",
  "app/features/treatment-memory/page.tsx",
  "app/features/charting-records/page.tsx",
  "app/features/booking-calendar/page.tsx",
  "app/resources/page.tsx",
  "app/resources/electrolysis-treatment-record-checklist/page.tsx",
  "app/resources/moving-an-electrolysis-practice-from-paper-records/page.tsx",
] as const;

/**
 * Everything a visitor reads, not just the route files.
 *
 * This was a hand-maintained list, on the reasoning that a new route should have
 * to be added deliberately. Review broke that reasoning twice: first the three
 * `app/resources/` routes were missing, then - after those were added - the
 * SHARED COMPONENTS every one of those routes renders. `SiteFooter.tsx` alone
 * authors "Operated from Canada."; swapping that literal for a prohibited claim
 * left the guard green, because imports are not followed and the file was not
 * listed.
 *
 * A list that must be remembered is a list that will be forgotten, and it fails
 * in the direction that matters: the guard reports clean on copy it never
 * opened. Component coverage is therefore DERIVED from the directory, so a new
 * shared component is scanned the day it is added.
 *
 * Routes stay explicit - a new public route is a deliberate act, and a short
 * list of them is genuinely reviewable - but a test below pins that list against
 * the live MARKETING_PAGES registry so it cannot silently fall behind either.
 */
function marketingComponentFiles(): string[] {
  const roots = ["app/_components/marketing", "app/_components/marketing/visuals"];
  const out: string[] = [];
  for (const rel of roots) {
    for (const f of readdirSync(join(ROOT, rel))) {
      if (f.endsWith(".tsx") || f.endsWith(".ts")) out.push(`${rel}/${f}`);
    }
  }
  return out;
}

const MARKETING_SOURCES: string[] = [
  ...MARKETING_ROUTES,
  ...marketingComponentFiles(),
  "app/_components/PolicyLayout.tsx",
  "app/_components/DemoForm.tsx",
  "lib/marketing/content.ts",
  // Article titles, descriptions and author render, and also feed the sitemap
  // and Article JSON-LD.
  "lib/marketing/resources.ts",
];

/**
 * Remove comments by SCANNING, not by regex order.
 *
 * The first version stripped block comments then line comments, which broke on
 * `lib/marketing/content.ts`: it carries `next/*` inside a line comment, and a
 * regex reads that as a block-comment opener, so the lazy match ran to the next
 * `*\/` and deleted 1,403 characters of real code including CANONICAL_HOST and
 * all of POSITIONING. The scan then reported the file clean because it could no
 * longer see the file.
 *
 * Swapping the order fixed that case and broke a different one, which review
 * caught: in a legitimate block comment whose body contains a line starting with
 * `//`, line-first stripping eats that line INCLUDING the block's closing
 * `*\/`, after which the block rule consumes real source up to the next
 * terminator. Either order is wrong on some valid input, because neither knows
 * what it is already inside.
 *
 * So this walks the source once, tracking whether it is in a line comment, a
 * block comment, a string, or a template literal. Comment bodies are replaced
 * with spaces (preserving offsets and newlines); everything else is kept
 * verbatim. A `//` or `/*` inside a string is not a comment, and a quote inside
 * a comment does not open a string - which is exactly what the regexes could not
 * express.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (mode === "code") {
      if (c === "/" && c2 === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && c2 === "*") { mode = "block"; out += "  "; i += 2; continue; }
      if (c === "'") { mode = "single"; out += c; i += 1; continue; }
      if (c === '"') { mode = "double"; out += c; i += 1; continue; }
      if (c === "`") { mode = "template"; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }

    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += "\n"; i += 1; continue; }
      out += " "; i += 1; continue;
    }

    if (mode === "block") {
      if (c === "*" && c2 === "/") { mode = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i += 1; continue;
    }

    // Inside a string or template: copy verbatim, honour escapes, and only the
    // matching terminator closes it.
    if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (mode === "single" && c === "'") { mode = "code"; out += c; i += 1; continue; }
    if (mode === "double" && c === '"') { mode = "code"; out += c; i += 1; continue; }
    if (mode === "template" && c === "`") { mode = "code"; out += c; i += 1; continue; }
    out += c; i += 1; continue;
  }
  return out;
}

/**
 * Every span of authored copy in a source file, whichever form it was written
 * in. Review flagged that scanning only double-quoted literals let raw JSX text,
 * single-quoted strings and template literals carry a banned claim untouched -
 * `<p>Every record has an append-only edit history.</p>` was invisible to the
 * guard. All four forms are extracted here so a future author's choice of
 * quoting cannot decide whether the claim is audited.
 */
function copySegments(src: string): string[] {
  const code = stripComments(src);
  const segs: string[] = [];
  for (const re of [/"((?:[^"\\]|\\.)*)"/g, /'((?:[^'\\]|\\.)*)'/g, /`((?:[^`\\]|\\.)*)`/g]) {
    for (const m of code.matchAll(re)) segs.push(m[1]);
  }
  // JSX text, flattened across INLINE markup.
  //
  // Splitting at every tag boundary judged a fragment instead of the sentence a
  // visitor reads. Review's example:
  //
  //   <p>Every treatment record has <strong>an append-only edit history for
  //   sterile items</strong></p>
  //
  // The <strong> fragment names a supported record type and contains no
  // overreach term, so it passed - while the rendered sentence promises history
  // for every treatment record, which is exactly the claim §0.4 N1 rejects.
  //
  // So inline elements are dissolved before text runs are read, and only
  // BLOCK-level boundaries still separate one claim from the next. That keeps a
  // sentence whole without gluing two unrelated paragraphs together.
  const INLINE = "a|abbr|b|br|code|em|i|mark|s|small|span|strong|sub|sup|time|u";
  const flattened = code
    .replace(new RegExp(`</?(?:${INLINE})(?:\\s[^<>]*)?/?>`, "gi"), " ")
    // A JSX expression holding a plain string literal is INLINED, not dropped.
    // Dropping it re-created the split-claim hole one level down:
    //
    //   <p>Every treatment record has {"an append-only edit history for
    //   sterile items"}</p>
    //
    // left "Every treatment record has" in one segment and the literal in
    // another - and the literal, scanned alone, names a supported record type
    // and carries no overreach term, so it passed. Inlining keeps the sentence
    // a visitor actually reads intact.
    .replace(/\{\s*(['"])((?:[^'"\\]|\\.)*)\1\s*\}/g, " $2 ")
    // Any remaining expression is a value this scan cannot resolve; blank it so
    // it cannot glue two sentences together.
    .replace(/\{[^{}]*\}/g, " ");
  for (const m of flattened.matchAll(/>([^<>]+)</g)) {
    const t = m[1].replace(/\s+/g, " ").trim();
    if (t && /[A-Za-z]/.test(t)) segs.push(t);
  }
  return segs;
}

const MARKETING_COPY = MARKETING_SOURCES.map((f) => stripComments(read(f)))
  .join("\n")
  .replace(/\s+/g, " ");

describe("the scan covers what a visitor actually reads", () => {
  it("the route list matches the live MARKETING_PAGES registry", () => {
    // MARKETING_PAGES drives the sitemap, per-page metadata and the middleware
    // public-route allowlist, so it is the registry of record for what is
    // public. Pinning against it means a new indexable route cannot be added
    // without this list noticing — which is the failure that happened twice by
    // hand.
    const registryRoutes = MARKETING_PAGES.filter((p) => p.indexable)
      .map((p) => p.path)
      // The two policy pages own their own shell (PolicyLayout), which is
      // scanned directly rather than as a route file.
      .filter((path) => path !== "/privacy" && path !== "/terms");

    const scannedRoutes = MARKETING_ROUTES.map((f) =>
      f === "app/page.tsx"
        ? "/"
        : "/" + f.replace(/^app\//, "").replace(/\/page\.tsx$/, ""),
    );

    for (const path of registryRoutes) {
      expect(
        scannedRoutes,
        `${path} is an indexable marketing route but is not scanned for forbidden claims`,
      ).toContain(path);
    }
  });

  it("scans the shared components those routes render", () => {
    // Derived from the directory, so this asserts the derivation WORKED rather
    // than re-listing it. SiteFooter is named explicitly because it is the file
    // review used to demonstrate the hole.
    expect(MARKETING_SOURCES).toContain(
      "app/_components/marketing/SiteFooter.tsx",
    );
    expect(MARKETING_SOURCES.length).toBeGreaterThan(MARKETING_ROUTES.length);
  });

  it("the copy it reads includes copy authored in a shared component", () => {
    // A live string that exists only in SiteFooter. If this disappears the
    // derivation has silently stopped reaching components.
    expect(MARKETING_COPY).toMatch(/Operated from Canada/);
  });
});

describe("truth register: provenance is declared, not assumed", () => {
  it("names the production head it was built against, as a full SHA", () => {
    expect(
      declaredHead(),
      "the register must declare the 40-character production head it was verified against",
    ).toMatch(/^[0-9a-f]{40}$/);
  });

  // Both checks below need real history. CI's validate lane clones at depth 1,
  // where an ANCESTOR commit is simply absent — `git cat-file -e` returns 128
  // and `merge-base` cannot answer. That is not a stale register, it is a
  // truncated clone, and failing on it would be a false red.
  //
  // The first version of this guard gated only the ancestry check on
  // shallowness and let the existence check run unconditionally. It passed
  // locally on a full clone and failed in CI on the first push, with
  // "declares head a946a983…, which is not a commit in this repository" — the
  // register was fine; the clone had no such object. Both are gated now.
  //
  // This repo has been bitten by the converse too: history-derived docs rules
  // that silently never executed in CI. So the skip is an explicit, visible
  // assertion about the clone rather than an early `return` that looks green.
  const shallowClone = (): boolean =>
    spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: ROOT,
      encoding: "utf8",
    }).stdout?.trim() === "true";

  it("the declared head is a commit that actually exists in this repository", () => {
    const sha = declaredHead();
    if (shallowClone()) {
      expect(
        sha,
        "shallow clone: object presence is not checkable here",
      ).toMatch(/^[0-9a-f]{40}$/);
      return;
    }
    const { status } = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(
      status,
      `the register declares head ${sha}, which is not a commit in this repository`,
    ).toBe(0);
  });

  it("the declared head is an ancestor of the branch under test", () => {
    const sha = declaredHead();
    if (shallowClone()) {
      expect(sha, "shallow clone: ancestry is not checkable here").toMatch(
        /^[0-9a-f]{40}$/,
      );
      return;
    }
    const { status } = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", sha, "HEAD"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(
      status,
      `the register declares head ${sha}, which is not an ancestor of HEAD`,
    ).toBe(0);
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
  // N1. An UNSCOPED edit-history claim. The scoped form shipped on
  // /features/charting-records is true — migration 0086 writes a trigger-based,
  // tamper-proof trail for sterile items, disinfectants, exposure incidents,
  // the aftercare mark and session_blocks.probe_lot_number. What is NOT true is
  // the general form: editing any other charted clinical value runs through
  // update_block_with_entry (0166) as a plain UPDATE that keeps no prior value.
  it("no unscoped 'every change is tracked' / 'complete audit trail' claim", () => {
    for (const banned of [
      // The register's OWN N1 wording came first. Review caught that the guard
      // claimed to enforce §0.4 while not matching the exact sentence §0.4
      // rejects - the canonical rejected claim could have shipped green.
      /edits kept as history/i,
      /not written over/i,
      /changes are preserved rather than replaced/i,
      // and the paraphrases that mean the same thing
      /every change is (tracked|recorded|kept|preserved)/i,
      /complete audit trail/i,
      /full (edit )?history of every (change|edit)/i,
      /nothing is ever overwritten/i,
      /never overwritten/i,
    ]) {
      expect(
        MARKETING_COPY,
        `forbidden by truth register §0.4 N1: ${banned}`,
      ).not.toMatch(banned);
    }
  });

  it("the append-only claim, where it appears, names an audited record type", () => {
    // §0.4 N1: migration 0086's trigger-written trail covers sterile items,
    // disinfectants, exposure incidents, the aftercare mark, and
    // session_blocks.probe_lot_number - THAT COLUMN ONLY. Every other charted
    // value is a plain UPDATE that keeps no prior value.
    //
    // Two review findings shaped this check.
    //
    // (a) It used to scan only double-quoted literals, so the same claim in raw
    //     JSX text, a single-quoted string or a template literal was invisible.
    //     copySegments() now yields all four forms.
    //
    // (b) The old scope regex accepted any of lot|sterile|disinfectant|log|note,
    //     which "Every charting log has an append-only edit history" satisfies
    //     while promising exactly what the product cannot keep - and which bare
    //     "a lot" or "noteworthy" satisfied by accident. It now requires an
    //     explicit supported noun phrase AND rejects any segment that widens the
    //     promise to treatment records or to edits in general.
    const SUPPORTED =
      /\b(sterile[- ]item|sterile items|disinfectant|exposure incident|probe lot|lot number|record[- ]keeping)\b/i;
    const OVERREACH =
      /\b(every (record|change|edit|treatment|field)|all (records|changes|edits|treatments)|treatment record|charting|chart(ed)? (value|field)|session|clinical)\b/i;

    let checked = 0;
    for (const file of MARKETING_SOURCES) {
      for (const seg of copySegments(read(file))) {
        if (!/append-only/i.test(seg)) continue;
        checked += 1;
        expect(
          seg,
          `${file}: an append-only claim must name an audited record type (sterile items, disinfectants, exposure incidents, probe lots, record-keeping). Offending copy: "${seg}"`,
        ).toMatch(SUPPORTED);
        expect(
          seg,
          `${file}: this append-only claim also extends the promise beyond the audited records, which §0.4 N1 rejects. Offending copy: "${seg}"`,
        ).not.toMatch(OVERREACH);
      }
    }
    // Guard the guard: zero segments would pass by vacuity, and "no append-only
    // claim anywhere" is a different state, owned by the overcorrection block.
    expect(
      checked,
      "no append-only copy found; see the overcorrection block",
    ).toBeGreaterThan(0);
  });

  // N2. The film's capture provenance. The public label is fine and ships; what
  // must never appear is a claim about WHICH tenant supplied the data, because
  // the deck's assertion about that was disproven (§0.7).
  it("no public copy asserts the capture tenant", () => {
    for (const banned of [
      /synthetic[- ]twin/i,
      /captured from (our|the) (production|live) (tenant|studio)/i,
    ]) {
      expect(
        MARKETING_COPY,
        `forbidden by truth register §0.4 N2: ${banned}`,
      ).not.toMatch(banned);
    }
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
