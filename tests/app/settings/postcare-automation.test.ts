import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Postcare automation wiring (migration 0110). Behavior is unit-tested in
// tests/app/calendar/postcare-auto-send.test.ts; the DB contract in
// tests/db/studio-postcare-delivery-mode.db.test.ts. Here we pin the wiring.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const HELPER = read("app/(app)/calendar/postcare-auto-send.ts");
const CAL_ACTIONS = read("app/(app)/calendar/actions.ts");
const SESSION_ACTIONS = read("app/(app)/clients/[id]/sessions/new/actions.ts");
const SETTINGS_FORM = read("app/(app)/settings/studio/PostcareSettingsForm.tsx");
const STUDIO_ACTION = read("app/(app)/settings/studio/actions.ts");

describe("auto-send helper — safe, idempotent, studio-scoped", () => {
  it("claim requires status=completed + not-already-sent, and is studio-scoped", () => {
    expect(HELPER).toMatch(/\.eq\("status", "completed"\)/); // never cancelled/no_show
    expect(HELPER).toMatch(/\.is\("postcare_email_sent_at", null\)/); // no duplicate
    expect(HELPER).toMatch(/\.eq\("studio_id", studioId\)/); // studio isolation
    expect(HELPER).toMatch(/\.select\("id"\)/); // proves exactly one row claimed
  });
  it("records success (sent_at) and failure (failed_at) on the shared columns", () => {
    expect(HELPER).toMatch(/postcare_email_sent_at: nowIso/);
    expect(HELPER).toMatch(/postcare_email_failed_at: nowIso/);
    expect(HELPER).toMatch(/postcare_email_last_error: safeAutoLastError/);
  });
  it("is fail-soft (try/catch → never throws) and reuses the existing safe email", () => {
    expect(HELPER).toMatch(/} catch \(err\) \{/);
    expect(HELPER).toMatch(/return "threw"/);
    // Reuses the existing safe email (buildPostcareEmail = studio settings only,
    // no clinical/intake data) rather than building a new email — no health data.
    expect(HELPER).toMatch(/sendPostcareToClient/);
  });
});

describe("completion hooks call auto-send after the RPC succeeds (fail-soft)", () => {
  it("markAppointmentCompleteAction auto-sends after mark_appointment_complete", () => {
    const idx = CAL_ACTIONS.indexOf('rpc("mark_appointment_complete"');
    const hookIdx = CAL_ACTIONS.indexOf("autoSendPostcareOnComplete(appointmentId, studio.id)");
    expect(idx).toBeGreaterThan(-1);
    expect(hookIdx).toBeGreaterThan(idx); // called after the RPC
  });
  it("session-start auto-complete also triggers auto-send (only when the RPC did not error)", () => {
    expect(SESSION_ACTIONS).toMatch(/} else \{[\s\S]*autoSendPostcareOnComplete\(args\.appointmentId, args\.studioId\)/);
  });
});

describe("settings UI + save", () => {
  it("form offers Manual / Automatic and submits postcare_delivery_mode", () => {
    expect(SETTINGS_FORM).toMatch(/Manual only/);
    expect(SETTINGS_FORM).toMatch(/Automatically send after appointment completion/);
    expect(SETTINGS_FORM).toMatch(/fd\.set\("postcare_delivery_mode", deliveryMode\)/);
  });
  it("save writes postcare_delivery_mode best-effort (pre-migration safe), default manual", () => {
    expect(STUDIO_ACTION).toMatch(/postcare_delivery_mode: deliveryMode/);
    expect(STUDIO_ACTION).toMatch(/=== "auto_on_complete"\s*\?\s*"auto_on_complete"\s*:\s*"manual"/);
    expect(STUDIO_ACTION).toMatch(/PGRST204|42703|postcare_delivery_mode/);
  });
});

describe("the manual postcare path is unchanged", () => {
  it("sendPostcareEmailAction still exists and is untouched by auto-send", () => {
    expect(CAL_ACTIONS).toMatch(/export async function sendPostcareEmailAction/);
    // the manual action does not call the auto helper (separate, safe path)
    const manualStart = CAL_ACTIONS.indexOf("export async function sendPostcareEmailAction");
    const manualEnd = CAL_ACTIONS.indexOf("\n}", manualStart);
    expect(CAL_ACTIONS.slice(manualStart, manualEnd)).not.toMatch(/autoSendPostcareOnComplete/);
  });
});
