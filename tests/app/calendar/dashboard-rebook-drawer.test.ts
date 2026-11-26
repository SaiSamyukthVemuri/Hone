// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickBookDrawer } from "@/app/(app)/calendar/QuickBookDrawer";
import { DashboardRebookContext } from "@/app/(app)/calendar/dashboard-rebook-context";
import type { DashboardRebook } from "@/lib/calendar/dashboard-rebook";
import type { Service } from "@/lib/types/database";

const calls = vi.hoisted(() => ({
  book: vi.fn(), slots: vi.fn(), target: vi.fn(), last: vi.fn(), replace: vi.fn(), refresh: vi.fn(), close: vi.fn(),
}));
vi.mock("next/navigation", () => ({useRouter: () => ({replace: calls.replace, refresh: calls.refresh})}));
vi.mock("@/app/(app)/calendar/actions", () => ({
  bookAppointmentForClientAction: calls.book, createClientForCalendarBookingAction: vi.fn(), fetchLastServiceForClientAction: calls.last,
}));
vi.mock("@/app/(app)/clients/[id]/booking-actions", () => ({
  fetchSlotsForClientBookingAction: calls.slots, fetchEligiblePractitionersAction: calls.target,
}));

const id = "ec1f43d5-3d33-4096-a3d1-3f37ebd4fa65";
const origin: DashboardRebook = {
  appointmentId: id, dashboardHref: `/dashboard?day=2030-01-16#appointment-${id}`, clientId: "person",
  clientName: "Mo", serviceId: "treatment", practitionerId: "practitioner", durationMinutes: 30, next: null,
};
const slot = {start: "2040-02-05T15:00:00Z", end: "2040-02-05T15:30:00Z", startLabel: "10:00"};
const services = ["consultation", "treatment"].map((id) => ({id, name: id, modality: id, default_duration_minutes: 30, price_cents: 5000})) as Service[];
let root: Root;
let host: HTMLDivElement;
const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent === label)!;

async function mount(context: DashboardRebook = origin) {
  await act(async () => root.render(createElement(DashboardRebookContext.Provider, {value: context},
    createElement(QuickBookDrawer, {
      open: true, draft: {localDate: "2040-02-05", localTime: "10:00"}, clients: [], services,
      studioTimezone: "America/Toronto", timeFormat: "24h", practitionerCapacityEnabled: true,
      isOwner: true, currentPractitionerId: "owner", currentPractitionerName: "Owner", onClose: calls.close,
    }))));
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  calls.target.mockResolvedValue({ok: true, practitioners: [{id: "owner", displayName: "Owner"}, {id: "practitioner", displayName: "Practitioner"}]});
  calls.slots.mockResolvedValue({ok: true, slots: [slot]});
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("booking another visit from the dashboard", () => {
  it("fills in the client, service and eligible practitioner, then returns to the exact source row only on success", async () => {
    calls.book.mockResolvedValue({ok: true});
    await mount();
    expect(host.textContent).toContain("Mo");
    expect(host.querySelector('[data-testid="assigned-practitioner"]')?.textContent).toContain("Practitioner");
    expect(calls.slots).toHaveBeenCalledWith({serviceId: "treatment", date: "2040-02-05", practitionerId: "practitioner"});
    expect(button("Book appointment").disabled).toBe(false);
    await act(async () => button("Book appointment").click());
    const form = calls.book.mock.calls[0][0] as FormData;
    expect(Object.fromEntries(form)).toEqual({client_id: "person", service_id: "treatment", practitioner_id: "practitioner", starts_at: slot.start});
    expect(calls.replace).toHaveBeenCalledWith(origin.dashboardHref);
    expect(calls.refresh).not.toHaveBeenCalled();
  });

  it("keeps a lost slot in the drawer, shows the error, and clears the attempted time", async () => {
    calls.book.mockResolvedValue({ok: false, error: "That time was just taken."});
    await mount();
    await act(async () => button("Book appointment").click());
    expect(host.textContent).toContain("That time was just taken.");
    expect(button("Book appointment").disabled).toBe(true);
    expect(calls.slots).toHaveBeenCalledTimes(2);
    expect(calls.replace).not.toHaveBeenCalled();
    expect(calls.close).not.toHaveBeenCalled();
  });

  it("prefills a previous custom duration and requires explicit override confirmation", async () => {
    await mount({...origin, durationMinutes: 45});
    expect(host.querySelector<HTMLInputElement>("#override-duration")?.value).toBe("45");
    expect(button("Book appointment").disabled).toBe(true);
    expect(calls.book).not.toHaveBeenCalled();
  });
});
