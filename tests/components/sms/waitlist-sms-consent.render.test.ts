import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WaitlistSmsConsentFieldset } from "@/components/sms/WaitlistSmsConsentFieldset";
import { SMS_CONSENT_ANSWER_NO, SMS_CONSENT_ANSWER_YES, SMS_JOIN_CONSENT_QUESTION } from "@/lib/waitlist/prospect-sms-consent";

const html = (answer: "yes" | "no" | null, preview = false) =>
  renderToStaticMarkup(createElement(WaitlistSmsConsentFieldset, { questionId: "q", answer, preview }));

describe("the rendered waitlist text-message question", () => {
  it("has two answers, neither selected, and the stored v2 question verbatim", () => {
    const out = html(null);
    expect(out.match(/<input[^>]*>/g)?.length).toBe(2);
    for (const i of out.match(/<input[^>]*>/g) ?? []) {
      expect(i).not.toMatch(/\bchecked\b/);
      expect(i).not.toMatch(/\brequired\b/);
    }
    expect(out).toContain(SMS_JOIN_CONSENT_QUESTION.replace(/'/g, "&#x27;"));
    expect(out).toContain('value="yes"');
    expect(out).toContain('value="no"');
  });
  it("only shows a selection when the state says so (proves the check can fail)", () => {
    expect(html(SMS_CONSENT_ANSWER_YES)).toMatch(/value="yes"[^>]*checked|checked[^>]*value="yes"/);
    expect(html(SMS_CONSENT_ANSWER_NO)).toContain("We&#x27;ll email you instead");
  });
  it("carries the notice and both policy links", () => {
    const out = html(null);
    expect(out).toContain("Msg &amp; data rates may apply");
    expect(out).toContain('href="/sms-terms"');
    expect(out).toContain('href="/privacy#appointment-text-messages"');
  });
  it("the evidence-page preview is disabled and submits nothing (no field name)", () => {
    const out = html(null, true);
    for (const i of out.match(/<input[^>]*>/g) ?? []) {
      expect(i).toMatch(/\bdisabled\b/);
      expect(i).not.toMatch(/name=/);
    }
  });
});
