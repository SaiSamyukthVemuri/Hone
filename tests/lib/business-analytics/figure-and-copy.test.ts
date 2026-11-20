import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ANALYTICS_ACCESS_NOTE, FIRST_TIME_NOTE, INTERVAL_NOTE, TREATMENT_CONTEXT_NOTE, beyondUsualNote, noNextBookingNote } from "@/lib/business-analytics/copy";
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
    for (const r of ["too_many_appointments", "read_failed", "currency_unknown", "not_reconciled", "no_evidence_read"] as const) expect(FIGURE_UNAVAILABLE_COPY[r].length).toBeGreaterThan(10);
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
    expect(INTERVAL_NOTE).toContain("With a team-member filter, only that team member's visits are used.");
    expect(FIRST_TIME_NOTE).toContain("first visit recorded in Hone");
    expect(noNextBookingNote(12)).toContain("last 12 months");
    expect(noNextBookingNote()).not.toMatch(/last \d+ month/); // no look-back in use, none named
    expect(beyondUsualNote(1.5)).toContain("1.5 times");
    expect(TREATMENT_CONTEXT_NOTE).toContain("how many treatments were recorded and the date of the latest");
  });
});

const MODULES = ["chart-geometry.ts", "copy.ts", "figure.ts", "money-format.ts", "money-metrics.ts", "overview-csv.ts", "overview-model.ts", "overview-params.ts", "period.ts", "reconcile.ts", "reconciliation-line.ts", "service-value.ts", "visit-metrics.ts"];

describe("the analytics server folder is the only place that reads", () => {
  it("holds the one loader, which is owner-gated first and never writes or uses a service role", () => {
    const dir = path.resolve(__dirname, "../../../lib/business-analytics/server");
    expect(readdirSync(dir).sort()).toEqual(["overview-read.ts"]);
    const code = readFileSync(path.join(dir, "overview-read.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/if \(practitioner\.role !== "owner"\) return \{ access: "refused" \};\n  const supabase/);
    expect(code).not.toMatch(/service_role|createServiceClient|admin|\.(insert|update|upsert|delete|rpc)\(|appointment_payments|price_cents/);
  });
});

describe("the analytics modules stay pure (no I/O, no routes, no UI, no studio ids)", () => {
  const dir = path.resolve(__dirname, "../../../lib/business-analytics");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  it("has the modules and nothing else", () => {
    expect(files.sort()).toEqual(MODULES);
  });
  for (const f of MODULES) {
    it(`${f} imports no server code, database client, framework or clock`, () => {
      const src = readFileSync(path.join(dir, f), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/server-only|@\/lib\/supabase|from "next|from "react|createClient|\.from\(|fetch\(|process\.env|Date\.now|new Date\(\)/);
      expect(code).not.toMatch(/services\.price_cents|price_cents/); // a past visit is never priced from today's list
      expect(src).not.toMatch(/revenue|by payment date/i); // neither money figure is ever called revenue or "by payment date"
      expect(code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no id literal
    });
  }
});
