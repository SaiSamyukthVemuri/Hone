import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ANALYTICS_ACCESS_NOTE, BEYOND_USUAL_NOTE, FIRST_TIME_NOTE, NO_NEXT_BOOKING_NOTE, TREATMENT_CONTEXT_NOTE } from "@/lib/business-analytics/copy";
import { FIGURE_UNAVAILABLE_COPY, figureFrom, unavailableText, type FigureRead } from "@/lib/business-analytics/figure";

describe("a window over the cap makes only that figure unavailable", () => {
  type Overview = { collected: number; lifetime: number; visits: number };
  const reads: { collected: FigureRead<number>; lifetime: FigureRead<number>; visits: FigureRead<number> } = {
    collected: { ok: true, value: 21500 },
    lifetime: { ok: false, reason: "too_many_appointments" },
    visits: { ok: true, value: 4 },
  };
  it("the failing figure says why; the others are untouched; nothing is zero", () => {
    const o = { collected: figureFrom(reads.collected, (x) => x), lifetime: figureFrom(reads.lifetime, (x) => x), visits: figureFrom(reads.visits, (x) => x) };
    expect(o.collected).toEqual({ available: true, value: 21500 });
    expect(o.visits).toEqual({ available: true, value: 4 });
    expect(o.lifetime).toEqual({ available: false, reason: "too_many_appointments" });
    expect(unavailableText("too_many_appointments")).toBe("Unavailable: Too many appointments to summarise this at once.");
    const _typed: Overview | null = null;
    expect(_typed).toBeNull();
  });
  it("every failure reason has words", () => {
    for (const r of ["too_many_appointments", "read_failed", "currency_unknown", "not_reconciled"] as const) expect(FIGURE_UNAVAILABLE_COPY[r].length).toBeGreaterThan(10);
  });
});

describe("fixed copy that must stay true", () => {
  it("the access note says the gate controls who is SHOWN the page and is not a protection on the records", () => {
    expect(ANALYTICS_ACCESS_NOTE).toContain("who is shown");
    expect(ANALYTICS_ACCESS_NOTE).toContain("not a protection on the records");
    expect(ANALYTICS_ACCESS_NOTE).toContain("other practitioners in this studio can still read");
    expect(ANALYTICS_ACCESS_NOTE).toContain("Only payment records are restricted to the owner in the database");
  });
  it("labels say what the data cannot", () => {
    expect(FIRST_TIME_NOTE).toContain("first visit recorded in Hone");
    expect(NO_NEXT_BOOKING_NOTE).toContain("last 12 months");
    expect(BEYOND_USUAL_NOTE).toContain("1.5 times");
    expect(TREATMENT_CONTEXT_NOTE).toContain("how many treatments were recorded and the date of the latest");
  });
});

describe("the analytics modules stay pure (no I/O, no routes, no UI, no studio ids)", () => {
  const dir = path.resolve(__dirname, "../../../lib/business-analytics");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  it("has the modules and nothing else", () => {
    expect(files.sort()).toEqual(["copy.ts", "figure.ts", "money-metrics.ts", "period.ts", "reconcile.ts", "visit-metrics.ts"]);
  });
  for (const f of ["copy.ts", "figure.ts", "money-metrics.ts", "period.ts", "reconcile.ts", "visit-metrics.ts"]) {
    it(`${f} imports no server code, database client, framework or clock`, () => {
      const src = readFileSync(path.join(dir, f), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/server-only|@\/lib\/supabase|from "next|from "react|createClient|\.from\(|fetch\(|process\.env|Date\.now|new Date\(\)/);
      expect(code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no id literal
    });
  }
});
