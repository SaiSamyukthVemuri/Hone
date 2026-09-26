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

// TWO INDEPENDENT OWNERSHIP FAMILIES.
//
// Response and settings can move separately, and gating both on one predicate
// meant a migration of EITHER retired BOTH bans — so moving tolerance onto the
// area would also have licensed "settings recorded per treated area", which
// would still be false. Each family now carries its own predicate and gates
// only its own checks.
const RESPONSE_FIELDS = ["tolerance_rating", "reaction_type", "reaction_notes"];
const SETTINGS_FIELDS = ["machine_frequency", "probe_key", "probe_lot_number"];

function has(src: string, f: string): boolean {
  return new RegExp(`^\\s*${f}\\??:`, "m").test(src);
}

/** Where a family currently lives. */
function ownership(fields: string[]): {
  onBlock: string[];
  onArea: string[];
  blockOwned: boolean;
  areaOwned: boolean;
  split: boolean;
} {
  const sb = block("SessionBlock");
  const sba = block("SessionBlockArea");
  const onBlock = fields.filter((f) => has(sb, f));
  const onArea = fields.filter((f) => has(sba, f));
  return {
    onBlock,
    onArea,
    blockOwned: onBlock.length === fields.length && onArea.length === 0,
    areaOwned: onArea.length === fields.length && onBlock.length === 0,
    // Neither wholly one nor wholly the other: nothing can be trusted.
    split:
      !(onBlock.length === fields.length && onArea.length === 0) &&
      !(onArea.length === fields.length && onBlock.length === 0),
  };
}

function responseIsBlockOwned(): boolean {
  return ownership(RESPONSE_FIELDS).blockOwned;
}
function settingsAreBlockOwned(): boolean {
  return ownership(SETTINGS_FIELDS).blockOwned;
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
/**
 * Routes that carry BOTH profession-level guidance and Hone product promises.
 *
 * A whole-file exemption was too broad. The checklist legitimately lists
 * "Tolerance for each area" as something a thorough practitioner record may
 * contain — that is a statement about the profession, not about Hone — but the
 * same page also sold a Hone capability, and exempting the file let the product
 * claim through with the guidance.
 *
 * So the exemption is SENTENCE-scoped: on these routes the per-area patterns
 * run only on sentences that speak about Hone. Guidance survives; Hone-specific
 * claims on the same route stay checked. The universal-capture rule below
 * applies to these routes regardless.
 */
const GUIDANCE_ROUTES: Readonly<Record<string, string>> = {
  "app/resources/electrolysis-treatment-record-checklist/page.tsx":
    "Profession-level checklist of what a thorough treatment RECORD may contain. The list items describe the standard, not Hone's storage model; Hone-specific sentences on the page are still checked.",
};

/**
 * A promise to capture EVERYTHING on a page whose own guidance includes
 * per-area response.
 *
 * This is the shape the defect actually took: the checklist lists "Tolerance
 * for each area", and the page then said Hone "captures every item on this
 * checklist". Neither half is wrong alone. Together they assert per-area
 * response storage that does not exist, so the pair is what fails.
 */
const UNIVERSAL_CAPTURE =
  /\b(captur\w*|record\w*|structur\w*|keep\w*)\b[^.]{0,40}?\b(every|all)\s+(item|field|thing|one)\b|\b(every|all)\s+(item|field|thing)\b[^.]{0,40}?\b(is|are)\s+(captur\w*|record\w*|structur\w*)/i;

// A per-area quantifier sitting near a response/settings word, in either order.
// ONE adjective is allowed between quantifier and noun: mutation testing showed
// `each TREATED area` walked straight past a literal `(treatment\\s+)?`, which is
// how app/features/treatment-memory kept its claim through the first fix.
// `laterality` is deliberately absent: it IS per area.
// TWO TIERS, because the two halves of the model fail differently.
//
// TIER 1 — the RESPONSE words. Proximity alone is enough: a sentence putting
// "each area" near "tolerated" makes the claim whatever else it says.
//
// TIER 2 — the SETTINGS nouns. These appear constantly in copy that is TRUE
// ("those settings are recorded once, for that group"; "select every area
// treated using this settings setup"), so proximity would condemn the clearest
// explanations of the model in the repo. They are flagged only when an
// OWNERSHIP verb attaches them to the area — "recorded per treated area", which
// is exactly how the published SEO description put it.
//
// `laterality` is in neither tier: it is the one thing session_block_areas
// really does own per area.
const RESPONSE_WORD = "tolerat|toleran|reaction|respond|response|settings used|setup used";
const SETTINGS_NOUN = "settings|setup|modality|machine frequency|probe|lot";
const OWNERSHIP_VERB = "recorded|kept|stored|captured|logged|tracked";
type Family = "response" | "settings";
const PATTERNS: Array<[string, RegExp, Family]> = [
  [
    "per-area quantifier followed by a response word",
    new RegExp(`\\b(each|per|every)\\s+(\\w+\\s+)?area\\b[^.|]{0,80}?(${RESPONSE_WORD})`, "i"),
    "response",
  ],
  [
    "response word followed by a per-area quantifier",
    new RegExp(`(${RESPONSE_WORD})[^.|]{0,40}?\\b(per|each|every)\\s+(\\w+\\s+)?area\\b`, "i"),
    "response",
  ],
  [
    "block-owned settings said to be recorded per area",
    new RegExp(
      `(${SETTINGS_NOUN})[^.|]{0,30}?\\b(${OWNERSHIP_VERB})\\s+(per|for each|for every)\\s+(\\w+\\s+)?area\\b`,
      "i",
    ),
    "settings",
  ],
  [
    "an area said to own block-level settings",
    new RegExp(
      `\\b(each|every|per)\\s+(\\w+\\s+)?area\\b[^.|]{0,25}?\\bown\\s+(\\w+\\s+){0,2}(${SETTINGS_NOUN})`,
      "i",
    ),
    "settings",
  ],
];

/**
 * The one phrasing that makes a per-area sentence TRUE.
 *
 * The patterns cannot parse English attachment, so they fire on the correct
 * copy as readily as the wrong copy: "every treated area stays findable,
 * carrying the response FROM THE BLOCK it was charted under" is exactly what
 * the product does, and names the block as the owner while doing it.
 *
 * This is not a loophole. To qualify, the sentence must explicitly attribute
 * the data to the block — which IS the fact being enforced. A sentence that
 * merely mentions areas and response, with no owner named, still fails.
 */
const BLOCK_SCOPED = /\b(on|from|under|to|against)\s+(the\s+)?(settings[\s-]|machine[\s-]settings[\s-])?block\b/i;

/**
 * The owner must be named RIGHT THERE, not merely somewhere in the sentence.
 *
 * A sentence-wide search was too generous: a truth-register ROW is one long
 * sentence, so reverting the capability label still left "recorded on the
 * settings block" further along the row and the revert went unnoticed. The
 * window is therefore the match itself plus a short tail — the phrasing that
 * actually attributes it ("... and response FROM THE BLOCK it was charted
 * under") sits immediately after.
 */
const OWNER_WINDOW = 48;
function ownerNamedAt(text: string, index: number, matchLength: number): boolean {
  const tail = text.slice(index, index + matchLength + OWNER_WINDOW);
  // The window stops at the end of the sentence. Without this it ran straight
  // past the full stop and let the NEXT sentence supply the owner, so
  // "Each area keeps its own tolerance. Settings live on the block." rescued
  // itself with a sentence that says nothing about those areas.
  const stop = tail.indexOf(".", matchLength);
  return BLOCK_SCOPED.test(stop === -1 ? tail : tail.slice(0, stop));
}

/**
 * The single detector, used BOTH for the real sweep and for synthetic controls.
 *
 * Mutation testing found the first shape untestable: the rescue lived inline in
 * the file loop, so turning it into a blanket `continue` passed every control
 * while the sweep reported nothing. Sharing one function means the synthetic
 * cases below exercise the exact code the sweep runs.
 */
function offendersIn(rel: string, copy: string): string[] {
  const found: string[] = [];
  const guidance = rel in GUIDANCE_ROUTES;
  for (const [label, re, family] of PATTERNS) {
    // Each family's ban runs only while THAT family is block-owned.
    if (family === "response" && !responseIsBlockOwned()) continue;
    if (family === "settings" && !settingsAreBlockOwned()) continue;
    for (const hit of copy.matchAll(new RegExp(re.source, re.flags + "g"))) {
      if (hit.index === undefined) continue;
      if (ownerNamedAt(copy, hit.index, hit[0].length)) continue;
      // On a guidance route, only sentences that speak about Hone are claims.
      if (guidance && !/\bHone\b/i.test(sentenceAt(copy, hit.index))) continue;
      found.push(`${rel}: ${label}: "${hit[0].replace(/\s+/g, " ").slice(0, 90)}"`);
    }
  }
  // A universal-capture promise is false on any page whose own content carries
  // per-area response guidance — whichever half you read first.
  if (responseIsBlockOwned() && UNIVERSAL_CAPTURE.test(copy)) {
    const perAreaResponse = PATTERNS.filter(([, , f]) => f === "response").some(
      ([, re]) => re.test(copy),
    );
    if (perAreaResponse) {
      const m = UNIVERSAL_CAPTURE.exec(copy);
      found.push(
        `${rel}: universal capture promise on a page whose own guidance includes per-area response: "${(m?.[0] ?? "").replace(/\s+/g, " ").slice(0, 90)}"`,
      );
    }
  }
  return found;
}

/** The sentence an index falls in. */
function sentenceAt(text: string, index: number): string {
  const start = text.lastIndexOf(".", index) + 1;
  const end = text.indexOf(".", index);
  return text.slice(start, end === -1 ? text.length : end);
}

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

  it("every guidance-scoped surface is still swept", () => {
    for (const rel of Object.keys(GUIDANCE_ROUTES)) {
      expect(() => read(rel), `${rel} is scoped but missing`).not.toThrow();
      // and it must still be SWEPT, not skipped
      expect(marketingSurfaces(), `${rel} must remain in the sweep`).toContain(rel);
    }
  });

  it("no public marketing surface claims per-area response", () => {
    const offenders: string[] = [];
    for (const rel of marketingSurfaces()) {
      offenders.push(...offendersIn(rel, copyOnly(read(rel))));
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

  it("naming the block RIGHT THERE is what rescues a per-area sentence", () => {
    const fires = (t: string) => offendersIn("synthetic", t).length > 0;
    // TRUE: owner named immediately after the claim.
    expect(fires("Every treated area stays findable, carrying the response from the block it was charted under.")).toBe(false);
    expect(fires("Tolerance and skin response are recorded on the settings block that covers them.")).toBe(false);
    // FALSE: no owner named at all.
    expect(fires("Each treated area keeps its own tolerance and response.")).toBe(true);
    expect(fires("Capture how each area was tolerated and any reaction.")).toBe(true);
    // FALSE: the owner is named, but far away — a long row must not rescue a
    // claim made at its start. This is the case that let two reverts through.
    expect(
      fires(
        "Client tolerance + skin/reaction per area (with numbing record) and a great many further words of unrelated register prose padding this row out well past the window, recorded on the settings block",
      ),
    ).toBe(true);
    // FALSE: owner named in a NEIGHBOURING sentence only.
    expect(fires("Each area keeps its own tolerance. Settings live on the block.")).toBe(true);
  });

  it("a rescued sentence does not hide a LATER claim in the same file", () => {
    // The multi-match case. With `re.exec` only the first hit per pattern was
    // examined, so a file whose opening sentence was truthful and rescued kept
    // every later unscoped claim invisible — it passed on the strength of its
    // best sentence.
    const text =
      "Every treated area carries the response from the block it was charted under. " +
      "Each area has its own tolerance and reaction.";
    const found = offendersIn("synthetic", text);
    expect(found.length).toBe(1);
    expect(found[0]).toMatch(/own toleran/);
  });

  it("settings nouns are flagged only when OWNED by the area", () => {
    const fires = (x: string) => offendersIn("synthetic", x).length > 0;
    // REJECT — the published SEO description's exact shape.
    expect(fires("Modality, settings, probe and lot recorded per treated area, with booking.")).toBe(true);
    expect(fires("Each treated area has its own machine settings.")).toBe(true);
    // ALLOW — the clearest true statements of block ownership in the repo.
    expect(fires("Treat several areas at the same settings and those settings are recorded once, for that group, and every area in it carries the treatment into its own history.")).toBe(false);
    expect(fires("Select every area treated using this settings setup.")).toBe(false);
    expect(fires("It keeps a separate history for every treated area and brings last time's settings forward.")).toBe(false);
  });

  it("guidance may stand; a Hone claim on the same route may not", () => {
    // P2-1. The checklist legitimately lists per-area response as something a
    // thorough RECORD may contain. That is a statement about the profession.
    // A Hone sentence on the same page is a product claim and stays checked.
    const rel = "app/resources/electrolysis-treatment-record-checklist/page.tsx";
    expect(Object.keys(GUIDANCE_ROUTES)).toContain(rel);
    // guidance alone — allowed
    expect(offendersIn(rel, '"Tolerance for each area", "Any skin reaction"')).toEqual([]);
    // the same words in a HONE sentence — rejected
    expect(
      offendersIn(rel, "Hone records tolerance for each area as a structured field").length,
    ).toBeGreaterThan(0);
    // and on a NON-guidance route the guidance form is still a claim
    expect(offendersIn("app/page.tsx", "Tolerance for each area").length).toBeGreaterThan(0);
  });

  it("a universal-capture promise fails on a page whose guidance is per-area", () => {
    // P2-1's actual shape: neither half is wrong alone, the pair is.
    const rel = "app/resources/electrolysis-treatment-record-checklist/page.tsx";
    const guidanceOnly = '"Tolerance for each area", "Minutes performed per area"';
    const promiseOnly = "See how Hone captures every item on this page as structured data";
    expect(offendersIn(rel, guidanceOnly)).toEqual([]);
    const both = `${guidanceOnly} ... ${promiseOnly}`;
    const hits = offendersIn(rel, both);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.join(" ")).toMatch(/universal capture promise/);
  });

  it("the live checklist route makes no universal-capture promise", () => {
    const rel = "app/resources/electrolysis-treatment-record-checklist/page.tsx";
    expect(offendersIn(rel, copyOnly(read(rel)))).toEqual([]);
    // the guidance itself is still there — not deleted to satisfy the guard
    const src = read(rel);
    expect(src).toContain('"Tolerance for each area"');
    expect(src).toContain('"Any skin or client reaction, and whether it settled"');
  });

  it("each ownership family is coherent on its own", () => {
    // P2-2 / state D: a family split across both tables is the state where
    // nothing can be trusted, and it fails loudly in EITHER direction.
    for (const [name, fields] of [
      ["response", RESPONSE_FIELDS],
      ["settings", SETTINGS_FIELDS],
    ] as const) {
      const o = ownership(fields as string[]);
      expect(
        o.split,
        `${name} fields must sit wholly on one table; block: [${o.onBlock}], area: [${o.onArea}]`,
      ).toBe(false);
    }
  });

  it("the two families gate independently", () => {
    // The shape of states A and B: each family's checks consult only its own
    // predicate, so a migration of one cannot license the other's false claim.
    const responsePatterns = PATTERNS.filter(([, , f]) => f === "response");
    const settingsPatterns = PATTERNS.filter(([, , f]) => f === "settings");
    expect(responsePatterns.length).toBeGreaterThan(0);
    expect(settingsPatterns.length).toBeGreaterThan(0);
    const src = read("tests/source-guards/clinical-response-scope-guards.test.ts");
    expect(src).toContain('if (family === "response" && !responseIsBlockOwned()) continue;');
    expect(src).toContain('if (family === "settings" && !settingsAreBlockOwned()) continue;');
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
