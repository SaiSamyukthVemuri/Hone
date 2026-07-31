import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { timeRangeLabel } from "@/app/(app)/calendar/calendar-format";
import { serviceCardClasses } from "@/lib/calendar/service-colors";

// PR — calendar appointment card visual refresh (Fresha used only as a
// readability benchmark, not copied). Stronger-but-calm fills, a visible time
// range, and a clear time → name → service hierarchy. Render-only: no booking
// logic, no query/data/migration, no positioning-math change.

const root = path.resolve(__dirname, "../../../");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");
const COLORS = read("lib/calendar/service-colors.ts");

describe("timeRangeLabel", () => {
  it("formats a clean 24h range, leading zero stripped, en dash", () => {
    expect(timeRangeLabel("09:00", "10:00")).toBe("9:00–10:00");
    expect(timeRangeLabel("14:15", "15:30")).toBe("14:15–15:30");
  });
  it("falls back to just the start when the end is missing/blank", () => {
    expect(timeRangeLabel("09:00", null)).toBe("9:00");
    expect(timeRangeLabel("09:00", "")).toBe("9:00");
    expect(timeRangeLabel("09:00", undefined)).toBe("9:00");
  });
});

describe("appointment card renders a time range + hierarchy", () => {
  it("computes and renders a visible time range", () => {
    // Migration 0109: the displayed range honors the studio 12h/24h preference
    // (dispStart/dispEnd via formatTimeForStudio); positioning still uses the
    // 24h localTime. See tests/app/settings/time-format-preference.test.ts.
    expect(DAYCOL).toMatch(/const timeRange = timeRangeLabel\(dispStart, dispEnd\)/);
    expect(DAYCOL).toMatch(/\{timeRange\}/);
    // Range is derived from the existing row (starts_at + ends_at), not new data.
    expect(DAYCOL).toMatch(/a\.ends_at\s*\n?\s*\?\s*formatTimeForStudio\(new Date\(a\.ends_at\), tz, timeFormat\)/);
  });

  it("keeps the client name prominent (bold, its own line in the tall card)", () => {
    expect(DAYCOL).toMatch(/<div className="truncate font-semibold">\{clientName\}<\/div>/);
  });

  it("shows service/modality on its OWN line (not mushed with time)", () => {
    expect(DAYCOL).toMatch(/serviceName && \(\s*\n?\s*<div className="truncate text-\[10px\] opacity-70">\s*\n?\s*\{serviceName\}/);
  });

  it("keeps the terminal/cancelled dim; the card opens the in-context preview", () => {
    expect(DAYCOL).toMatch(/terminal \? "opacity-60" : ""/);
    // PR C-lite: the appointment card is a button that opens the preview drawer
    // (no navigation); the /calendar/[id] deep link lives in the preview.
    expect(DAYCOL).toMatch(/onClick=\{\(\) => setPreview\(a\)\}/);
  });
});

describe("stronger-but-calm fills + accent", () => {
  it("the APPOINTMENT card uses a clearer left accent (border-l-4)", () => {
    // Pin the appointment card className specifically (blocked-time cards keep
    // their own border treatment).
    // 0153: the card now renders the SERVICE's persisted calendar_color via the
    // canonical appointmentCardClasses(service) helper (was the id-hash serviceCardClasses).
    expect(DAYCOL).toMatch(/border-l-4 \$\{appointmentCardClasses\(/);
  });

  it("palette is deepened off the ultra-pale -50 default", () => {
    // No appointment fill uses the old bg-*-50; the new default is bg-*-100.
    expect(COLORS).not.toMatch(/bg-(amber|emerald|teal|sky|indigo|violet)-50\b/);
    expect(COLORS).toMatch(/bg-amber-100/);
    expect(COLORS).toMatch(/border-l-amber-500/);
  });

  it("STILL excludes the rose/red family (allergy/EpiPen reservation holds)", () => {
    expect(COLORS).not.toMatch(/\brose-/);
    expect(COLORS).not.toMatch(/bg-red-/);
  });

  it("service color remains deterministic + stable (hash unchanged)", () => {
    const a = serviceCardClasses("svc-abc", "Electrolysis");
    const b = serviceCardClasses("svc-abc", "Electrolysis");
    expect(a).toBe(b); // same id → same color
    // 0161 deepened emerald/indigo (and added orange/lime/fuchsia/slate) so the
    // hue-adjacent pairs Chloe could not tell apart now differ in LIGHTNESS too;
    // the legacy id hash is still bounded to the ORIGINAL six families.
    expect(a).toMatch(/^bg-(amber|emerald|teal|sky|indigo|violet)-(100|200) /);
    // deleted/unknown service → the unchanged neutral fallback
    expect(serviceCardClasses(null, null)).toMatch(/^bg-neutral-100 /);
  });
});

describe("scope guard: render-only", () => {
  it("does not touch booking-slot logic, queries, or migrations", () => {
    const code = codeOnly(DAYCOL) + "\n" + codeOnly(COLORS);
    expect(code).not.toMatch(/getAvailableSlots|SLOT_GRANULARITY/);
    expect(code).not.toMatch(/\.from\("|\.select\(|supabase/);
    expect(code).not.toMatch(/alter table|create table |add column/i);
  });

  it("does not copy Fresha branding/assets", () => {
    // Strip // comments (which may reference Fresha as the readability
    // benchmark) — the rendered code must carry no Fresha asset/brand strings.
    expect(codeOnly(DAYCOL)).not.toMatch(/fresha/i);
    expect(codeOnly(COLORS)).not.toMatch(/fresha/i);
  });
});
