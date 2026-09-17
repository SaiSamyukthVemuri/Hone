import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationState } from "../migrations/helpers/migration-state";

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

// The public marketing surface, as source. Kept as a list rather than a glob so
// a new marketing route has to be added here deliberately — a guard that
// silently stops covering a new page is the failure mode this repo has already
// paid for once.
const MARKETING_SOURCES = [
  "app/page.tsx",
  "app/pricing/page.tsx",
  "app/demo/page.tsx",
  "app/electrolysis-software/page.tsx",
  "app/features/treatment-memory/page.tsx",
  "app/features/charting-records/page.tsx",
  "app/features/booking-calendar/page.tsx",
  "lib/marketing/content.ts",
] as const;

/** Strip source comments so scans read RENDERED copy, not the explanatory prose
 *  around it. The register itself is quoted in comments in several of these
 *  files, and a comment explaining why a claim is forbidden must not trip the
 *  guard that forbids it.
 *
 *  ORDER MATTERS, and getting it wrong silently blinds the guard.
 *  `lib/marketing/content.ts` contains, inside an ordinary line comment:
 *
 *      // This module is intentionally framework-agnostic (no next/* imports) …
 *
 *  That `next/*` is a block-comment OPENER as far as a regex is concerned. Strip
 *  block comments first and the lazy match runs from there to the next `*\/` —
 *  the JSDoc on `PricingPlan.priceLabel`, ~1,400 characters later — taking
 *  CANONICAL_HOST, all of POSITIONING, WALKTHROUGH and the pricing block with
 *  it. The scan then reports a clean file because it can no longer see the file.
 *  Measured: 1,403 characters of real code lost.
 *
 *  Stripping LINE comments first removes the phantom opener with its line, and
 *  the block strip is then safe. The shipped marketing guards do not hit this
 *  because none of them reads content.ts; this one does, deliberately. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

const MARKETING_COPY = MARKETING_SOURCES.map((f) => stripComments(read(f)))
  .join("\n")
  .replace(/\s+/g, " ");

describe("truth register: provenance is declared, not assumed", () => {
  it("names the production head it was built against, as a full SHA", () => {
    const m = REGISTER.match(
      /Built against production head \| `([0-9a-f]{40})`/,
    );
    expect(
      m,
      "the register must declare the 40-character production head it was verified against",
    ).not.toBeNull();
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
      /every change is (tracked|recorded|kept)/i,
      /complete audit trail/i,
      /full (edit )?history of every (change|edit)/i,
      /nothing is ever overwritten/i,
    ]) {
      expect(
        MARKETING_COPY,
        `forbidden by truth register §0.4 N1: ${banned}`,
      ).not.toMatch(banned);
    }
  });

  it("the append-only claim, where it appears, stays scoped to logs", () => {
    // This is the surface-split ruling in §0.4 N1, made mechanical.
    //
    // It must be checked against the STRING LITERAL that carries the claim, not
    // against a "sentence" of the surrounding source. An earlier draft of this
    // guard split the concatenated source on sentence boundaries, and a mutation
    // that replaced the scoped body with the unscoped "Everything you record is
    // kept with an append-only edit history." still PASSED — because the chunk
    // also swept in the neighbouring `title: "Traceability and logs"`, and the
    // word "logs" satisfied the scope check from a claim it had nothing to do
    // with. Proximity has to be measured inside one claim.
    const SCOPE = /lot|sterile|disinfectant|log\b|logs\b|note|incident/i;
    let checked = 0;
    for (const file of MARKETING_SOURCES) {
      const src = stripComments(read(file));
      // Double-quoted string literals, which is how every copy body in this
      // codebase is written. Escaped quotes are handled; newlines are not, and
      // do not occur inside these literals.
      for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        const literal = m[1];
        if (!/append-only/i.test(literal)) continue;
        checked += 1;
        expect(
          literal,
          `${file}: an append-only claim must name its own scope (lots / sterile items / disinfectants / logs / notes / incidents) inside the SAME string. Offending literal: "${literal}"`,
        ).toMatch(SCOPE);
      }
    }
    // Guard the guard: if the phrase disappears entirely this test would pass
    // by vacuity, and "no append-only claim anywhere" is a different (and also
    // wrong) state. The overcorrection block below owns that, so here we only
    // record that the scan had something to look at.
    expect(
      checked,
      "no append-only literal found in marketing copy; see the overcorrection block",
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
