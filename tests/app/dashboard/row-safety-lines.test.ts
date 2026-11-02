import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RowSafetyLines } from "@/app/(app)/dashboard/row-safety-lines";
import { CLINICAL_UNAVAILABLE_HEADLINE } from "@/components/clinical-unavailable-notice";

// The CLOSED Today row must keep its safety lines visible (Insurance D-1/E-1). Photos could not put the
// failed-read marker on screen in a browser, so it is proved here by rendering the real component.

const html = (p: { pinnedNotes?: { id: string; text: string }[] | null; unavailable?: boolean; caution?: string | null }) =>
  renderToStaticMarkup(createElement(RowSafetyLines, { pinnedNotes: p.pinnedNotes ?? null, unavailable: p.unavailable ?? false, caution: p.caution ?? null }));

describe("RowSafetyLines", () => {
  it("a failed Before-Today read renders the unavailable marker, in the profile's own words", () => {
    const out = html({ unavailable: true });
    expect(out).toContain('data-testid="today-row-unavailable"');
    expect(out).toContain(CLINICAL_UNAVAILABLE_HEADLINE);
    expect(out).not.toContain("today-row-caution");
  });

  it("the marker is not gated on history, caution or pinned notes", () => {
    expect(html({ unavailable: true, caution: null, pinnedNotes: null })).toContain("today-row-unavailable");
    const both = html({ unavailable: true, pinnedNotes: [{ id: "n1", text: "Prefers the afternoon" }] });
    expect(both).toContain("today-row-unavailable");
    expect(both).toContain("Prefers the afternoon");
  });

  it("an answered read renders no marker and, with no caution, no safety line at all (a silent absence is not a claim)", () => {
    const out = html({});
    expect(out).toBe("");
  });

  it("the caution line is rendered in full with its text, and only when there is one", () => {
    const text = "Avoid the jawline and keep the energy low on the upper lip for the whole visit, per the last session";
    const out = html({ caution: text });
    expect(out).toContain('data-testid="today-row-caution"');
    expect(out).toContain(`Caution: ${text}`);
    expect(out).toContain("whitespace-pre-wrap break-words");
    expect(out).not.toContain("today-row-unavailable");
  });

  it("every pinned note is rendered in full, newest first, wrapped (never truncated)", () => {
    const long = "park at the rear entrance and bring the shorter cable for the second appointment of the day";
    const out = html({ pinnedNotes: [{ id: "a", text: long }, { id: "b", text: "second" }] });
    expect(out).toContain(long);
    expect(out.indexOf(long)).toBeLessThan(out.indexOf("second"));
    expect(out).toContain("Pinned");
    expect(out).not.toMatch(/truncate|line-clamp/);
  });

  it("an empty pinned list renders nothing", () => {
    expect(html({ pinnedNotes: [] })).toBe("");
  });
});

describe("compact row layout pins (OPS 1308: plain row ~56-72px at 1280, ~96-120px at 390)", () => {
  const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");
  const row = page.slice(page.indexOf("function AppointmentRow("), page.indexOf("function AppointmentStatusPill("));
  it("the row body, the details disclosure and the Open action share one wrapping row, tight padding", () => {
    expect(row).toMatch(/flex flex-wrap items-start gap-x-3 gap-y-0 py-2 pr-4 lg:items-center/);
    expect(row).not.toMatch(/py-4 pr-4/);
    expect(row).toMatch(/basis-full gap-3 lg:basis-0 lg:flex-1/);
  });
  it("an open disclosure takes the full width below; a closed one sits beside Open", () => {
    expect(row).toMatch(/order-2 open:order-3 open:basis-full lg:order-1 lg:open:order-3/);
    expect(row).toMatch(/order-1 ml-\[5\.75rem\] flex flex-wrap items-center gap-2 lg:order-2 lg:ml-auto lg:justify-end/);
  });
  it("on a phone Open starts at the text column (mobile-ux pins every action's left edge to the body's)", () => {
    // 5.75rem = 80px time cell + 12px gap = the body text column offset from the card's content edge
    expect(row).toMatch(/ml-\[5\.75rem\]/);
    expect(row).not.toMatch(/order-2 ml-auto/);
  });
  it("the intake pill sits on the name line, ahead of the service line", () => {
    expect(row.indexOf("<IntakePill")).toBeGreaterThan(row.indexOf("{nextAction.chip && ("));
    expect(row.indexOf("<IntakePill")).toBeLessThan(row.indexOf("COMPACT ROW: service"));
  });
  it("the disclosure content is indented to the text column (80px time cell + 12px gap + 16px padding)", () => {
    expect(row).toMatch(/flex flex-col gap-1\.5 pb-2 pl-\[5\.75rem\]/);
  });
});
