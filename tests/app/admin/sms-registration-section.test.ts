import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// SMS-SENDER-REG-01: the operator's form exists only over a readable snapshot
// with exactly one live sender, shows that sender's number before any record,
// and carries that sender's id (Codex P2 4244108801, 4244108809, 4244108814).

vi.mock("@/app/admin/studios/[id]/actions", () => ({
  recordSmsRegistrationAction: async () => ({ ok: true }),
  recordSmsRegistrationFormAction: async () => ({ ok: true }),
}));

import { SmsRegistrationSection } from "@/app/admin/studios/[id]/SmsRegistrationSection";
import { parseLiveRegistrationState, type LiveRegistrationState } from "@/lib/sms/sender-registration";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const SENDER = { id: "22222222-2222-4222-8222-222222222222", studio_id: STUDIO, status: "active", phone_number: "+12125550123", messaging_service_sid: "MGx" };
const render = (state: LiveRegistrationState) => renderToStaticMarkup(createElement(SmsRegistrationSection, { studioId: STUDIO, state }));

describe("the operator's registration section", () => {
  it("unreadable state: no form at all", () => {
    const html = render({ ok: false });
    expect(html).toContain('data-state="unreadable"');
    expect(html).not.toMatch(/<form|<button/);
  });

  it("no live sender, or more than one: no form", () => {
    expect(render({ ok: true, senders: [], registrations: [], campaignBindings: [], stopPreflights: [] })).not.toMatch(/<form/);
    const two = render({ ok: true, senders: [SENDER, { ...SENDER, id: "33333333-3333-4333-8333-333333333333" }], registrations: [], campaignBindings: [], stopPreflights: [] });
    expect(two).toContain('data-state="ambiguous"');
    expect(two).not.toMatch(/<form/);
  });

  it("one live sender with NO record yet: its number is shown, and the form is bound to it", () => {
    const html = render({ ok: true, senders: [SENDER], registrations: [], campaignBindings: [], stopPreflights: [] });
    expect(html).toContain(SENDER.phone_number);
    expect(html).toContain(`name="expected_sender_id" value="${SENDER.id}"`);
    expect(html).toContain(`name="expected_phone_number" value="${SENDER.phone_number}"`);
    expect(html).toContain("Nothing recorded for this number");
    // The messaging service is never rendered.
    expect(html).not.toContain("MGx");
  });

  it("a sender with NO number yet: shown, but no form (Codex P2 4244484021)", () => {
    for (const status of ["off", "selecting", "provisioning"]) {
      const html = render({ ok: true, senders: [{ ...SENDER, status, phone_number: null }], registrations: [], campaignBindings: [], stopPreflights: [] });
      expect(html).toContain('data-state="no-number"');
      expect(html).toContain("not assigned yet");
      expect(html).not.toMatch(/<form|<button/);
    }
  });

  it("the kind is the number's, shown and never chosen (Codex P2 4244484022)", () => {
    const longCode = render({ ok: true, senders: [SENDER], registrations: [], campaignBindings: [], stopPreflights: [] });
    expect(longCode).not.toMatch(/name="kind"/);
    expect(longCode).toMatch(/data-testid="admin-sms-registration-kind">A2P 10DLC/);
    const tollFree = render({ ok: true, senders: [{ ...SENDER, phone_number: "+18885550123" }], registrations: [], campaignBindings: [], stopPreflights: [] });
    expect(tollFree).not.toMatch(/name="kind"/);
    expect(tollFree).toMatch(/data-testid="admin-sms-registration-kind">Toll-free verification/);
    // A number Hone does not serve gets no form at all.
    const other = render({ ok: true, senders: [{ ...SENDER, phone_number: "+18765550123" }], registrations: [], campaignBindings: [], stopPreflights: [] });
    expect(other).toContain('data-state="unsupported-number"');
    expect(other).not.toMatch(/<form/);
  });

  it("an existing record PREFILLS the form, so re-submitting never silently downgrades it (Codex P2 4248698137)", () => {
    const rec = {
      sender_id: SENDER.id, studio_id: STUDIO, phone_number: SENDER.phone_number, kind: "us_10dlc" as const,
      status: "requires_information" as const, missing_information: "a sample message", provider_reference: "CMabc123", updated_at: "x",
    };
    const html = render({ ok: true, senders: [SENDER], registrations: [rec], campaignBindings: [], stopPreflights: [] });
    expect(html).toMatch(/<option value="requires_information" selected="">/);
    expect(html).toContain('name="missing_information" value="a sample message"');
    expect(html).toContain('name="provider_reference" value="CMabc123"');
    expect(html).toContain("Currently recorded: <strong>requires_information</strong>");

    const approved = render({ ok: true, senders: [SENDER], registrations: [{ ...rec, status: "approved", missing_information: null }], campaignBindings: [], stopPreflights: [] });
    expect(approved).toMatch(/<option value="approved" selected="">/);
    expect(approved).not.toMatch(/<option value="pending" selected="">/);
  });

  it("with no record (or only a record of another kind) the defaults apply", () => {
    const none = render({ ok: true, senders: [SENDER], registrations: [], campaignBindings: [], stopPreflights: [] });
    expect(none).toMatch(/<option value="pending" selected="">/);
    expect(none).not.toContain("Currently recorded");
  });

  it("refusals are form state, never thrown (Codex P2 4244484024)", async () => {
    const { readFileSync } = await import("node:fs");
    const section = readFileSync("app/admin/studios/[id]/SmsRegistrationSection.tsx", "utf8");
    const form = readFileSync("app/admin/studios/[id]/SmsRegistrationForm.tsx", "utf8");
    expect(section).not.toMatch(/\bthrow\b/);
    expect(form).not.toMatch(/\bthrow\b/);
    expect(form).toMatch(/useActionState/);
    expect(form).toMatch(/state\.error/);
  });
});

describe("parseLiveRegistrationState", () => {
  it("accepts the 0217 shape", () => {
    expect(parseLiveRegistrationState({ senders: [SENDER], registrations: [] }, STUDIO)).toEqual({ ok: true, senders: [SENDER], registrations: [], campaignBindings: [], stopPreflights: [] });
  });

  it("refuses a row about a number the sender no longer holds", () => {
    const row = { sender_id: SENDER.id, studio_id: STUDIO, kind: "us_10dlc", status: "approved", missing_information: null, provider_reference: null, updated_at: "x" };
    expect(parseLiveRegistrationState({ senders: [SENDER], registrations: [{ ...row, phone_number: SENDER.phone_number }] }, STUDIO).ok).toBe(true);
    expect(parseLiveRegistrationState({ senders: [SENDER], registrations: [{ ...row, phone_number: "+12125550999" }] }, STUDIO)).toEqual({ ok: false });
    expect(parseLiveRegistrationState({ senders: [SENDER], registrations: [row] }, STUDIO)).toEqual({ ok: false });
  });

  it("refuses anything about another studio, rows of an unknown sender, or a broken shape", () => {
    expect(parseLiveRegistrationState({ senders: [{ ...SENDER, studio_id: "other" }], registrations: [] }, STUDIO)).toEqual({ ok: false });
    expect(parseLiveRegistrationState({ senders: [SENDER], registrations: [{ sender_id: "elsewhere", studio_id: STUDIO, kind: "us_10dlc", status: "approved" }] }, STUDIO)).toEqual({ ok: false });
    expect(parseLiveRegistrationState(null, STUDIO)).toEqual({ ok: false });
    expect(parseLiveRegistrationState({ senders: "x" }, STUDIO)).toEqual({ ok: false });
  });
});

describe("approved means COMPLETE for this number (Codex P2 4253281361)", () => {
  it("the form and its guidance say so", () => {
    const html = render({ ok: true, senders: [SENDER], registrations: [], campaignBindings: [], stopPreflights: [] });
    expect(html).toMatch(/approved: COMPLETE for this number \(brand, campaign and the number registered\)/);
    expect(html).toMatch(/pending: anything not yet complete, including this number(&#x27;|')s own registration/);
    expect(html).toMatch(/only when registration is complete for this exact number/);
  });
});

describe("a replacement sender gets a fresh form (Codex P2 4253596170)", () => {
  // The repo's unit tests run without a DOM; React's documented key semantics
  // (a changed key remounts) do the reset, and this pins that the key exists.
  it("ONE unkeyed stateful panel in every state; only the <form> is keyed, by sender, number and record version (Codex P2 4270957975)", async () => {
    const { readFileSync } = await import("node:fs");
    const strip = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join("\n");
    const section = strip(readFileSync("app/admin/studios/[id]/SmsRegistrationSection.tsx", "utf8"));
    const form = strip(readFileSync("app/admin/studios/[id]/SmsRegistrationForm.tsx", "utf8"));
    // Every return of the section is the same panel; none renders its own <section>.
    const returns = [...section.matchAll(/^\s*return\s+([A-Za-z]+)/gm)].map((m) => m[1]);
    expect(returns).toEqual(["panel", "panel", "panel", "panel"]);
    expect(section).not.toMatch(/<section/);
    // The panel itself is never keyed.
    expect(section).toMatch(/<SmsRegistrationPanel\s+action=/);
    expect(section).not.toMatch(/<SmsRegistrationPanel[^>]*\bkey=/);
    // The state and the result live in the panel; the keyed element is the form.
    const panelAt = form.indexOf("export function SmsRegistrationPanel(");
    const fieldsAt = form.indexOf("function RegistrationForm(");
    expect(form.indexOf("useActionState<")).toBeGreaterThan(panelAt);
    expect(form.indexOf("useActionState<")).toBeLessThan(fieldsAt);
    expect(form.indexOf('data-testid="admin-sms-registration-result"')).toBeGreaterThan(panelAt);
    expect(form.indexOf('data-testid="admin-sms-registration-result"')).toBeLessThan(fieldsAt);
    expect(form).toMatch(/<RegistrationForm key=\{formKey\(target\)\}/);
    expect(form.slice(fieldsAt)).not.toMatch(/useActionState/);
  });

  it("the form key changes with the sender, the number and the record version, and only with them", async () => {
    const { formKey } = await import("@/app/admin/studios/[id]/SmsRegistrationForm");
    const base = { senderId: "s1", phoneNumber: "+12125550123", kindLabel: "k", current: null };
    const rec = { status: "approved", missing_information: null, provider_reference: null, updated_at: "2026-10-14T03:12:45.123456+00:00" };
    const keys = new Set([
      formKey(base),
      formKey({ ...base, senderId: "s2" }),
      formKey({ ...base, phoneNumber: "+12125550124" }),
      formKey({ ...base, current: rec }),
      formKey({ ...base, current: { ...rec, updated_at: "2026-10-14T03:12:45.123457+00:00" } }),
    ]);
    expect(keys.size).toBe(5);
    expect(formKey({ ...base, kindLabel: "other" })).toBe(formKey(base));
    expect(formKey({ ...base, current: { ...rec, status: "suspended" } })).toBe(formKey({ ...base, current: rec }));
  });


});

// Codex P2 4274699533: the kept result must never read as the replacement
// sender's approval.
describe("success names the number it recorded for", () => {
  it("says which number, and says plainly when the studio's number has since changed", async () => {
    const { successText } = await import("@/app/admin/studios/[id]/SmsRegistrationForm");
    expect(successText("+12125550123", "+12125550123")).toBe("Recorded for +12125550123.");
    const moved = successText("+12125550123", "+12125550199");
    expect(moved).toMatch(/^Recorded for \+12125550123\. That is no longer this studio's number; nothing is recorded for the number shown now\.$/);
    expect(moved).not.toContain("+12125550199");
    // The sender released (no live sender, a definite answer).
    expect(successText("+12125550123", null, "no-live-sender")).toMatch(/no longer this studio's number/);
  });

  it("an UNREADABLE or AMBIGUOUS refresh claims nothing about the current number (Codex P2 4275179860)", async () => {
    const { successText } = await import("@/app/admin/studios/[id]/SmsRegistrationForm");
    for (const state of ["unreadable", "ambiguous"]) {
      const text = successText("+12125550123", null, state);
      expect(text, state).toBe("Recorded for +12125550123. The studio's current number could not be confirmed just now; reload to check it.");
      expect(text, state).not.toMatch(/no longer|nothing is recorded/);
    }
    // A definite read still gets the definite answer.
    expect(successText("+12125550123", "+12125550199", "ready")).toMatch(/no longer this studio's number/);
    expect(successText("+12125550123", "+12125550123", "ready")).toBe("Recorded for +12125550123.");
  });

  it("the panel renders success through successText with the number shown now", async () => {
    const { readFileSync } = await import("node:fs");
    const form = readFileSync("app/admin/studios/[id]/SmsRegistrationForm.tsx", "utf8");
    expect(form).toMatch(/state\.ok \? successText\(state\.phoneNumber, target\?\.phoneNumber \?\? null, dataState\)/);
    expect(form).not.toMatch(/state\.ok \? "Recorded\."/);
  });
});
