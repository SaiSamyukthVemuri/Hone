import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// SMS-SENDER-REG-01: the operator's form exists only over a readable snapshot
// with exactly one live sender, shows that sender's number before any record,
// and carries that sender's id (Codex P2 4244108801, 4244108809, 4244108814).

vi.mock("@/app/admin/studios/[id]/actions", () => ({ recordSmsRegistrationAction: async () => ({ ok: true }) }));

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
    expect(html).toContain("Nothing recorded for this number");
    // The messaging service is never rendered.
    expect(html).not.toContain("MGx");
  });
});

describe("parseLiveRegistrationState", () => {
  it("accepts the 0217 shape", () => {
    expect(parseLiveRegistrationState({ senders: [SENDER], registrations: [] }, STUDIO)).toEqual({ ok: true, senders: [SENDER], registrations: [] });
  });

  it("refuses anything about another studio, rows of an unknown sender, or a broken shape", () => {
    expect(parseLiveRegistrationState({ senders: [{ ...SENDER, studio_id: "other" }], registrations: [] }, STUDIO)).toEqual({ ok: false });
    expect(parseLiveRegistrationState({ senders: [SENDER], registrations: [{ sender_id: "elsewhere", studio_id: STUDIO, kind: "us_10dlc", status: "approved" }] }, STUDIO)).toEqual({ ok: false });
    expect(parseLiveRegistrationState(null, STUDIO)).toEqual({ ok: false });
    expect(parseLiveRegistrationState({ senders: "x" }, STUDIO)).toEqual({ ok: false });
  });
});
