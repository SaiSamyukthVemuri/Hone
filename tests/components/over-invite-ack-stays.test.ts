// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OverInviteForm } from "@/components/waitlist/over-invite-form";
import type { OverInviteResult } from "@/lib/waitlist/over-invite-result";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The sequence that hid the acknowledgement: the page shows a NONZERO estimate, availability drops to zero before the send, the server asks again
// with the zero (reconfirm), the owner submits WITHOUT the new box, and the server answers with a plain notice. The notice carries no numbers, so
// the form must keep the zero it was last told, or it falls back to the page's nonzero estimate and hides the checkbox the notice asks for.
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const REASK: OverInviteResult = { state: "reconfirm", notice: "The numbers changed since you looked.", fit: 0, active: 0, extra: 2, expiringSoon: 0 };
const NEED: OverInviteResult = { state: "notice", notice: "Tick the box to confirm: These clients may open the invitation and find no times to book. Nothing was sent." };

async function mount(replies: OverInviteResult[]) {
  const posted: FormData[] = [];
  const action = async (_prev: OverInviteResult, fd: FormData) => {
    posted.push(fd);
    return replies.shift() ?? ({ state: "idle" } as OverInviteResult);
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(OverInviteForm, {
        action,
        candidates: [],
        fit: 5,
        active: 8,
        expiringSoon: 0,
        batchKey: "33333333-3333-4333-8333-333333333333",
        scope: { serviceId: "00000000-0000-4000-8000-000000000900", windowDays: 7, allowedWeekdays: null },
        serviceName: "Consultation",
      } as never),
    );
  });
  return { h: host, posted };
}
const submit = async (h: HTMLElement) => {
  await act(async () => {
    h.querySelector("form")!.requestSubmit();
  });
};
const ack = (h: HTMLElement) => h.querySelector('input[name="ackNoTimes"]');
const shownFit = (h: HTMLElement) => (h.querySelector('input[name="shownFit"]') as HTMLInputElement).value;

describe("the no-times acknowledgement stays while the estimate stays at zero", () => {
  it("nonzero page, then reconfirm to zero, then a notice without the box: the checkbox is STILL there and the zero is still shown", async () => {
    const { h, posted } = await mount([REASK, NEED]);
    expect(ack(h)).toBeNull();
    expect(shownFit(h)).toBe("5");

    await submit(h); // the server answers with the new zero
    expect(ack(h)).not.toBeNull();
    expect(shownFit(h)).toBe("0");

    await submit(h); // submitted WITHOUT ticking it: the server's notice
    expect(h.querySelector('[data-testid="over-invite-notice"]')?.textContent).toContain("find no times to book");
    expect(ack(h)).not.toBeNull();
    expect(shownFit(h)).toBe("0");
    expect(h.querySelector('[data-testid="over-invite-line"]')?.textContent).toContain("0 estimated appointments");
    expect(posted).toHaveLength(2);
  });
  it("the next submit posts the zero it was told, so the server does not ask again for the same numbers", async () => {
    const { h, posted } = await mount([REASK, NEED, { state: "idle" }]);
    await submit(h);
    await submit(h);
    await submit(h);
    expect(posted[2]!.get("shownFit")).toBe("0");
  });
});
