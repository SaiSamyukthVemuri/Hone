// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeskCalendar } from "@/app/(desk)/desk/DeskCalendar";

// The picked day and the "Booked for" notice belong to ONE calendar period. Leaving a period and coming back to it must start from that period's
// default day with no old notice (as it did when the period remounted the calendar), while an open booking panel is not touched by a late view change
// (tests/desk/desk-late-view-change.test.ts). DeskBooking is stubbed here so a completed booking can be driven directly through its onBooked callback.

vi.mock("@/app/(desk)/desk/DeskBooking", () => ({
  DeskBooking: (props: { onBooked: (day: string) => void }) =>
    createElement("button", { type: "button", "data-testid": "book-thursday", onClick: () => props.onBooked("2099-06-18") }, "stub booking"),
}));
vi.mock("@/app/(desk)/desk/contact-actions", () => ({ getDeskAppointmentContactAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MONDAY_WEEK = "2099-06-15";
const NEXT_WEEK = "2099-06-22";
const booking = {
  timezone: "America/Toronto", studioId: "studio", practitioners: [{ id: "maya", name: "Maya" }],
  services: [{ id: "svc-1", name: "Consultation", durationMinutes: 30 }],
};

let root: Root;
let el: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollIntoView = vi.fn();
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.unstubAllGlobals(); });

function render(date: string) {
  act(() => root.render(createElement(DeskCalendar, { studioId: "studio", today: "2099-01-01", date, view: "week", timezone: booking.timezone, booking, rows: [] })));
}
const pressedDay = () => el.querySelectorAll<HTMLButtonElement>("button[aria-pressed='true']");
const dayButton = (label: RegExp) => Array.from(el.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).find(b => label.test(b.getAttribute("aria-label") ?? ""))!;
const notice = () => Array.from(el.querySelectorAll("p[role='status']")).map(p => p.textContent).find(t => t?.startsWith("Booked for"));

describe("the picked day and the booked notice belong to one period", () => {
  it("returning to a period starts from its default day, not the day picked there earlier", () => {
    render(MONDAY_WEEK);
    expect(pressedDay()).toHaveLength(1);
    expect(pressedDay()[0].getAttribute("aria-label")).toMatch(/June 15, 2099/);
    act(() => dayButton(/June 18, 2099/).click());
    expect(pressedDay()[0].getAttribute("aria-label")).toMatch(/June 18, 2099/);

    render(NEXT_WEEK);
    expect(pressedDay()[0].getAttribute("aria-label")).toMatch(/June 22, 2099/);
    render(MONDAY_WEEK); // press Next, then press back to the same week

    expect(pressedDay(), "the old pick came back").toHaveLength(1);
    expect(pressedDay()[0].getAttribute("aria-label")).toMatch(/June 15, 2099/);
  });

  it("the Booked for notice is reset with the period and does not come back on return", () => {
    render(MONDAY_WEEK);
    expect(notice()).toBeUndefined();
    act(() => el.querySelector<HTMLButtonElement>("[data-testid='book-thursday']")!.click());
    expect(notice(), "the booked notice should show for the booked day").toBe("Booked for Thursday, June 18, 2099.");
    expect(pressedDay()[0].getAttribute("aria-label")).toMatch(/June 18, 2099/);

    render(NEXT_WEEK);
    expect(notice(), "the notice survived leaving the period").toBeUndefined();
    render(MONDAY_WEEK);
    expect(notice(), "the old notice came back on return").toBeUndefined();
    expect(pressedDay()[0].getAttribute("aria-label")).toMatch(/June 15, 2099/);
  });
});
