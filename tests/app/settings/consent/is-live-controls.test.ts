import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #167. Settings -> Consent forms: a new template lands as Draft +
// is_live=false, and going live is a separate, owner-only step. These
// source-grep tests pin the server actions that carry that safety
// property (no behavioural test drives them yet).

const ACTIONS_PATH = path.resolve(
  __dirname,
  "../../../../app/(app)/settings/consent/actions.ts",
);
const ACTIONS = readFileSync(ACTIONS_PATH, "utf8");

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
});

describe("setConsentTemplateLiveAction (server)", () => {
  it("is studio-scoped and owner-only", () => {
    const fn =
      ACTIONS.match(
        /export async function setConsentTemplateLiveAction[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).toMatch(/getCurrentPractitionerWithStudio/);
    expect(fn).toMatch(/practitioner\.role !== "owner"/);
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
