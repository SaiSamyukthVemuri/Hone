// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeskCalendar } from "@/app/(desk)/desk/DeskCalendar";
import type { DeskScheduleRow } from "@/lib/desk/read";

// A view or date change on the receptionist calendar can commit LATE: the response lands after the receptionist has already opened "Find an
// opening" and started filling it in. The new period must replace the calendar underneath, never the open panel or what was typed into it.
// (Re-rendering DeskCalendar with new date/view props is exactly what the router's late commit does.)

vi.mock("@/app/(desk)/desk/contact-actions", () => ({ getDeskAppointmentContactAction: vi.fn() }));
vi.mock("@/app/(desk)/desk/booking-actions", () => ({
  getDeskBookingOptionsAction: vi.fn(), findDeskOpeningsAction: vi.fn(), bookDeskOpeningAction: vi.fn(), searchDeskBookingClientsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WEEK = "2099-06-15";
const NEXT_MONTH = "2099-07-01";
const maya = { id: "maya", name: "Maya" };
const booking = {
  timezone: "America/Toronto", studioId: "studio", practitioners: [maya, { id: "priya", name: "Priya" }],
  services: [{ id: "svc-1", name: "Consultation", durationMinutes: 30 }],
};
const visit = (date: string): DeskScheduleRow => ({
  appointmentId: `visit-${date}`, startsAt: `${date}T14:00:00Z`, endsAt: `${date}T14:15:00Z`, status: "confirmed", durationMinutes: 15,
  studioTimezone: booking.timezone, practitionerId: maya.id, practitionerName: maya.name, practitionerColor: "teal", clientName: `Client ${date}`, serviceName: "Short visit",
});

let root: Root;
let el: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  Element.prototype.scrollIntoView = vi.fn();
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.unstubAllGlobals(); });

function render(date: string, view: "day" | "week" | "month") {
  act(() => root.render(createElement(DeskCalendar, { studioId: "studio", today: "2099-01-01", date, view, timezone: booking.timezone, booking, rows: [visit(date)] })));
}
const panel = () => el.querySelector<HTMLElement>('section[aria-label="Desk booking"]')!;
function setNative(control: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(control, value);
  control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
function openPanelAndType() {
  const open = Array.from(panel().querySelectorAll("button")).find(b => b.textContent === "Find an opening")!;
  act(() => open.click());
  const time = Array.from(panel().querySelectorAll("select")).find(s => Array.from(s.options).some(o => o.text === "Noon onward"))!;
  const from = panel().querySelector<HTMLInputElement>('input[type="date"]')!;
  act(() => setNative(time, "pm"));
  act(() => setNative(from, "2099-06-20"));
  return { time, from };
}

describe("a late view or date change", () => {
  it("keeps the open booking panel mounted and what was typed into it", () => {
    render(WEEK, "week");
    const section = panel();
    const { time, from } = openPanelAndType();
    expect(time.value).toBe("pm");
    expect(from.value).toBe("2099-06-20");

    render(NEXT_MONTH, "month"); // the slow Month response finally commits

    expect(panel(), "the panel was remounted").toBe(section);
    expect(panel().textContent).toContain("Search availability");
    const nowTime = Array.from(panel().querySelectorAll("select")).find(s => Array.from(s.options).some(o => o.text === "Noon onward"))!;
    expect(nowTime, "the Time of day control was replaced").toBe(time);
    expect(nowTime.value).toBe("pm");
    expect(panel().querySelector<HTMLInputElement>('input[type="date"]')!, "the From control was replaced").toBe(from);
    expect(from.value).toBe("2099-06-20");
  });

  it("still changes the calendar underneath to the new period", () => {
    render(WEEK, "week");
    openPanelAndType();
    render(NEXT_MONTH, "month");
    expect(el.querySelector("h1")?.textContent).toContain("July 2099");
    expect(el.textContent).toContain(`Client ${NEXT_MONTH}`);
    expect(el.textContent).not.toContain(`Client ${WEEK}`);
  });

  it("still closes the panel when the receptionist picks a different day themselves", () => {
    render(NEXT_MONTH, "month");
    openPanelAndType();
    expect(panel().textContent).toContain("Search availability");
    const otherDay = Array.from(el.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).find(b => b.getAttribute("aria-pressed") === "false" && /July 8, 2099/.test(b.getAttribute("aria-label") ?? ""))!;
    act(() => otherDay.click());
    expect(panel().textContent).not.toContain("Search availability");
  });
});
