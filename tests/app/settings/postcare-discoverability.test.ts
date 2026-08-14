import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Postcare auto-send discoverability fix (UI/copy only). The delivery-mode
// control already existed + works (PR #360 / migration 0110); this PR makes it
// findable and removes the stale "no auto-send" copy. No behavior/logic change.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const LAYOUT = read("app/(app)/settings/layout.tsx");
const INTAKE = read("app/(app)/settings/intake/page.tsx");
const FORM = read("app/(app)/settings/studio/PostcareSettingsForm.tsx");
const ACTIONS = read("app/(app)/settings/studio/actions.ts");

describe("postcare settings are discoverable", () => {
  it("the settings nav label surfaces Postcare", () => {
    expect(LAYOUT).toMatch(/href: "\/settings\/intake", label: "Forms & Postcare"/);
    expect(LAYOUT).toMatch(/Postcare/);
    expect(LAYOUT).not.toMatch(/label: "Forms & Policies"/);
  });

  it("the stale 'always manual / no auto-send' copy is gone", () => {
    expect(INTAKE).not.toMatch(/Send is always manual/i);
    expect(INTAKE).not.toMatch(/no\s*\n?\s*auto-send/i);
  });

  it("the section copy explains manual vs automatic delivery", () => {
    expect(INTAKE).toMatch(
      /sent manually or automatically after completed\s*\n?\s*appointments/i,
    );
  });
});

describe("delivery control + helper copy", () => {
  it("keeps both delivery options incl. automatic send after completion", () => {
    expect(FORM).toMatch(/Manual only/);
    expect(FORM).toMatch(/Automatically send after appointment completion/);
    expect(FORM).toMatch(/"manual"/);
    expect(FORM).toMatch(/auto_on_complete/);
  });

  it("helper copy says automatic postcare sends after a completed appointment (not cancelled/no-show)", () => {
    expect(FORM).toMatch(
      /Automatic postcare sends once when an appointment is\s*\n?\s*marked complete/i,
    );
    expect(FORM).toMatch(/never sends for cancelled or no-show/i);
  });
});

describe("owner-only editing is preserved; non-owner sees read-only note", () => {
  it("the postcare/delivery editor still renders only for owners", () => {
    expect(INTAKE).toMatch(/\{isOwner && \(/);
    expect(INTAKE).toMatch(/PostcareSettingsForm/);
  });
  it("a non-owner sees a read-only explanation, not the edit controls", () => {
    expect(INTAKE).toMatch(/\{!isOwner && \(/);
    expect(INTAKE).toMatch(/Only studio owners can edit postcare delivery settings/i);
  });
  it("the save action stays owner-gated server-side (unchanged)", () => {
    expect(ACTIONS).toMatch(/updateStudioPostcareAction/);
    expect(ACTIONS).toMatch(/Only studio owners can change postcare settings/);
  });
});

describe("UI/copy only: no send/payment/logic change", () => {
  it("touches no postcare send logic, Stripe, email, or SMS in the changed surfaces", () => {
    for (const src of [LAYOUT, INTAKE, FORM]) {
      expect(src).not.toMatch(/sendPostcare|autoSendPostcare|recordOpsAlert|stripe|twilio|sendSms/i);
    }
  });
});
