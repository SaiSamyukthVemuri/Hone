import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatTimeForStudio } from "@/lib/booking/tz";

// Mobile calendar redesign: a separate single-day timeline replaces the
// sideways-scrollable 7-day week grid on small screens; desktop week/month is
// unchanged. Behavior is structural (client components + router); these lock the
// shape + the reuse invariants (no new booking/block action, no divergent query,
// studio tz + 12h/24h preserved).
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const PAGE = read("app/(app)/calendar/page.tsx");
const MOBILE = read("app/(app)/calendar/CalendarMobileDayView.tsx");
const TIMELINE = read("app/(app)/calendar/MobileDayTimeline.tsx");

describe("mobile renders a single day, not the 7-day week grid", () => {
  it("mounts the mobile day view; desktop grid is now md-only", () => {
    expect(PAGE).toMatch(/<CalendarMobileDayView/);
    expect(MOBILE).toMatch(/className="md:hidden"/);
    expect(PAGE).toMatch(/hidden max-h-\[calc\(100dvh-13rem\)\][^"]*md:block/);
  });
  it("renders ONE MobileDayTimeline (a single day), never 7 DayColumns", () => {
    expect(MOBILE).toMatch(/<MobileDayTimeline/);
    expect(MOBILE).not.toMatch(/<DayColumn/);
  });
  it("has NO horizontal week-grid panning: one vertical scroll, no overflow-x / min-w week grid", () => {
    expect(MOBILE).toMatch(/overflow-y-auto overscroll-contain/);
    expect(MOBILE).not.toMatch(/overflow-x/);
    expect(TIMELINE).not.toMatch(/overflow-x|min-w-\[840px\]|grid-cols-\[60px_repeat\(7/);
  });
  it("reuses the SAME loaded week data (no divergent query)", () => {
    expect(PAGE).toMatch(/const mobileDays: MobileDayData\[\]/);
    expect(PAGE).toMatch(/appts: byDate\.get\(date\)/);
    expect(PAGE).toMatch(/timedBlocks: timedBlocksByDate\.get\(date\)/);
  });
});

describe("mobile navigation: today / prev day / next day / week strip", () => {
  it("exposes Today, previous-day and next-day controls", () => {
    expect(MOBILE).toMatch(/onClick=\{goToday\}/);
    expect(MOBILE).toMatch(/aria-label="Previous day"/);
    expect(MOBILE).toMatch(/aria-label="Next day"/);
  });
  it("switches day within the loaded week with no fetch, and crosses weeks via ?day=", () => {
    expect(MOBILE).toMatch(/setSelectedDate\(days\[idx - 1\]\.date\)/);
    expect(MOBILE).toMatch(/setSelectedDate\(days\[idx \+ 1\]\.date\)/);
    expect(MOBILE).toMatch(/router\.push\(`\/calendar\?day=\$\{addDays/);
  });
  it("page anchors the week to ?day= and computes the initial selected day (tz-safe strings)", () => {
    expect(PAGE).toMatch(/params\.day \?\? params\.week \?\? startOfWeek\(today\)/);
    expect(PAGE).toMatch(/const initialSelectedDate =/);
  });
});

describe("mobile timeline: labels, now-line, timezone + 12h/24h", () => {
  it("renders hour labels via formatHourLabel", () => {
    expect(TIMELINE).toMatch(/formatHourLabel\(h\)/);
  });
  it("shows the now-line only for today (existing pattern)", () => {
    expect(TIMELINE).toMatch(/isToday && <NowLine tz=\{tz\}/);
  });
  it("positions in 24h localTimeString(tz) and DISPLAYS via studio-tz formatTimeForStudio — never device-local", () => {
    expect(TIMELINE).toMatch(/localTimeString\(start, tz\)/);
    expect(TIMELINE).toMatch(/formatTimeForStudio\(start, tz, timeFormat\)/);
    expect(TIMELINE).not.toMatch(/toLocaleTimeString|toLocaleString/);
  });
  it("the formatter the timeline uses renders AM/PM for 12h and 24h for 24h", () => {
    const d = new Date("2026-07-09T17:30:00Z");
    const tz = "America/New_York";
    expect(formatTimeForStudio(d, tz, "12h")).toMatch(/AM|PM/i);
    expect(formatTimeForStudio(d, tz, "24h")).toMatch(/\d{1,2}:\d{2}/);
    expect(formatTimeForStudio(d, tz, "24h")).not.toMatch(/AM|PM/i);
  });
});

describe("mobile cards + create flow reuse existing paths (no new server actions)", () => {
  it("appointment card links to the existing detail page with returnTo", () => {
    expect(TIMELINE).toMatch(/href=\{`\/calendar\/\$\{a\.id\}\$\{returnTo\}`\}/);
  });
  it("block card opens the existing edit drawer via onEditBlock", () => {
    expect(TIMELINE).toMatch(/onClick=\{\(\) => onEditBlock\(tb\)\}/);
    expect(MOBILE).toMatch(/<TimedBlockEditDrawer/);
  });
  it("tap empty time opens QuickBookDrawer at the EXACT tapped time", () => {
    expect(TIMELINE).toMatch(/onBookAt\(minutesToHHMM\(snapped\)\)/);
    expect(MOBILE).toMatch(/onBookAt=\{\(localTime\) =>/);
    expect(MOBILE).toMatch(/<QuickBookDrawer/);
  });
  it("floating + is present and books at a context-aware default (not always top-of-day)", () => {
    expect(MOBILE).toMatch(/aria-label="Add appointment"/);
    expect(MOBILE).toMatch(/function bookFromPlus/);
    expect(MOBILE).toMatch(/Math\.ceil\(now \/ 30\)/);
  });
  it("introduces NO new booking/block server action", () => {
    for (const src of [MOBILE, TIMELINE]) {
      expect(src).not.toMatch(
        /"use server"|bookAppointmentForClientAction|createCalendarTimedBlockAction|updateTimedBlockAction/,
      );
    }
  });
});

describe("safety: desktop untouched surfaces + no payment/email/SMS", () => {
  it("desktop still renders the week grid (DayColumn) and month path", () => {
    expect(PAGE).toMatch(/<DayColumn/);
    expect(PAGE).toMatch(/renderMonthView/);
  });
  it("mobile files touch no payment/email/SMS", () => {
    for (const src of [MOBILE, TIMELINE]) {
      expect(src).not.toMatch(/stripe|payment|sendEmail|twilio|sendSms/i);
    }
  });
});
