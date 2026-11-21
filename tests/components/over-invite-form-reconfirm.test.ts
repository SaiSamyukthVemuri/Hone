import { describe, expect, it, vi } from "vitest";

// After the server asks again, the form must show the SERVER's numbers (fit, active and the count it can actually invite), and the hidden "shown"
// numbers it will post next must match what is displayed, so a second confirm is a confirm of what the owner can see.

const h = vi.hoisted(() => ({ result: { state: "idle" } as unknown }));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return { ...actual, useActionState: () => [h.result, () => {}, false] };
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { OverInviteForm } = await import("@/components/waitlist/over-invite-form");

const props = {
  action: async () => ({ state: "idle" as const }),
  candidates: [],
  fit: 5,
  active: 8,
  expiringSoon: 1,
  batchKey: "33333333-3333-4333-8333-333333333333",
  scope: { serviceId: "00000000-0000-4000-8000-000000000900", windowDays: 7, allowedWeekdays: null },
};
const render = () => renderToStaticMarkup(createElement(OverInviteForm, props));
const hidden = (html: string, name: string) => new RegExp(`name="${name}" value="(\\d+)"`).exec(html)?.[1];

describe("the form after a re-ask", () => {
  it("shows the server's fit, active and admissible count, and posts exactly those as the new shown numbers", () => {
    h.result = { state: "reconfirm", notice: "The numbers changed since you looked.", fit: 2, active: 11, extra: 7, expiringSoon: 3 };
    const html = render();
    expect(hidden(html, "shownFit")).toBe("2");
    expect(hidden(html, "shownActive")).toBe("11");
    expect(hidden(html, "shownExtra")).toBe("7"); // the server's admissible count, not the 0 currently chosen
    expect(html).toContain("The numbers changed since you looked.");
  });
  it("without a re-ask the numbers are the ones the page was rendered with", () => {
    h.result = { state: "idle" };
    const html = render();
    expect(hidden(html, "shownFit")).toBe("5");
    expect(hidden(html, "shownActive")).toBe("8");
    expect(hidden(html, "shownExtra")).toBe("0");
  });
});
