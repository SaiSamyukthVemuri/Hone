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
  const session = {
    id: "s5",
    started_at: "2026-10-01T15:00:00Z",
    ended_at: null,
    modality: "electrolysis",
    session_notes: null,
    performed_by_practitioner_id: null,
    practitioner_id: null,
    record_status: null,
    finalized_at: null,
    aftercare_and_risks_explained_at: null,
  };
  const blockWith = (over: Record<string, unknown>) =>
    ({
      id: "b5",
      session_id: "s5",
      sort_order: 0,
      primary_area: "chin",
      side: null,
      created_at: "2026-10-01T15:01:00Z",
      caution_note: null,
      caution_for_next_session: null,
      ...over,
    }) as unknown as ExportBlockSource;
  const notesOf = (b: ExportBlockSource) =>
    buildClinicalRecordsDocument({
      sessions: [session],
      blocks: [b],
      entries: [],
      notes: [],
      practitionerNameById: new Map(),
    }).sessions[0].blocks[0].notes;

  it("a flag-only caution is exported", () => {
    expect(notesOf(blockWith({ caution_for_next_session: true }))).toEqual([
      { label: "Caution for next session", value: "Yes" },
    ]);
  });
  it("the note is shown when present, and nothing when neither is set", () => {
    expect(notesOf(blockWith({ caution_for_next_session: true, caution_note: "Thin skin" }))).toEqual([
      { label: "Caution for next session", value: "Thin skin" },
    ]);
    expect(notesOf(blockWith({}))).toEqual([]);
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

    // The settings block, with its structured probe, lot and observations.
    expect(s.blocks).toHaveLength(1);
    // Legacy single-area block: the shared label contract (blockAreasLabel).
    expect(s.blocks[0].title).toBe("Left upper lip");
    expect(s.blocks[0].readings).toEqual(
      expect.arrayContaining([
        { label: "Mode", value: "blend" },
        { label: "Machine frequency", value: "13.56" },
        { label: "Minutes performed", value: "15 min" },
        { label: "Probe", value: "Ballet F3 gold" },
        { label: "Probe lot", value: "LOT-7" },
        { label: "Tolerance", value: "4" },
      ]),
    );
    expect(s.blocks[0].readings.map((r) => r.label)).not.toContain("Reaction");
    expect(s.blocks[0].notes).toEqual([
      { label: "Legacy skin response", value: "Mild redness" },
      { label: "Legacy response note", value: "Settled in 10 min." },
      { label: "Notes", value: "Block note." },
    ]);

    // The entry charted in that block, with the CURRENT readings.
    expect(s.blocks[0].entries).toHaveLength(1);
    const e = s.blocks[0].entries[0];
    expect(e.readings).toEqual(
      expect.arrayContaining([
        { label: "Thermolysis intensity", value: "22 %" },
        { label: "Thermolysis duration", value: "4 s" },
        { label: "Galvanic current", value: "0.3 mA" },
        { label: "Galvanic duration", value: "6 s" },
        { label: "Pulse delay", value: "1.5 s" },
        { label: "Pulses", value: "120" },
        { label: "Hairs treated", value: "60" },
      ]),
    );
    expect(e.observations).toEqual(["Coarse hair", "Client tolerated well"]);
    expect(e.comments).toBe("Good response.");
    // Absent values are not emitted as empty labels.
    expect(e.readings.map((r) => r.label)).not.toContain("Units of lye");

    // The legacy entry (no block) keeps its generic readings, at session level.
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].areas).toEqual(["chin"]);
    expect(s.entries[0].readings).toEqual(
      expect.arrayContaining([
        { label: "Probe", value: "F 2" },
        { label: "Intensity", value: "40" },
        { label: "Duration", value: "3 s" },
      ]),
    );

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
    expect(s.blocks[0].entries.map((e) => e.id)).toEqual(["in-live"]);
  });
});

describe("reactions print through the saved-record view's rule (Codex P1 4304382927)", () => {
  const notesFor = (reactionType: string | null, chips: unknown[]) =>
    buildClinicalRecordsDocument({
      sessions: [
        {
          id: "s6",
          started_at: "2026-10-01T15:00:00Z",
          ended_at: null,
          modality: "electrolysis",
          session_notes: null,
          performed_by_practitioner_id: null,
          practitioner_id: null,
          record_status: null,
          finalized_at: null,
          aftercare_and_risks_explained_at: null,
        },
      ],
      blocks: [
        {
          id: "b6",
          session_id: "s6",
          sort_order: 0,
          primary_area: "chin",
          side: null,
          created_at: "2026-10-01T15:01:00Z",
          reaction_type: reactionType,
        } as unknown as ExportBlockSource,
      ],
      entries: chips.map(
        (c, i) =>
          ({
            id: `e6-${i}`,
            session_id: "s6",
            block_id: "b6",
            area: "chin",
            observation_chips: c,
            created_at: `2026-10-01T15:0${i + 2}:00Z`,
          }) as unknown as ExportEntrySource,
      ),
      notes: [],
      practitionerNameById: new Map(),
    }).sessions[0].blocks[0];

  it("a chip-backed legacy value prints ONCE (as the chip), not again as a reading", () => {
    const b = notesFor("mild_redness", [["Mild redness"]]);
    expect(b.notes.map((n) => n.label)).not.toContain("Legacy skin response");
    expect(b.readings.map((r) => r.label)).not.toContain("Reaction");
    expect(JSON.stringify(b).match(/Mild redness/g) ?? []).toHaveLength(1);
  });

  it("an unmatched legacy value is labelled LEGACY", () => {
    const b = notesFor("swelling", [["good release"]]);
    expect(b.notes).toContainEqual({ label: "Legacy skin response", value: "Swelling" });
  });

  it('reaction_type "none" beside a real response chip prints no "none"', () => {
    const b = notesFor("none", [["Mild redness"]]);
    expect(JSON.stringify(b)).not.toMatch(/No visible reaction|"none"/);
  });
});

describe("the RETIRED galvanic % never prints as a reading (Codex P1 4303753479)", () => {
  it("a legacy entry's galvanic_intensity_percent is omitted, beside the active galvanic readings", () => {
    const doc = buildClinicalRecordsDocument({
      sessions: [
        {
          id: "s8",
          started_at: "2026-10-01T15:00:00Z",
          ended_at: null,
          modality: "electrolysis",
          session_notes: null,
          performed_by_practitioner_id: null,
          practitioner_id: null,
          record_status: null,
          finalized_at: null,
          aftercare_and_risks_explained_at: null,
        },
      ],
      entries: [
        {
          id: "e8",
          session_id: "s8",
          block_id: null,
          area: "chin",
          created_at: "2026-10-01T15:01:00Z",
          galvanic_ma: 0.4,
          galvanic_duration_seconds: 5,
          // A row from before the reading was retired: the column is non-null.
          galvanic_intensity_percent: 37,
        } as unknown as ExportEntrySource,
      ],
      notes: [],
      practitionerNameById: new Map(),
    });
    const readings = doc.sessions[0].entries[0].readings;
    expect(readings).toEqual(
      expect.arrayContaining([
        { label: "Galvanic current", value: "0.4 mA" },
        { label: "Galvanic duration", value: "5 s" },
      ]),
    );
    expect(readings.map((r) => r.label)).not.toContain("Galvanic intensity");
    expect(JSON.stringify(doc)).not.toContain("37");
  });
});

describe("structured readings suppress the stale legacy pair, by the saved view's rule (Codex P1 4304983088)", () => {
  const entry = (id: string, over: Record<string, unknown>) =>
    ({
      id,
      session_id: "s3",
      block_id: null,
      area: "chin",
      areas: null,
      mode: null,
      intensity: null,
      duration_seconds: null,
      thermolysis_intensity_percent: null,
      thermolysis_duration_seconds: null,
      galvanic_ma: null,
      galvanic_duration_seconds: null,
      units_of_lye: null,
      pulse_count: null,
      created_at: `2026-10-01T15:0${id.length % 10}:00Z`,
      ...over,
    }) as unknown as ExportEntrySource;
  // ONE session holding all three kinds.
  const doc = buildClinicalRecordsDocument({
    sessions: [
      {
        id: "s3",
        started_at: "2026-10-01T15:00:00Z",
        ended_at: null,
        modality: "electrolysis",
        session_notes: null,
        performed_by_practitioner_id: null,
        practitioner_id: null,
        record_status: null,
        finalized_at: null,
        aftercare_and_risks_explained_at: null,
      },
    ],
    entries: [
      // A legacy entry: the generic pair only.
      entry("a-legacy", { intensity: 40, duration_seconds: 3 }),
      // A legacy entry LATER edited through structured charting: the old pair
      // is still stored beside the new fields (update_block_with_entry, 0166).
      entry("b-edited", { intensity: 40, duration_seconds: 3, thermolysis_intensity_percent: 22, thermolysis_duration_seconds: 4 }),
      // A structured-only entry.
      entry("c-structured", { galvanic_ma: 0.3, galvanic_duration_seconds: 6 }),
    ],
    notes: [],
    practitionerNameById: new Map(),
  });
  const byId = new Map(doc.sessions[0].entries.map((e) => [e.id, e.readings]));
  const labels = (id: string) => (byId.get(id) ?? []).map((r) => r.label);

  it("a legacy-only entry still prints intensity and duration", () => {
    expect(byId.get("a-legacy")).toEqual(
      expect.arrayContaining([
        { label: "Intensity", value: "40" },
        { label: "Duration", value: "3 s" },
      ]),
    );
  });
  it("a legacy entry later edited with structured readings prints ONLY the structured set", () => {
    expect(labels("b-edited")).toEqual(expect.arrayContaining(["Thermolysis intensity", "Thermolysis duration"]));
    expect(labels("b-edited")).not.toContain("Intensity");
    expect(labels("b-edited")).not.toContain("Duration");
  });
  it("a structured-only entry is unchanged", () => {
    expect(byId.get("c-structured")).toEqual([
      { label: "Galvanic current", value: "0.3 mA" },
      { label: "Galvanic duration", value: "6 s" },
    ]);
  });
  it("the export and the saved view use the SAME rule (one shared function)", async () => {
    const { readFileSync } = await import("node:fs");
    const scope = readFileSync("lib/clinical-records/export-scope.ts", "utf8");
    const view = readFileSync("components/entry-row.tsx", "utf8");
    expect(view).toContain('import { hasStructuredReadings } from "@/lib/sessions/structured-readings";');
    expect(scope).toContain('import { hasStructuredReadings, pulseReadingsShown } from "@/lib/sessions/structured-readings";');
    expect(view).toContain("const hasStructured = hasStructuredReadings(entry);");
    expect(scope).toContain("const legacyPair = !hasStructuredReadings(e);");
  });
});

describe("pulses print only where the saved view shows them (Codex P1 4305560955)", () => {
  const one = (over: Record<string, unknown>) =>
    buildClinicalRecordsDocument({
      sessions: [
        {
          id: "s4",
          started_at: "2026-10-01T15:00:00Z",
          ended_at: null,
          modality: "electrolysis",
          session_notes: null,
          performed_by_practitioner_id: null,
          practitioner_id: null,
          record_status: null,
          finalized_at: null,
          aftercare_and_risks_explained_at: null,
        },
      ],
      entries: [
        {
          id: "e4",
          session_id: "s4",
          block_id: null,
          area: "chin",
          created_at: "2026-10-01T15:01:00Z",
          ...over,
        } as unknown as ExportEntrySource,
      ],
      notes: [],
      practitionerNameById: new Map(),
    }).sessions[0].entries[0].readings.map((r) => r.label);

  it("a current GALVANIC entry's stored default pulse count (1) is NOT printed", () => {
    const labels = one({ mode: "galvanic", galvanic_ma: 0.3, pulse_count: 1, pulse_delay_seconds: 0.5 });
    expect(labels).not.toContain("Pulses");
    expect(labels).not.toContain("Pulse delay");
  });
  it("a THERMO or BLEND entry prints its pulses, and the delay only for more than one pulse", () => {
    expect(one({ mode: "thermo", thermolysis_intensity_percent: 20, pulse_count: 3, pulse_delay_seconds: 0.5 })).toEqual(
      expect.arrayContaining(["Pulses", "Pulse delay"]),
    );
    const single = one({ mode: "blend", galvanic_ma: 0.3, pulse_count: 1, pulse_delay_seconds: 0.5 });
    expect(single).toContain("Pulses");
    expect(single).not.toContain("Pulse delay");
  });
  it("a LEGACY entry with no structured readings keeps its recorded pulse count", () => {
    expect(one({ mode: null, intensity: 40, pulse_count: 2 })).toContain("Pulses");
  });
});

describe("legacy observations are hydrated from comments, as the saved view does (Codex P2 4305560961)", () => {
  const entryOf = (over: Record<string, unknown>) =>
    buildClinicalRecordsDocument({
      sessions: [
        {
          id: "s5",
          started_at: "2026-10-01T15:00:00Z",
          ended_at: null,
          modality: "electrolysis",
          session_notes: null,
          performed_by_practitioner_id: null,
          practitioner_id: null,
          record_status: null,
          finalized_at: null,
          aftercare_and_risks_explained_at: null,
        },
      ],
      entries: [
        { id: "e5", session_id: "s5", block_id: null, area: "chin", created_at: "2026-10-01T15:01:00Z", ...over } as unknown as ExportEntrySource,
      ],
      notes: [],
      practitionerNameById: new Map(),
    }).sessions[0].entries[0];

  it("a pre-0108 entry's chips stored in comments print as observations, not as comment text", () => {
    const e = entryOf({ observation_chips: [], comments: "Coarse hair, Client tolerated well" });
    expect(e.observations).toEqual(["Coarse hair", "Client tolerated well"]);
    expect(e.comments).toBeNull();
  });
  it("matches the shared resolver exactly, chips and remaining narrative", async () => {
    const { resolveDisplayChips } = await import("@/lib/observation-chips");
    for (const comments of ["Coarse hair, Client tolerated well\nGood response.", "Free narrative only.", ""]) {
      const e = entryOf({ observation_chips: [], comments });
      const r = resolveDisplayChips([], comments);
      expect(e.observations).toEqual(r.chips);
      expect(e.comments).toBe(r.note.length > 0 ? r.note : null);
    }
  });
  it("a current entry keeps its structured chips and its comment", () => {
    const e = entryOf({ observation_chips: ["Coarse hair"], comments: "Good response." });
    expect(e.observations).toEqual(["Coarse hair"]);
    expect(e.comments).toBe("Good response.");
  });
});

describe("probe-lot confirmation is exported (Codex P2 4302799069)", () => {
  const lotOf = (over: Record<string, unknown>) =>
    buildClinicalRecordsDocument({
      sessions: [
        {
          id: "s9",
          started_at: "2026-10-01T15:00:00Z",
          ended_at: null,
          modality: "electrolysis",
          session_notes: null,
          performed_by_practitioner_id: null,
          practitioner_id: null,
          record_status: null,
          finalized_at: null,
          aftercare_and_risks_explained_at: null,
        },
      ],
      blocks: [
        {
          id: "b9",
          session_id: "s9",
          sort_order: 0,
          primary_area: "chin",
          side: null,
          created_at: "2026-10-01T15:01:00Z",
          ...over,
        } as unknown as ExportBlockSource,
      ],
      entries: [],
      notes: [],
      practitionerNameById: new Map(),
    }).sessions[0].blocks[0].readings.find((r) => r.label === "Probe lot")?.value;

  it("a confirmed lot says so, as the live chart does", () => {
    expect(lotOf({ probe_lot_number: " LOT-9 ", probe_lot_confirmed: true })).toBe("LOT-9 (confirmed)");
  });
  it("an unconfirmed lot reads as the bare lot, and no lot emits nothing", () => {
    expect(lotOf({ probe_lot_number: "LOT-9", probe_lot_confirmed: false })).toBe("LOT-9");
    expect(lotOf({ probe_lot_number: null, probe_lot_confirmed: true })).toBeUndefined();
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
    const block = {
      id: "b9",
      session_id: "s9",
      sort_order: 0,
      primary_area: "Cheeks", // legacy projection keeps only the FIRST area
      side: null, // and clears the side when laterality differs
      custom_area_detail: null,
      block_name: null,
      created_at: "2026-10-01T15:05:00Z",
    } as unknown as ExportBlockSource;
    const doc = buildClinicalRecordsDocument({
      sessions: [
        {
          id: "s9",
          started_at: "2026-10-01T15:00:00Z",
          ended_at: null,
          modality: "electrolysis",
          session_notes: null,
          performed_by_practitioner_id: null,
          practitioner_id: null,
          record_status: null,
          finalized_at: null,
          aftercare_and_risks_explained_at: null,
        },
      ],
      blocks: [block],
      blockAreasById: new Map([
        [
          "b9",
          [
            { area: "Cheeks", laterality: "left" },
            { area: "Sideburns", laterality: "right" },
          ] as never,
        ],
      ]),
      entries: [],
      notes: [],
      practitionerNameById: new Map(),
    });
    expect(doc.sessions[0].blocks[0].title).toBe("Left Cheeks · Right Sideburns");
  });
});

describe("laser treatment passes are exported (Codex P1 4301153312)", () => {
  it("zone, session number, plain equipment params, observations and results", () => {
    const doc = buildClinicalRecordsDocument({
      sessions: [
        {
          id: "s7",
          started_at: "2026-10-01T15:00:00Z",
          ended_at: null,
          modality: "laser",
          session_notes: null,
          performed_by_practitioner_id: null,
          practitioner_id: null,
          record_status: null,
          finalized_at: null,
          aftercare_and_risks_explained_at: null,
        },
      ],
      entries: [],
      laserEntries: [
        {
          id: "l1",
          session_id: "s7",
          zone: "Underarm",
          session_number: 3,
          equipment_params: { fluence_j_cm2: 18, spot_size_mm: 12, nested: { x: 1 }, note_private: null },
          observation_notes: "Even erythema.",
          ejection_results: "Good",
          created_at: "2026-10-01T15:10:00Z",
        },
      ],
      notes: [],
      practitionerNameById: new Map(),
    });
    const l = doc.sessions[0].laserEntries[0];
    expect(l.zone).toBe("Underarm");
    expect(l.readings).toEqual([
      { label: "Session number", value: "3" },
      { label: "fluence j cm2", value: "18" },
      { label: "spot size mm", value: "12" },
    ]);
    expect(l.notes).toEqual([
      { label: "Observations", value: "Even erythema." },
      { label: "Results", value: "Good" },
    ]);
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
