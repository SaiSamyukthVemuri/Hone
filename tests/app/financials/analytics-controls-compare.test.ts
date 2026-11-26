import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { Controls } from "@/app/(app)/financials/analytics/overview-screen";
import { parseOverviewParams } from "@/lib/business-analytics/overview-params";
import { ALL_PRACTITIONERS } from "@/lib/business-analytics/visit-metrics";

// The shared Analytics controls submit the comparison. A link that arrives with compare=previous_month (the Overview's "Explore analytics" for a chosen
// month) must be RESUBMITTABLE as it is: pressing Show, even after changing only the team member, must not quietly send "preceding".
const REVEAL_CLASS = "group-has-[select[name=period]_option[value^=previous]:checked]:flex";
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
  it("any other range does not offer it as a choice", () => {
    expect(compareSelect(html({ period: "custom", from: "2026-03-02", to: "2026-03-31" }))).not.toContain("previous_month");
    expect(compareSelect(html({}))).not.toContain("previous_month");
  });
  it("the team-member filter is untouched", () => {
    expect(ALL_PRACTITIONERS).toBeDefined();
    expect(html({ period: "custom", from: "2026-03-01", to: "2026-03-31", compare: "previous_month" })).toContain('name="practitioner"');
  });
  it("LAST MONTH: ONE compare field, selected 'The previous calendar month', plus the read-only line the form shows while Period reads Last month", () => {
    const raws: Record<string, string>[] = [{ period: "previous_month", compare: "previous_month" }, { period: "previous_month" }, { period: "previous_month", compare: "preceding" }];
    for (const raw of raws) {
      const h = html(raw);
      // exactly one field named compare, so nothing can be submitted twice, and it submits previous_month
      expect(h.match(/name="compare"/g), JSON.stringify(raw)).toHaveLength(1);
      expect(compareSelect(h)).toContain('<option value="previous_month" selected="">The previous calendar month</option>');
      // the read-only line: text, not a control, and revealed by the form's own :has() rule for the Last month option
      const fixed = /<div[^>]*data-fixed-comparison[\s\S]*?<\/div>/.exec(h)?.[0] ?? "";
      expect(fixed).toContain("Compared with");
      expect(fixed).toContain("The previous calendar month");
      expect(fixed).not.toMatch(/<(select|input)/);
      expect(fixed).toContain(REVEAL_CLASS);
    }
  });
  it("the full selector is the one that is submitted for a Custom range, with every valid choice, so the comparison follows the period chosen", () => {
    const h = html({ period: "custom", from: "2026-03-02", to: "2026-03-20" });
    expect(h.match(/name="compare"/g)).toHaveLength(1);
    expect(compareSelect(h)).toContain('<option value="preceding" selected="">');
    expect(compareSelect(h)).toContain('<option value="last_year">');
    expect(compareSelect(h)).not.toContain("previous_month"); // not one whole month: not offered
  });
});

describe("the reveal rule is a REAL selector once Tailwind has compiled it", () => {
  // A class string in the markup proves nothing: Tailwind turned the underscore in value=previous_month into a space and emitted a rule that never matched,
  // so the read-only line stayed hidden in every browser. Compile the class with Tailwind itself and read the selector it produced.
  it("scopes to the Period select, names the Last month option, and is not mangled", async () => {
    const { compile } = await import("tailwindcss");
    const css = (await compile("@tailwind utilities;")).build([REVEAL_CLASS]);
    expect(css).toContain("select[name=period] option[value^=previous]:checked");
    expect(css).not.toMatch(/:is\(\)|previous month/);
    expect(css).toContain("display: flex");
  });
});

