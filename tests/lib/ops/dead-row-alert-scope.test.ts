import { describe, expect, it } from "vitest";
import { deadRowAlertSafeDetails } from "@/lib/google-calendar/sync/reconcile-heartbeat";
import { isMemberSensitiveAlert, routeOperatorOnly } from "@/lib/ops/operator-only";

// HON-125, Insurance P3 on #1845. The Google Calendar dead-row alert is deduped by its studio_id COLUMN
// (reconcile-heartbeat.ts: select ... eq("event", DEAD_ROW_EVENT).eq("studio_id", studioId) and resolved_at is null).
// If a future detail key (for example total_dead) matched the operator-only deny-list, the writer would route the row to studio_id NULL,
// the dedupe would stop finding it and the alert would repeat on every run. This pins that the real details stay studio-scoped.

const STUDIO = "11111111-1111-4111-8111-111111111111";

describe("the calendar dead-row alert stays studio-scoped", () => {
  const details = deadRowAlertSafeDetails(STUDIO, 3, Date.UTC(2026, 10, 27));

  it("its details are not member-sensitive", () => {
    expect(isMemberSensitiveAlert({ studioId: STUDIO, safeDetails: details })).toBe(false);
  });

  it("the router writes it with its studio_id unchanged and its details untouched", () => {
    expect(routeOperatorOnly({ studioId: STUDIO, safeDetails: details })).toEqual({
      studioId: STUDIO,
      clientId: null,
      safeDetails: details,
    });
  });

  it("negative control: a key like total_dead WOULD route it away, which is what this test guards against", () => {
    expect(routeOperatorOnly({ studioId: STUDIO, safeDetails: { ...details, total_dead: 3 } }).studioId).toBeNull();
  });
});
