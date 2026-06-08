import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #167. Settings -> Consent forms gained an explicit "Live in
// client portal" toggle and the create action now forces a new
// row to land as Draft + is_live=false. These source-grep tests
// pin both the wire-up and the helper copy so the safety
// property survives future refactors.

const EDITOR_PATH = path.resolve(
  __dirname,
  "../../../../app/(app)/settings/consent/ConsentTemplatesEditor.tsx",
);
const EDITOR = readFileSync(EDITOR_PATH, "utf8");

const ACTIONS_PATH = path.resolve(
  __dirname,
  "../../../../app/(app)/settings/consent/actions.ts",
);
const ACTIONS = readFileSync(ACTIONS_PATH, "utf8");

const PAGE_PATH = path.resolve(
  __dirname,
  "../../../../app/(app)/settings/consent/page.tsx",
);
const PAGE = readFileSync(PAGE_PATH, "utf8");

describe("Settings -> Consent: new templates default to draft + not live", () => {
  it("createConsentTemplateAction inserts status='draft' and is_live=false", () => {
    // The previous behavior was status='active'. PR #167 pins
    // status='draft' AND is_live=false on the server, so a
    // newly created template cannot reach the portal by
    // accident even if a malicious client posts the form
    // directly.
    const fn =
      ACTIONS.match(
        /createConsentTemplateAction[\s\S]*?\.insert\(\{[\s\S]*?\}\)/,
      )?.[0] ?? "";
    expect(fn).toMatch(/status: "draft"/);
    expect(fn).toMatch(/is_live: false/);
  });

  it("createConsentTemplateAction does NOT read status from the form data", () => {
    // The previous code accepted status from the form; PR #167
    // removes that path so a malicious client cannot force a
    // status='active' insert by posting a hand-crafted form.
    const block =
      ACTIONS.match(/export async function createConsentTemplateAction[\s\S]*?\n\}/)?.[0] ??
      "";
    expect(block).not.toMatch(/fdStr\(formData, "status"\)/);
  });

  it("the create form helper copy names the consequence", () => {
    // Practitioner needs to know what happens after Save. The
    // exact wording is pinned so a future visual refactor that
    // removes the explanatory block is caught.
    expect(EDITOR).toContain(
      "New forms are saved as Draft. They are not shown to clients until",
    );
    expect(EDITOR).toContain("you mark them Active and then Live in client portal.");
  });

  it("the create form no longer auto-stamps status='active' on submit", () => {
    expect(EDITOR).not.toMatch(/fd\.set\("status", "active"\)/);
  });
});

describe("Settings -> Consent: per-template Live toggle", () => {
  it("the editor accepts a setLiveAction prop", () => {
    expect(EDITOR).toMatch(/setLiveAction:\s*ActionStatus/);
  });

  it("the editor handles the live toggle via a handleLive function", () => {
    expect(EDITOR).toMatch(/function handleLive\(/);
    expect(EDITOR).toMatch(/fd\.set\("is_live"/);
  });

  it("a Make live button is rendered when status='active' && !is_live", () => {
    expect(EDITOR).toMatch(
      /t\.status === "active" && !t\.is_live[\s\S]{0,500}Make live in client portal/,
    );
  });

  it("a Hide from portal button is rendered when is_live=true", () => {
    expect(EDITOR).toMatch(
      /t\.is_live[\s\S]{0,500}Hide from client portal/,
    );
  });

  it("the Live/Draft badge renders next to the status label", () => {
    expect(EDITOR).toMatch(/function LiveBadge/);
    // The badge component appears in the row layout
    expect(EDITOR).toMatch(/<LiveBadge isLive=\{t\.is_live\}/);
  });
});

describe("Settings -> Consent: action wire-up", () => {
  it("page.tsx imports setConsentTemplateLiveAction", () => {
    expect(PAGE).toMatch(/setConsentTemplateLiveAction/);
  });

  it("page.tsx passes setLiveAction to the editor", () => {
    expect(PAGE).toMatch(/setLiveAction=\{setConsentTemplateLiveAction\}/);
  });

  it("page.tsx mentions 'Live in client portal' in the header copy", () => {
    expect(PAGE).toContain("Live in client portal");
  });
});

describe("setConsentTemplateLiveAction (server)", () => {
  it("rejects making a non-active template live with a clear message", () => {
    // The DB CHECK constraint would reject a (is_live=true,
    // status!=active) UPDATE; the action must catch that
    // pre-flight so the practitioner sees a useful message
    // instead of a generic 500.
    expect(ACTIONS).toMatch(
      /Mark the template active first, then make it live in the client portal/,
    );
  });

  it("is studio-scoped and owner-only", () => {
    const fn =
      ACTIONS.match(
        /export async function setConsentTemplateLiveAction[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).toMatch(/getCurrentPractitionerWithStudio/);
    expect(fn).toMatch(/practitioner\.role !== "owner"/);
  });

  it("validates the is_live form field strictly as 'true' | 'false'", () => {
    const fn =
      ACTIONS.match(
        /export async function setConsentTemplateLiveAction[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).toMatch(/isLiveRaw !== "true" && isLiveRaw !== "false"/);
  });
});

describe("setConsentTemplateStatusAction: side effect on draft/archive", () => {
  it("moving to draft or archived also writes is_live = false", () => {
    // The DB CHECK constraint forbids (is_live=true, status!=active),
    // so without this side effect a UPDATE that moves a live row
    // to draft would fail at the DB. The action must preempt by
    // writing is_live = false in the same UPDATE.
    expect(ACTIONS).toMatch(
      /if \(status === "draft" \|\| status === "archived"\)[\s\S]{0,80}update\.is_live = false/,
    );
  });

  it("moving to active does NOT auto-flip is_live to true", () => {
    // The whole safety property is that the practitioner has to
    // take a second deliberate step to expose a template to
    // clients. Pin the negative: no auto-live on activation.
    const fn =
      ACTIONS.match(
        /export async function setConsentTemplateStatusAction[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).not.toMatch(/status === "active"[\s\S]{0,200}is_live\s*[:=]\s*true/);
  });
});

describe("no payment / live-mode / SMS behavior added", () => {
  it("the editor does not call PaymentIntent / Charge / Refund / Checkout / live-mode", () => {
    expect(EDITOR).not.toMatch(/paymentIntents\.create/);
    expect(EDITOR).not.toMatch(/charges\.create/);
    expect(EDITOR).not.toMatch(/refunds\.create/);
    expect(EDITOR).not.toMatch(/checkout\.sessions/);
    expect(EDITOR).not.toMatch(/STRIPE_ALLOW_LIVE_MODE=true/);
  });

  it("the actions file does not call PaymentIntent / Charge / Refund / Checkout / live-mode", () => {
    expect(ACTIONS).not.toMatch(/paymentIntents\.create/);
    expect(ACTIONS).not.toMatch(/charges\.create/);
    expect(ACTIONS).not.toMatch(/refunds\.create/);
    expect(ACTIONS).not.toMatch(/checkout\.sessions/);
    expect(ACTIONS).not.toMatch(/STRIPE_ALLOW_LIVE_MODE=true/);
  });

  it("no SMS path is added in the actions file", () => {
    expect(ACTIONS).not.toMatch(/twilio/i);
    expect(ACTIONS).not.toMatch(/lib\/sms/i);
  });
});
