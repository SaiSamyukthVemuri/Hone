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
const dateInput = (which: "From" | "Through") =>
  [...host.querySelectorAll("label")].find((l) => l.textContent?.trim().startsWith(which))!.querySelector<HTMLInputElement>("input")!;
const setDate = async (which: "From" | "Through", value: string) => {
  await act(async () => {
    const input = dateInput(which);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const choosePractitioner = async (id: string) => {
  const practitioner = host.querySelectorAll("select")[1] as HTMLSelectElement;
  await act(async () => {
    practitioner.value = id;
    practitioner.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const alerts = () => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
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

// HON-131: the search window is up to seven days. The form says so, checks it itself and says what to change beside the field, instead of leaving it to the browser's bubble.
describe("calendar Find time: the 7-day window", () => {
  it("states the window beside the fields and leaves the checking to the form, not the browser", async () => {
    await mount();
    expect(host.textContent).toContain("Search up to 7 days at a time.");
    expect(host.querySelector("form")!.noValidate).toBe(true);
    expect(dateInput("Through").hasAttribute("max")).toBe(false);
    expect(alerts()).toEqual([]);
  });

  it("names the fix and the latest allowed date when Through alone runs past the window, sends nothing and keeps the selections", async () => {
    await mount();
    await chooseService("consult");
    await choosePractitioner("ava");
    await setDate("Through", "2030-03-18");
    expect(alerts()).toEqual(["You can search up to 7 days at a time. The latest Through date for this From is Mar 7. To search a later week, move From later."]);
    expect(dateInput("Through").getAttribute("aria-invalid")).toBe("true");
    expect(dateInput("Through").getAttribute("aria-describedby")).toContain("find-time-through-error");
    await click("Search availability");
    expect(find).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(dateInput("Through"));
    expect(select().value).toBe("consult");
    expect((host.querySelectorAll("select")[1] as HTMLSelectElement).value).toBe("ava");
    expect(dateInput("From").value).toBe("2030-03-01");
    expect(dateInput("Through").value).toBe("2030-03-18"); // what was typed is never rewritten
  });

  it("says what to change when Through is before From", async () => {
    await mount();
    await setDate("Through", "2030-02-27");
    expect(alerts()).toEqual(["Through can't be before From. Choose Mar 1 to Mar 7."]);
    await click("Search availability");
    expect(find).not.toHaveBeenCalled();
  });

  it("moves Through with From when it would become invalid, says so politely, keeps the selections and then searches", async () => {
    find.mockResolvedValue({ ok: true, openings: [] });
    await mount();
    await chooseService("consult");
    await choosePractitioner("ava");
    await setDate("From", "2030-03-20");
    expect(dateInput("Through").value).toBe("2030-03-22");
    const notice = host.querySelector('[data-testid="find-time-notice"]')!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("aria-live")).toBe("polite");
    expect(notice.textContent).toBe("Through moved to Mar 22 so the search stays within 7 days of Mar 20.");
    expect(alerts()).toEqual([]);
    expect(select().value).toBe("consult");
    await click("Search availability");
    expect(find).toHaveBeenCalledWith({ serviceId: "consult", fromDate: "2030-03-20", toDate: "2030-03-22", practitionerId: "ava" });
    expect(notice.textContent).toBe(""); // a finished search clears the note
  });

  it("does not announce a move when Through is still inside the window", async () => {
    await mount();
    await setDate("From", "2030-03-02");
    expect(dateInput("Through").value).toBe("2030-03-03");
    expect(host.querySelector('[data-testid="find-time-notice"]')!.textContent).toBe("");
  });

  it.each([7, 14, 21, 28, 35, 41])("searches a week starting %i days from today, up to the full seven days", async (offset) => {
    find.mockResolvedValue({ ok: true, openings: [] });
    await mount();
    const from = addDays("2030-02-01", offset);
    const through = addDays(from, 6);
    await setDate("From", from);
    await setDate("Through", through);
    expect(alerts()).toEqual([]);
    await click("Search availability");
    expect(find).toHaveBeenCalledWith({ serviceId: "short", fromDate: from, toDate: through, practitionerId: null });
  });

  it("refuses an eighth day and a From before today with a message, not a request", async () => {
    await mount();
    await setDate("Through", "2030-03-08");
    expect(alerts()[0]).toContain("The latest Through date for this From is Mar 7.");
    await setDate("Through", "2030-03-03");
    await setDate("From", "2030-01-15");
    expect(alerts()).toEqual(["From can't be before today. Choose Feb 1 or later."]);
    await click("Search availability");
    expect(find).not.toHaveBeenCalled();
  });
});
