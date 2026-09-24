import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// MKT-02C: the multi-area settings-block claim, pinned in both directions.
//
// THE DEFECT THIS EXISTS FOR. `/features/treatment-memory` is the canonical
// outreach URL, so a sentence on it is a promise to a prospect evaluating a
// switch. Its first version said "each treated area is its own block" and
// described mode, energy, minutes, tolerance and response as independent
// per-area rows. That is not the product: migration 0128 makes
// `session_block_areas` a CHILD of `session_blocks` carrying only `area`,
// `laterality` and an ordering hint, so one settings block may cover SEVERAL
// areas that shared a setup, and every clinical value lives on the block.
//
// NOT A PARSER, NOT A SCANNER. It strips comments, collapses whitespace and
// looks for literal phrases; every assertion names one artefact and one
// property. It cannot decide in general whether copy is truthful — it pins the
// one overclaim that was actually made, plus the schema premises that make it
// an overclaim, so the claim and the model fail together rather than drifting
// apart silently.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PAGE = "app/features/treatment-memory/page.tsx";
const MIGRATION = "supabase/migrations/0128_session_block_areas.sql";
const INTELLIGENCE = "lib/sessions/treatment-intelligence.ts";

// LINE comments are stripped BEFORE block comments. This page's comments
// EXPLAIN the retired overclaim by quoting it, so a stripper that ran in the
// other order would leave that prose in scope and every "does not say"
// assertion below would fail against correct copy — or, with one `/*` inside a
// `//` line, eat real copy and pass vacuously.
const codeOnly = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

/** The page's user-visible copy, whitespace-collapsed so JSX line breaks
 *  cannot hide a phrase that renders as one sentence. */
const copy = () => codeOnly(read(PAGE)).replace(/\s+/g, " ");

describe("the comment stripper itself", () => {
  it("drops the prose that explains the retired overclaim", () => {
    const raw = read(PAGE);
    // This phrase exists ONLY in the explanatory comment.
    expect(raw).toContain("would be describing a product we did not build");
    expect(codeOnly(raw)).not.toContain("would be describing a product we did not build");
    // And it keeps real copy.
    expect(copy()).toContain("Every area keeps its own history");
  });
});

describe("premise: session_block_areas carries no clinical value", () => {
  // Read from the migration, so the claim and the schema cannot drift apart.
  // If a future migration puts settings on the area row, this fails and the
  // copy below becomes re-arguable instead of silently wrong in the other
  // direction.
  const createTable = (() => {
    const sql = read(MIGRATION);
    const start = sql.indexOf("create table if not exists public.session_block_areas");
    expect(start, `${MIGRATION}: table not found`).toBeGreaterThan(-1);
    // Ends at a `);` ALONE ON ITS LINE. Slicing to the first `);` stops inside
    // `check (laterality in (...))` and silently drops everything after it,
    // which would make the "holds no clinical column" assertion below pass by
    // never seeing most of the table.
    const end = sql.indexOf("\n);", start);
    expect(end, `${MIGRATION}: unterminated create table`).toBeGreaterThan(start);
    return sql.slice(start, end);
  })();

  it("holds the area, its side, and ordering — and nothing else", () => {
    for (const col of ["area", "laterality", "display_order"]) {
      expect(createTable, `child row lost ${col}`).toContain(col);
    }
  });

  it("holds NO setting, timing, tolerance, reaction, numbing or caution column", () => {
    for (const clinical of [
      "energy_level",
      "machine_frequency",
      "minutes_performed",
      "probe_label",
      "probe_lot_number",
      "tolerance_rating",
      "reaction_type",
      "numbing_status",
      "caution_note",
    ]) {
      expect(
        createTable,
        `session_block_areas gained ${clinical}: the page's settings-block copy must be re-derived`,
      ).not.toContain(clinical);
    }
  });

  it("is a child of the settings block, not a peer", () => {
    expect(createTable).toMatch(
      /session_block_id\s+uuid not null references public\.session_blocks/,
    );
  });
});

describe("the page does not claim one settings row per area", () => {
  // Each string here was either written on this page and removed, or is the
  // natural way the same false thing gets said again.
  const BANNED = [
    "each treated area is its own block",
    "each area is its own block",
    "one block per area",
    "a block per area",
    "the treated area is the unit",
    "per area rather than per appointment",
    "stored on the treated area itself",
    "stored on the area itself",
    "recorded on the area itself",
    "each treated area is stored as structured fields",
    "carries forward independently",
    "its own settings, its own probe",
  ];

  it("says none of them", () => {
    const c = copy().toLowerCase();
    expect(c.length, "no copy extracted — assertion would be vacuous").toBeGreaterThan(2000);
    const found = BANNED.filter((b) => c.includes(b));
    expect(
      found,
      "copy describes a shared settings block as independent per-area settings",
    ).toEqual([]);
  });

  it("states the sharing rule positively, so the model is described and not merely not-misdescribed", () => {
    // A page could pass the ban list by saying nothing at all about the model.
    const c = copy();
    expect(c, "copy never says a block covers more than one area").toMatch(
      /A block lists every area the setup was used on/,
    );
    expect(c, "copy never says areas can share a block").toMatch(
      /Areas share a block when the same setup applied/,
    );
    expect(c, "copy never says differing settings become separate blocks").toMatch(
      /when the settings differ they are separate blocks/,
    );
  });
});

describe('"Every area keeps its own history" is earned, not asserted', () => {
  it("the page makes the claim", () => {
    expect(copy()).toContain("Every area keeps its own history");
  });

  it("the read model really does fan one block across every area it covered", () => {
    // THE CLAIM'S ONLY SUPPORT. `treatment-intelligence` groups by area name
    // and resolves a block's structured areas into a LIST, so a block covering
    // "Cheeks + Sideburns" lands under both cards. Without this the headline
    // would be false even though the schema part above still held: the areas
    // would be recorded and never read back per area.
    const src = read(INTELLIGENCE);
    expect(src).toContain("resolveBlockAreas");
    expect(src, "blockAreaNames no longer returns a list of areas per block").toMatch(
      /function blockAreaNames\([\s\S]*?\): string\[\]/,
    );
    expect(
      src,
      "the block-contributes-to-every-area contract is no longer documented where it is implemented",
    ).toContain("contributes to EVERY area");
  });
});
