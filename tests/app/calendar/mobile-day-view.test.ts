import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileDayTimeline } from "@/app/(app)/calendar/MobileDayTimeline";
import type { StudioTimedBlock } from "@/lib/types/database";
import { AppointmentOverlapChooser } from "@/app/(app)/calendar/AppointmentOverlapChooser";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";
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
    expect(MOBILE).toMatch(/router\.push\(withSelection\(`\/calendar\?day=\$\{addDays/);
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
    expect(MONTHVIEW).toMatch(/const dayHref = withSelection\(\s*`\/calendar\?view=week&week=\$\{startOfWeek\(cellDate\)\}&day=\$\{cellDate\}`,\s*selectionParam,?\s*\)/);
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


describe("overlap chooser reuses exact authorized calendar identities", () => {
  const appointments = Array.from({ length: 5 }, (_, i) => ({
    id: `appointment-${i}`, starts_at: "2030-03-01T20:00:00Z", ends_at: "2030-03-01T20:30:00Z",
    status: "confirmed", client: { id: `client-${i}`, name: `Synthetic client ${i}` },
    practitioner: { id: `practitioner-${i}`, color: "sky", display_name: `Practitioner ${i}` },
    service: null,
  } as unknown as AppointmentWithPractitionerColor));
  it("renders five real detail links preserving each id and returnTo; never invents a chart link", () => {
    const html = renderToStaticMarkup(createElement(AppointmentOverlapChooser, {
      appointments, tz: "America/Los_Angeles", timeFormat: "12h", returnTo: "?view=week", onClose: () => {},
    }));
    for (const a of appointments) {
      expect(html).toContain(`href="/calendar/${a.id}?view=week"`);
      expect(html).toContain(a.client!.name);
    }
    expect(html.match(/href="\/calendar\//g)).toHaveLength(5);
    expect(html).not.toMatch(/sessions\/new|appointment_id=/);
    expect(html).toContain("min-h-[44px] min-w-[44px]");
    expect(html).toContain('aria-label="Choose an appointment"');
  });
  it("desktop renders appointment choice buttons, not direct links or form submissions", () => {
    const html = renderToStaticMarkup(createElement(AppointmentOverlapChooser, {
      appointments, tz: "America/Los_Angeles", timeFormat: "12h", returnTo: "", onClose: () => {}, onSelect: () => {},
    }));
    expect(html).not.toContain("href=");
    for (const a of appointments) expect(html).toContain(a.client!.name);
    expect(html).not.toContain("<form");
  });
  it("keeps five appointment/practitioner identities even when client and time are identical", () => {
    const sameClient = appointments.map((a) => ({ ...a, client: { id: "same-client", name: "Same client" } }));
    const html = renderToStaticMarkup(createElement(AppointmentOverlapChooser, {
      appointments: sameClient, tz: "America/Los_Angeles", timeFormat: "12h", returnTo: "", onClose: () => {},
    }));
    for (const a of sameClient) {
      expect(html).toContain(`href="/calendar/${a.id}"`);
      expect(html).toContain(a.practitioner!.display_name!);
    }
    expect(html.match(/href="\/calendar\//g)).toHaveLength(5);
  });
  it("uses the existing modal keyboard contract and resolves selected ids against current-day objects", () => {
    const chooser = read("app/(app)/calendar/AppointmentOverlapChooser.tsx");
    expect(chooser).toContain("useDialogKeyboard");
    expect(chooser).toContain("ref={panelRef}");
    expect(chooser).toContain("ref={initialFocusRef}");
    expect(chooser).toContain("onSelect(a)");
    expect(TIMELINE).toContain("appointmentsById.get(id)");
    expect(TIMELINE).toContain("calendarCollisionGroups(rectangles, timedBlockRectangles)");
    expect(TIMELINE).toContain("<AppointmentOverlapChooser");
    expect(MOBILE).toMatch(/<MobileDayTimeline\s+key=\{day.date\}/);
    const query = read("lib/booking/queries.ts");
    expect(query).toContain("practitioners!appointments_practitioner_same_studio_fk(id, color, display_name)");
  });
});


describe("adjacent appointment and timed-block hit targets", () => {
  const appointment = {
    id: "same-id", starts_at: "2030-03-01T18:00:00Z", ends_at: "2030-03-01T18:15:00Z",
    duration_minutes: 15, status: "confirmed", client: { id: "synthetic-client", name: "Synthetic appointment" },
    service: null, practitioner: { display_name: "Synthetic practitioner" },
  } as unknown as AppointmentWithPractitionerColor;
  const block = {
    id: "same-id", starts_at: "2030-03-01T18:15:00Z", ends_at: "2030-03-01T18:30:00Z",
    category: "break", private_note: "Synthetic block",
  } as StudioTimedBlock;
  it("renders one mixed chooser instead of two overlapping standalone hit targets", () => {
    const html = renderToStaticMarkup(createElement(MobileDayTimeline, {
      date: "2030-03-01", appts: [appointment], timedBlocks: [block], recurringBreaks: [],
      availability: null, closedDay: false, isToday: false, tz: "America/Los_Angeles",
      timeFormat: "12h", returnTo: "?view=day", onBookAt: () => {}, onEditBlock: () => {},
    }));
    expect(html).toContain('aria-label="Choose from 2 calendar items"');
    expect(html).not.toContain('href="/calendar/same-id');
    expect(html).not.toContain('title="Break: Synthetic block"');
    expect(html).toContain("min-h-[44px] min-w-[44px]");
  });
  it("keeps a lone block's original edit control and supports block-only overlapping choices", () => {
    const props = { date: "2030-03-01", appts: [], timedBlocks: [block], recurringBreaks: [],
      availability: null, closedDay: false, isToday: false, tz: "America/Los_Angeles", timeFormat: "12h" as const,
      returnTo: "", onBookAt: () => {}, onEditBlock: () => {} };
    const single = renderToStaticMarkup(createElement(MobileDayTimeline, props));
    expect(single).toContain('title="Break: Synthetic block"');
    expect(single).not.toContain("calendar items");
    expect(single).toContain("min-h-[44px] min-w-[44px]");
    const mixed = renderToStaticMarkup(createElement(MobileDayTimeline, { ...props,
      timedBlocks: [block, { ...block, id: "second-block" }] }));
    expect(mixed).toContain('aria-label="Choose from 2 calendar items"');
    const choices = renderToStaticMarkup(createElement(AppointmentOverlapChooser, {
      appointments: [], timedBlocks: [block], tz: "America/Los_Angeles", timeFormat: "12h",
      returnTo: "", onClose: () => {}, onSelectBlock: () => {},
    }));
    expect(choices).toContain('data-timed-block-id="same-id"');
  });
  it("preserves the appointment link and offers the exact timed block through the existing edit callback", () => {
    const html = renderToStaticMarkup(createElement(AppointmentOverlapChooser, {
      appointments: [appointment], timedBlocks: [block], tz: "America/Los_Angeles", timeFormat: "12h",
      returnTo: "?view=day", onClose: () => {}, onSelectBlock: () => {},
    }));
    expect(html).toContain('aria-label="Choose a calendar item"');
    expect(html).toContain('href="/calendar/same-id?view=day"');
    expect(html).toContain('data-timed-block-id="same-id"');
    expect(html).toContain("min-h-[44px] min-w-[44px]");
    expect(html).not.toContain("<form");
    const chooser = read("app/(app)/calendar/AppointmentOverlapChooser.tsx");
    expect(chooser).toContain("onSelectBlock(block)");
    expect(TIMELINE).toContain("onSelectBlock={onEditBlock}");
  });
});
