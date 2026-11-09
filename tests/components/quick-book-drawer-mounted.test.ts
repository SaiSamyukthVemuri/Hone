// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { Service } from "@/lib/types/database";

const book = vi.fn<(data: FormData) => Promise<{ ok: boolean }>>();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/(app)/clients/[id]/booking-actions", () => ({
  fetchSlotsForClientBookingAction: async () => ({ ok: true, slots: [] }),
  fetchEligiblePractitionersAction: async () => ({
    ok: true,
    practitioners: [{ id: "owner", displayName: "Owner" }],
  }),
}));
vi.mock("@/app/(app)/calendar/actions", () => ({
  bookAppointmentForClientAction: (data: FormData) => book(data),
  createClientForCalendarBookingAction: vi.fn(),
  fetchLastServiceForClientAction: async () => ({ ok: true, lastService: null }),
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QuickBookDrawer } = await import("@/app/(app)/calendar/QuickBookDrawer");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each([
  { mode: "typed", value: "3:37 PM", startsAt: "2030-11-11T20:37:00.000Z" },
  { mode: "picker", value: "15:30:00", startsAt: "2030-11-11T20:30:00.000Z" },
])("accepts a $mode custom time and submits it after acknowledgement", async ({ mode, value, startsAt }) => {
  book.mockReset().mockResolvedValue({ ok: true });
  refresh.mockClear();
  const onClose = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const button = (name: string) => [...host.querySelectorAll("button")].find((el) => el.textContent === name)!;
  const checkbox = (text: string) => [...host.querySelectorAll("label")]
    .find((el) => el.textContent?.includes(text))!
    .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const changeInput = async (selector: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(selector)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  try {
    await act(async () => {
      root.render(createElement(QuickBookDrawer, {
        open: true,
        draft: { localDate: "2030-11-11", localTime: "10:00" },
        clients: [{ id: "client", name: "Synthetic client", email: null, phone: null, pronouns: null }],
        services: [{ id: "service", name: "Treatment", default_duration_minutes: 45 } as Service],
        studioTimezone: "America/Toronto",
        timeFormat: "12h",
        practitionerCapacityEnabled: true,
        isOwner: true,
        currentPractitionerId: "owner",
        currentPractitionerName: "Owner",
        onClose,
      }));
    });
    await changeInput("input[type=search]", "Synthetic");
    const client = [...host.querySelectorAll("li button")].find((el) => el.textContent?.startsWith("Synthetic client"))!;
    await act(async () => client.click());
    await act(async () => checkbox("Outside your regular availability").click());
    if (mode === "typed") {
      await act(async () => button("Type a time instead").click());
      await changeInput("#override-time", "3:37");
      expect(host.querySelector('[role="status"]')!.textContent).toContain("Enter a valid start time");
      expect(button("Book appointment").disabled).toBe(true);
    }
    await changeInput("#override-time", value);
    expect(host.querySelector('[role="status"]')!.textContent).toContain("Confirm");
    expect(button("Book appointment").disabled).toBe(true);
    expect(book).not.toHaveBeenCalled();

    await act(async () => checkbox("I understand").click());
    expect(button("Book appointment").disabled).toBe(false);
    await act(async () => button("Book appointment").click());

    expect(book).toHaveBeenCalledOnce();
    expect(Object.fromEntries(book.mock.calls[0][0])).toEqual({
      client_id: "client",
      service_id: "service",
      practitioner_id: "owner",
      starts_at: startsAt,
      allow_outside_availability: "true",
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
