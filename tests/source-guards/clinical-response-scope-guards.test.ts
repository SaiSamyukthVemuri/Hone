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

// THE SETTINGS FAMILY WAS INCOMPLETE. Three fields stood in for every
// "settings / setup / modality / probe / lot" claim, so migrating just those
// three would have retired the whole settings ban while the rest of the
// machine and probe columns stayed on the block — the claim would still be
// false and the guard would have stopped saying so.
//
// Split into the two families the marketing vocabulary actually distinguishes,
// each complete, so a PARTIAL migration inside either is a split and fails
// loudly rather than silently retiring anything.
//
// "settings", "setup", "modality", "energy", "machine frequency":
const MACHINE_FIELDS = ["mode", "apilus_modality", "energy_level", "machine_frequency"];
// "probe", "lot" — every column the probe/lot claim rests on:
const PROBE_FIELDS = [
  "probe_type",
  "probe_size",
  "probe_key",
  "probe_brand",
  "probe_material",
  "probe_piece_type",
  "probe_shank",
  "probe_size_value",
  "probe_length",
  "probe_label",
  "probe_lot_number",
  "probe_lot_confirmed",
];
//
// DELIBERATELY EXCLUDED, not overlooked:
//   primary_area / side / custom_area_detail  — area identity, not settings
//   caution_for_next_session / caution_note   — the Watch band, not settings
//   numbing_status / numbing_notes            — recorded with response, and no
//                                               guarded noun refers to it
//   probe_inventory_item_id                   — an inventory FK, never marketed
//   minutes_performed                         — "minutes per area" is its own
//                                               claim with its own vocabulary;
//                                               folding it in here would widen
//                                               this guard past its defect class

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
function machineSettingsAreBlockOwned(): boolean {
  return ownership(MACHINE_FIELDS).blockOwned;
}
function probeIsBlockOwned(): boolean {
  return ownership(PROBE_FIELDS).blockOwned;
}

/** Every guarded family, so nothing can be added without an ownership premise. */
const FAMILIES = [
  ["response", RESPONSE_FIELDS],
  ["machine", MACHINE_FIELDS],
  ["probe", PROBE_FIELDS],
] as const;

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
const GUIDANCE_ROUTES: Readonly<
  Record<string, { reason: string; from: string; to: string }>
> = {
  "app/resources/electrolysis-treatment-record-checklist/page.tsx": {
    reason:
      "Profession-level checklist of what a thorough treatment RECORD may contain. The SECTIONS data describes the standard, not Hone's storage model.",
    // A STRUCTURAL region, not a word test. The previous rule exempted any
    // sentence that did not literally say "Hone", which is far too broad: a CTA
    // reading "We record tolerance for each area" names no subject and is still
    // plainly a product claim. Adding "we"/"our" would only move the heuristic.
    // The guidance IS the SECTIONS array; everything outside it is marketing
    // copy and is swept normally, whatever subject it names or omits.
    from: "const SECTIONS",
    to: "\n];",
  },
};

/** [start, end) of a route's guidance region within the text being scanned. */
function guidanceRegion(rel: string, copy: string): [number, number] | null {
  const spec = GUIDANCE_ROUTES[rel];
  if (!spec) return null;
  const start = copy.indexOf(spec.from);
  if (start < 0) return null;
  const end = copy.indexOf(spec.to, start);
  return end < 0 ? null : [start, end + spec.to.length];
}

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
const MACHINE_NOUN = "settings|setup|modality|machine frequency|energy";
const PROBE_NOUN = "probe|lot";
const SETTINGS_NOUN = `${MACHINE_NOUN}|${PROBE_NOUN}`;
const OWNERSHIP_VERB = "recorded|kept|stored|captured|logged|tracked";
type Family = "response" | "machine" | "probe";
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
    "block-owned machine settings said to be recorded per area",
    new RegExp(
      `(${MACHINE_NOUN})[^.|]{0,30}?\\b(${OWNERSHIP_VERB})\\s+(per|for each|for every)\\s+(\\w+\\s+)?area\\b`,
      "i",
    ),
    "machine",
  ],
  [
    "an area said to own block-level machine settings",
    new RegExp(
      `\\b(each|every|per)\\s+(\\w+\\s+)?area\\b[^.|]{0,25}?\\bown\\s+(\\w+\\s+){0,2}(${MACHINE_NOUN})`,
      "i",
    ),
    "machine",
  ],
  [
    "block-owned probe/lot said to be recorded per area",
    new RegExp(
      `(${PROBE_NOUN})[^.|]{0,30}?\\b(${OWNERSHIP_VERB})\\s+(per|for each|for every)\\s+(\\w+\\s+)?area\\b`,
      "i",
    ),
    "probe",
  ],
  [
    "an area said to own block-level probe/lot",
    new RegExp(
      `\\b(each|every|per)\\s+(\\w+\\s+)?area\\b[^.|]{0,25}?\\bown\\s+(\\w+\\s+){0,2}(${PROBE_NOUN})`,
      "i",
    ),
    "probe",
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
/**
 * `gated` separates two different questions that were tangled together:
 *   - does the detector RECOGNISE this wording?            (gated: false)
 *   - is the ban currently IN FORCE for that family?        (gated: true)
 *
 * The sweep needs both. The synthetic controls need only the first — gating
 * them meant a correct, complete migration made them fail, which would have
 * blocked exactly the model change the design says should retire the ban.
 */
/**
 * Which families are currently block-owned.
 *
 * INJECTABLE ON PURPOSE. The previous version of the independence test read
 * this file and asserted it CONTAINED the two gating lines — and the literals
 * it searched for were the assertion's own arguments, so the check satisfied
 * itself and proved nothing about `offendersIn`. Passing the regime in lets the
 * five gating behaviours be exercised directly, against a detector that cannot
 * know it is being tested.
 */
type Regime = { response: boolean; machine: boolean; probe: boolean };
function currentRegime(): Regime {
  return {
    response: responseIsBlockOwned(),
    machine: machineSettingsAreBlockOwned(),
    probe: probeIsBlockOwned(),
  };
}

function offendersIn(
  rel: string,
  copy: string,
  gated = true,
  regime: Regime = currentRegime(),
): string[] {
  const found: string[] = [];
  const region = guidanceRegion(rel, copy);
  for (const [label, re, family] of PATTERNS) {
    // Each family's ban runs only while THAT family is block-owned.
    if (gated && !regime[family]) continue;
    for (const hit of copy.matchAll(new RegExp(re.source, re.flags + "g"))) {
      if (hit.index === undefined) continue;
      if (ownerNamedAt(copy, hit.index, hit[0].length)) continue;
      // Exempt ONLY hits that fall inside the structural guidance region.
      if (region && hit.index >= region[0] && hit.index < region[1]) continue;
      found.push(`${rel}: ${label}: "${hit[0].replace(/\s+/g, " ").slice(0, 90)}"`);
    }
  }
  // A universal-capture promise is false on any page whose own content carries
  // per-area response guidance — whichever half you read first.
  if ((!gated || regime.response) && UNIVERSAL_CAPTURE.test(copy)) {
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
    const fires = (t: string) => offendersIn("synthetic", t, false).length > 0;
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
    const found = offendersIn("synthetic", text, false);
    expect(found.length).toBe(1);
    expect(found[0]).toMatch(/own toleran/);
  });

  it("settings nouns are flagged only when OWNED by the area", () => {
    const fires = (x: string) => offendersIn("synthetic", x, false).length > 0;
    // REJECT — the published SEO description's exact shape.
    expect(fires("Modality, settings, probe and lot recorded per treated area, with booking.")).toBe(true);
    expect(fires("Each treated area has its own machine settings.")).toBe(true);
    // ALLOW — the clearest true statements of block ownership in the repo.
    expect(fires("Treat several areas at the same settings and those settings are recorded once, for that group, and every area in it carries the treatment into its own history.")).toBe(false);
    expect(fires("Select every area treated using this settings setup.")).toBe(false);
    expect(fires("It keeps a separate history for every treated area and brings last time's settings forward.")).toBe(false);
  });

  const CHECKLIST = "app/resources/electrolysis-treatment-record-checklist/page.tsx";

  // A synthetic page shaped like the real one: a SECTIONS array of profession
  // guidance, then marketing copy after it.
  const page = (after: string) =>
    [
      'const SECTIONS = [',
      '  { h: "6. Client response", items: [',
      '    "Tolerance for each area",',
      '    "Any skin or client reaction, and whether it settled",',
      '  ] },',
      '];',
      after,
    ].join("\n");

  it("guidance inside the SECTIONS region stands", () => {
    expect(offendersIn(CHECKLIST, page(""), false)).toEqual([]);
  });

  it("a product sentence OUTSIDE the region is swept, whatever subject it names", () => {
    // P2-1's control. None of these says "Hone"; every one is a product claim.
    for (const claim of [
      "We record tolerance for each area.",
      "Our software records tolerance for each area.",
      "This software records tolerance for each area.",
      "Tolerance for each area is recorded automatically.",
      "Hone records tolerance for each area.",
    ]) {
      const found = offendersIn(CHECKLIST, page(claim), false);
      expect(found.length, `must be swept: ${claim}`).toBeGreaterThan(0);
    }
  });

  it("the boundary is structural, not a word test", () => {
    // The SAME sentence is guidance inside the region and a claim outside it.
    const inside = [
      'const SECTIONS = [',
      '  { items: ["Tolerance for each area"] },',
      '];',
    ].join("\n");
    const outside = ["const SECTIONS = [", "  { items: [] },", "];", '"Tolerance for each area"'].join("\n");
    expect(offendersIn(CHECKLIST, inside, false)).toEqual([]);
    expect(offendersIn(CHECKLIST, outside, false).length).toBeGreaterThan(0);
    // and on a route with no guidance region at all, it is always a claim
    expect(offendersIn("app/page.tsx", "Tolerance for each area", false).length).toBeGreaterThan(0);
  });

  it("a universal-capture promise outside the region still fails", () => {
    const promise = "See how we capture every item on this checklist as structured data.";
    const found = offendersIn(CHECKLIST, page(promise), false);
    expect(found.join(" ")).toMatch(/universal capture promise/);
    // guidance alone, with no promise, stays clean
    expect(offendersIn(CHECKLIST, page(""), false)).toEqual([]);
  });

  it("the live checklist route makes no universal-capture promise", () => {
    const rel = "app/resources/electrolysis-treatment-record-checklist/page.tsx";
    expect(offendersIn(rel, copyOnly(read(rel)), false)).toEqual([]);
    // the guidance itself is still there — not deleted to satisfy the guard
    const src = read(rel);
    expect(src).toContain('"Tolerance for each area"');
    expect(src).toContain('"Any skin or client reaction, and whether it settled"');
  });

  it("each ownership family is coherent on its own", () => {
    // P2-2 / state D: a family split across both tables is the state where
    // nothing can be trusted, and it fails loudly in EITHER direction.
    for (const [name, fields] of FAMILIES) {
      const o = ownership(fields as string[]);
      expect(
        o.split,
        `${name} fields must sit wholly on one table; block: [${o.onBlock}], area: [${o.onArea}]`,
      ).toBe(false);
    }
  });

  // Wording that only the named family can object to, so each assertion below
  // isolates one gate.
  const RESPONSE_CLAIM = "Capture how each area was tolerated and any reaction.";
  const MACHINE_CLAIM = "Modality and settings recorded per treated area.";
  const PROBE_CLAIM = "Probe and lot recorded per treated area.";
  const hits = (copy: string, gated: boolean, regime: Regime) =>
    offendersIn("app/page.tsx", copy, gated, regime);

  const ALL_BLOCK: Regime = { response: true, machine: true, probe: true };
  const RESPONSE_MOVED: Regime = { response: false, machine: true, probe: true };
  const MACHINE_MOVED: Regime = { response: true, machine: false, probe: true };
  const PROBE_MOVED: Regime = { response: true, machine: true, probe: false };
  const ALL_MOVED: Regime = { response: false, machine: false, probe: false };

  it("the detector recognises every claim regardless of regime (gated=false)", () => {
    for (const regime of [ALL_BLOCK, RESPONSE_MOVED, MACHINE_MOVED, PROBE_MOVED, ALL_MOVED]) {
      expect(hits(RESPONSE_CLAIM, false, regime).length, "response").toBeGreaterThan(0);
      expect(hits(MACHINE_CLAIM, false, regime).length, "machine").toBeGreaterThan(0);
      expect(hits(PROBE_CLAIM, false, regime).length, "probe").toBeGreaterThan(0);
    }
  });

  it("gated: a block-owned family APPLIES its prohibition", () => {
    expect(hits(RESPONSE_CLAIM, true, ALL_BLOCK).length).toBeGreaterThan(0);
    expect(hits(MACHINE_CLAIM, true, ALL_BLOCK).length).toBeGreaterThan(0);
    expect(hits(PROBE_CLAIM, true, ALL_BLOCK).length).toBeGreaterThan(0);
  });

  it("gated: response moving lapses ONLY the response prohibition", () => {
    expect(hits(RESPONSE_CLAIM, true, RESPONSE_MOVED)).toEqual([]);
    expect(hits(MACHINE_CLAIM, true, RESPONSE_MOVED).length).toBeGreaterThan(0);
    expect(hits(PROBE_CLAIM, true, RESPONSE_MOVED).length).toBeGreaterThan(0);
  });

  it("gated: machine settings moving lapses ONLY the machine prohibition", () => {
    // The property P2-2 asks for: probe claims must not ride on machine
    // ownership, nor response on either.
    expect(hits(MACHINE_CLAIM, true, MACHINE_MOVED)).toEqual([]);
    expect(hits(PROBE_CLAIM, true, MACHINE_MOVED).length).toBeGreaterThan(0);
    expect(hits(RESPONSE_CLAIM, true, MACHINE_MOVED).length).toBeGreaterThan(0);
  });

  it("gated: probe moving lapses ONLY the probe prohibition", () => {
    expect(hits(PROBE_CLAIM, true, PROBE_MOVED)).toEqual([]);
    expect(hits(MACHINE_CLAIM, true, PROBE_MOVED).length).toBeGreaterThan(0);
    expect(hits(RESPONSE_CLAIM, true, PROBE_MOVED).length).toBeGreaterThan(0);
  });

  it("gated: everything moved lapses everything; nothing moved applies everything", () => {
    for (const claim of [RESPONSE_CLAIM, MACHINE_CLAIM, PROBE_CLAIM]) {
      expect(hits(claim, true, ALL_MOVED)).toEqual([]);
      expect(hits(claim, true, ALL_BLOCK).length).toBeGreaterThan(0);
    }
  });

  it("no family is blanket-skipped: each fires under its own regime", () => {
    for (const [claim, name] of [
      [RESPONSE_CLAIM, "response"],
      [MACHINE_CLAIM, "machine"],
      [PROBE_CLAIM, "probe"],
    ] as const) {
      expect(hits(claim, true, ALL_BLOCK).length, `${name} must fire`).toBeGreaterThan(0);
    }
  });

  it("the live regime is the default, so the sweep is not silently ungated", () => {
    // offendersIn's default argument must be the REAL model, not a constant.
    const live = currentRegime();
    expect(live).toEqual({
      response: responseIsBlockOwned(),
      machine: machineSettingsAreBlockOwned(),
      probe: probeIsBlockOwned(),
    });
    // and with the default omitted the detector behaves as the live regime says
    const viaDefault = offendersIn("app/page.tsx", RESPONSE_CLAIM, true);
    const viaExplicit = offendersIn("app/page.tsx", RESPONSE_CLAIM, true, live);
    expect(viaDefault).toEqual(viaExplicit);
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
