import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { Controls } from "@/app/(app)/financials/analytics/overview-screen";
import { parseOverviewParams } from "@/lib/business-analytics/overview-params";
import { ALL_PRACTITIONERS } from "@/lib/business-analytics/visit-metrics";

// The shared Analytics controls submit the comparison. A link that arrives with compare=previous_month (the Overview's "Explore analytics" for a chosen
// month) must be RESUBMITTABLE as it is: pressing Show, even after changing only the team member, must not quietly send "preceding".
const params = (raw: Record<string, string>) => {
  const r = parseOverviewParams(raw, { strict: false, practitionerIds: new Set() });
  if (!r.ok) throw new Error("bad");
  return r.params;
};
const html = (raw: Record<string, string>) => renderToStaticMarkup(Controls({ params: params(raw), options: [] }) as never);
const compareSelect = (h: string) => /<select name="compare"[\s\S]*?<\/select>/.exec(h)?.[0] ?? "";

describe("Analytics controls: the comparison survives Show", () => {
  it("arriving with compare=previous_month on one whole month: the option is there AND selected, so Show resubmits it", () => {
    const sel = compareSelect(html({ period: "custom", from: "2026-03-01", to: "2026-03-31", compare: "previous_month" }));
    expect(sel).toContain('<option value="previous_month" selected="">The previous calendar month</option>');
  });
  it("one whole month without it: offered, not selected (the default stays 'The period just before')", () => {
    const sel = compareSelect(html({ period: "custom", from: "2026-03-01", to: "2026-03-31" }));
    expect(sel).toContain('<option value="previous_month">The previous calendar month</option>');
    expect(sel).toContain('<option value="preceding" selected="">');
  });
  it("any other range does not offer it", () => {
    expect(compareSelect(html({ period: "custom", from: "2026-03-02", to: "2026-03-31" }))).not.toContain("previous_month");
    expect(compareSelect(html({}))).not.toContain("previous_month");
  });
  it("the team-member filter is untouched", () => {
    expect(ALL_PRACTITIONERS).toBeDefined();
    expect(html({ period: "custom", from: "2026-03-01", to: "2026-03-31", compare: "previous_month" })).toContain('name="practitioner"');
  });
});
