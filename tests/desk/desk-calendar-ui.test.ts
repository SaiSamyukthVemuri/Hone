// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeskCalendar } from "@/app/(desk)/desk/DeskCalendar";
import type { DeskScheduleRow } from "@/lib/desk/read";

const { contact, push } = vi.hoisted(() => ({ contact: vi.fn(), push: vi.fn() }));
vi.mock("@/app/(desk)/desk/contact-actions", () => ({ getDeskAppointmentContactAction: contact }));
vi.mock("@/app/(desk)/desk/booking-actions", () => ({
  getDeskBookingOptionsAction: vi.fn(), findDeskOpeningsAction: vi.fn(), bookDeskOpeningAction: vi.fn(), searchDeskBookingClientsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const date = "2099-06-15";
const maya = { id: "maya", name: "Maya" };
const chloe = { id: "chloe", name: "Chloe" };
const booking = { timezone: "America/Toronto", studioId: "studio", services: [], practitioners: [maya, chloe] };
const visit: DeskScheduleRow = {
  appointmentId: "visit-1", startsAt: date+"T14:00:00Z", endsAt:date+"T14:15:00Z", status:"confirmed", durationMinutes:15,
  studioTimezone:booking.timezone, practitionerId:maya.id, practitionerName:maya.name, practitionerColor:"teal", clientName:"Sam Rowan", serviceName:"Short visit",
};
const adjacent = { ...visit, appointmentId:"visit-2", startsAt:date+"T14:15:00Z", endsAt:date+"T14:30:00Z", clientName:"Ari Brook" };
let root: Root;
let el: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  Element.prototype.scrollIntoView = vi.fn();
  el=document.createElement("div"); document.body.append(el); root=createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.unstubAllGlobals(); });
function render(view: "day" | "week" | "month", rows = [visit, adjacent]) {
  act(() => root.render(createElement(DeskCalendar, { studioId:"studio", today:date, date, view, timezone:booking.timezone, booking, rows })));
}
function buttons() { return Array.from(el.querySelectorAll("button")); }

describe("receptionist calendar interactions", () => {
  it("shows names and per-practitioner counts, filters the agenda, and retrieves only the opened visit's contacts", async () => {
    contact.mockResolvedValue({ ok:true, phone:"555-0100", email:"sam@example.com" });
    render("month");
    const cell = el.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!;
    expect(cell.getAttribute("aria-label")).toContain("2 visits, Maya 2, Chloe 0");
    expect(contact).not.toHaveBeenCalled();
    const checkbox = el.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => checkbox.click());expect(el.textContent).not.toContain(visit.clientName);
    act(() => checkbox.click());
    await act(async () => buttons().find(b => b.getAttribute("aria-label")?.includes(visit.clientName))!.click());
    expect(contact).toHaveBeenCalledExactlyOnceWith({ studioId:"studio", appointmentId:visit.appointmentId });
    expect(el.querySelector("dialog")?.textContent).toContain("sam@example.com");
    act(() => buttons().find(b => b.textContent === "Close")!.click());expect(el.textContent).not.toContain("sam@example.com");
  });
  it("renders adjacent quarter-hour appointments at their occupied height, both using the full column", () => {
    render("day");
    const cards = buttons().filter(b => b.title.includes("Short visit"));
    expect(cards.map(b => b.style.height)).toEqual(["15px","15px"]);
    expect(cards[0].style.width).toBe(cards[1].style.width);
    expect(cards[0].style.width).toContain("100%");
    expect(parseInt(cards[1].style.top) - parseInt(cards[0].style.top)).toBe(15);
  });
  it("keeps old practitioners' appointments visible and limits booking cells to current practitioners", () => {
    render("day", [{ ...visit, practitionerId:"former", practitionerName:"Former practitioner" }]);
    expect(buttons().some(b => b.title.includes("Former practitioner"))).toBe(true);
    expect(buttons().some(b => b.getAttribute("aria-label")?.startsWith("Find an opening with Former"))).toBe(false);
  });
});
