import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MobileDayTimeline } from "@/app/(app)/calendar/MobileDayTimeline";
import { DayColumn } from "@/app/(app)/calendar/DayColumn";
import {
  NO_SHOW_CARD_CLASS,
  appointmentStatusTag,
} from "@/app/(app)/calendar/appointment-display-status";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";

// The week column mounts its drawers, which call useRouter; a static render
// has no app router, so supply an inert one.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
}));

// HON-48: no-show stays distinguishable on the TEAM calendar, with practitioner
// colours present. Done, Completed and No-show all render dimmed, and a team
// calendar splits a column into narrow lanes for overlapping practitioners, so
// a trailing "No-show" is the first text truncated and the card would read as
// Done. A no-show therefore carries a dashed edge (neither colour nor text) and
// its label LEADS the line. Synthetic data only.

const TZ = "America/Los_Angeles";
// 2030-03-01 is PST (UTC-8). The clock sits on the next day so every card is
// past: a confirmed one derives "done".
const NOW = "2030-03-02T20:00:00Z";

function appt(id: string, status: string, startHourUtc: number, minutes: number, practitioner: number) {
  const start = Date.parse(`2030-03-01T${String(startHourUtc).padStart(2, "0")}:00:00Z`);
  return {
    id,
    starts_at: new Date(start).toISOString(),
    ends_at: new Date(start + minutes * 60_000).toISOString(),
    duration_minutes: minutes,
    status,
    client: { id: `synthetic-client-${id}`, name: `Synthetic client ${id}` },
    service: null,
    practitioner: { id: `synthetic-practitioner-${practitioner}`, color: practitioner === 0 ? "teal" : "amber",
      display_name: `Synthetic Practitioner ${practitioner}` },
  } as unknown as AppointmentWithPractitionerColor;
}

// One practitioner each, so a no-show sits beside a done and a completed card.
const DAY = [
  appt("noshow", "no_show", 18, 60, 0),
  appt("done", "confirmed", 19, 60, 1),
  appt("completed", "completed", 20, 60, 0),
  appt("noshowshort", "no_show", 21, 30, 1),
];

// The rendered element for one card: from its href/title marker to the next card.
function cardOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const anchor = html.lastIndexOf("<a ", at);
  const button = html.lastIndexOf("<button", at);
  const start = Math.max(anchor, button);
  const close = start === anchor ? "</a>" : "</button>";
  return html.slice(start, html.indexOf(close, at));
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { vi.useRealTimers(); });

describe("appointmentStatusTag", () => {
  it("names each terminal state and nothing for an upcoming one", () => {
    expect(appointmentStatusTag("no_show")).toBe("No-show");
    expect(appointmentStatusTag("done")).toBe("Done");
    expect(appointmentStatusTag("completed")).toBe("Completed");
    expect(appointmentStatusTag("upcoming")).toBeNull();
    expect(appointmentStatusTag("cancelled")).toBeNull();
  });
});

describe("mobile team day: a no-show is never just a dimmed card", () => {
  const html = () => renderToStaticMarkup(createElement(MobileDayTimeline, {
    date: "2030-03-01", appts: DAY, timedBlocks: [], recurringBreaks: [],
    availability: null, closedDay: false, isToday: false, tz: TZ,
    timeFormat: "12h", returnTo: "?view=day", onBookAt: () => {}, onEditBlock: () => {},
    showPractitioner: true,
  }));

  it("practitioner colours are present on every card", () => {
    expect(html().match(/data-practitioner-tag=""/g)).toHaveLength(4);
  });

  it("only no-show cards carry the dashed edge", () => {
    const h = html();
    expect(cardOf(h, "/calendar/noshow?")).toContain(NO_SHOW_CARD_CLASS);
    expect(cardOf(h, "/calendar/noshowshort?")).toContain(NO_SHOW_CARD_CLASS);
    expect(cardOf(h, "/calendar/done?")).not.toContain(NO_SHOW_CARD_CLASS);
    expect(cardOf(h, "/calendar/completed?")).not.toContain(NO_SHOW_CARD_CLASS);
  });

  it("No-show leads the line, before the time and the practitioner, even on a 30-minute card", () => {
    for (const id of ["noshow", "noshowshort"]) {
      const card = cardOf(html(), `/calendar/${id}?`);
      const label = card.indexOf("No-show");
      expect(label).toBeGreaterThan(-1);
      expect(label).toBeLessThan(card.search(/\d{1,2}:\d{2}/));
      expect(label).toBeLessThan(card.indexOf("data-practitioner-tag"));
      expect(card.match(/No-show/g)).toHaveLength(1);
    }
  });

  it("Done and Completed keep their trailing tag", () => {
    const h = html();
    for (const [id, tag] of [["done", "Done"], ["completed", "Completed"]]) {
      const card = cardOf(h, `/calendar/${id}?`);
      expect(card.indexOf(tag)).toBeGreaterThan(card.search(/\d{1,2}:\d{2}/));
      expect(card).not.toContain("No-show");
    }
  });
});

describe("desktop team week column: the same cues", () => {
  const DAYCOL = readFileSync(path.resolve(__dirname, "../../../app/(app)/calendar/DayColumn.tsx"), "utf8");
  // Before the column measures a fine pointer (always, in a static render) every
  // card uses the touch/narrow single-appointment button, whose body is
  // OverlapAppointmentSummary. That path is rendered here.
  const html = () => renderToStaticMarkup(createElement(DayColumn, {
    date: "2030-03-01", appts: DAY, timedBlocks: [], recurringBreaks: [],
    blocked: false, tz: TZ, timeFormat: "12h", isOwner: true,
    practitionerCapacityEnabled: true, currentPractitionerId: "synthetic-practitioner-0",
    currentPractitionerName: "Synthetic Practitioner 0", clients: [], services: [],
    isToday: false, availability: null, closedDay: false,
  } as unknown as Parameters<typeof DayColumn>[0]));
  const touchCard = (h: string, id: string) => cardOf(h, `Synthetic client ${id}<`);

  it("touch/narrow cards: only no-shows are dashed, and No-show leads the client and time", () => {
    const h = html();
    for (const id of ["noshow", "noshowshort"]) {
      const card = touchCard(h, id);
      expect(card).toContain(NO_SHOW_CARD_CLASS);
      const label = card.indexOf("No-show");
      expect(label).toBeGreaterThan(-1);
      expect(label).toBeLessThan(card.indexOf(`Synthetic client ${id}`));
      expect(label).toBeLessThan(card.search(/\d{1,2}:\d{2}/));
      expect(card.match(/No-show/g)).toHaveLength(1);
      expect(card).toContain(`Synthetic Practitioner ${id === "noshow" ? 0 : 1}`);
    }
    for (const [id, tag] of [["done", "Done"], ["completed", "Completed"]]) {
      const card = touchCard(h, id);
      expect(card).not.toContain(NO_SHOW_CARD_CLASS);
      expect(card).toContain(tag);
      expect(card).not.toContain("No-show");
    }
  });

  it("fine-pointer cards (source): the dashed edge, a leading No-show on both layouts, and status in the title", () => {
    expect(DAYCOL).toContain('${terminal ? "opacity-60" : ""} ${noShow ? NO_SHOW_CARD_CLASS : ""}');
    expect(DAYCOL).toContain('{noShow && <span className="shrink-0">No-show ·</span>}');
    expect(DAYCOL).toContain('{noShow && "No-show · "}');
    expect(DAYCOL).toContain("title={[...titleParts, statusTag, arrivedTag].filter(Boolean).join(\" · \")}");
    expect(DAYCOL.match(/\{trailingTag \? ` · \$\{trailingTag\}` : ""\}/g)).toHaveLength(2);
    expect(DAYCOL).not.toContain("{statusTag ? ` · ${statusTag}` : \"\"}");
  });
});
