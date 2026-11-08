// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { registeredGuardCount, useUnsavedGuard } from "@/lib/sessions/use-unsaved-guard";

// Codex, #1369 4505287597: two dirty BlockSection editors each mounted their own Navigation-API guard. Both cancelled Back and
// opened a dialog; confirming one armed only that form's replay flag, so the other guard cancelled the replay, and confirming
// the second re-cancelled the first. The listeners are now owned ONCE by a module-level coordinator the dirty forms register with.
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fake = EventTarget & { currentEntry: { index: number }; traverseTo: ReturnType<typeof vi.fn> };
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  delete (window as unknown as { navigation?: unknown }).navigation;
  vi.restoreAllMocks();
});

function installNav(): Fake {
  const nav = Object.assign(new EventTarget(), { currentEntry: { index: 5 }, traverseTo: vi.fn() }) as Fake;
  (window as unknown as { navigation: unknown }).navigation = nav;
  return nav;
}
function Form({ dirty, onLeave }: { dirty: boolean; onLeave: (proceed: () => void) => void }) {
  useUnsavedGuard(dirty, onLeave);
  return null;
}
async function mountForms(forms: Array<{ dirty: boolean; onLeave: (proceed: () => void) => void }>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement("div", null, ...forms.map((f, i) => createElement(Form, { key: i, ...f }))));
  });
}
const back = (nav: Fake) => {
  const ev = Object.assign(new Event("navigate", { cancelable: true }), { navigationType: "traverse", destination: { key: "k4" } });
  act(() => {
    nav.dispatchEvent(ev);
  });
  return ev;
};

describe("one coordinator for every dirty form", () => {
  it("two dirty forms, Back: ONE dialog; Leave replays the traversal exactly once and nothing re-cancels it", async () => {
    const nav = installNav();
    const proceeds: Array<() => void> = [];
    const a = vi.fn((p: () => void) => proceeds.push(p));
    const b = vi.fn((p: () => void) => proceeds.push(p));
    await mountForms([{ dirty: true, onLeave: a }, { dirty: true, onLeave: b }]);
    expect(registeredGuardCount()).toBe(2);
    expect(back(nav).defaultPrevented, "the traversal is held").toBe(true);
    expect(a.mock.calls.length + b.mock.calls.length, "one dialog for both forms").toBe(1);
    expect(a, "the first-registered form asks").toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(nav.traverseTo).not.toHaveBeenCalled();
    proceeds[0]();
    expect(nav.traverseTo, "one replay").toHaveBeenCalledTimes(1);
    expect(nav.traverseTo).toHaveBeenCalledWith("k4");
    expect(back(nav).defaultPrevented, "the replayed traversal is let through, not re-cancelled").toBe(false);
    expect(a.mock.calls.length + b.mock.calls.length, "and no second dialog opened").toBe(1);
  });

  it("two dirty forms, Back, Stay: one dialog, nothing replayed, and the next Back asks again", async () => {
    const nav = installNav();
    const a = vi.fn();
    const b = vi.fn();
    await mountForms([{ dirty: true, onLeave: a }, { dirty: true, onLeave: b }]);
    expect(back(nav).defaultPrevented).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
    expect(nav.traverseTo).not.toHaveBeenCalled();
    expect(back(nav).defaultPrevented, "still guarded after Stay").toBe(true);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).not.toHaveBeenCalled();
  });

  it("one dirty form and one clean form: only the dirty one is registered and asks", async () => {
    const nav = installNav();
    const clean = vi.fn();
    const dirty = vi.fn();
    await mountForms([{ dirty: false, onLeave: clean }, { dirty: true, onLeave: dirty }]);
    expect(registeredGuardCount()).toBe(1);
    expect(back(nav).defaultPrevented).toBe(true);
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(clean).not.toHaveBeenCalled();
  });

  it("a link click with two dirty forms also opens ONE dialog", async () => {
    installNav();
    const a = vi.fn();
    const b = vi.fn();
    await mountForms([{ dirty: true, onLeave: a }, { dirty: true, onLeave: b }]);
    const link = document.createElement("a");
    link.href = `${window.location.origin}/elsewhere`;
    document.body.appendChild(link);
    act(() => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    link.remove();
    expect(a.mock.calls.length + b.mock.calls.length).toBe(1);
  });

  it("when the last dirty form goes clean, the listeners are removed", async () => {
    const nav = installNav();
    const a = vi.fn();
    await mountForms([{ dirty: true, onLeave: a }]);
    await act(async () => {
      root!.render(createElement("div", null, createElement(Form, { dirty: false, onLeave: a })));
    });
    expect(registeredGuardCount()).toBe(0);
    expect(back(nav).defaultPrevented, "nothing is held once no form is dirty").toBe(false);
    expect(a).not.toHaveBeenCalled();
  });
});
