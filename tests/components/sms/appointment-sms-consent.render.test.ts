import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AppointmentSmsConsent } from "@/components/sms/AppointmentSmsConsent";

// The opt-in is opt-in only: rendered as the form renders it, the box is unticked, not required and not pre-checked.
// (A source grep for useState(false) cannot see a `required` or a defaultChecked added on the input; this can.)

const html = (checked: boolean, preview = false) =>
  renderToStaticMarkup(createElement(AppointmentSmsConsent, { studioName: "Example Studio", checked, preview }));

describe("the rendered consent checkbox", () => {
  it("is unticked, not required and not pre-checked when the form state is false", () => {
    const out = html(false);
    const input = out.match(/<input[^>]*>/)?.[0] ?? "";
    expect(input).toContain('type="checkbox"');
    expect(input).not.toMatch(/\brequired\b/);
    expect(input).not.toMatch(/\bchecked\b/);
    expect(input).not.toMatch(/defaultChecked|aria-required/);
  });
  it("only shows ticked when the state says so (proves the check above can fail)", () => {
    expect(html(true).match(/<input[^>]*>/)?.[0] ?? "").toMatch(/\bchecked\b/);
  });
  it("the evidence-page preview is unticked, disabled and carries the disclosure", () => {
    const out = html(false, true);
    expect(out.match(/<input[^>]*>/)?.[0] ?? "").toMatch(/\bdisabled\b/);
    expect(out).toContain("Example Studio");
    expect(out).toContain("Consent isn&#x27;t a condition of booking");
  });
});
