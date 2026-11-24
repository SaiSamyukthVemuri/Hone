// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { groupMonthAppointmentsByDate, MonthView } from "@/app/(app)/calendar/MonthView";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";

const selected = "2030-03-04";

function visit(id: string, name: string, hour: number, status = "confirmed"): AppointmentWithPractitionerColor {
  const instant = `${selected}T${hour}:00:00.000Z`;
  return {
    id, starts_at: instant, ends_at: instant, status,
    client: { id: name, name }, practitioner_id: "first", practitioner: { id: "first", display_name: "Sam", color: "teal" },
    service: { name: "Consultation" },
  } as AppointmentWithPractitionerColor;
}

function render() {
  const late = visit("late", "Second client", 22);
  const early = visit("early", "First client", 12);
  const cancelled = visit("cancelled", "Cancelled client", 14, "cancelled");
  const next = { ...early, id: "next", client: {id: "other", name: "Tomorrow client"}, starts_at: "2030-03-06T01:00:00Z" };
  const appointmentsByDate = groupMonthAppointmentsByDate([late, cancelled, next, early], "America/Toronto",
    (iso, timeZone) => new Date(iso).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" }));
  document.body.innerHTML = renderToStaticMarkup(createElement(MonthView, {
    monthAnchor: "2030-03-01", today: "2030-03-01", selectedDate: selected, hasDayView: true,
    appointmentsByDate, selectionParam: "first", blockedByDate: new Map(), isClosedDate: () => false,
  }));
  return document;
}

describe("selecting a date in Month", () => {
  it("counts visits on the studio-local date and lists the selected clients chronologically", () => {
    const page = render();
    const cell = page.querySelector(`a[aria-label="Open ${selected}"]`)!;
    expect(cell.getAttribute("aria-current")).toBe("date");
    expect(cell.querySelector("[data-month-count]")?.textContent).toBe("2");
    expect(cell.textContent).toContain("Sam 2");
    expect(page.querySelector('a[aria-label="Open 2030-03-05"] [data-month-count]')?.textContent).toBe("1");
    const agenda = page.querySelector("#month-agenda")!;
    const rows = [...agenda.querySelectorAll("li")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("First client");
    expect(rows[1].textContent).toContain("Second client");
    expect(agenda.textContent).not.toContain("Tomorrow client");
    expect(agenda.textContent).not.toContain("Cancelled client");
    expect(rows[0].querySelector("a")?.getAttribute("href")).toBe("/calendar/early?view=month&day=2030-03-04&month=2030-03-01");
  });
  it("keeps the active filter and exact day when opening Day or selecting a spillover date", () => {
    const page = render();
    expect(page.querySelector("#month-agenda a")?.getAttribute("href")).toBe("/calendar?view=day&day=2030-03-04&people=first");
    expect(page.querySelector('a[aria-label="Open 2030-04-01"]')?.getAttribute("href"))
      .toBe("/calendar?view=month&month=2030-04-01&day=2030-04-01&people=first#month-agenda");
  });
});
