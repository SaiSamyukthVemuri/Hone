import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

const { SummaryStrip } = await import("@/app/(app)/dashboard/summary-strip");
const { computeTimeInsights, formatInsightHours, insightPeriod } = await import("@/lib/calendar/time-insights");

const ALL = { mode: "all" as const, ids: new Set<string>() };
const day = insightPeriod(new Date("2026-11-02T05:00:00Z"), new Date("2026-11-03T05:00:00Z"));

describe("summary strip (fidelity A)", () => {
  it("renders the three labelled values", () => {
    const out = renderToStaticMarkup(
      createElement(SummaryStrip, { appointmentCount: 4, bookedTime: "5 h 30 min", clientsToReview: "7" }),
    );
    expect(out).toContain("Appointments");
    expect(out).toContain("Booked time");
    expect(out).toContain("Clients to review");
    expect(out).toContain('data-testid="summary-appointments-value">4<');
    expect(out).toContain("5 h 30 min");
  });
  it("booked time is the calendar definition: cancelled excluded, only minutes inside the day", () => {
    const m = computeTimeInsights({
      appointments: [
        { id: "a", status: "scheduled", starts_at: "2026-11-02T15:00:00Z", ends_at: "2026-11-02T16:30:00Z", practitioner_id: null },
        { id: "b", status: "cancelled", starts_at: "2026-11-02T17:00:00Z", ends_at: "2026-11-02T19:00:00Z", practitioner_id: null },
        { id: "c", status: "completed", starts_at: "2026-11-02T20:00:00Z", ends_at: "2026-11-02T21:00:00Z", practitioner_id: null },
      ],
      period: day,
      selection: ALL,
    });
    expect(m).toEqual({ minutes: 150, count: 2 });
    expect(formatInsightHours(m.minutes)).toBe("2 h 30 min");
  });
});

describe("Clients to review comes from the Needs attention model", () => {
  const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
  const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");
  it("one builder serves the panel and the strip, and the strip reads .clients.length", () => {
    expect(stack).toMatch(/async function resolveNeedsAttentionInput\(/);
    expect(stack).toMatch(/needs=\{buildNeedsAttention\(await resolveNeedsAttentionInput\(props\)\)\}/);
    expect(stack).toMatch(/buildNeedsAttention\(await resolveNeedsAttentionInput\(props\)\)\.clients\.length/);
    expect(page).toMatch(/<ClientsToReview\b/);
  });
  it("a failed read says Unavailable, never 0", async () => {
    const mod = await import("@/app/(app)/dashboard/secondary-stack");
    const { ClientsToReview } = mod;
    const rejected = Promise.reject(new Error("x"));
    rejected.catch(() => undefined);
    const wrapper = ClientsToReview({
      attentionSources: rejected as never,
      staffManaged: Promise.resolve(false),
      procedureActions: rejected as never,
      upcomingVisitClients: rejected as never,
      clientsNeedingAttention: rejected as never,
      followUpAssistant: rejected as never,
      expiringSupplies: rejected as never,
      isOwner: true,
      todayLocal: "2026-11-02",
    });
    // the wrapper is a Suspense around the async value; resolve the async child directly
    const child = (wrapper.props as { children: { type: (p: unknown) => Promise<unknown>; props: unknown } }).children;
    const out = renderToStaticMarkup((await child.type(child.props)) as never);
    expect(out).toContain("Unavailable");
    expect(out).not.toMatch(/>0</);
  });
});
