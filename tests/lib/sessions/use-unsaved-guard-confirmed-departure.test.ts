// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUnsavedGuard } from "@/lib/sessions/use-unsaved-guard";

// Codex, #1369 4475784173: after the practitioner confirms Leave in the app's own dialog, the confirmed navigation is a full document load, which
// fires beforeunload, and the browser asked a SECOND time. A confirmed departure must pass; an unconfirmed one must still be held.
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.restoreAllMocks();
});

function Probe({ onLeave }: { onLeave: (proceed: () => void) => void }) {
  useUnsavedGuard(true, onLeave);
  return createElement("a", { id: "x", href: "/elsewhere" }, "x");
}
const unload = () => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

describe("a confirmed departure is not asked about twice", () => {
  it("beforeunload is held while dirty, passes once the app's dialog was confirmed, and re-arms if the navigation does not happen", async () => {
    vi.useFakeTimers();
    let proceed: (() => void) | null = null;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(Probe, { onLeave: (p) => (proceed = p) }));
    });
    // Held while dirty (the control for the pass below).
    expect(unload()).toBe(true);
    // A click on an in-app link asks the app's dialog, not the browser.
    await act(async () => host!.querySelector<HTMLAnchorElement>("#x")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(proceed).not.toBeNull();
    // Confirm: the full-document load's beforeunload must not prompt.
    try {
      proceed!();
    } catch {
      /* jsdom does not implement navigation */
    }
    expect(unload()).toBe(false);
    // The navigation never happened: the guard re-arms.
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(unload()).toBe(true);
    vi.useRealTimers();
  });
});
