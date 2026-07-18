import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WALKTHROUGH } from "@/lib/marketing/content";

// Demo + analytics guards (stage 7): "Request" not "Book", concise form, no
// phone field, a success state that explains the real manual follow-up, and
// analytics that send event NAMES ONLY — never name/email/studio/free text/
// tokens/client data.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const PAGE = read("app/demo/page.tsx");
const FORM = read("app/_components/DemoForm.tsx");
const DELEGATOR = read("app/_components/marketing/MarketingAnalytics.tsx");
const SURFACE = stripComments(PAGE + "\n" + FORM).replace(/\s+/g, " ");

describe("demo: request, not book", () => {
  it("resolves the CTA to a Request (lead-capture flow)", () => {
    expect(WALKTHROUGH.submitLabel.toLowerCase()).toContain("request");
    expect(WALKTHROUGH.submitLabel.toLowerCase()).not.toContain("book");
  });

  it("uses no 'Book … walkthrough' language anywhere on the demo surface", () => {
    expect(SURFACE).not.toMatch(/Book (a|the|your|my)[^.]*walkthrough/i);
    expect(SURFACE).not.toMatch(/Book a 15-minute/i);
  });

  it("wires the new shell + metadata + request heading", () => {
    expect(PAGE).toMatch(/marketingMetadata\("\/demo"\)/);
    expect(PAGE).toMatch(/SiteHeader/);
    expect(PAGE).toMatch(/WALKTHROUGH\.demoHeading/);
  });
});

describe("demo form: concise, no phone, honest success", () => {
  it("has no phone field", () => {
    expect(FORM).not.toMatch(/type="tel"/);
    expect(FORM).not.toMatch(/\bphone\b/i);
  });

  it("uses the shared submit label + success message", () => {
    expect(FORM).toMatch(/WALKTHROUGH\.submitLabel/);
    expect(FORM).toMatch(/WALKTHROUGH\.successMessage/);
  });

  it("success state explains the real manual follow-up", () => {
    expect(FORM).toMatch(/no automatic booking/i);
    expect(FORM).toMatch(/real person will email you/i);
  });
});

describe("analytics: event names only, no PII", () => {
  it("fires form-started and form-submitted events", () => {
    expect(FORM).toMatch(/track\(ANALYTICS_EVENTS\.walkthroughFormStarted\)/);
    expect(FORM).toMatch(/track\(ANALYTICS_EVENTS\.walkthroughFormSubmitted\)/);
  });

  it("never passes field values / PII into track()", () => {
    // Every track(...) call in the form takes a single event-name argument.
    const calls = FORM.match(/track\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c).toMatch(/track\(ANALYTICS_EVENTS\.[a-zA-Z]+\)/);
      expect(c).not.toMatch(/values|\.name|\.email|\.notes|\.practice|\.location|\.current_tool/);
    }
  });

  it("the click delegator sends only the data-event attribute name", () => {
    expect(DELEGATOR).toMatch(/getAttribute\("data-event"\)/);
    expect(DELEGATOR).toMatch(/if \(name\) track\(name\)/);
    // No PII/DOM-text harvesting (scan code, not the explanatory comment).
    const code = stripComments(DELEGATOR);
    expect(code).not.toMatch(/textContent|innerText|\.value\b|email|name=/);
  });
});
