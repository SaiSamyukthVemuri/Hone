import { describe, expect, it, vi } from "vitest";
import {
  EXPORT_EXCLUSIONS,
  MAX_RANGE_DAYS,
  auditThenLoad,
  buildClinicalRecordsDocument,
  civilDayBounds,
  localDayBounds,
  parseExportScope,
  scopeAuditMetadata,
  type ExportBlockSource,
  type ExportEntrySource,
  type ExportNoteSource,
  type ExportSessionSource,
} from "@/lib/clinical-records/export-scope";
import { guardBrowserEvent } from "@/lib/analytics/client-boundary";
import { EXPORT_MAX_PAGES, EXPORT_PAGE_SIZE, readAllPages } from "@/lib/clinical-records/export-queries";
import { PRINT_GATE_CSS } from "@/lib/clinical-records/print-gate";
import { toleranceLabel } from "@/lib/sessions/clinical-response";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExportSessionTreatments } from "@/app/(records-export)/clients/[id]/records/export/session-treatments";

// WHAT PRINTS for a treatment is the SAVED VIEW's own render (#896): the
// printout renders SavedAreaRecord / ElectrolysisEntryRow / LaserEntryRow, and
// tests/components/saved-record-print-parity.test.ts proves screen == paper.
// The cases below keep each finding's regression, asserted on the printed text.
const BASE_SESSION = {
  id: "s",
  started_at: "2026-10-01T15:00:00Z",
  ended_at: null,
  modality: "electrolysis",
  session_notes: null,
  performed_by_practitioner_id: null,
  practitioner_id: null,
  record_status: null,
  finalized_at: null,
  aftercare_and_risks_explained_at: null,
  aftercare_and_risks_explained_by: null,
};
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
type BuildInput = Parameters<typeof buildClinicalRecordsDocument>[0];
function printed(input: Partial<BuildInput>): string {
  const doc = buildClinicalRecordsDocument({
    sessions: [BASE_SESSION],
    entries: [],
    notes: [],
    practitionerNameById: new Map(),
    ...input,
  });
  return text(renderToStaticMarkup(createElement(ExportSessionTreatments, { session: doc.sessions[0] })));
}
const blockOf = (over: Record<string, unknown>) =>
  ({ id: "b", session_id: "s", sort_order: 0, primary_area: "chin", side: null, created_at: "2026-10-01T15:01:00Z", ...over }) as unknown as ExportBlockSource;
const entryOf = (over: Record<string, unknown>) =>
  ({ id: "e", session_id: "s", block_id: null, area: "chin", created_at: "2026-10-01T15:02:00Z", ...over }) as unknown as ExportEntrySource;

// HON-46 — the pure half of the per-client clinical-records export: which
// scopes parse, how a local day becomes UTC bounds, that the document is an
// allow-list (private and payment fields cannot reach it), and that a preview
// is audited BEFORE anything is loaded (#828 G-13, fail closed).

const SESSION_ID = "6f1c2c1e-2b0a-4c3d-9e8f-0a1b2c3d4e5f";

describe("parseExportScope", () => {
  it("accepts a session, a real day, and an ordered range", () => {
    expect(parseExportScope({ scope: "session", session: SESSION_ID.toUpperCase() })).toEqual({
      ok: true,
      scope: { kind: "session", sessionId: SESSION_ID },
    });
    expect(parseExportScope({ scope: "day", day: "2026-10-01" })).toEqual({
      ok: true,
      scope: { kind: "day", day: "2026-10-01" },
    });
    expect(parseExportScope({ scope: "range", from: "2026-01-01", to: "2026-01-31" })).toEqual({
      ok: true,
      scope: { kind: "range", from: "2026-01-01", to: "2026-01-31" },
    });
  });

  it("refuses anything malformed, reversed, impossible or unknown", () => {
    expect(parseExportScope({})).toEqual({ ok: false, reason: "missing" });
    for (const raw of [
      { scope: "session", session: "not-a-uuid" },
      { scope: "session" },
      { scope: "day", day: "2026-02-30" },
      { scope: "day", day: "01/10/2026" },
      { scope: "range", from: "2026-02-01", to: "2026-01-01" },
      { scope: "range", from: "2026-01-01" },
      { scope: "everything" },
    ]) {
      expect(parseExportScope(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it(`bounds a range at ${MAX_RANGE_DAYS} days, inclusive`, () => {
    expect(parseExportScope({ scope: "range", from: "2025-01-01", to: "2026-01-01" }).ok).toBe(true); // 366
    expect(parseExportScope({ scope: "range", from: "2025-01-01", to: "2026-01-02" })).toEqual({
      ok: false,
      reason: "range_too_long",
    });
  });
});

describe("localDayBounds", () => {
  it.each([
    ["2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", 23],
    ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", 25],
  ])("keeps all of the studio-local DST day %s, with an exclusive end", (day, fromUtc, toUtcExclusive, hours) => {
    const bounds = localDayBounds(day, day, "America/Toronto");
    expect(bounds).toEqual({ fromUtc, toUtcExclusive });
    expect((Date.parse(bounds.toUtcExclusive) - Date.parse(bounds.fromUtc)) / 3_600_000).toBe(hours);
    const includes = (instant: number) => instant >= Date.parse(bounds.fromUtc) && instant < Date.parse(bounds.toUtcExclusive);
    expect(includes(Date.parse(fromUtc) - 1)).toBe(false);
    expect(includes(Date.parse(fromUtc))).toBe(true);
    expect(includes(Date.parse(toUtcExclusive) - 1)).toBe(true);
    expect(includes(Date.parse(toUtcExclusive))).toBe(false);
  });

  it("is the studio-local day, in UTC, end-exclusive", () => {
    expect(localDayBounds("2026-01-15", "2026-01-15", "America/Toronto")).toEqual({
      fromUtc: "2026-01-15T05:00:00.000Z",
      toUtcExclusive: "2026-01-16T05:00:00.000Z",
    });
    expect(localDayBounds("2026-07-01", "2026-07-02", "America/Los_Angeles")).toEqual({
      fromUtc: "2026-07-01T07:00:00.000Z",
      toUtcExclusive: "2026-07-03T07:00:00.000Z",
    });
  });
});

describe("civilDayBounds: clinical-note dates are CALENDAR dates (Codex P1 4302644059)", () => {
  it("bounds the stored midnight-UTC civil dates, independent of any studio timezone", () => {
    expect(civilDayBounds("2026-09-15", "2026-09-15")).toEqual({
      fromUtc: "2026-09-15T00:00:00.000Z",
      toUtcExclusive: "2026-09-16T00:00:00.000Z",
    });
    // A note dated the 15th (stored 2026-09-15T00:00Z) is in; the 16th is out,
    // where the studio-local window for Los Angeles would do the reverse.
    const b = civilDayBounds("2026-09-15", "2026-09-15");
    expect("2026-09-15T00:00:00.000Z" >= b.fromUtc && "2026-09-15T00:00:00.000Z" < b.toUtcExclusive).toBe(true);
    expect("2026-09-16T00:00:00.000Z" < b.toUtcExclusive).toBe(false);
    const local = localDayBounds("2026-09-15", "2026-09-15", "America/Los_Angeles");
    expect("2026-09-15T00:00:00.000Z" >= local.fromUtc).toBe(false); // the old filter dropped it
  });
});

describe("caution flag without a note (Codex P2 4302644062)", () => {
  it("a flag-only caution is printed, as the saved view shows it", () => {
    expect(printed({ blocks: [blockOf({ caution_for_next_session: true })] })).toContain("Caution for next session");
  });
  it("the note is shown when present, and nothing when neither is set", () => {
    expect(printed({ blocks: [blockOf({ caution_for_next_session: true, caution_note: "Thin skin" })] })).toContain(
      "Caution for next session: Thin skin",
    );
    expect(printed({ blocks: [blockOf({})] })).not.toContain("Caution");
  });
});

describe("scopeAuditMetadata", () => {
  it("records what was looked at, never a name or a note", () => {
    expect(scopeAuditMetadata({ kind: "day", day: "2026-10-01" })).toEqual({ scope: "day", day: "2026-10-01" });
    expect(scopeAuditMetadata({ kind: "session", sessionId: SESSION_ID })).toEqual({
      scope: "session",
      session_id: SESSION_ID,
    });
  });
});

describe("buildClinicalRecordsDocument is an allow-list", () => {
  const PRIVATE = "SENTINEL-PRIVATE-WARNING";
  const PERSONAL = "SENTINEL-PERSONAL-NOTE";
  const PAY = 98765;

  // Rows as if a query had returned MORE than it should: extra private,
  // payment and deletion fields ride along on every source.
  const session = {
    id: "s1",
    started_at: "2026-10-01T15:00:00Z",
    ended_at: "2026-10-01T16:00:00Z",
    modality: "electrolysis",
    session_notes: "Clinical session note.",
    performed_by_practitioner_id: "p1",
    practitioner_id: "p1",
    record_status: "finalized",
    finalized_at: "2026-10-01T16:05:00Z",
    aftercare_and_risks_explained_at: "2026-10-01T16:00:00Z",
    private_warnings: PRIVATE,
    personal_notes: PERSONAL,
    price_paid_cents: PAY,
    next_session_note: "SENTINEL-PLANNING",
    delete_reason: "SENTINEL-DELETE",
  } as unknown as ExportSessionSource;
  // Current charting: a settings block with its structured probe and
  // observations, and an entry charted in it with the newer readings.
  const block = {
    id: "b1",
    session_id: "s1",
    sort_order: 0,
    block_name: null,
    primary_area: "upper lip",
    side: "left",
    custom_area_detail: null,
    mode: "blend",
    apilus_modality: null,
    energy_level: null,
    minutes_performed: 15,
    machine_frequency: "13.56",
    probe_label: "Ballet F3 gold",
    probe_type: "F",
    probe_size: "3",
    probe_lot_number: "LOT-7",
    numbing_status: "none",
    numbing_notes: null,
    tolerance_rating: 4,
    reaction_type: "mild_redness",
    reaction_notes: "Settled in 10 min.",
    caution_note: null,
    block_notes: "Block note.",
    started_at: null,
    ended_at: null,
    created_at: "2026-10-01T15:05:00Z",
    delete_reason: "SENTINEL-DELETE",
    private_warnings: PRIVATE,
  } as unknown as ExportBlockSource;
  const entry = {
    id: "e1",
    session_id: "s1",
    block_id: "b1",
    area: "upper lip",
    areas: null,
    probe_type: null,
    probe_size: null,
    mode: "blend",
    apilus_modality: null,
    intensity: null,
    duration_seconds: null,
    energy_level: null,
    machine_frequency: null,
    thermolysis_intensity_percent: 22,
    thermolysis_duration_seconds: 4,
    galvanic_ma: 0.3,
    galvanic_duration_seconds: 6,
    units_of_lye: null,
    pulse_delay_seconds: 1.5,
    minutes_performed: null,
    pulse_count: 120,
    hairs_treated: 60,
    observation_chips: ["Coarse hair", "Client tolerated well"],
    comments: "Good response.",
    created_at: "2026-10-01T15:10:00Z",
    private_warnings: PRIVATE,
    delete_reason: "SENTINEL-DELETE",
  } as unknown as ExportEntrySource;
  // Older charting: an entry with no block and only the legacy readings.
  const legacy = {
    id: "e0",
    session_id: "s1",
    block_id: null,
    area: "chin",
    areas: null,
    probe_type: "F",
    probe_size: "2",
    mode: "thermolysis",
    intensity: 40,
    duration_seconds: 3,
    comments: null,
    created_at: "2026-10-01T15:01:00Z",
  } as unknown as ExportEntrySource;
  const note = {
    id: "n1",
    kind: "consultation",
    body: "Consultation body.",
    areas: ["chin"],
    occurred_at: "2026-10-01T14:00:00Z",
    practitioner_id: "p1",
    supersedes_note_id: null,
    created_at: "2026-10-01T14:05:00Z",
    personal_notes: PERSONAL,
  } as unknown as ExportNoteSource;

  const doc = buildClinicalRecordsDocument({
    sessions: [session],
    blocks: [block],
    entries: [entry, legacy],
    notes: [note],
    practitionerNameById: new Map([["p1", "Practitioner One"]]),
  });

  it("keeps the clinical record: current blocks and readings, and legacy entries", () => {
    expect(doc.sessions).toHaveLength(1);
    const s = doc.sessions[0];
    expect(s).toMatchObject({ notes: "Clinical session note.", practitioner: "Practitioner One" });
    expect(s.blocks.map((b) => b.record.electrolysis_entries.map((e) => e.id))).toEqual([["e1"]]);
    expect(s.entries.map((e) => e.id)).toEqual(["e0"]);

    const out = text(renderToStaticMarkup(createElement(ExportSessionTreatments, { session: s })));
    // The settings block, worded as the saved view words it.
    for (const shown of [
      "Blend · 13.56 · 15 min",
      "Probe: Ballet F3 gold · Lot #LOT-7",
      "Client tolerance: Mild discomfort",
      "Legacy skin response: Mild redness · Legacy response note: Settled in 10 min.",
      // Print-only, NAMED (PRINT_ONLY_FIELDS): the legacy block note.
      "Area notes: Block note.",
      // The pass charted in it, with the CURRENT readings.
      "Galvanic: 6s · 0.3 mA",
      "Thermolysis: 4 seconds · 22% · 120 pulses · 1.50s delay",
      "Hairs treated: 60",
      "Coarse hair Client tolerated well",
      "Notes: Good response.",
      // The legacy pass (no block) keeps its generic readings.
      "40% · 3s",
    ]) {
      expect(out, shown).toContain(shown);
    }
    expect(out).not.toContain("Units of lye");
    expect(doc.clinicalNotes[0]).toMatchObject({ body: "Consultation body.", areas: ["chin"], isRevision: false });
  });

  it("drops every private, payment, planning and deletion field", () => {
    const json = JSON.stringify(doc);
    for (const sentinel of [PRIVATE, PERSONAL, String(PAY), "SENTINEL-PLANNING", "SENTINEL-DELETE"]) {
      expect(json).not.toContain(sentinel);
    }
  });
});

describe("entries of a filtered-out (soft-deleted) block are omitted (Codex P1 4302941115)", () => {
  const session = {
    id: "s7",
    started_at: "2026-10-01T15:00:00Z",
    ended_at: null,
    modality: "electrolysis",
    session_notes: null,
    performed_by_practitioner_id: null,
    practitioner_id: null,
    record_status: null,
    finalized_at: null,
    aftercare_and_risks_explained_at: null,
    aftercare_and_risks_explained_by: null,
  };
  const entry = (id: string, blockId: string | null) =>
    ({
      id,
      session_id: "s7",
      block_id: blockId,
      area: "chin",
      areas_list: null,
      created_at: `2026-10-01T15:0${id.length}:00Z`,
    }) as unknown as ExportEntrySource;
  const live = { id: "b-live", session_id: "s7", sort_order: 0, primary_area: "chin", side: null, created_at: "2026-10-01T15:01:00Z" } as unknown as ExportBlockSource;
  const doc = buildClinicalRecordsDocument({
    sessions: [session],
    // "b-deleted" is NOT here: the block query filtered it (deleted_at set).
    blocks: [live],
    entries: [entry("in-live", "b-live"), entry("orphan-of-deleted", "b-deleted"), entry("legacy", null)],
    notes: [],
    practitionerNameById: new Map(),
  });
  const s = doc.sessions[0];

  it("an active child of a deleted block is not printed anywhere", () => {
    expect(JSON.stringify(doc)).not.toContain("orphan-of-deleted");
  });
  it("a true legacy entry (no block) still prints at session level, and a live block keeps its entry", () => {
    expect(s.entries.map((e) => e.id)).toEqual(["legacy"]);
    expect(s.blocks[0].record.electrolysis_entries.map((e) => e.id)).toEqual(["in-live"]);
  });
});

describe("reactions print through the saved-record view's rule (Codex P1 4304382927)", () => {
  const out = (reactionType: string | null, chips: unknown[]) =>
    printed({
      blocks: [blockOf({ reaction_type: reactionType })],
      entries: chips.map((c, i) => entryOf({ id: `e${i}`, block_id: "b", observation_chips: c, created_at: `2026-10-01T15:0${i + 2}:00Z` })),
    });

  it("a chip-backed legacy value prints ONCE (as the chip), not again as a legacy response", () => {
    const o = out("mild_redness", [["Mild redness"]]);
    expect(o).not.toContain("Legacy skin response");
    expect(o.match(/Mild redness/g) ?? []).toHaveLength(1);
  });
  it("an unmatched legacy value is labelled LEGACY", () => {
    expect(out("swelling", [["Coarse hair"]])).toContain("Legacy skin response: Swelling");
  });
  it('reaction_type "none" beside a real response chip prints no "none"', () => {
    expect(out("none", [["Mild redness"]])).not.toMatch(/No visible reaction/);
  });
});

describe("legacy comment chips count when classifying the block reaction (Codex P1 4305737599)", () => {
  it('a stale "none" is not printed beside a response hydrated from a pre-0108 comment', () => {
    const o = printed({
      blocks: [blockOf({ reaction_type: "none" })],
      entries: [entryOf({ block_id: "b", observation_chips: [], comments: "Redness (erythema)" })],
    });
    expect(o).toContain("Redness (erythema)");
    expect(o).not.toMatch(/Legacy skin response|No visible reaction/);
  });
});

describe("tolerance prints the saved view's label, never the stored integer (Codex P2 4307190165)", () => {
  it("every stored rating prints exactly toleranceLabel's wording", () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(printed({ blocks: [blockOf({ tolerance_rating: rating })] })).toContain(`Client tolerance: ${toleranceLabel(rating)}`);
    }
    expect(printed({ blocks: [blockOf({ tolerance_rating: 1 })] })).toContain("Client tolerance: Needed pause / stopped early");
  });
  it("an unrecorded rating prints nothing", () => {
    expect(printed({ blocks: [blockOf({ tolerance_rating: null })] })).not.toMatch(/tolerance/i);
  });
});

describe("numbing prints through the saved view's presenter (Codex P2 4305737602)", () => {
  const out = (numbing_status: unknown, numbing_notes: string | null) =>
    printed({ blocks: [blockOf({ numbing_status, numbing_notes })] });

  it('"none" prints its label, and a stray note is NOT printed', () => {
    const o = out("none", "lidocaine 5%");
    expect(o).toContain("No numbing used");
    expect(o).not.toContain("lidocaine");
  });
  it('"used" prints its label and its note', () => {
    expect(out("used", "lidocaine 5%")).toContain("Numbing used Numbing notes: lidocaine 5%");
  });
  it("unrecorded or invalid status prints nothing, note included", () => {
    for (const status of [null, "bogus"]) {
      const o = out(status, "lidocaine 5%");
      expect(o).not.toMatch(/numbing|lidocaine/i);
    }
  });
});

describe("the RETIRED galvanic % never prints as a reading (Codex P1 4303753479)", () => {
  it("a legacy entry's galvanic_intensity_percent is omitted, beside the active galvanic readings", () => {
    const input = {
      entries: [
        // A row from before the reading was retired: the column is non-null.
        entryOf({ galvanic_ma: 0.4, galvanic_duration_seconds: 5, galvanic_intensity_percent: 37 }),
      ],
    };
    const o = printed(input);
    expect(o).toContain("Galvanic: 5s · 0.4 mA");
    expect(o).not.toContain("37");
    expect(JSON.stringify(buildClinicalRecordsDocument({ sessions: [BASE_SESSION], notes: [], practitionerNameById: new Map(), ...input }))).not.toContain("37");
  });
});

describe("structured readings suppress the stale legacy pair, by the saved view's rule (Codex P1 4304983088)", () => {
  it("a legacy-only entry still prints intensity and duration", () => {
    expect(printed({ entries: [entryOf({ intensity: 40, duration_seconds: 3 })] })).toContain("40% · 3s");
  });
  it("a legacy entry later edited with structured readings prints ONLY the structured set", () => {
    const o = printed({
      entries: [entryOf({ intensity: 40, duration_seconds: 3, thermolysis_intensity_percent: 22, thermolysis_duration_seconds: 4 })],
    });
    expect(o).toContain("Thermolysis: 4 seconds · 22%");
    expect(o).not.toContain("40%");
    expect(o).not.toContain("3s");
  });
  it("a structured-only entry is unchanged", () => {
    expect(printed({ entries: [entryOf({ galvanic_ma: 0.3, galvanic_duration_seconds: 6 })] })).toContain("Galvanic: 6s · 0.3 mA");
  });
});

describe("pulses print only where the saved view shows them (Codex P1 4305560955)", () => {
  it("a current GALVANIC entry's stored default pulse count (1) is NOT printed", () => {
    expect(printed({ entries: [entryOf({ mode: "galv", galvanic_ma: 0.3, pulse_count: 1, pulse_delay_seconds: 0.5 })] })).not.toMatch(/pulse/i);
  });
  it("a THERMO or BLEND entry prints its pulses, and the delay only for more than one pulse", () => {
    expect(printed({ entries: [entryOf({ mode: "thermo", thermolysis_intensity_percent: 20, pulse_count: 3, pulse_delay_seconds: 0.5 })] })).toContain(
      "3 pulses · 0.50s delay",
    );
    const single = printed({ entries: [entryOf({ mode: "blend", galvanic_ma: 0.3, pulse_count: 1, pulse_delay_seconds: 0.5 })] });
    expect(single).toContain("1 pulse");
    expect(single).not.toContain("delay");
  });
  it("a LEGACY entry with no structured readings keeps its recorded pulse count", () => {
    expect(printed({ entries: [entryOf({ mode: null, intensity: 40, pulse_count: 2 })] })).toContain("2 pulses");
  });
});

describe("legacy observations are hydrated from comments, as the saved view does (Codex P2 4305560961)", () => {
  it("a pre-0108 entry's chips stored in comments print as observations, not as comment text", () => {
    const o = printed({ entries: [entryOf({ observation_chips: [], comments: "Coarse hair, Client tolerated well" })] });
    expect(o).toContain("Coarse hair Client tolerated well");
    expect(o).not.toContain("Coarse hair, Client");
  });
  it("a current entry keeps its structured chips and its comment", () => {
    const o = printed({ entries: [entryOf({ observation_chips: ["Coarse hair"], comments: "Good response." })] });
    expect(o).toContain("Coarse hair");
    expect(o).toContain("Good response.");
  });
});

describe("probe-lot confirmation is exported (Codex P2 4302799069)", () => {
  const out = (over: Record<string, unknown>) => printed({ blocks: [blockOf({ probe_label: "Ballet F3", ...over })] });

  it("a confirmed lot says so, as the live chart does", () => {
    expect(out({ probe_lot_number: " LOT-9 ", probe_lot_confirmed: true })).toContain("Probe: Ballet F3 · Lot #LOT-9 (confirmed)");
  });
  it("an unconfirmed lot reads as the bare lot, and no lot emits nothing", () => {
    const unconfirmed = out({ probe_lot_number: "LOT-9", probe_lot_confirmed: false });
    expect(unconfirmed).toContain("Probe: Ballet F3 · Lot #LOT-9");
    expect(unconfirmed).not.toContain("(confirmed)");
    expect(out({ probe_lot_number: null, probe_lot_confirmed: true })).not.toContain("Lot #");
  });
});

describe("superseded clinical-note versions are labelled (Codex P1 4302740025)", () => {
  const v = (id: string, createdAt: string, supersedes: string | null): ExportNoteSource => ({
    id,
    kind: "consultation",
    body: `body ${id}`,
    areas: [],
    occurred_at: "2026-10-01T00:00:00+00:00",
    practitioner_id: null,
    supersedes_note_id: supersedes,
    created_at: createdAt,
  });
  const build = (notes: ExportNoteSource[], superseded: string[]) =>
    buildClinicalRecordsDocument({
      sessions: [],
      entries: [],
      notes,
      supersededNoteIds: new Set(superseded),
      practitionerNameById: new Map(),
    }).clinicalNotes;

  it("marks the obsolete version superseded and orders same-day versions as written", () => {
    const notes = build(
      [v("revision", "2026-10-01T11:00:00Z", "original"), v("original", "2026-10-01T10:00:00Z", null)],
      ["original"],
    );
    expect(notes.map((n) => [n.id, n.isRevision, n.isSuperseded])).toEqual([
      ["original", false, true],
      ["revision", true, false],
    ]);
  });

  it("an in-range note replaced by a revision OUTSIDE the range is still superseded", () => {
    expect(build([v("original", "2026-10-01T10:00:00Z", null)], ["original"])[0].isSuperseded).toBe(true);
  });

  it("a note nothing supersedes is current", () => {
    expect(build([v("only", "2026-10-01T10:00:00Z", null)], [])[0].isSuperseded).toBe(false);
  });
});

describe("multi-area blocks use the authoritative area rows (Codex P1 4301307238)", () => {
  it("structured session_block_areas win over the legacy single area, every area kept", () => {
    const o = printed({
      // The legacy projection keeps only the FIRST area and clears the side.
      blocks: [blockOf({ primary_area: "Cheeks", side: null })],
      blockAreasById: new Map([
        [
          "b",
          [
            { area: "Cheeks", laterality: "left" },
            { area: "Sideburns", laterality: "right" },
          ] as never,
        ],
      ]),
    });
    expect(o).toMatch(/Recorded area Left [Cc]heeks · Right [Ss]ideburns/);
  });
});

describe("laser treatment passes are exported (Codex P1 4301153312)", () => {
  it("the saved view's laser row, plus the named print-only settings and results", () => {
    const o = printed({
      laserEntries: [
        {
          id: "l1",
          session_id: "s",
          zone: "Underarm",
          session_number: 3,
          equipment_params: { fluence_j_cm2: 18, spot_size_mm: 12, nested: { x: 1 }, note_private: null },
          observation_notes: "Even erythema.",
          ejection_results: "Good",
          created_at: "2026-10-01T15:10:00Z",
        },
      ],
    });
    expect(o).toContain("Underarm Treatment #3 Even erythema.");
    expect(o).toContain("Settings: fluence j cm2 18 · spot size mm 12");
    expect(o).toContain("Results: Good");
    expect(o).not.toContain("nested");
  });
});

describe("the retired draft status is never printed (Codex P2 4307447128)", () => {
  const statusOf = (record_status: string | null) =>
    buildClinicalRecordsDocument({
      sessions: [{ ...BASE_SESSION, record_status }],
      entries: [],
      notes: [],
      practitionerNameById: new Map(),
    }).sessions[0].recordStatus;
  it("draft prints nothing; a preserved legacy finalized or void status still shows", () => {
    expect(statusOf("draft")).toBeNull();
    expect(statusOf("finalized")).toBe("finalized");
    expect(statusOf("void")).toBe("void");
    expect(statusOf(null)).toBeNull();
  });
});

describe("a galvanic pass never prints the writer's default pulse (Codex P1 4307447121)", () => {
  it("a reading-less galv pass stored with pulse_count 1 shows no pulses, on paper as on screen", () => {
    expect(printed({ entries: [entryOf({ mode: "galv", pulse_count: 1 })] })).not.toMatch(/pulse/i);
  });
});

describe("the aftercare disclosure is attributed to whoever recorded it (Codex P2 4307259896)", () => {
  const docWith = (by: string | null, at: string | null) =>
    buildClinicalRecordsDocument({
      sessions: [{ ...BASE_SESSION, performed_by_practitioner_id: "p1", aftercare_and_risks_explained_at: at, aftercare_and_risks_explained_by: by }],
      entries: [],
      notes: [],
      practitionerNameById: new Map([
        ["p1", "Performer"],
        ["p2", "Front practitioner"],
      ]),
    }).sessions[0];
  it("names the recorder, which can differ from the performer", () => {
    expect(docWith("p2", "2026-10-01T16:00:00Z")).toMatchObject({ practitioner: "Performer", aftercareExplainedBy: "Front practitioner" });
  });
  it("no stamp, no attribution; an unknown recorder is not invented", () => {
    expect(docWith("p2", null).aftercareExplainedBy).toBeNull();
    expect(docWith(null, "2026-10-01T16:00:00Z").aftercareExplainedBy).toBeNull();
  });
});

describe("print gate CSS (Codex P1 4301153310)", () => {
  it("hides the unarmed document in print media and shows the notice instead", () => {
    expect(PRINT_GATE_CSS).toMatch(/@media print[\s\S]*\[data-export-document\]:not\(\[data-print-armed\]\)\s*\{\s*display: none !important;/);
    expect(PRINT_GATE_CSS).toMatch(/\[data-print-unarmed-notice\] \{ display: none; \}/);
    expect(PRINT_GATE_CSS).toContain("~ [data-print-unarmed-notice] { display: block !important; }");
  });
});

describe("readAllPages — complete or nothing (Codex P1 4301307242)", () => {
  const page = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("reads to exhaustion across full pages", async () => {
    const sizes = [EXPORT_PAGE_SIZE, EXPORT_PAGE_SIZE, 7];
    const calls: Array<[number, number]> = [];
    const rows = await readAllPages<number>(async (from, to) => {
      calls.push([from, to]);
      return { data: page(sizes[calls.length - 1]), error: null };
    });
    expect(rows).toHaveLength(EXPORT_PAGE_SIZE * 2 + 7);
    expect(calls).toEqual([
      [0, EXPORT_PAGE_SIZE - 1],
      [EXPORT_PAGE_SIZE, EXPORT_PAGE_SIZE * 2 - 1],
      [EXPORT_PAGE_SIZE * 2, EXPORT_PAGE_SIZE * 3 - 1],
    ]);
  });

  it("an error anywhere fails the read", async () => {
    let n = 0;
    expect(
      await readAllPages<number>(async () => {
        n += 1;
        return n === 2 ? { data: null, error: { code: "x" } } : { data: page(EXPORT_PAGE_SIZE), error: null };
      }),
    ).toBeNull();
  });

  it("saturation (every page full up to the cap) fails closed instead of truncating", async () => {
    let calls = 0;
    const rows = await readAllPages<number>(async () => {
      calls += 1;
      return { data: page(EXPORT_PAGE_SIZE), error: null };
    });
    expect(rows).toBeNull();
    expect(calls).toBe(EXPORT_MAX_PAGES);
  });

  it("an exactly-full final page is followed by one more read, not assumed complete", async () => {
    const sizes = [EXPORT_PAGE_SIZE, 0];
    let i = 0;
    const rows = await readAllPages<number>(async () => ({ data: page(sizes[i++]), error: null }));
    expect(rows).toHaveLength(EXPORT_PAGE_SIZE);
    expect(i).toBe(2);
  });
});

describe("auditThenLoad — audited before anything is read, fail closed", () => {
  it("loads nothing when the audit write fails", async () => {
    const load = vi.fn(async () => ({ ok: true as const, value: "records" }));
    expect(await auditThenLoad(async () => ({ ok: false }), load)).toEqual({ ok: false, reason: "audit_failed" });
    expect(load).not.toHaveBeenCalled();
  });

  it("loads nothing when the audit write throws", async () => {
    const load = vi.fn(async () => ({ ok: true as const, value: "records" }));
    const out = await auditThenLoad(async () => {
      throw new Error("db down");
    }, load);
    expect(out).toEqual({ ok: false, reason: "audit_failed" });
    expect(load).not.toHaveBeenCalled();
  });

  it("audits first, then loads; a failed load is reported, not shown", async () => {
    const order: string[] = [];
    const out = await auditThenLoad(
      async () => {
        order.push("audit");
        return { ok: true };
      },
      async () => {
        order.push("load");
        return { ok: true as const, value: "records" };
      },
    );
    expect(order).toEqual(["audit", "load"]);
    expect(out).toEqual({ ok: true, document: "records" });
    expect(await auditThenLoad(async () => ({ ok: true }), async () => ({ ok: false as const }))).toEqual({
      ok: false,
      reason: "load_failed",
    });
  });
});

describe("what the page says it leaves out (#828 F18/G-21)", () => {
  it("names private notes, payments, intake, consents and photos as excluded", () => {
    const text = EXPORT_EXCLUSIONS.join(" | ").toLowerCase();
    for (const term of ["private warnings", "personal notes", "payment", "intake", "consent", "photos"]) {
      expect(text).toContain(term);
    }
  });
});

describe("analytics never sees the export page (#828 G-26)", () => {
  it("drops a pageview on the export URL", () => {
    const url = `https://hone.care/clients/${SESSION_ID}/records/export?scope=day&day=2026-10-01`;
    expect(guardBrowserEvent({ event: "$pageview", properties: { $current_url: url } })).toBeNull();
  });
});
