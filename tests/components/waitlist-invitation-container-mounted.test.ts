// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MOUNTED (jsdom, this file only). The container's background refresh and the
// reply note: a half-typed note must survive a tab-return refresh and the pending
// state, a failed background read must keep the offer, and the refresh is
// throttled. The actions module is mocked; no server, no database.

const load = vi.fn();
const timesDontWork = vi.fn();
const bookAction = vi.fn();
vi.mock("@/app/invitation/[token]/actions", () => ({
  bookInvitationSlotAction: (...a: unknown[]) => bookAction(...a),
  declineInvitationAction: vi.fn(),
  loadInvitationAction: (...a: unknown[]) => load(...a),
  requestInvitationProofAction: vi.fn(),
  submitInvitationProofAction: vi.fn(),
  timesDontWorkAction: (...a: unknown[]) => timesDontWork(...a),
}));

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { InvitationContainer, REFRESH_MIN_INTERVAL_MS } = await import(
  "@/app/invitation/[token]/InvitationContainer"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PRESENTATION = {
  studioName: "Studio",
  serviceName: "Consultation",
  serviceDurationMinutes: 30,
  studioTimezone: "America/Toronto",
};
const SLOT = { start: "2026-09-07T14:00:00.000Z", end: "2026-09-07T14:30:00.000Z", startLabel: "10:00 AM" };
const offer = (extra: Record<string, unknown> = {}) =>
  ({
    kind: "offer",
    presentation: PRESENTATION,
    days: [{ date: "2026-09-07", dateLabel: "Mon, Sep 7", slots: [SLOT] }],
    windowDescription: "Mondays",
    ...extra,
  }) as never;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let now = 1_000_000;

beforeEach(() => {
  load.mockReset();
  timesDontWork.mockReset();
  bookAction.mockReset();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(createElement(InvitationContainer, { token: "t".repeat(64), initial: offer(), timesFeedback: true }));
  });
}
const note = () => host.querySelector("textarea") as HTMLTextAreaElement | null;
async function type(value: string) {
  const el = note() as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function returnToTab() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("InvitationContainer background refresh", () => {
  it("keeps a half-typed reply note across a tab-return refresh", async () => {
    await mount();
    await type("Weekday evenings");
    load.mockResolvedValueOnce(offer({ noTimeDays: ["Tue, Sep 8"] }));
    await returnToTab();
    expect(load).toHaveBeenCalledTimes(1);
    expect(note()?.value).toBe("Weekday evenings");
    expect(host.textContent).toContain("Nothing is open on: Tue, Sep 8.");
  });

  it("keeps the note while the reply is pending, and after a refused save", async () => {
    await mount();
    await type("Mornings only");
    let release!: (v: unknown) => void;
    timesDontWork.mockReturnValueOnce(new Promise((r) => (release = r)));
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "These times don’t work")!;
    await act(async () => {
      btn.click();
    });
    expect(note()?.value).toBe("Mornings only");
    expect(note()?.disabled).toBe(true);
    await act(async () => {
      release(offer({ refusal: "feedback_unavailable" }));
    });
    expect(note()?.value).toBe("Mornings only");
    expect(note()?.disabled).toBe(false);
    expect(host.textContent).toContain("Nothing has changed");
  });

  it("a FAILED background read keeps the offer; it does not swap to the error screen", async () => {
    await mount();
    await type("keep me");
    load.mockResolvedValueOnce({ kind: "error", retryable: true });
    await returnToTab();
    expect(note()?.value).toBe("keep me");
    expect(host.textContent).not.toContain("couldn");
    expect(host.querySelector('[data-testid="availability-note"]')).not.toBeNull();
  });

  it("a thrown background read also keeps the offer", async () => {
    await mount();
    load.mockRejectedValueOnce(new Error("network"));
    await returnToTab();
    expect(host.querySelector('[data-testid="availability-note"]')).not.toBeNull();
  });

  it("a read that began BEFORE a booking and lands AFTER it does not overwrite the booked screen", async () => {
    await mount();
    let landLate!: (v: unknown) => void;
    load.mockReturnValueOnce(new Promise((r) => (landLate = r)));
    await returnToTab(); // background read begins, unresolved
    expect(load).toHaveBeenCalledTimes(1);

    const slotBtn = host.querySelector('button[aria-label="Mon, Sep 7 at 10:00 AM"]') as HTMLButtonElement;
    await act(async () => {
      slotBtn.click();
    });
    bookAction.mockResolvedValueOnce({
      kind: "booked",
      presentation: PRESENTATION,
      startLabel: "10:00 AM",
      dateLabel: "Mon, Sep 7",
    });
    const book = [...host.querySelectorAll("button")].find((b) => b.textContent === "Book this time")!;
    await act(async () => {
      book.click();
    });
    expect(host.textContent).toContain("10:00 AM");
    expect(host.querySelector("textarea")).toBeNull(); // no longer an offer

    await act(async () => {
      landLate(offer({ noTimeDays: ["Tue, Sep 8"] }));
    });
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector('[data-testid="availability-note"]')).toBeNull();
  });

  it("is throttled: a second return inside the interval does not read again", async () => {
    await mount();
    load.mockResolvedValue(offer());
    await returnToTab();
    expect(load).toHaveBeenCalledTimes(1);
    now += REFRESH_MIN_INTERVAL_MS - 1;
    await returnToTab();
    expect(load).toHaveBeenCalledTimes(1);
    now += 2;
    await returnToTab();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
