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
const BLOCK_FORM =
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx";
const CLIENT_PAGE = "app/(app)/clients/[id]/page.tsx";
const BEFORE_TODAY_CARD = "components/before-today-card.tsx";

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
    // `[^)]*` CANNOT CROSS THE CLOSING PAREN, and that is the whole point. An
    // earlier version used a lazy `[\s\S]*?`, which happily ran past this
    // signature to some LATER function's `: string[]` and reported a pass while
    // blockAreaNames returned a bare string — the assertion was satisfied by a
    // different function than the one it names. Proved by mutation: changing
    // the return type here must be red.
    expect(src, "blockAreaNames no longer returns a list of areas per block").toMatch(
      /function blockAreaNames\([^)]*\): string\[\]/,
    );
    expect(
      src,
      "the block-contributes-to-every-area contract is no longer documented where it is implemented",
    ).toContain("contributes to EVERY area");
  });
});

describe("the page advertises no retired input", () => {
  // A COLUMN THAT STILL EXISTS IS NOT A FEATURE A PRACTITIONER CAN USE, and
  // that gap is invisible to every other check here. `session_blocks` really
  // does carry `caution_for_next_session` and `caution_note`, and the charting
  // form really does round-trip them — but PR #199 removed the INPUTS, so a
  // practitioner charting today cannot create one. Copy written from the schema
  // alone therefore describes read-only legacy behaviour as if it were a
  // workflow, which is exactly what this page did.

  it("premise: the block caution inputs really are gone", () => {
    const form = read(BLOCK_FORM);
    // The removal is documented where it happened.
    expect(form, "block-setup-form no longer documents the removed caution inputs")
      .toContain("caution inputs are gone");
    // And it is REAL: no control is bound to either caution field. Checked as
    // a control binding rather than by absence of the identifier, because the
    // draft legitimately still carries both to round-trip legacy values.
    const bound = codeOnly(form)
      .split("\n")
      .filter(
        (l) =>
          /caution(Note|ForNextSession)/.test(l) &&
          /(onChange|onCheckedChange|<input|<textarea|checked=\{|value=\{)/.test(l),
      );
    expect(
      bound,
      "a caution input exists again — the page may describe flagging one",
    ).toEqual([]);
  });

  it("so the page never claims a caution can be flagged on a block", () => {
    const c = copy().toLowerCase();
    expect(c.length, "no copy extracted — vacuous").toBeGreaterThan(2000);
    const BANNED = [
      "caution you flagged",
      "a caution you flag",
      "flag a caution",
      "caution is stored on the block",
      "caution rides with the setup",
      "caution rides with the area",
      "the caution you flagged for this visit",
    ];
    expect(
      BANNED.filter((b) => c.includes(b)),
      "copy advertises the retired block-caution input",
    ).toEqual([]);
  });

  it("and describes the note that DOES exist instead", () => {
    // Positive half: passing by saying nothing about carry-forward would be a
    // worse page, not a correct one.
    expect(copy()).toMatch(/The plan for next time, written at the end of the session/);
    expect(copy()).toMatch(/One note on the session, not filed and not tagged/);
  });
});

describe("the carry-forward section shows no capture of the retired panel", () => {
  // STRUCTURAL, NOT A FILENAME BAN. Banning the `previous-session` stem would
  // also reject a correctly re-captured asset that happened to reuse the name,
  // and would miss the same defect shipped under any other name. What must hold
  // is that THIS section carries no figure until someone has a capture proving
  // the live path — so the assertion is about the section, and adding a figure
  // back forces a human through this comment rather than past it.
  //
  // WHY THE SECTION IS SPECIAL. `point-of-care-memory.ts` builds its WATCH
  // TODAY lines from `session_blocks.caution_note`, whose input PR #199
  // removed. A capture rendering that panel, placed under "what comes forward",
  // advertises the retired path in pictures after the prose stopped advertising
  // it in words.

  /** The "Carry forward" section's source, from its eyebrow to its close. */
  const section = (() => {
    const code = codeOnly(read(PAGE));
    const start = code.indexOf("<Eyebrow>Carry forward</Eyebrow>");
    expect(start, "the Carry forward section is gone — re-derive this rule").toBeGreaterThan(-1);
    const end = code.indexOf("</Section>", start);
    expect(end, "unterminated Carry forward section").toBeGreaterThan(start);
    return code.slice(start, end);
  })();

  it("still contains the three carry-forward steps, so the section is real", () => {
    // Anti-vacuity: an emptied section would trivially satisfy "no figure".
    expect(section).toContain("You write it once");
    expect(section).toContain("It stays where you wrote it");
    expect(section).toContain("It resurfaces on its own");
  });

  it("renders no ScreenFigure", () => {
    expect(
      section.match(/<ScreenFigure\b/g) ?? [],
      "a capture returned to the carry-forward section: prove it does not render " +
        "the WATCH TODAY panel before removing this guard",
    ).toHaveLength(0);
  });

  it("and the page still shows captures elsewhere, so this is not a blanket removal", () => {
    const stems = [...read(PAGE).matchAll(/base="([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(stems.length, "the page lost all its captures").toBeGreaterThanOrEqual(3);
  });
});

describe("imported history is described as the product actually shows it", () => {
  // THE CLAIM THAT WAS WRONG. The page promised imported entries were marked
  // "in the briefing and the record, permanently and visibly". The product caps
  // what Before Today renders at BEFORE_TODAY_IMPORTED_CAP and prints
  // "Showing the latest N of M imported records" when there are more. The rows
  // beyond the cap are STORED and reachable by no practitioner-facing surface
  // in the app, so "permanently and visibly" described something that does not
  // exist.
  //
  // NOT A PHRASE BLOCKLIST. Banning that exact sentence would be satisfied by
  // "every imported entry stays on screen", which is the same promise. What is
  // checked instead is the SHAPE of the promise: in any sentence about imports,
  // a totality quantifier must not co-occur with a visibility verb. The copy
  // may say imports are kept, labelled, or surfaced — it may not say all of
  // them are seen.

  /** Rendered prose only: comments and module imports removed. */
  const prose = () =>
    codeOnly(read(PAGE))
      .split("\n")
      .filter((l) => !/^\s*import\s/.test(l))
      .join(" ")
      .replace(/\s+/g, " ");

  /** Sentences that talk about importing. */
  const importSentences = () =>
    prose()
      .split(/(?<=[.!?])\s+/)
      .filter((t) => /\bimport/i.test(t));

  it("premise: the product really does cap what the briefing renders", () => {
    // Read from the product. If the cap is ever removed, this fails and the
    // bounded wording becomes re-arguable — which is the correct direction for
    // a guard over a claim that is only true while the cap exists.
    const m = read(CLIENT_PAGE).match(/BEFORE_TODAY_IMPORTED_CAP\s*=\s*(\d+)/);
    expect(m, `${CLIENT_PAGE}: no BEFORE_TODAY_IMPORTED_CAP to read`).not.toBeNull();
    const cap = Number(m![1]);
    expect(cap, "the cap is not a finite positive number").toBeGreaterThan(0);
    expect(read(CLIENT_PAGE), "the cap is declared but not applied as a limit").toMatch(
      /limit:\s*BEFORE_TODAY_IMPORTED_CAP/,
    );
    // And the card admits the truncation in its own words.
    expect(
      read(BEFORE_TODAY_CARD),
      "the card no longer tells the practitioner how many were omitted",
    ).toContain("Showing the latest");
  });

  it("there is import copy to check — otherwise this is vacuous", () => {
    const sentences = importSentences();
    expect(sentences.length, "no sentences mention importing").toBeGreaterThanOrEqual(3);
  });

  it("no sentence promises that ALL imported history is visible", () => {
    // Two open classes, intersected. Either alone is fine and appears in
    // legitimate copy ("every area keeps its own history"; "wherever they
    // surface"); together, in a sentence about imports, they are the promise
    // the product cannot keep.
    const TOTALITY = /\b(all|every|each|always|permanent(ly)?|entire|complete(ly)?|nothing is (lost|hidden)|never (lost|hidden))\b/i;
    const VISIBILITY =
      /\b(visible|visibly|shown|shows|showing|surfaced|surfaces|appears?|displayed|on screen|in view|see|seen|readable|accessible)\b/i;
    const offenders = importSentences().filter(
      (t) => TOTALITY.test(t) && VISIBILITY.test(t),
    );
    expect(
      offenders,
      "import copy promises total visibility, but the briefing renders only the " +
        "latest BEFORE_TODAY_IMPORTED_CAP entries and no other surface shows the rest",
    ).toEqual([]);
  });

  it("and the copy says what IS true: recency, and a count", () => {
    // The honest version has to be present, not merely the dishonest one
    // absent — copy that fell silent about imports would pass the ban above
    // while telling a prospect less than the product does.
    const joined = importSentences().join(" ");
    expect(joined, "import copy no longer says the briefing leads with the most recent").toMatch(
      /\b(most recent|latest|newest)\b/i,
    );
    expect(joined, "import copy no longer mentions the count of what is held").toMatch(
      /\b(how many|count|total)\b/i,
    );
    // And the migration capability is still described.
    expect(joined, "the import capability itself is no longer described").toMatch(
      /\b(paper|spreadsheet)\b/i,
    );
    expect(joined, "copy no longer says imported history is kept").toMatch(
      /\bkept\b/i,
    );
  });
});

describe("the area summary is described within the window that builds it", () => {
  // THE CLAIM THAT WAS WRONG. The page said "Every block that covered an area
  // feeds that area's history" without qualification. `app/(app)/clients/[id]/
  // page.tsx` reads intelligence blocks for `sessions.slice(0, 200)` only - its
  // own comment calls that "the intelligence window" - so blocks living solely
  // in older sessions never reach the area cards, the totals, or the
  // first-treated date. The sentence was true INSIDE the window and false about
  // a client with a longer history.
  //
  // THE BINDING IS THE GUARD. Rather than pattern-match hedging language, the
  // copy must name the same number the product actually uses, read from the
  // product. Change the limit and the copy goes stale here; change the copy and
  // it stops matching the limit. Neither side can move alone, which is the
  // property asked for.

  /**
   * The intelligence window, read from its one unambiguous use.
   *
   * Anchored on `.map((sess) => sess.id)` because this file ALSO slices
   * `sessions.slice(0, 25)` for `recentSessions`; a bare `sessions.slice(0, N)`
   * match would pick up whichever came first and silently bind the copy to the
   * wrong number.
   */
  const windowSize = (() => {
    const src = read(CLIENT_PAGE);
    const all = [...src.matchAll(/sessions\.slice\(0,\s*(\d+)\)\.map\(\(sess\) => sess\.id\)/g)];
    expect(
      all.length,
      `${CLIENT_PAGE}: expected exactly one intelligence-window slice, found ${all.length}`,
    ).toBe(1);
    return Number(all[0][1]);
  })();

  it("premise: the product really does bound the intelligence read", () => {
    expect(windowSize, "the window is not a finite positive number").toBeGreaterThan(0);
    // And it really is the read that feeds the area cards: the same query
    // selects the per-area clinical columns the summary is built from.
    const src = read(CLIENT_PAGE);
    const at = src.indexOf("sessions.slice(0, " + windowSize + ").map((sess) => sess.id)");
    const query = src.slice(Math.max(0, at - 1200), at);
    for (const col of ["primary_area", "tolerance_rating", "minutes_performed"]) {
      expect(
        query,
        `the ${windowSize}-session slice no longer feeds the per-area intelligence read (${col} absent)`,
      ).toContain(col);
    }
  });

  it("the page names that exact window", () => {
    const c = copy();
    expect(
      c,
      `copy must state the ${windowSize}-session window the area summary is built from`,
    ).toContain(String(windowSize));
    // Named as a RECENCY bound, not as some other number that happens to match.
    expect(c, "the window is not described as the most recent sessions").toMatch(
      new RegExp(`most recent ${windowSize} sessions`, "i"),
    );
  });

  it("and still says the true part: inside the window, a block feeds every area it covered", () => {
    // Bounding the claim must not delete it. The multi-area contribution is
    // real and is the point of the section.
    expect(copy(), "the in-window per-area contribution is no longer stated").toMatch(
      /inside that window every block that covered an area feeds that area/i,
    );
  });

  it("no copy claims lifetime coverage of the area summary", () => {
    // The open class, so a reworded promise is caught too.
    const LIFETIME =
      /\b(lifetime|all[-\s]time|entire history|complete history|every session|all sessions|from the (very )?first (visit|session)|since the beginning)\b/i;
    const sentences = copy()
      .split(/(?<=[.!?])\s+/)
      .filter((t) => /\b(area|history|summary|totals?)\b/i.test(t));
    expect(sentences.length, "no area/history sentences found — vacuous").toBeGreaterThanOrEqual(3);
    const offenders = sentences.filter((t) => LIFETIME.test(t));
    expect(
      offenders,
      `copy claims lifetime coverage, but the summary reads only ${windowSize} sessions`,
    ).toEqual([]);
  });
});
