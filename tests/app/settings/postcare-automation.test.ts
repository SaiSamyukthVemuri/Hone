import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Postcare automation wiring (migration 0110). The helper's claim/settle
// behaviour is unit-tested in tests/app/calendar/postcare-auto-send.test.ts;
// the DB contract in tests/db/studio-postcare-delivery-mode.db.test.ts. Here we
// pin the two call sites and the owner-gated settings save.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const CAL_ACTIONS = read("app/(app)/calendar/actions.ts");
const SESSION_ACTIONS = read("app/(app)/clients/[id]/sessions/new/actions.ts");
const STUDIO_ACTION = read("app/(app)/settings/studio/actions.ts");

describe("completion hooks call auto-send after the RPC succeeds (fail-soft)", () => {
  it("markAppointmentCompleteAction auto-sends after mark_appointment_complete", () => {
    const idx = CAL_ACTIONS.indexOf('rpc("mark_appointment_complete"');
    // B8 threads the server-resolved practitioner as a third argument.
    const hookIdx = CAL_ACTIONS.indexOf(
      "autoSendPostcareOnComplete(appointmentId, studio.id, practitioner.id)",
    );
    expect(idx).toBeGreaterThan(-1);
    expect(hookIdx).toBeGreaterThan(idx); // called after the RPC
  });
  it("session-start auto-complete also triggers auto-send (only when the RPC did not error)", () => {
    expect(SESSION_ACTIONS).toMatch(/} else \{[\s\S]*autoSendPostcareOnComplete\(args\.appointmentId, args\.studioId, args\.practitionerId\)/);
  });
});

describe("settings save", () => {
  it("the save action stays owner-gated server-side", () => {
    expect(STUDIO_ACTION).toMatch(/updateStudioPostcareAction/);
    expect(STUDIO_ACTION).toMatch(/Only studio owners can change postcare settings/);
  });

  it("save writes postcare_delivery_mode best-effort (pre-migration safe), default manual", () => {
    expect(STUDIO_ACTION).toMatch(/postcare_delivery_mode: deliveryMode/);
    expect(STUDIO_ACTION).toMatch(/=== "auto_on_complete"\s*\?\s*"auto_on_complete"\s*:\s*"manual"/);
    expect(STUDIO_ACTION).toMatch(/PGRST204|42703|postcare_delivery_mode/);
  });
});
