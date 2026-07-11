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
const MONTHVIEW = read("app/(app)/calendar/MonthView.tsx");

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
  it("has NO horizontal week-grid panning: the day timeline scrolls vertically; only the compact date strip scrolls horizontally", () => {
    expect(MOBILE).toMatch(/overflow-y-auto overscroll-contain/);
    // The day timeline itself never pans horizontally.
    expect(TIMELINE).not.toMatch(/overflow-x|min-w-\[840px\]|grid-cols-\[60px_repeat\(7/);
    // The old 7-day horizontal week grid is gone from mobile; the ONLY horizontal
    // scroll is the compact weekday/date navigation strip (not a grid).
    expect(MOBILE).not.toMatch(/min-w-\[840px\]|grid-cols-\[60px_repeat\(7/);
    expect(MOBILE).toMatch(/ref=\{stripRef\}[\s\S]*overflow-x-auto/);
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
  it("floating + opens the Book/Block chooser at a context-aware default (not always top-of-day)", () => {
    expect(MOBILE).toMatch(/aria-label="Add appointment or block time"/);
    expect(MOBILE).toMatch(/function openPlusChooser/);
    expect(MOBILE).toMatch(/onClick=\{openPlusChooser\}/);
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

describe("month view tapping a date preserves the EXACT date (not the week start)", () => {
  it("day cell navigates with ?day=<exact date>, so the tapped day is not snapped to week start", () => {
    // The bug: tapping Thu the 23rd opened the week start (Sun the 19th). The day
    // href must carry the exact cellDate via ?day= (the mobile selected-day param).
    expect(MONTHVIEW).toMatch(/const dayHref = `\/calendar\?view=week&week=\$\{startOfWeek\(cellDate\)\}&day=\$\{cellDate\}`/);
    expect(MONTHVIEW).not.toMatch(/href=\{weekHref\}/); // old week-only href is gone
    expect(MONTHVIEW).toMatch(/href=\{dayHref\}/);
  });
  it("page consumes ?day= as the selected day (already wired), anchoring the containing week", () => {
    expect(PAGE).toMatch(/params\.day \?\? params\.week \?\? startOfWeek\(today\)/);
  });
  it("today is unmistakable in the month grid (filled badge + accent), distinct from other days", () => {
    expect(MONTHVIEW).toMatch(/aria-label="Today"/);
    expect(MONTHVIEW).toMatch(/rounded-full bg-sky-600/);
    expect(MONTHVIEW).toMatch(/border-t-2 border-t-sky-500/);
  });
});

describe("mobile + chooser (Book / Block) and block-time reuse", () => {
  it("the + opens the reused DragActionChooser (not QuickBook directly)", () => {
    expect(MOBILE).toMatch(/import \{ DragActionChooser/);
    expect(MOBILE).toMatch(/<DragActionChooser/);
    expect(MOBILE).toMatch(/setChooserDraft\(/);
  });
  it("choosing Book opens QuickBookDrawer; choosing Block opens QuickBlockDrawer (reused, no new model)", () => {
    expect(MOBILE).toMatch(/onBook=\{/);
    expect(MOBILE).toMatch(/onBlock=\{/);
    expect(MOBILE).toMatch(/<QuickBlockDrawer/);
    expect(MOBILE).toMatch(/import \{ QuickBlockDrawer/);
    // Block create reuses the desktop drawer/action — no server action in this file.
    expect(MOBILE).not.toMatch(/"use server"|createCalendarTimedBlockAction|updateTimedBlockAction/);
  });
  it("block-time create prefills the selected day + a start/end range", () => {
    expect(MOBILE).toMatch(/localDate: chooserDraft\.localDate/);
    expect(MOBILE).toMatch(/startLocal: minutesToHHMM\(minutes\)/);
    expect(MOBILE).toMatch(/endLocal: minutesToHHMM/);
  });
});

describe("mobile date strip: today survives selection, appt dots, scroll + a11y", () => {
  it("today keeps a high-contrast ring even when it is the selected pill", () => {
    expect(MOBILE).toMatch(/d\.isToday[\s\S]*ring-2 ring-inset ring-sky-500/);
  });
  it("shows an appointment indicator dot per day with appointments", () => {
    expect(MOBILE).toMatch(/const hasAppts = d\.appts\.length > 0/);
  });
  it("pills are horizontally scrollable, keep the selected one in view, with a11y labels + 44px targets", () => {
    expect(MOBILE).toMatch(/overflow-x-auto/);
    expect(MOBILE).toMatch(/data-selected=\{selected\}/);
    expect(MOBILE).toMatch(/scrollIntoView\(\{ inline: "center"/);
    expect(MOBILE).toMatch(/aria-label=\{`\$\{d\.isToday \? "Today, " : ""\}/);
    expect(MOBILE).toMatch(/min-h-\[44px\]/);
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
