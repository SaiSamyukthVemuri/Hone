import { describe, expect, it } from "vitest";
import { intakeForViewer, toIntakeStatusOnly } from "@/lib/intake/status-only";
import { buildGettingStarted, type GettingStartedSignals } from "@/lib/onboarding/getting-started";

// Privacy X1: a viewer without clin.view_intake carries only the allow-listed status fields. Built field by field, so no other column survives.
const FULL = {
  id: "i1", client_id: "c1", status: "reviewed", started_at: "2026-11-01T10:00:00Z", submitted_at: "2026-11-01T11:00:00Z", reviewed_at: "2026-11-02T09:00:00Z",
  intake_link_last_sent_at: "2026-11-01T09:00:00Z", intake_link_expires_at: "2026-11-08T09:00:00Z", intake_link_send_count: 2,
  // everything below must NOT survive
  responses: { q: "answer" }, practitioner_notes: "private note", questionnaire_snapshot: { v: 1 }, revision: 3, studio_id: "s1", current_step: 4,
  reviewed_by: "p1", deleted_at: null, requested_at: null, requested_by: "p1", created_at: "x", updated_at: "y", some_future_column: "leak",
} as never;

describe("status-only intake row", () => {
  it("keeps exactly the allow-listed fields and nothing else", () => {
    const out = intakeForViewer(FULL, false) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual([
      "client_id", "id", "intake_link_expires_at", "intake_link_last_sent_at", "intake_link_send_count", "reviewed_at", "started_at", "status", "submitted_at",
    ]);
    for (const k of ["responses", "practitioner_notes", "questionnaire_snapshot", "reviewed_by", "some_future_column"]) expect(out).not.toHaveProperty(k);
    expect(toIntakeStatusOnly(FULL)).toEqual(out);
  });
  it("returns the full row for a viewer who holds the key, and null for no row", () => {
    expect(intakeForViewer(FULL, true)).toBe(FULL);
    expect(intakeForViewer(null, false)).toBeNull();
  });
  it("getting-started charting items are informational, never a false to-do, when records are not available", () => {
    const base = {
      studioName: "S", practitionerName: "P", hasSlug: true, activeServices: 1, appointments: 0, clients: 0, sessions: 0, treatmentAreas: 0,
      hasFrequency: false, hasProbe: false, hasProbeLot: false, hasReactionOrTolerance: false, hasNextVisitNote: false, liveTreatmentConsent: true,
      sterileItems: 0, disinfectants: 0, paymentAttempts: null, runtimeLivemode: false, nextStepSignalsAvailable: false,
    } as unknown as GettingStartedSignals;
    const items = (r: boolean) => buildGettingStarted({ ...base, recordsAvailable: r }).sections.find((x) => x.key === "charting")!.items.filter((i) => i.key !== "test-client");
    expect(items(false).every((i) => i.status === "review")).toBe(true);
    expect(items(true).every((i) => i.status === "todo")).toBe(true);
  });
});
