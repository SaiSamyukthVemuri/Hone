import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Codex #1303 round 2: after a successful MOVE the row (same appointment, still confirmed) must offer
// Move and Cancel again. The component's own state used to treat a move as terminal, and the re-key
// alone did not help when the refreshed row kept the component mounted. Synthetic values only.

const s = vi.hoisted(() => ({
  moved: { status: "idle" } as { status: string; message?: string },
  cancelled: { status: "idle" } as { status: string; message?: string },
}));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  let call = 0;
  return {
    ...actual,
    useEffect: () => undefined,
    useActionState: () => [call++ % 2 === 0 ? s.moved : s.cancelled, () => undefined, false],
  };
});
vi.mock("@/app/(desk)/desk/actions", () => ({ moveAppointmentAction: async () => ({ status: "idle" }), cancelAppointmentAction: async () => ({ status: "idle" }) }));

import { ScheduleRowActions } from "@/app/(desk)/desk/ScheduleRowActions";

const render = () =>
  renderToStaticMarkup(
    createElement(ScheduleRowActions, {
      appointmentId: "a1", practitionerId: "p1", startsAt: "2030-01-01T15:00:00Z", endsAt: "2030-01-01T16:00:00Z",
      date: "2030-01-01", time: "10:00", practitioners: [{ id: "p1", name: "Pat", color: null }], timezone: "America/Toronto",
    }),
  );

beforeEach(() => {
  s.moved = { status: "idle" };
  s.cancelled = { status: "idle" };
});

describe("row actions after a move or a cancel", () => {
  it("control: idle row offers Move and Cancel", () => {
    const html = render();
    expect(html).toContain(">Move<");
    expect(html).toContain(">Cancel<");
  });
  it("a successfully MOVED row offers Move and Cancel again, with the success message", () => {
    s.moved = { status: "ok", message: "Appointment moved." };
    const html = render();
    expect(html).toContain(">Move<");
    expect(html).toContain(">Cancel<");
    expect(html).toContain("Appointment moved.");
  });
  it("a CANCELLED row is terminal: no Move or Cancel, message shown", () => {
    s.cancelled = { status: "ok", message: "Appointment cancelled." };
    const html = render();
    expect(html).not.toContain(">Move<");
    expect(html).not.toContain(">Cancel<");
    expect(html).toContain("Appointment cancelled.");
  });
});
