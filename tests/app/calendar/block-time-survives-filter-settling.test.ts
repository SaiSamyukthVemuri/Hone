// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CalendarBlockTime } from "@/app/(app)/calendar/CalendarBlockTime";

// On a phone, a member's first visit to the by-practitioner week settles the practitioner filter to their own column.
// That re-renders the page with ONE person shown, which is a time-grid layout with no page-level Block time button.
// An open Block time panel used to be unmounted with the button, so Save vanished mid-edit. The panel must survive
// the filter settling: only the BUTTON follows the layout, the open panel does not.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}));
vi.mock("@/app/(app)/calendar/calendar-block-actions", () => ({ createCalendarTimedBlockAction: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const props = { date: "2031-05-12", studioTimezone: "America/Los_Angeles", blockScopeNames: { m1: "Synthetic Cy" }, isOwner: false, currentPractitionerId: "m1", currentPractitionerName: "Synthetic Cy" };
const blockButton = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Block time");
const saveButton = () => [...document.querySelectorAll("button")].find((b) => /^Save block/.test(b.textContent ?? ""));

describe("Block time while the practitioner filter settles", () => {
  it("keeps the open panel and its Save button when the layout stops showing the page-level button", async () => {
    await act(async () => root.render(createElement(CalendarBlockTime, { ...props, showButton: true })));
    await act(async () => blockButton()!.click());
    expect(saveButton()).toBeTruthy();

    // The filter settles to one person: the by-practitioner layout (and its button) goes away.
    await act(async () => root.render(createElement(CalendarBlockTime, { ...props, showButton: false })));
    expect(blockButton()).toBeUndefined();
    expect(saveButton()).toBeTruthy();
  });

  it("with no panel open, the button follows the layout as before", async () => {
    await act(async () => root.render(createElement(CalendarBlockTime, { ...props, showButton: false })));
    expect(blockButton()).toBeUndefined();
    await act(async () => root.render(createElement(CalendarBlockTime, { ...props, showButton: true })));
    expect(blockButton()).toBeTruthy();
  });
});
