// @vitest-environment jsdom
import { readFileSync } from "node:fs";
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
    await act(async () => root.render(createElement(CalendarBlockTime, { ...props, showTrigger: true })));
    await act(async () => blockButton()!.click());
    expect(saveButton()).toBeTruthy();

    // The filter settles to one person: the by-practitioner layout (and its button) goes away.
    await act(async () => root.render(createElement(CalendarBlockTime, { ...props, showTrigger: false })));
    expect(blockButton()).toBeUndefined();
    expect(saveButton()).toBeTruthy();
  });

  it("with no panel open, the button follows the layout as before", async () => {
    await act(async () => root.render(createElement(CalendarBlockTime, { ...props, showTrigger: false })));
    expect(blockButton()).toBeUndefined();
    await act(async () => root.render(createElement(CalendarBlockTime, { ...props, showTrigger: true })));
    expect(blockButton()).toBeTruthy();
  });
});

// The panel's day is the day chosen when Block time was CLICKED, and a real day change resets the panel (the page keys the
// component by the selected day). Two properties no other test pinned: dropping the key, and snapshotting the wrong day.
const dayText = () => document.body.textContent ?? "";
const withKey = (date: string, showTrigger = true) => createElement(CalendarBlockTime, { key: date, ...props, date, showTrigger });

describe("Block time day handling", () => {
  it("a day change closes the open panel and drops its draft (the page keys CalendarBlockTime by the selected day)", async () => {
    await act(async () => root.render(withKey("2031-05-12")));
    await act(async () => blockButton()!.click());
    expect(saveButton()).toBeTruthy();
    expect(dayText()).toContain("2031-05-12");
    await act(async () => root.render(withKey("2031-05-13")));
    expect(saveButton()).toBeUndefined();
    expect(dayText()).not.toContain("2031-05-12");
    // and the next open starts from the NEW day, not the dropped draft
    await act(async () => blockButton()!.click());
    expect(dayText()).toContain("2031-05-13");
    expect(dayText()).not.toContain("2031-05-12");
  });

  it("the page really keys it by the selected day (the component test above cannot see the page)", () => {
    const page = readFileSync("app/(app)/calendar/page.tsx", "utf8");
    expect(page).toMatch(/<CalendarBlockTime key=\{initialSelectedDate\} showTrigger=\{byPractitioner\}/);
  });

  it("with the filter settling and NO day change, the open panel keeps the day it was clicked on", async () => {
    // The prop moves to B before the click (same key, as a re-render of the same mounted component): the click-time day is B.
    await act(async () => root.render(createElement(CalendarBlockTime, { ...props, date: "2031-05-12", showTrigger: true })));
    await act(async () => root.render(createElement(CalendarBlockTime, { ...props, date: "2031-05-14", showTrigger: true })));
    await act(async () => blockButton()!.click());
    expect(dayText()).toContain("2031-05-14");
    expect(dayText()).not.toContain("2031-05-12");
    // The filter settles: the trigger goes, the day does not change, the panel keeps the click-time day and its Save.
    await act(async () => root.render(createElement(CalendarBlockTime, { ...props, date: "2031-05-14", showTrigger: false })));
    expect(saveButton()).toBeTruthy();
    expect(dayText()).toContain("2031-05-14");
    expect(dayText()).not.toContain("2031-05-12");
  });
});
