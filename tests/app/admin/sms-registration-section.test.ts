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
    expect(render({ ok: true, senders: [], registrations: [] })).not.toMatch(/<form/);
    const two = render({ ok: true, senders: [SENDER, { ...SENDER, id: "33333333-3333-4333-8333-333333333333" }], registrations: [] });
    expect(two).toContain('data-state="ambiguous"');
    expect(two).not.toMatch(/<form/);
  });

  it("one live sender with NO record yet: its number is shown, and the form is bound to it", () => {
    const html = render({ ok: true, senders: [SENDER], registrations: [] });
    expect(html).toContain(SENDER.phone_number);
    expect(html).toContain(`name="expected_sender_id" value="${SENDER.id}"`);
    expect(html).toContain(`name="expected_phone_number" value="${SENDER.phone_number}"`);
    expect(html).toContain("Nothing recorded for this number");
    // The messaging service is never rendered.
    expect(html).not.toContain("MGx");
  });

  it("a sender with NO number yet: shown, but no form (Codex P2 4244484021)", () => {
    for (const status of ["off", "selecting", "provisioning"]) {
      const html = render({ ok: true, senders: [{ ...SENDER, status, phone_number: null }], registrations: [] });
      expect(html).toContain('data-state="no-number"');
      expect(html).toContain("not assigned yet");
      expect(html).not.toMatch(/<form|<button/);
    }
  });

  it("the kind is the number's, shown and never chosen (Codex P2 4244484022)", () => {
    const longCode = render({ ok: true, senders: [SENDER], registrations: [] });
    expect(longCode).not.toMatch(/name="kind"/);
    expect(longCode).toMatch(/data-testid="admin-sms-registration-kind">A2P 10DLC/);
    const tollFree = render({ ok: true, senders: [{ ...SENDER, phone_number: "+18885550123" }], registrations: [] });
    expect(tollFree).not.toMatch(/name="kind"/);
    expect(tollFree).toMatch(/data-testid="admin-sms-registration-kind">Toll-free verification/);
    // A number Hone does not serve gets no form at all.
    const other = render({ ok: true, senders: [{ ...SENDER, phone_number: "+18765550123" }], registrations: [] });
    expect(other).toContain('data-state="unsupported-number"');
    expect(other).not.toMatch(/<form/);
  });

  it("an existing record PREFILLS the form, so re-submitting never silently downgrades it (Codex P2 4248698137)", () => {
    const rec = {
      sender_id: SENDER.id, studio_id: STUDIO, phone_number: SENDER.phone_number, kind: "us_10dlc" as const,
      status: "requires_information" as const, missing_information: "a sample message", provider_reference: "CMabc123", updated_at: "x",
    };
    const html = render({ ok: true, senders: [SENDER], registrations: [rec] });
    expect(html).toMatch(/<option value="requires_information" selected="">/);
    expect(html).toContain('name="missing_information" value="a sample message"');
    expect(html).toContain('name="provider_reference" value="CMabc123"');
    expect(html).toContain("Currently recorded: <strong>requires_information</strong>");

    const approved = render({ ok: true, senders: [SENDER], registrations: [{ ...rec, status: "approved", missing_information: null }] });
    expect(approved).toMatch(/<option value="approved" selected="">/);
    expect(approved).not.toMatch(/<option value="pending" selected="">/);
  });

  it("with no record (or only a record of another kind) the defaults apply", () => {
    const none = render({ ok: true, senders: [SENDER], registrations: [] });
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
    expect(parseLiveRegistrationState({ senders: [SENDER], registrations: [] }, STUDIO)).toEqual({ ok: true, senders: [SENDER], registrations: [] });
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
    const html = render({ ok: true, senders: [SENDER], registrations: [] });
    expect(html).toMatch(/approved: COMPLETE for this number \(brand, campaign and the number registered\)/);
    expect(html).toMatch(/pending: anything not yet complete, including this number(&#x27;|')s own registration/);
    expect(html).toMatch(/only when registration is complete for this exact number/);
  });
});

describe("a replacement sender gets a fresh form (Codex P2 4253596170)", () => {
  // The repo's unit tests run without a DOM; React's documented key semantics
  // (a changed key remounts) do the reset, and this pins that the key exists.
  it("a new sender or number is a new form component; a new record VERSION resets the fields but keeps the action result", async () => {
    const { readFileSync } = await import("node:fs");
    const section = readFileSync("app/admin/studios/[id]/SmsRegistrationSection.tsx", "utf8");
    const form = readFileSync("app/admin/studios/[id]/SmsRegistrationForm.tsx", "utf8");
    // The component (which owns useActionState) is keyed by sender and number only.
    expect(section).toMatch(/<SmsRegistrationForm\s+(\/\/[^\n]*\n\s*)*key=\{`\$\{sender\.id\}:\$\{sender\.phone_number\}`\}/);
    expect(section).not.toMatch(/key=\{`[^`]*updated_at/);
    // The record version keys the <form> element inside it (Codex P2 4266543216) ...
    expect(form).toMatch(/<form\s+key=\{current\?\.updated_at \?\? "none"\}\s+action=\{formAction\}/);
    // ... and the result is rendered OUTSIDE that element, by the component
    // that holds the state, so a refresh never discards it (Codex P2 4266641804).
    const formEnd = form.indexOf("</form>");
    const result = form.indexOf('data-testid="admin-sms-registration-result"');
    expect(formEnd).toBeGreaterThan(0);
    expect(result).toBeGreaterThan(formEnd);
    expect(form.indexOf("useActionState")).toBeLessThan(form.indexOf("<form"));
  });

});
