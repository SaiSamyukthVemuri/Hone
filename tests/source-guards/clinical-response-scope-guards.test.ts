import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

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

const SURFACES = [
  "app/page.tsx",
  "app/features/charting-records/page.tsx",
  "lib/marketing/content.ts",
  "docs/marketing/product-truth-register.md",
];

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
  it("the precondition holds: response is owned by the BLOCK, not the area", () => {
    // If this ever fails, the model changed and the ban below rightly lapses.
    expect(responseIsBlockOwned()).toBe(true);
    // stated explicitly so the failure message is legible
    for (const f of RESPONSE_FIELDS) {
      expect(block("SessionBlock"), `${f} must be on session_blocks`).toMatch(
        new RegExp(`^\\s*${f}\\??:`, "m"),
      );
      expect(block("SessionBlockArea"), `${f} must NOT be on session_block_areas`).not.toMatch(
        new RegExp(`^\\s*${f}\\??:`, "m"),
      );
    }
  });

  it.each(SURFACES)("%s makes no per-area response claim", (rel) => {
    if (!responseIsBlockOwned()) return; // model changed; ban lapses
    const copy = copyOnly(read(rel));
    for (const [label, re] of PATTERNS) {
      const hit = re.exec(copy);
      expect(
        hit?.[0] ?? null,
        `${rel}: ${label} — response belongs to the settings block, which may cover several areas`,
      ).toBeNull();
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
