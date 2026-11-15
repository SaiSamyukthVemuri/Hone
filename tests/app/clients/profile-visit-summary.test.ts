import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: (p: { href: string; className?: string; children?: unknown }) =>
    createElement("a", { href: p.href, className: p.className }, p.children as never),
}));

const { VisitSummary } = await import("@/app/(app)/clients/[id]/_profile/VisitSummary");

type Props = Parameters<typeof VisitSummary>[0];
const base: Props = {
  clientId: "c1",
  lastVisit: null,
  lastChartedAt: null,
  lastChartedSessionId: null,
  next: null,
  timezone: "America/Toronto",
  timeFormat: "12h",
};
const html = (over: Partial<Props> = {}) => renderToStaticMarkup(createElement(VisitSummary, { ...base, ...over }));
const cell = (out: string, id: string) => out.split(`data-testid="${id}"`)[1]!.split("</div>")[0]!;

describe("three distinct values, none replacing another", () => {
  it("shows Last visit, Last charted treatment and Next appointment as separate, labelled values", () => {
    const out = html({
      lastVisit: { kind: "appointment", id: "a9", at: "2026-10-30T15:00:00Z" },
      lastChartedAt: "2026-10-20T15:00:00Z",
      lastChartedSessionId: "s1",
      next: { id: "a10", at: "2026-11-12T15:00:00Z" },
    });
    expect(cell(out, "profile-last-visit")).toContain("October 30, 2026");
    expect(cell(out, "profile-last-charted-treatment")).toContain("October 20, 2026");
    expect(cell(out, "profile-next-appointment")).toContain("November 12, 2026");
    // the last visit (an uncharted appointment) is NOT the last charted treatment
    expect(cell(out, "profile-last-visit")).not.toContain("October 20");
  });
  it("links to the real record of each value", () => {
    const out = html({
      lastVisit: { kind: "session", id: "s7", at: "2026-10-30T15:00:00Z" },
      lastChartedAt: "2026-10-30T15:00:00Z",
      lastChartedSessionId: "s7",
      next: { id: "a10", at: "2026-11-12T15:00:00Z" },
    });
    expect(cell(out, "profile-last-visit")).toContain('href="/clients/c1/sessions/s7"');
    expect(cell(out, "profile-next-appointment")).toContain('href="/calendar/a10"');
    expect(html({ lastVisit: { kind: "appointment", id: "a9", at: "2026-10-30T15:00:00Z" } })).toContain('href="/calendar/a9"');
  });
  it("a value that does not exist says so, and the others still render", () => {
    const out = html({ next: { id: "a10", at: "2026-11-12T15:00:00Z" } });
    expect(cell(out, "profile-last-visit")).toContain("No visit recorded in Hone");
    expect(cell(out, "profile-last-charted-treatment")).toContain("Not recorded");
    expect(cell(out, "profile-next-appointment")).toContain("November 12, 2026");
    expect(cell(html(), "profile-next-appointment")).toContain("None booked");
  });
});

describe("an unavailable charted-treatment read is not an empty one", () => {
  it("failed read: Last charted treatment says Unavailable, never Not recorded; the other values are unaffected", () => {
    const out = html({ lastChartedUnavailable: true, next: { id: "a10", at: "2026-11-12T15:00:00Z" } });
    expect(cell(out, "profile-last-charted-treatment")).toContain("Unavailable");
    expect(cell(out, "profile-last-charted-treatment")).not.toContain("Not recorded");
    expect(cell(out, "profile-last-visit")).toContain("No visit recorded in Hone");
    expect(cell(out, "profile-next-appointment")).toContain("November 12, 2026");
  });
  it("genuinely empty (read succeeded): Not recorded", () => {
    const out = html({ lastChartedUnavailable: false });
    expect(cell(out, "profile-last-charted-treatment")).toContain("Not recorded");
    expect(cell(out, "profile-last-charted-treatment")).not.toContain("Unavailable");
  });
  it("a loaded value wins over the flag", () => {
    const out = html({ lastChartedUnavailable: true, lastChartedAt: "2026-10-20T15:00:00Z", lastChartedSessionId: "s1" });
    expect(cell(out, "profile-last-charted-treatment")).toContain("October 20, 2026");
  });
  it("the page passes the clinical-history flag", () => {
    const page = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
    expect(page).toMatch(/lastChartedUnavailable=\{clinicalHistoryUnavailable\}/);
  });
});

describe("dates are STUDIO time, not the viewer's clock", () => {
  it("23:30 Toronto on Oct 30 is Oct 31 in UTC, and renders as Oct 30 in Toronto but Oct 31 in Tokyo", () => {
    const at = "2026-10-31T03:30:00Z"; // 23:30 on Oct 30 in Toronto (EDT, UTC-4)
    const toronto = html({ lastVisit: { kind: "session", id: "s1", at }, timezone: "America/Toronto" });
    const tokyo = html({ lastVisit: { kind: "session", id: "s1", at }, timezone: "Asia/Tokyo" });
    expect(cell(toronto, "profile-last-visit")).toContain("October 30, 2026");
    expect(cell(toronto, "profile-last-visit")).toContain("11:30 PM");
    expect(cell(tokyo, "profile-last-visit")).toContain("October 31, 2026");
  });
  it("honours the studio's 24-hour display choice", () => {
    const out = html({ lastVisit: { kind: "session", id: "s1", at: "2026-10-30T19:05:00Z" }, timeFormat: "24h" });
    expect(cell(out, "profile-last-visit")).toContain("15:05");
  });
});

describe("the page wires the visits read once, for Overview only, and nothing is written", () => {
  it("one bounded read, gated to Overview, one shared instant", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
    expect((page.match(/getOverviewVisitAppointments\(/g) ?? []).length).toBe(1);
    expect(page).toMatch(/isOverview\s*\?\s*getOverviewVisitAppointments\(/);
    expect(page).toContain("const visitNowMs = Date.now();");
    const src = readFileSync("lib/clients/profile-appointments.ts", "utf8");
    expect(src).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
    expect((src.match(/\.limit\(1\)/g) ?? []).length).toBe(2);
  });
});
