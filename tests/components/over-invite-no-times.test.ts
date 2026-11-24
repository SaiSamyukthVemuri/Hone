import { describe, expect, it, vi } from "vitest";
import { buildScopeSummary } from "@/lib/waitlist/over-invite-preview";

const h = vi.hoisted(() => ({ result: { state: "idle" } as unknown }));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return { ...actual, useActionState: () => [h.result, () => {}, false] };
});
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { OverInviteForm } = await import("@/components/waitlist/over-invite-form");
const { OVER_INVITE_NO_TIMES_LABEL } = await import("@/components/waitlist/over-invite-confirm");

const base = {
  action: async () => ({ state: "idle" as const }),
  candidates: [],
  active: 0,
  expiringSoon: 0,
  batchKey: "33333333-3333-4333-8333-333333333333",
  scope: { serviceId: "00000000-0000-4000-8000-000000000900", windowDays: 14, allowedWeekdays: null as number[] | null },
  serviceName: "Intake consultation",
};
const render = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(OverInviteForm, { ...base, fit: 0, ...over } as never));

describe("the acknowledgement at a zero estimate", () => {
  it("is worded exactly, and is a checkbox the server reads as ackNoTimes", () => {
    expect(OVER_INVITE_NO_TIMES_LABEL).toBe("These clients may open the invitation and find no times to book.");
    const html = render();
    expect(html).toContain('data-testid="over-invite-no-times"');
    expect(html).toContain('name="ackNoTimes"');
    expect(html).toContain(OVER_INVITE_NO_TIMES_LABEL);
  });
  it("is not shown when appointments are estimated", () => {
    const html = render({ fit: 4 });
    expect(html).not.toContain("ackNoTimes");
    expect(html).not.toContain(OVER_INVITE_NO_TIMES_LABEL);
  });
  it("sits beside, never in place of, the existing confirmation", () => {
    const html = render();
    expect(html).toContain('name="confirmed"');
    expect(html).toContain('name="ackNoTimes"');
  });
  it("shows the service, the booking window and the number selected before the send", () => {
    const html = render();
    expect(html).toContain('data-testid="over-invite-scope"');
    expect(html).toContain("Service: Intake consultation");
    expect(html).toContain("Booking window: next 14 days, any day");
    expect(html).toContain("People selected: 0");
  });
});

describe("buildScopeSummary", () => {
  it("names the weekdays when the offer is limited, and counts one day in the singular", () => {
    expect(buildScopeSummary({ serviceName: "X", windowDays: 1, allowedWeekdays: [1, 3], selected: 2 })).toEqual({
      service: "Service: X",
      window: "Booking window: next 1 day, Monday, Wednesday",
      people: "People selected: 2",
    });
  });
  it("never prints a negative or fractional count", () => {
    expect(buildScopeSummary({ serviceName: "X", windowDays: 7, allowedWeekdays: null, selected: -3 }).people).toBe("People selected: 0");
  });
});
