// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OverInviteConfirm } from "@/components/waitlist/over-invite-confirm";
import { buildOverInvitePreview } from "@/lib/waitlist/over-invite-preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const chooser = createElement("div", null, createElement("input", { type: "checkbox", id: "cb" }), createElement("input", { type: "text", id: "tx" }));
  act(() =>
    root!.render(
      createElement(OverInviteConfirm, { action: () => undefined, preview: buildOverInvitePreview({ fit: 0, active: 0, expiringSoon: 0, extra: 2 }), recipientChooser: chooser, batchKey: "k" }),
    ),
  );
  return host;
}
const enter = (el: Element) => {
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  act(() => void el.dispatchEvent(ev));
  return ev.defaultPrevented;
};

describe("OverInviteConfirm form-level Enter guard", () => {
  it("Enter on a checkbox, a text box or the confirmation box is blocked", () => {
    const h = mount();
    expect(enter(h.querySelector("#cb")!)).toBe(true);
    expect(enter(h.querySelector("#tx")!)).toBe(true);
    expect(enter(h.querySelector('input[name="confirmed"]')!)).toBe(true);
  });
  it("Enter on the submit button is left alone, so the button still submits", () => {
    const h = mount();
    expect(enter(h.querySelector('button[type="submit"]')!)).toBe(false);
  });
  it("other keys are never touched", () => {
    const h = mount();
    const ev = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    act(() => void h.querySelector("#cb")!.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(false);
  });
});
