// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const loadSlots = vi.fn();
const move = vi.fn();
vi.mock("@/app/(app)/calendar/move-appointment-actions", () => ({
  loadMoveSlotsAction: (...args: unknown[]) => loadSlots(...args),
  moveAppointmentAction: (...args: unknown[]) => move(...args),
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: MoveAppointmentDialog } = await import("@/app/(app)/calendar/MoveAppointmentDialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("lets an owner type 3:30 PM and move the same appointment after acknowledging", async () => {
  loadSlots.mockResolvedValue({
    ok: true,
    slots: [],
    canUseCustomTime: true,
    reassignEnabled: true,
    eligiblePractitioners: [{ id: "practitioner", displayName: "Owner" }],
    holderMustBeValid: true,
    currentPractitionerId: "practitioner",
    currentPractitionerValid: true,
  });
  move.mockResolvedValue({ ok: true });
  const onMoved = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const button = (name: string) => [...host.querySelectorAll("button")].find((el) => el.textContent === name)!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const change = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  try {
    await act(async () => {
      root.render(createElement(MoveAppointmentDialog, {
        open: true,
        onClose: vi.fn(),
        onMoved,
        appointment: {
          id: "appointment",
          startsAt: "2030-11-09T19:00:00Z",
          endsAt: "2030-11-09T19:45:00Z",
          durationMinutes: 45,
          clientName: null,
          serviceName: null,
        },
        studioTimezone: "America/Toronto",
        timeFormat: "12h",
      }));
    });
    await act(async () => button("Custom time").click());
    await act(async () => button("Type a time instead").click());
    await change(host.querySelector('input[type="date"]')!, "2030-11-11");
    const time = host.querySelector<HTMLInputElement>('input[aria-label="Custom time"]')!;
    expect(time.type).toBe("text");
    await change(time, "3:30 PM");
    expect(button("Move appointment").disabled).toBe(true);
    expect(move).not.toHaveBeenCalled();

    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(button("Move appointment").disabled).toBe(false);
    await act(async () => button("Move appointment").click());

    expect(move).toHaveBeenCalledExactlyOnceWith({
      appointmentId: "appointment",
      expectedStartsAt: "2030-11-09T19:00:00Z",
      expectedEndsAt: "2030-11-09T19:45:00Z",
      localDate: "2030-11-11",
      localTime: "15:30",
      mode: "custom_time",
      outsideAvailabilityConfirmed: true,
      targetPractitionerId: "practitioner",
    });
    expect(onMoved).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
