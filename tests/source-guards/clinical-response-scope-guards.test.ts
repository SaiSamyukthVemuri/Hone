import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readdirSync } from "node:fs";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// ===========================================================================
// MARKETING MAY NOT CLAIM PER-AREA TOLERANCE / REACTION / SETTINGS
// ===========================================================================
//
// THE MODEL. `session_blocks` owns `tolerance_rating`, `reaction_type`,
// `reaction_notes` and every machine/probe setting. `session_block_areas` owns
// `area`, `laterality` and `display_order` — identity and order, nothing else.
// A settings block may cover SEVERAL areas, so a response recorded against that
// block is one observation shared by all of them, not an independent reading
// per area.
//
// Production shipped the overstatement on four surfaces at once ("how each area
// was tolerated", "response and tolerance per area", "setup used per area",
// and the register's own capability label). Nothing pinned the wording, which
// is why it shipped.
//
// WHAT STAYS TRUE, AND MUST NOT BE BANNED. Areas remain individually findable
// in treatment history; a multi-area block contributes to every area it covers;
// laterality really is per area; and charting areas in SEPARATE blocks really
// does give each its own response. The guard targets the coupling of a per-area
// quantifier to a response/settings word, not the words themselves.
//
// CONDITIONAL, NOT ABSOLUTE — the house pattern from
// export-copy-truth-guards.test.ts. The ban is enforced only while the model
// actually owns response at the block level. If a migration ever moves these
// fields onto `session_block_areas`, the precondition below fails, this guard
// stops objecting, and the claim becomes true on its own. A guard that banned
// the phrasing forever would have to be deleted by the very change that earns
// it.
// ===========================================================================

const DB_TYPES = read("lib/types/database.ts");

function block(typeName: string): string {
  const start = DB_TYPES.indexOf(`export type ${typeName} = {`);
  if (start < 0) return "";
  return DB_TYPES.slice(start, DB_TYPES.indexOf("\n};", start));
}

const RESPONSE_FIELDS = ["tolerance_rating", "reaction_type", "reaction_notes"];

/** The precondition the ban rests on, read from the model itself. */
function responseIsBlockOwned(): boolean {
  const sb = block("SessionBlock");
  const sba = block("SessionBlockArea");
  if (!sb || !sba) return false;
  const ownedByBlock = RESPONSE_FIELDS.every((f) =>
    new RegExp(`^\\s*${f}\\??:`, "m").test(sb),
  );
  const absentFromArea = RESPONSE_FIELDS.every(
    (f) => !new RegExp(`^\\s*${f}\\??:`, "m").test(sba),
  );
  return ownedByBlock && absentFromArea;
}

// Comments are where a correction records what it corrected, so quoting the old
// wording in a comment must not trip the guard. The guard is about what the
// SCREEN says. Line comments and block-comment bodies are both dropped.
function copyOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(line))
    .join("\n");
}

// DERIVED, NOT HAND-LISTED. The first version of this guard named four files
// and missed app/electrolysis-software/page.tsx, which went on publishing the
// claim while the guard passed — a hand list can only ever confirm what its
// author already knew about. Walking the public marketing tree means a NEW
// route is covered the day it is added.
//
// `app/(app)/**` and `app/api/**` are excluded: those are the authenticated
// product and its endpoints, not marketing claims.
function marketingSurfaces(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "(app)" || e.name === "api" || e.name === "node_modules") continue;
        walk(child);
      } else if (/\.(tsx?|md)$/.test(e.name)) {
        out.push(child);
      }
    }
  };
  for (const root of ["app", "lib/marketing", "docs/marketing", "components"]) walk(root);
  return out.sort();
}

/**
 * Surfaces deliberately OUT of this defect class, each with the reason.
 *
 * Not an escape hatch for copy that is merely inconvenient: the entry must
 * describe why the text is not a claim about what Hone stores. The file is
 * asserted to exist so a rename cannot turn an exemption into a silent
 * wildcard.
 */
const OUT_OF_CLASS: Readonly<Record<string, string>> = {
  "app/resources/electrolysis-treatment-record-checklist/page.tsx":
    "A best-practice checklist of what an electrolysis treatment RECORD should contain. It is guidance for the practitioner's own record-keeping, not a statement about what Hone stores or how it scopes response, so correcting it would misrepresent the profession's standard rather than Hone.",
};

// A per-area quantifier sitting near a response/settings word, in either order.
// `laterality` is deliberately absent: it IS per area.
const RESPONSE_WORD = "tolerat|toleran|reaction|respond|response|settings used|setup used";
const PATTERNS: Array<[string, RegExp]> = [
  [
    "per-area quantifier followed by a response word",
    new RegExp(`\\b(each|per|every)\\s+(treatment\\s+)?area\\b[^.|]{0,60}?(${RESPONSE_WORD})`, "i"),
  ],
  [
    "response word followed by a per-area quantifier",
    new RegExp(`(${RESPONSE_WORD})[^.|]{0,40}?\\b(per|each|every)\\s+(treatment\\s+)?area\\b`, "i"),
  ],
];

describe("marketing may not claim per-area tolerance / reaction / settings", () => {
  it("the response-ownership regime is COHERENT (either owner, never half)", () => {
    // Deliberately NOT `expect(responseIsBlockOwned()).toBe(true)`. That form
    // would fail the moment a migration moved these fields onto the area —
    // blocking exactly the change this guard's own comments say should retire
    // the ban. A guard that has to be deleted by the change that earns it is a
    // guard nobody will trust.
    //
    // What IS enduring: one owner, not both and not neither. A half-migrated
    // model is the state where neither the ban nor the claim can be trusted,
    // and that is worth failing on in either regime.
    const has = (src: string, f: string) => new RegExp(`^\\s*${f}\\??:`, "m").test(src);
    const onBlock = RESPONSE_FIELDS.filter((f) => has(block("SessionBlock"), f));
    const onArea = RESPONSE_FIELDS.filter((f) => has(block("SessionBlockArea"), f));

    expect(
      onBlock.length === RESPONSE_FIELDS.length ||
        onArea.length === RESPONSE_FIELDS.length,
      `response fields must sit wholly on one table; on block: [${onBlock}], on area: [${onArea}]`,
    ).toBe(true);
    expect(
      onBlock.length > 0 && onArea.length > 0,
      `response fields must not be split across both tables; on block: [${onBlock}], on area: [${onArea}]`,
    ).toBe(false);
  });

  it("records which regime is in force, without demanding either", () => {
    // Informational: makes the current ownership visible in the run, and makes
    // a future flip legible rather than silent.
    expect(typeof responseIsBlockOwned()).toBe("boolean");
  });

  it("every exempted surface still exists", () => {
    for (const rel of Object.keys(OUT_OF_CLASS)) {
      expect(() => read(rel), `${rel} is exempted but missing`).not.toThrow();
    }
  });

  it("no public marketing surface claims per-area response", () => {
    if (!responseIsBlockOwned()) return; // model moved; the ban lapses by design
    const offenders: string[] = [];
    for (const rel of marketingSurfaces()) {
      if (rel in OUT_OF_CLASS) continue;
      const copy = copyOnly(read(rel));
      for (const [label, re] of PATTERNS) {
        const hit = re.exec(copy);
        if (hit) offenders.push(`${rel}: ${label}: "${hit[0].replace(/\s+/g, " ").slice(0, 90)}"`);
      }
    }
    expect(
      offenders,
      "response belongs to the settings block, which may cover several areas",
    ).toEqual([]);
  });

  it("the sweep actually reaches the routes that shipped the defect", () => {
    // A derived list that silently walked nothing would pass the test above.
    const found = marketingSurfaces();
    expect(found.length).toBeGreaterThan(20);
    for (const rel of [
      "app/page.tsx",
      "app/electrolysis-software/page.tsx",
      "app/features/treatment-memory/page.tsx",
      "app/features/charting-records/page.tsx",
      "lib/marketing/content.ts",
      "docs/marketing/product-truth-register.md",
    ]) {
      expect(found, `${rel} must be swept`).toContain(rel);
    }
  });

  it("the truthful distinctions are NOT banned", () => {
    // Positive control against the real tree: each of these is true and must
    // survive the guard, or the guard would force the copy to understate.
    const home = copyOnly(read("app/page.tsx"));
    expect(home).toContain("area stays findable on its own");
    const register = copyOnly(read("docs/marketing/product-truth-register.md"));
    expect(register).toMatch(/Memory is kept per treatment area/);
    expect(register).toMatch(/Multi-area under one settings block \+ per-area laterality/);
    for (const [, re] of PATTERNS) {
      expect(re.test("area stays findable on its own")).toBe(false);
      expect(re.test("Memory is kept per treatment area, so multi-area sessions stay legible.")).toBe(false);
      expect(re.test("Record several treatment areas under one machine-settings block, each with its own laterality")).toBe(false);
    }
  });

  it("the patterns catch the exact wording production shipped", () => {
    // Negative control against synthetic source, so the guard cannot pass by
    // accident on a tree that happens to be correct today. These are the four
    // real sentences, verbatim from before the repair.
    const SHIPPED = [
      "the machine settings, probe and lot, how each area was tolerated, and what",
      "capture how each area was tolerated and any reaction, as structured",
      "areas treated, response and tolerance per area, a Watch Today caution",
      "setup used per area, consultation and skin/hair",
      "Client tolerance + skin/reaction per area (with numbing record)",
      "laterality, tolerance and skin response, per area.",
    ];
    for (const s of SHIPPED) {
      expect(
        PATTERNS.some(([, re]) => re.test(s)),
        `guard must reject: ${s}`,
      ).toBe(true);
    }
  });

  it("a comment quoting the old wording does not trip the guard", () => {
    const withComment = copyOnly(
      '// was: "how each area was tolerated"\nconst copy = "how the treatment was tolerated";',
    );
    for (const [, re] of PATTERNS) expect(re.test(withComment)).toBe(false);
    // but the same words in live copy still trip it
    expect(
      PATTERNS.some(([, re]) => re.test('const copy = "how each area was tolerated";')),
    ).toBe(true);
  });
});
