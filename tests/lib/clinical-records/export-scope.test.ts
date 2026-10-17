import { describe, expect, it, vi } from "vitest";
import {
  EXPORT_EXCLUSIONS,
  MAX_RANGE_DAYS,
  auditThenLoad,
  buildClinicalRecordsDocument,
  localDayBounds,
  parseExportScope,
  scopeAuditMetadata,
  type ExportBlockSource,
  type ExportEntrySource,
  type ExportNoteSource,
  type ExportSessionSource,
} from "@/lib/clinical-records/export-scope";
import { guardBrowserEvent } from "@/lib/analytics/client-boundary";

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
    reaction_type: "mild erythema",
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
    galvanic_intensity_percent: null,
    units_of_lye: null,
    pulse_delay_seconds: 1.5,
    minutes_performed: null,
    pulse_count: 120,
    hairs_treated: 60,
    observation_chips: ["good release", "minimal heat"],
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
    expect(s.blocks[0].title).toBe("upper lip · left");
    expect(s.blocks[0].readings).toEqual(
      expect.arrayContaining([
        { label: "Mode", value: "blend" },
        { label: "Machine frequency", value: "13.56" },
        { label: "Minutes performed", value: "15 min" },
        { label: "Probe", value: "Ballet F3 gold" },
        { label: "Probe lot", value: "LOT-7" },
        { label: "Tolerance", value: "4" },
        { label: "Reaction", value: "mild erythema" },
      ]),
    );
    expect(s.blocks[0].notes).toEqual([
      { label: "Reaction notes", value: "Settled in 10 min." },
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
    expect(e.observations).toEqual(["good release", "minimal heat"]);
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
    for (const term of ["private warnings", "personal notes", "payment", "intake", "consent", "photos", "laser"]) {
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
