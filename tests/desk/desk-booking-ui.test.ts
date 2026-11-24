// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeskBooking } from "@/app/(desk)/desk/DeskBooking";

const api = vi.hoisted(() => ({
  getDeskBookingOptionsAction: vi.fn(),
  findDeskOpeningsAction: vi.fn(),
  searchDeskBookingClientsAction: vi.fn(),
  bookDeskOpeningAction: vi.fn(),
}));
vi.mock("@/app/(desk)/desk/booking-actions", () => api);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const slot = {
  start: "2099-07-23T17:30:00Z", end: "2099-07-23T18:15:00Z", serviceId: "svc",
  practitionerId: "pr", practitionerName: "Maya", localTime: "13:30", date: "2099-07-23",
};
const options = {
  ok: true, studioId: "studio", timezone: "America/Toronto", services: [{ id: "svc", name: "Electrolysis", durationMinutes: 45 }],
  practitioners: [{ id: "pr", name: "Maya" }],
};
let el: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  api.getDeskBookingOptionsAction.mockResolvedValue(options);
  api.findDeskOpeningsAction.mockResolvedValue({ ok: true, openings: [slot] });
  api.searchDeskBookingClientsAction.mockResolvedValue({ ok: true, clients: [{ id: "c1", name: "Name on file", contactHint: "•••1234" }] });
  api.bookDeskOpeningAction.mockResolvedValue({ ok: true });
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root.render(createElement(DeskBooking, { studioId: "studio" })));
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

async function click(name: RegExp) {
  const btn = [...el.querySelectorAll("button")].find(b => name.test(b.textContent ?? ""));
  expect(btn, name.toString()).toBeDefined();
  await act(async () => btn!.click());
}
function enterQuery(query: string) {
  const input = el.querySelector<HTMLInputElement>("input[placeholder]")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function chooseTime() {
  await click(/^Find time$/);
  await click(/^Search availability$/);
  await click(/1:30 PM · Maya/);
}
async function chooseClient() {
  enterQuery("1234");
  await click(/^Find client$/);
  await click(/^Name on file · •••1234$/);
}

describe("booking from the receptionist desk", () => {
  it("previews the exact opening, searches on demand, and books only after explicit client selection", async () => {
    expect(api.getDeskBookingOptionsAction).not.toHaveBeenCalled();
    await chooseTime();
    expect(el.textContent).toContain("45 min · America/Toronto");
    expect(api.searchDeskBookingClientsAction).not.toHaveBeenCalled();
    await chooseClient();
    expect(api.searchDeskBookingClientsAction).toHaveBeenCalledWith({ studioId: "studio", query: "1234" });
    expect(api.bookDeskOpeningAction).not.toHaveBeenCalled();
    await click(/^Book appointment for/);
    expect(api.bookDeskOpeningAction).toHaveBeenCalledExactlyOnceWith({
      studioId: "studio", clientId: "c1", serviceId: "svc", practitionerId: "pr", start: slot.start, end: slot.end,
    });
    expect(el.textContent).toContain("No booking confirmation was sent");
    expect(el.textContent).not.toContain("•••1234");
  });

  it("invalidates a selected client when the user changes the lookup", async () => {
    await chooseTime();
    await chooseClient();
    enterQuery("4321");
    expect(el.textContent).not.toMatch(/Book appointment for/);
    expect(api.bookDeskOpeningAction).not.toHaveBeenCalled();
  });

  it("withholds indistinguishable matches until the lookup is refined", async () => {
    api.searchDeskBookingClientsAction.mockResolvedValue({ ok: true, clients: ["c1", "c2"].map(id => ({ id, name: "Name on file", contactHint: "" })) });
    await chooseTime();
    enterQuery("dupe");
    await click(/^Find client$/);
    const ambiguous = [...el.querySelectorAll("button")].filter(b => b.textContent?.includes("Refine search"));
    expect(ambiguous).toHaveLength(2);
    expect(ambiguous.every(b => b.disabled)).toBe(true);
    expect(el.textContent).not.toContain("Book appointment for");
  });

  it("resets a stale opening before another attempt", async () => {
    api.bookDeskOpeningAction.mockResolvedValue({ ok: false, error: "That time was taken. Search again." });
    await chooseTime();
    await chooseClient();
    await click(/^Book appointment for/);
    expect(el.querySelector('[role="alert"]')?.textContent).toMatch(/time was taken/);
    expect(el.textContent).not.toMatch(/Book appointment for/);
  });

  it("rejects options from a studio selected in another tab", async () => {
    api.getDeskBookingOptionsAction.mockResolvedValue({ ...options, studioId: "other" });
    await click(/^Find time$/);
    expect(el.textContent).toMatch(/selected studio changed/);
    expect(el.querySelector("form")).toBeNull();
  });
});
