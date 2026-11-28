import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecipientChooser } from "@/components/waitlist/recipient-chooser";
import type { Candidate } from "@/lib/waitlist/recipient-chooser";

const many = (n: number): Candidate[] => Array.from({ length: n }, (_, i) => ({ entryId: `e${i}`, name: `Person ${i}` }));
const render = (n: number, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RecipientChooser, { candidates: many(n), ...props }));

describe("RecipientChooser", () => {
  it("5,000 candidates render one bounded page of checkboxes, not 5,000", () => {
    const h = render(5000);
    expect((h.match(/type="checkbox"/g) ?? []).length).toBe(50);
    expect(h).toContain("1–50 of 5000");
  });
  it("selects nobody by default and posts no ids until someone is chosen", () => {
    const h = render(200);
    expect(h).not.toMatch(/name="entryId"/);
    expect(h).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(h).toContain("0 selected in all");
  });
  it("posts EVERY initially selected id as a hidden entryId, including ones that are not on the rendered page", () => {
    const ids = Array.from({ length: 3000 }, (_, i) => `e${i}`);
    const h = render(5000, { initialSelected: ids });
    expect((h.match(/type="hidden" name="entryId"/g) ?? []).length).toBe(3000);
    expect((h.match(/type="checkbox"[^>]*checked/g) ?? []).length).toBe(50);
    expect(h).toContain("3000 selected in all");
  });
  it("offers search, page and select controls that cannot submit the form", () => {
    const h = render(200);
    expect(h).toContain('type="search"');
    expect(h).toContain("Select all 200 listed");
    const buttons = h.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    expect(buttons.every((b) => b.includes('type="button"'))).toBe(true);
  });
  it("Previous is disabled on the first page and Next on the last, and an empty list says so", () => {
    const first = render(200);
    expect(first).toMatch(/<button[^>]*\sdisabled=""[^>]*>Previous/);
    expect(first).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Next/);
    const one = render(10);
    expect(one).toMatch(/<button[^>]*\sdisabled=""[^>]*>Next/);
    expect(render(0)).toContain("No one matches that search.");
  });
  it("a small list needs no cap and renders everyone", () => {
    expect((render(7).match(/type="checkbox"/g) ?? []).length).toBe(7);
  });
  it("the search box opts out of browser autofill, so names typed here are not remembered by the browser", () => {
    expect(render(10)).toMatch(/<input[^>]*type="search"[^>]*autoComplete="off"|<input[^>]*autoComplete="off"[^>]*type="search"/i);
  });
});
