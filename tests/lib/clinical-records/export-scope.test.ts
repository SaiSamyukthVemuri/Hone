import { describe, expect, it, vi } from "vitest";
import {
  EXPORT_EXCLUSIONS,
  MAX_RANGE_DAYS,
  auditThenLoad,
  buildClinicalRecordsDocument,
  localDayBounds,
  parseExportScope,
  scopeAuditMetadata,
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
  const entry = {
    id: "e1",
    session_id: "s1",
    area: "upper lip",
    areas: null,
    probe_type: "F",
    probe_size: "3",
    mode: "blend",
    intensity: 40,
    duration_seconds: null,
    minutes_performed: 15,
    pulse_count: 120,
    hairs_treated: 60,
    comments: "Good response.",
    created_at: "2026-10-01T15:10:00Z",
    private_warnings: PRIVATE,
    delete_reason: "SENTINEL-DELETE",
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
    entries: [entry],
    notes: [note],
    practitionerNameById: new Map([["p1", "Practitioner One"]]),
  });

  it("keeps the clinical record", () => {
    expect(doc.sessions).toHaveLength(1);
    expect(doc.sessions[0]).toMatchObject({ notes: "Clinical session note.", practitioner: "Practitioner One" });
    expect(doc.sessions[0].entries[0]).toMatchObject({
      areas: ["upper lip"],
      probe: "F 3",
      intensity: "40",
      minutesPerformed: 15,
      comments: "Good response.",
    });
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
