// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CalendarFindTime } from "@/app/(app)/calendar/CalendarFindTime";
import type { CalendarOpening } from "@/app/(app)/calendar/find-time-actions";

const find = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/calendar/find-time-actions", () => ({ findCalendarOpeningsAction: find }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const services = [
  { id: "short", name: "Electrolysis", modality: "electrolysis", default_duration_minutes: 30 },
  { id: "long", name: "Treatment", modality: "electrolysis", default_duration_minutes: 45 },
  { id: "consult", name: "Consultation", modality: null, default_duration_minutes: 45 },
];
const opening: CalendarOpening = {
  date: "2030-03-01", localTime: "13:30", start: "2030-03-01T18:30:00Z", end: "2030-03-01T19:15:00Z",
  practitionerId: "maya", practitionerName: "Maya", serviceId: "long",
};
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
const onSelect = vi.fn();
const onClear = vi.fn();
const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent === label)!;
const select = () => host.querySelector<HTMLSelectElement>("select")!;
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const chooseService = async (id: string) => {
  await act(async () => {
    select().value = id;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
};
async function mount(rebook = false) {
  await act(async () => root.render(createElement(CalendarFindTime, {
    services, practitioners: [{ id: "maya", name: "Maya" }, { id: "ava", name: "Ava" }],
    viewerId: "ava", isOwner: true, anchorDate: "2030-03-01", today: "2030-02-01",
    timeFormat: "12h", selected: null, onSelect, onClear,
    rebook: rebook ? { serviceId: "long", durationMinutes: 50, practitionerId: "maya", clientId: "client" } : null,
  })));
}
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.resetAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("calendar Find time", () => {
  it("requires the operator to choose among services sharing a duration, then previews the exact result", async () => {
    find.mockResolvedValue({ ok: true, openings: [opening] });
    await mount();
    await click("45 min");
    expect(select().value).toBe("");
    expect(button("Search availability").disabled).toBe(true);
    expect([...select().options].map(o => o.value)).toEqual(["", "long", "consult"]);
    await chooseService("long");
    await click("Search availability");
    expect(find).toHaveBeenCalledWith({ serviceId: "long", fromDate: "2030-03-01", toDate: "2030-03-03", practitionerId: null });
    expect(onSelect).not.toHaveBeenCalled();
    await click("1:30 PM · Maya");
    expect(onSelect).toHaveBeenCalledWith(opening);
  });

  it("keeps a late response from restoring an opening for an earlier search", async () => {
    let finish!: (r: { ok: true; openings: CalendarOpening[] }) => void;
    find.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await mount();
    await click("Search availability");
    await chooseService("consult");
    await act(async () => finish({ ok: true, openings: [opening] }));
    expect(host.textContent).not.toContain("1:30 PM");
    expect(button("Search availability").disabled).toBe(false);
  });

  it("uses the current configured duration when rebooking, and returns a recoverable empty state", async () => {
    find.mockResolvedValue({ ok: true, openings: [] });
    await mount(true);
    expect(select().value).toBe("long");
    expect(host.textContent).toContain("previous appointment was 50 minutes");
    expect(host.textContent).toContain("This service books for 45 minutes");
    await click("Search availability");
    expect(find.mock.calls[0][0].practitionerId).toBe("maya");
    expect(host.textContent).toContain("No openings match");
  });
});
