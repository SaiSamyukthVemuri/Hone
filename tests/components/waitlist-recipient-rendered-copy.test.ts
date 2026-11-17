// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MOUNTED (jsdom). The recipient's screen, in each state a person reaches by pressing something, asserted on the TEXT on that screen.
// No assertion compares a constant with itself. The server actions are mocked; no server, no database.

const loadAction = vi.fn();
const noTimesWork = vi.fn();
const noLongerNeed = vi.fn();
vi.mock("@/app/invitation/[token]/actions", () => ({
  bookInvitationSlotAction: vi.fn(),
  declineInvitationAction: vi.fn(),
  loadInvitationAction: (...a: unknown[]) => loadAction(...a),
  requestInvitationProofAction: vi.fn(),
  submitInvitationProofAction: vi.fn(),
  timesDontWorkAction: vi.fn(),
  noTimesWorkAction: (...a: unknown[]) => noTimesWork(...a),
  noLongerNeedAction: (...a: unknown[]) => noLongerNeed(...a),
}));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { InvitationContainer } = await import("@/app/invitation/[token]/InvitationContainer");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLOT = { start: "2026-09-07T14:00:00.000Z", end: "2026-09-07T14:30:00.000Z", startLabel: "10:00 AM" };
const offer = (extra: Record<string, unknown> = {}) =>
  ({
    kind: "offer",
    presentation: { studioName: "Studio", serviceName: "Consultation", serviceDurationMinutes: 30, studioTimezone: "America/Toronto" },
    days: [{ date: "2026-09-07", dateLabel: "Mon, Sep 7", slots: [SLOT] }],
    windowDescription: "Mondays",
    ...extra,
  }) as never;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const TOKEN = "t".repeat(64);

beforeEach(() => {
  for (const m of [loadAction, noTimesWork, noLongerNeed]) m.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(createElement(InvitationContainer, { token: TOKEN, initial: offer(), declineAnswers: true }));
  });
}
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const click = async (el: HTMLElement | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const type = async (el: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const labels = () => [...host.querySelectorAll("label")].map((l) => l.textContent?.trim());

describe("the screen before and after 'None of these times work' is pressed", () => {
  it("shows the two choices and neither question first", async () => {
    await mount();
    expect(button("None of these times work")).toBeTruthy();
    expect(button("I no longer need an appointment")).toBeTruthy();
    expect(text()).not.toContain("Why don't these times work?");
    expect(text()).not.toContain("What days and times work better for you?");
  });
  it("then shows the notice first and the two questions, worded exactly, and Send response", async () => {
    await mount();
    await click(button("None of these times work"));
    expect(labels()).toEqual(["Why don't these times work?", "What days and times work better for you?"]);
    expect(text()).toContain("Within your studio, only the studio owner can see your answers.");
    expect(button("Send response")).toBeTruthy();
    // The notice is read before the first question.
    expect(text().indexOf("only the studio owner can see your answers")).toBeLessThan(text().indexOf("Why don't these times work?"));
  });
});

describe("the screen after 'I no longer need an appointment' is pressed", () => {
  it("asks nothing and shows the one neutral confirmation, word for word", async () => {
    noLongerNeed.mockResolvedValue({ kind: "declined", keptOnList: false, answered: "withdrawal" });
    await mount();
    await click(button("I no longer need an appointment"));
    expect(text()).toContain("Thanks. We've passed this on to the studio. Nothing is booked.");
    expect(host.querySelector("textarea")).toBeNull();
    // It does not claim they are still on the list.
    expect(text()).not.toContain("still on the waitlist");
  });
});

describe("the screen after 'Send response' succeeds", () => {
  it("shows the confirmation that nothing is booked and the person keeps their place, word for word", async () => {
    noTimesWork.mockResolvedValue({ kind: "declined", keptOnList: true, answered: "answers" });
    await mount();
    await click(button("None of these times work"));
    await type(host.querySelector("#no-times-why") as HTMLTextAreaElement, "The mornings clash");
    await type(host.querySelector("#no-times-better") as HTMLTextAreaElement, "Afternoons");
    await click(button("Send response"));
    expect(text()).toContain("Nothing is booked. You're still on the waitlist in your original place. The studio will contact you to arrange a suitable time.");
  });
});

describe("the screen when the response could not be saved", () => {
  it("says the message cannot be saved as written and still shows the offered time", async () => {
    noTimesWork.mockResolvedValue(offer({ refusal: "note_invalid" }));
    await mount();
    await click(button("None of these times work"));
    await type(host.querySelector("#no-times-why") as HTMLTextAreaElement, "The mornings clash");
    await type(host.querySelector("#no-times-better") as HTMLTextAreaElement, "Afternoons");
    await click(button("Send response"));
    expect(text()).toContain("Your message can’t be saved as written. Please use plain text and try again.");
    expect(text()).toContain("10:00 AM");
    expect(text()).not.toContain("Nothing is booked. You're still on the waitlist");
  });
});
