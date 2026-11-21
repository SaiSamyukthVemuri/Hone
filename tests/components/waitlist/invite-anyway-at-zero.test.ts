import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BEYOND_ESTIMATE_CONFIRM_TEXT, BeyondEstimateConfirm, beyondEstimateSubmitStep } from "@/components/waitlist/invite-composer";
import { COMPOSER_FIELD_NAMES, inviteSubmissionFromFormData } from "@/lib/waitlist/b4-invitation-draft";

// "Invite anyway" when the estimate says no consultation availability remains. This repo has no jsdom, so a click cannot be dispatched here: the
// decision a press makes is a pure function the form calls, proved directly, and the confirmation is proved by rendering it. The real clicks run in the
// browser suite.

const SRC = readFileSync(join(__dirname, "..", "..", "..", "components/waitlist/invite-composer.tsx"), "utf8");

describe("what a press does at an estimate of zero", () => {
  it("Send asks first, and so does an Enter key that submits through it or a submission with no known button", () => {
    expect(beyondEstimateSubmitStep({ atZero: true, via: "composer-send" })).toBe("ask");
    expect(beyondEstimateSubmitStep({ atZero: true, via: null })).toBe("ask");
    expect(beyondEstimateSubmitStep({ atZero: true, via: undefined })).toBe("ask");
    expect(beyondEstimateSubmitStep({ atZero: true, via: "anything-else" })).toBe("ask");
  });
  it("only the explicit Invite anyway (and the composer's own Cancel) go through at zero", () => {
    expect(beyondEstimateSubmitStep({ atZero: true, via: "composer-invite-anyway" })).toBe("send");
    expect(beyondEstimateSubmitStep({ atZero: true, via: "composer-cancel" })).toBe("send");
  });
  it("above zero, or with no estimate, every submission goes through exactly as before", () => {
    for (const via of ["composer-send", null, undefined, "composer-invite-anyway", "composer-cancel"]) {
      expect(beyondEstimateSubmitStep({ atZero: false, via })).toBe("send");
    }
  });
  it("the form asks through that function and the confirmation is only opened when it says ask", () => {
    expect(SRC).toMatch(/beyondEstimateSubmitStep\(\{ atZero, via \}\) === "ask"/);
    expect(SRC).toMatch(/atZero = capacity\.status === "ok" && capacity\.open === 0/);
  });
});

describe("the confirmation", () => {
  const html = renderToStaticMarkup(createElement(BeyondEstimateConfirm, { disabled: false, onCancel: () => {} }));
  it("says exactly the agreed words", () => {
    expect(BEYOND_ESTIMATE_CONFIRM_TEXT).toBe("No estimated consultation availability remains. Invite this person anyway? They may find no appointments available.");
    expect(html).toContain(BEYOND_ESTIMATE_CONFIRM_TEXT);
  });
  it("has exactly two buttons: Cancel (sends nothing) and Invite anyway (submits the one explicit field)", () => {
    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    const anyway = buttons.find((b) => b.includes("composer-invite-anyway")) ?? "";
    expect(anyway).toContain('type="submit"');
    expect(anyway).toContain(`name="${COMPOSER_FIELD_NAMES.allowBeyondEstimate}"`);
    expect(anyway).toContain('value="true"');
    expect(anyway).toContain(">Invite anyway<");
    const cancel = buttons.find((b) => b.includes("composer-beyond-cancel")) ?? "";
    expect(cancel).toContain('type="button"');
    expect(cancel).not.toContain("name=");
    expect(cancel).toContain(">Cancel<");
  });
  it("both buttons are disabled while the send is in flight, so a double press cannot send twice", () => {
    expect(SRC).toMatch(/disabled=\{disabled \|\| pending\}\s+data-testid="composer-invite-anyway"/);
    expect(SRC).toMatch(/onClick=\{onCancel\}\s+disabled=\{pending\}/);
  });
  it("Invite anyway is withheld while the send is not operable", () => {
    const off = renderToStaticMarkup(createElement(BeyondEstimateConfirm, { disabled: true, onCancel: () => {} }));
    expect((off.match(/<button[^>]*composer-invite-anyway[^>]*>/)?.[0] ?? "")).toContain("disabled");
  });
});

describe("the override field", () => {
  const form = (extra: Record<string, string>) => {
    const f = new FormData();
    f.set("entry_id", "e1");
    f.set("service_id", "s1");
    f.set("allowed_days_preset", "every");
    f.set("window_days", "14");
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };
  const read = (extra: Record<string, string>) => {
    const r = inviteSubmissionFromFormData(form(extra));
    if (!r.ok) throw new Error("unreadable");
    return r.submission.beyondEstimate;
  };
  it("is true only for exactly the text true", () => {
    expect(read({ [COMPOSER_FIELD_NAMES.allowBeyondEstimate]: "true" })).toBe(true);
    for (const v of ["True", "TRUE", "1", "on", "yes", "false", "", " true"]) expect(read({ [COMPOSER_FIELD_NAMES.allowBeyondEstimate]: v })).toBe(false);
  });
  it("is false when the field is absent", () => {
    expect(read({})).toBe(false);
  });
});
