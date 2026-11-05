// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { currentHistoryIndex, historyDelta, useUnsavedGuard } from "@/lib/sessions/use-unsaved-guard";

// Codex, #1369 4478075121: popstate carries no direction. The guard put the entry back with a fixed history.go(1), which is
// wrong for Forward (it must go back by one) and a NO-OP at the end of the stack, so Stay left the browser on the destination,
// Leave went the wrong way, and the "own move" flag stayed set so the next navigation slipped past the guard.
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("historyDelta", () => {
  it("Forward is positive, Back is negative, and a multi-step jump keeps its size", () => {
    expect(historyDelta(3, 4)).toBe(1);
    expect(historyDelta(3, 2)).toBe(-1);
    expect(historyDelta(3, 0)).toBe(-3);
  });
  it("unknown on either side is one step Back, the guard's original assumption", () => {
    expect(historyDelta(null, 2)).toBe(-1);
    expect(historyDelta(3, null)).toBe(-1);
  });
  it("the same entry is zero", () => {
    expect(historyDelta(3, 3)).toBe(0);
  });
});

describe("currentHistoryIndex", () => {
  it("prefers the Navigation API's entry index", () => {
    expect(currentHistoryIndex({ navigation: { currentEntry: { index: 7 } }, history: { state: { __unsavedGuardIdx: 2 } } })).toBe(7);
  });
  it("falls back to the index the guard stamped, and to null when there is none", () => {
    expect(currentHistoryIndex({ history: { state: { __unsavedGuardIdx: 2 } } })).toBe(2);
    expect(currentHistoryIndex({ history: { state: { other: 1 } } })).toBeNull();
    expect(currentHistoryIndex({ history: { state: null } })).toBeNull();
  });
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
let entry = 5;
let go: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  entry = 5;
  (window as unknown as { navigation: unknown }).navigation = {
    get currentEntry() {
      return { index: entry };
    },
  };
  // jsdom would really traverse history; record the request instead.
  go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  delete (window as unknown as { navigation?: unknown }).navigation;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function Probe({ onLeave }: { onLeave: (proceed: () => void) => void }) {
  useUnsavedGuard(true, onLeave);
  return null;
}

async function mount(onLeave: (proceed: () => void) => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(Probe, { onLeave }));
  });
}
/** The browser moved to `to` and raised popstate. */
const navigate = async (to: number) => {
  entry = to;
  await act(async () => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
};

describe("the guard puts history back the way it came", () => {
  it("BACK: puts it one entry forward again, and Leave goes back", async () => {
    let proceed: (() => void) | null = null;
    await mount((p) => (proceed = p));
    await navigate(4);
    expect(go).toHaveBeenLastCalledWith(1);
    expect(proceed).not.toBeNull();
    await navigate(5); // the restore's own popstate
    proceed!();
    expect(go).toHaveBeenLastCalledWith(-1);
  });

  it("FORWARD: puts it one entry BACK (not go(1), which is a no-op at the end of the stack), and Leave goes forward", async () => {
    let proceed: (() => void) | null = null;
    await mount((p) => (proceed = p));
    await navigate(6);
    expect(go).toHaveBeenLastCalledWith(-1);
    await navigate(5);
    proceed!();
    expect(go).toHaveBeenLastCalledWith(1);
  });

  it("a multi-step jump is put back by its whole distance", async () => {
    let proceed: (() => void) | null = null;
    await mount((p) => (proceed = p));
    await navigate(2);
    expect(go).toHaveBeenLastCalledWith(3);
    await navigate(5);
    proceed!();
    expect(go).toHaveBeenLastCalledWith(-3);
  });

  it("an unknown position keeps the original behaviour: one step Back", async () => {
    delete (window as unknown as { navigation?: unknown }).navigation;
    let proceed: (() => void) | null = null;
    await mount((p) => (proceed = p));
    // The destination is an entry this guard never saw: it carries no stamp.
    window.history.replaceState(null, "");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(go).toHaveBeenLastCalledWith(1);
    proceed!();
    expect(go).toHaveBeenLastCalledWith(-1);
  });

  it("without the Navigation API the guard stamps its own entry and tells Forward from Back by it", async () => {
    delete (window as unknown as { navigation?: unknown }).navigation;
    await mount(() => undefined);
    const stamped = (window.history.state as Record<string, number>).__unsavedGuardIdx;
    expect(typeof stamped).toBe("number");
    // Forward to an entry stamped one higher, as it would be had the guard been mounted there.
    window.history.replaceState({ __unsavedGuardIdx: stamped + 1 }, "");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(go).toHaveBeenLastCalledWith(-1);
  });

  it("a popstate that stays on the same entry (a hash change) is not a departure", async () => {
    const onLeave = vi.fn();
    await mount(onLeave);
    await navigate(5);
    expect(onLeave).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });
});

describe("the own-move flag cannot stay set after a move that raised no popstate", () => {
  it("the NEXT real navigation is still guarded once the timer lapses (it used to slip past)", async () => {
    vi.useFakeTimers();
    const onLeave = vi.fn();
    await mount(onLeave);
    await navigate(6); // guarded: a restore go(-1) was requested, but this browser never raises its popstate
    expect(onLeave).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    await navigate(7); // the practitioner navigates again
    expect(onLeave, "the second navigation must be asked about, not swallowed as the guard's own move").toHaveBeenCalledTimes(2);
  });

  it("NEGATIVE CONTROL: within the window the guard's OWN restore popstate is not asked about", async () => {
    const onLeave = vi.fn();
    await mount(onLeave);
    await navigate(6);
    expect(onLeave).toHaveBeenCalledTimes(1);
    await navigate(5); // the restore, immediately
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

describe("where the Navigation API exists the traversal is cancelled before it happens", () => {
  type Fake = EventTarget & { currentEntry: { index: number }; traverseTo: ReturnType<typeof vi.fn> };
  function install(): Fake {
    const nav = Object.assign(new EventTarget(), { currentEntry: { index: 5 }, traverseTo: vi.fn() }) as Fake;
    (window as unknown as { navigation: unknown }).navigation = nav;
    return nav;
  }
  const traverse = (nav: Fake, over: Record<string, unknown> = {}) => {
    const ev = Object.assign(new Event("navigate", { cancelable: true }), {
      navigationType: "traverse",
      destination: { key: "k4" },
      ...over,
    });
    act(() => {
      nav.dispatchEvent(ev);
    });
    return ev;
  };

  it("a Back/Forward traversal is cancelled, asked about, and Leave replays it by key", async () => {
    const nav = install();
    let proceed: (() => void) | null = null;
    await mount((p) => (proceed = p));
    const ev = traverse(nav);
    expect(ev.defaultPrevented, "nothing moved, so Stay needs no restore").toBe(true);
    expect(proceed).not.toBeNull();
    expect(nav.traverseTo).not.toHaveBeenCalled();
    proceed!();
    expect(nav.traverseTo).toHaveBeenCalledWith("k4");
    // The replayed traversal itself is let through, once.
    expect(traverse(nav).defaultPrevented).toBe(false);
    expect(traverse(nav).defaultPrevented, "and only once").toBe(true);
  });

  it("NEGATIVE CONTROLS: a push, a non-cancelable traversal and a hash change are not held", async () => {
    const nav = install();
    const onLeave = vi.fn();
    await mount(onLeave);
    expect(traverse(nav, { navigationType: "push" }).defaultPrevented).toBe(false);
    expect(traverse(nav, { hashChange: true }).defaultPrevented).toBe(false);
    const nonCancelable = Object.assign(new Event("navigate", { cancelable: false }), { navigationType: "traverse", destination: { key: "k4" } });
    act(() => {
      nav.dispatchEvent(nonCancelable);
    });
    expect(nonCancelable.defaultPrevented).toBe(false);
    expect(onLeave).not.toHaveBeenCalled();
  });
});
