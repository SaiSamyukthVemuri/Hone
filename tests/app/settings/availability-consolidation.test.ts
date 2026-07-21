import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// PR #301 — Settings Availability / Breaks & Blocks consolidation (Chloe pilot
// feedback). The separate "Breaks & blocks" (/settings/calendar) tab is folded
// into the Availability page; recurring breaks + one-off timed blocks now live
// there. Render/IA only — no DB table merge, no booking-slot change, no
// calendar rendering change, no migration.

const root = path.resolve(__dirname, "../../../");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const AVAIL_PAGE = read("app/(app)/settings/availability/page.tsx");
const CAL_PAGE = read("app/(app)/settings/calendar/page.tsx");
const LAYOUT = read("app/(app)/settings/layout.tsx");
const RECURRING = read("app/(app)/settings/availability/RecurringBreaksSection.tsx");
const TIMED = read("app/(app)/settings/availability/TimedBlocksSection.tsx");

describe("Availability is the home for hours, breaks, and blocks", () => {
  it("renders the recurring breaks section", () => {
    expect(AVAIL_PAGE).toMatch(/import \{ RecurringBreaksSection \} from "\.\/RecurringBreaksSection"/);
    expect(AVAIL_PAGE).toMatch(/<RecurringBreaksSection\b/);
    // PR B 3E-5/6: loaded through the migration-order-safe SCOPED loader
    // (replaces getRecurringBreakRules) so Legacy shows studio-wide only.
    expect(AVAIL_PAGE).toMatch(/getScopedRecurringBreakRulesSafe\(supabase, studio\.id/);
  });

  it("renders the timed blocks section", () => {
    expect(AVAIL_PAGE).toMatch(/import \{ TimedBlocksSection \} from "\.\/TimedBlocksSection"/);
    expect(AVAIL_PAGE).toMatch(/<TimedBlocksSection/);
    expect(AVAIL_PAGE).toMatch(/getScopedUpcomingTimedBlocksSafe\(supabase, studio\.id, nowIso/);
  });

  it("keeps the owner-only gate (no behavior loosened)", () => {
    expect(AVAIL_PAGE).toMatch(/practitioner\.role !== "owner"/);
  });

  it("the section components live under availability/ and import the same safe action file", () => {
    expect(
      existsSync(path.join(root, "app/(app)/settings/availability/RecurringBreaksSection.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(root, "app/(app)/settings/availability/TimedBlocksSection.tsx")),
    ).toBe(true);
    // Actions still come from the same centralized availability action file.
    expect(RECURRING).toMatch(/from "\.\/actions"/);
    expect(TIMED).toMatch(/from "\.\/actions"/);
  });

  it("clarifies the four scheduling concepts in copy", () => {
    expect(AVAIL_PAGE).toMatch(/Weekly opening hours/);
    expect(AVAIL_PAGE).toMatch(/Whole-day blocked dates/);
    expect(AVAIL_PAGE).toMatch(/Repeating breaks/);
    expect(AVAIL_PAGE).toMatch(/One-off timed blocks/);
    // The old "live in the Calendar tab" pointer is gone.
    expect(AVAIL_PAGE).not.toMatch(/Calendar tab/);
  });
});

describe("the separate Breaks & blocks tab is removed + the route is safe", () => {
  it("removes the Breaks & blocks nav item", () => {
    expect(LAYOUT).not.toMatch(/Breaks & blocks/);
    expect(LAYOUT).not.toMatch(/"\/settings\/calendar"/);
  });

  it("/settings/calendar redirects to /settings/availability (safe deep link)", () => {
    expect(CAL_PAGE).toMatch(/import \{ redirect \} from "next\/navigation"/);
    expect(CAL_PAGE).toMatch(/redirect\("\/settings\/availability"\)/);
    // The old data-loading / section rendering is gone from the route.
    expect(CAL_PAGE).not.toMatch(/RecurringBreaksSection|TimedBlocksSection|getUpcomingTimedBlocks/);
  });
});

describe("scope guard: no booking-slot / calendar-render / schema change", () => {
  it("does not touch booking-slot logic", () => {
    for (const src of [AVAIL_PAGE, CAL_PAGE, LAYOUT]) {
      expect(src).not.toMatch(/getAvailableSlots|SLOT_GRANULARITY|FALLBACK_GRANULARITY/);
    }
  });

  it("does not touch the calendar grid rendering", () => {
    for (const src of [AVAIL_PAGE, CAL_PAGE]) {
      expect(src).not.toMatch(/\/calendar\/(DayColumn|MonthView)|month-blocked/);
    }
  });

  it("no migration / schema / RLS keyword introduced", () => {
    for (const src of [AVAIL_PAGE, CAL_PAGE, LAYOUT, RECURRING, TIMED]) {
      expect(src).not.toMatch(/alter table|create policy|create table /i);
    }
  });
});
