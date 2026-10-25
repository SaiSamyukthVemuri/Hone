import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PracticeDashboardMetrics } from "@/lib/dashboard/practice-metrics";

// HON-44 (b): the dashboard's Service value and Payments cards are owner-only.
// The page asks the loader for money only when the viewer is the owner, and the
// snapshot renders money only when the loader returned it.

vi.mock("@/components/pending-link", () => ({
  PendingLink: ({ children }: { children: unknown }) => children,
}));

const base: Omit<PracticeDashboardMetrics, "money"> = {
  period: "week",
  periodLabel: "this week",
  appointments: {
    total: 2, completed: 1, upcoming: 1, cancelled: 0, noShows: 0, lateCancellations: 0,
  },
  actions: {
    reviewedSessions: 0, incompleteRecords: 0, missingProbeLots: 0,
    aftercareNotMarked: 0, recordsMissingDetails: 0,
  } as PracticeDashboardMetrics["actions"],
  chartedWithin24h: { completedCount: 0, chartedWithin24hCount: 0 },
};

async function render(metrics: PracticeDashboardMetrics): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PracticeSnapshot } = await import("@/app/(app)/dashboard/practice-snapshot");
  return renderToStaticMarkup(
    PracticeSnapshot({ metrics, selectedDay: "2026-10-20", todayLocal: "2026-10-20" }) as never,
  );
}

describe("HON-44 practice snapshot money is owner-only", () => {
  it("renders no service value or payment figures without a money object", async () => {
    const html = await render({ ...base, money: null });
    expect(html).toContain("Appointments this week");
    expect(html).not.toMatch(/Service value|service value|Payments charged|Refunds|\$/);
  });

  it("renders the owner's service value and payment counts", async () => {
    const html = await render({
      ...base,
      money: {
        bookedValueCents: 24000,
        completedValueCents: 12000,
        testPayments: { prepared: 0, charged: 3, refunds: 1 },
      },
    });
    expect(html).toContain("Booked service value");
    expect(html).toContain("$240");
    expect(html).toContain("Test payments charged");
  });

  it("the page requests money only for the owner", () => {
    const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");
    expect(page).toMatch(
      /getPracticeDashboardMetrics\(\s*studio\.id,\s*studio\.timezone,\s*period,\s*\{\s*viewerIsOwner:\s*isOwner,?\s*\}/,
    );
  });
});
