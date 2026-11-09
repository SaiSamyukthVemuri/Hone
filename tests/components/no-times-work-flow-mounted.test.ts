// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MOUNTED (jsdom, this file only). The recipient's two-choice flow (HON-7): choices first; "None of these times work" only REVEALS the questions
// (client state, no request, no record); "Send response" sends; "I no longer need an appointment" goes straight to the existing withdrawal
// confirmation with no question asked; Back returns to the choices. The server actions are mocked; no server, no database.

const loadAction = vi.fn();
const noTimesWork = vi.fn();
const noLongerNeed = vi.fn();
const bookAction = vi.fn();
vi.mock("@/app/invitation/[token]/actions", () => ({
  bookInvitationSlotAction: (...a: unknown[]) => bookAction(...a),
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
const { NO_TIMES_WORK_NOTICE, DECLINE_CONFIRMATION, WITHDRAWAL_CONFIRMATION } = await import("@/lib/waitlist/decline-copy");
const { ANSWER_PROBLEM_COPY, NO_TIMES_WORK_LABELS } = await import("@/lib/waitlist/decline-responses");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLOT = { start: "2026-09-07T14:00:00.000Z", end: "2026-09-07T14:30:00.000Z", startLabel: "10:00 AM" };
const offer = () =>
  ({
    kind: "offer",
    presentation: { studioName: "Studio", serviceName: "Consultation", serviceDurationMinutes: 30, studioTimezone: "America/Toronto" },
    days: [{ date: "2026-09-07", dateLabel: "Mon, Sep 7", slots: [SLOT] }],
    windowDescription: "Mondays",
  }) as never;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const TOKEN = "t".repeat(64);

beforeEach(() => {
  for (const m of [loadAction, noTimesWork, noLongerNeed, bookAction]) m.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function mount(declineAnswers = true) {
  await act(async () => {
    root.render(createElement(InvitationContainer, { token: TOKEN, initial: offer(), declineAnswers }));
  });
}
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const click = async (el: HTMLElement | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const area = (id: "why" | "better") => host.querySelector(`#no-times-${id}`) as HTMLTextAreaElement | null;
const type = async (el: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");

describe("the two choices come first", () => {
  it("shows both choices and no question, no field and no notice", async () => {
    await mount();
    expect(button("None of these times work")).toBeTruthy();
    expect(button(NO_TIMES_WORK_LABELS.noLongerNeed)).toBeTruthy();
    expect(host.querySelector("textarea")).toBeNull();
    expect(text()).not.toContain(NO_TIMES_WORK_LABELS.why);
    expect(text()).not.toContain(NO_TIMES_WORK_NOTICE);
    expect(button("Send response")).toBeUndefined();
  });
});

describe("path 1: None of these times work", () => {
  it("only reveals the two required questions and the notice: nothing is requested or recorded", async () => {
    await mount();
    await click(button("None of these times work"));
    expect(area("why")).toBeTruthy();
    expect(area("better")).toBeTruthy();
    expect(area("why")!.required).toBe(true);
    expect(area("better")!.required).toBe(true);
    expect(text()).toContain(NO_TIMES_WORK_LABELS.why);
    expect(text()).toContain(NO_TIMES_WORK_LABELS.better);
    expect(text()).toContain(NO_TIMES_WORK_NOTICE);
    expect(button("Send response")).toBeTruthy();
    for (const m of [noTimesWork, noLongerNeed, loadAction, bookAction]) expect(m).not.toHaveBeenCalled();
  });
  it("moves focus into the first question when it opens", async () => {
    await mount();
    await click(button("None of these times work"));
    expect(document.activeElement).toBe(area("why"));
  });
  it("refuses a missing answer with an announced error, focuses the first missing field and sends nothing", async () => {
    await mount();
    await click(button("None of these times work"));
    await type(area("why")!, "The mornings clash");
    await click(button("Send response"));
    expect(noTimesWork).not.toHaveBeenCalled();
    const err = host.querySelector("#no-times-better-error") as HTMLElement;
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toBe(ANSWER_PROBLEM_COPY.required);
    expect(area("better")!.getAttribute("aria-invalid")).toBe("true");
    expect(area("better")!.getAttribute("aria-describedby")).toBe("no-times-better-error");
    expect(document.activeElement).toBe(area("better"));
    expect(host.querySelector("#no-times-why-error")).toBeNull();
  });
  it("refuses both missing, focusing the first", async () => {
    await mount();
    await click(button("None of these times work"));
    await click(button("Send response"));
    expect(noTimesWork).not.toHaveBeenCalled();
    expect(host.querySelector("#no-times-why-error")?.getAttribute("role")).toBe("alert");
    expect(host.querySelector("#no-times-better-error")?.getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(area("why"));
  });
  it("sends both trimmed answers once, only when Send response is pressed, and shows the existing confirmation", async () => {
    noTimesWork.mockResolvedValue({ kind: "declined", keptOnList: true, answered: "answers" });
    await mount();
    await click(button("None of these times work"));
    await type(area("why")!, "  The mornings clash ");
    await type(area("better")!, " Tuesdays after 3 ");
    expect(noTimesWork).not.toHaveBeenCalled();
    await click(button("Send response"));
    expect(noTimesWork).toHaveBeenCalledTimes(1);
    expect(noTimesWork).toHaveBeenCalledWith(TOKEN, "The mornings clash", "Tuesdays after 3");
    expect(noLongerNeed).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="declined-answers"]')).toBeTruthy();
    expect(text()).toContain(DECLINE_CONFIRMATION);
  });
});

describe("path 2: I no longer need an appointment", () => {
  it("goes straight to the withdrawal action and its confirmation, asking neither question", async () => {
    noLongerNeed.mockResolvedValue({ kind: "declined", keptOnList: false, answered: "withdrawal" });
    await mount();
    await click(button(NO_TIMES_WORK_LABELS.noLongerNeed));
    expect(noLongerNeed).toHaveBeenCalledTimes(1);
    expect(noLongerNeed).toHaveBeenCalledWith(TOKEN);
    expect(noTimesWork).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector('[data-testid="declined-withdrawal"]')).toBeTruthy();
    expect(text()).toContain(WITHDRAWAL_CONFIRMATION);
  });
});

describe("path 3: going back", () => {
  it("returns to the two choices, hides the questions, sends nothing, and puts focus back on the opening choice", async () => {
    await mount();
    await click(button("None of these times work"));
    await click(button("Back"));
    expect(host.querySelector("textarea")).toBeNull();
    expect(button("None of these times work")).toBeTruthy();
    expect(button(NO_TIMES_WORK_LABELS.noLongerNeed)).toBeTruthy();
    expect(document.activeElement).toBe(button("None of these times work"));
    for (const m of [noTimesWork, noLongerNeed]) expect(m).not.toHaveBeenCalled();
  });
  it("can withdraw after going back, still without questions", async () => {
    noLongerNeed.mockResolvedValue({ kind: "declined", keptOnList: false, answered: "withdrawal" });
    await mount();
    await click(button("None of these times work"));
    await click(button("Back"));
    await click(button(NO_TIMES_WORK_LABELS.noLongerNeed));
    expect(noLongerNeed).toHaveBeenCalledTimes(1);
    expect(noTimesWork).not.toHaveBeenCalled();
  });
});

describe("flag off is unchanged", () => {
  it("does not render the form or either choice", async () => {
    await mount(false);
    expect(host.querySelector('[data-testid="no-times-work-form"]')).toBeNull();
    expect(button(NO_TIMES_WORK_LABELS.noLongerNeed)).toBeUndefined();
    expect(button("Send response")).toBeUndefined();
  });
});
