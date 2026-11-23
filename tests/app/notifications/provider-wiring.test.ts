import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider's WIRING, run for real without a DOM: React's hooks are replaced by a tiny runtime that honours dependency arrays
// (effects run on mount and when a dependency changes, cleanups run first, state updates re-render), and the few browser globals the
// provider touches are stubs this file controls. The poller's own rules are pinned in tests/lib/notifications/live-poller.test.ts;
// what only the wiring can get wrong is pinned here: which request options are sent, that a fresh server render reaches the machine
// (even with an unchanged number), that each probe carries the generation it STARTED under, that a superseded answer is dropped, and
// that nothing is left running after unmount. These were previously protected only by the browser spec.
//
// Not covered here (browser spec only): real focus/visibility events from a real tab, real fetch abort timing, real sessionStorage.

type Effect = { deps: readonly unknown[] | undefined; cleanup: (() => void) | void };
const rt = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    effects: [] as Array<{ deps: readonly unknown[] | undefined; cleanup: (() => void) | void }>,
    memos: [] as Array<{ deps: readonly unknown[]; value: unknown }>,
    idx: 0,
    eIdx: 0,
    mIdx: 0,
    dirty: false,
    queue: [] as Array<() => void>,
  };
  return state;
});

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = rt.idx++;
      if (!(i in rt.slots)) rt.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        const next = typeof v === "function" ? (v as (p: unknown) => unknown)(rt.slots[i]) : v;
        if (!Object.is(next, rt.slots[i])) {
          rt.slots[i] = next;
          rt.dirty = true;
        }
      };
      return [rt.slots[i], set];
    },
    useRef: (init: unknown) => {
      const i = rt.idx++;
      if (!(i in rt.slots)) rt.slots[i] = { current: init };
      return rt.slots[i];
    },
    useMemo: (fn: () => unknown, deps: readonly unknown[]) => {
      const i = rt.mIdx++;
      const prev = rt.memos[i];
      if (prev && same(prev.deps, deps)) return prev.value;
      const value = fn();
      rt.memos[i] = { deps, value };
      return value;
    },
    useEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) => {
      const i = rt.eIdx++;
      const prev = rt.effects[i];
      if (prev && same(prev.deps, deps)) return;
      rt.queue.push(() => {
        if (prev && typeof prev.cleanup === "function") prev.cleanup();
        rt.effects[i] = { deps, cleanup: fn() };
      });
      rt.effects[i] = { deps: prev?.deps, cleanup: prev?.cleanup }; // keep the slot until the queued run replaces it
    },
  };
});

import { createElement, type ReactNode } from "react";
import { NotificationsProvider, useNotificationsLive } from "@/app/(app)/NotificationsProvider";

type Props = { initialPersistedUnread: number; computedUnread: number; renderRevision: number };
let latest: { unread: number; arrivals: readonly string[] } | null = null;
let props: Props;

function Probe(): ReactNode {
  latest = useNotificationsLive();
  return null;
}

function renderOnce() {
  rt.idx = 0;
  rt.eIdx = 0;
  rt.mIdx = 0;
  // The provider is a function component: call it, then its child Probe reads the context value the provider created.
  const el = (NotificationsProvider as unknown as (p: Props & { children: ReactNode }) => { props: { value: { unread: number; arrivals: readonly string[] } } })({
    ...props,
    children: createElement(Probe),
  });
  latest = el.props.value;
}

function flush() {
  for (let guard = 0; guard < 20; guard++) {
    renderOnce();
    const q = rt.queue.splice(0);
    q.forEach((run) => run());
    if (!q.length && !rt.dirty) return;
    rt.dirty = false;
  }
  throw new Error("render did not settle");
}

function mount(p: Props) {
  props = p;
  flush();
}
function rerender(patch: Partial<Props>) {
  props = { ...props, ...patch };
  flush();
}
function unmount() {
  for (const e of rt.effects) if (e && typeof e.cleanup === "function") e.cleanup();
  rt.effects.length = 0;
}

// --- browser stubs ----------------------------------------------------------------------------------------------------------------

const VIEWER = "0123456789abcdef";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Pending = { init: RequestInit; resolve: (res: unknown) => void; reject: (e: unknown) => void };
let pending: Pending[] = [];
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let listeners: Record<string, Array<() => void>> = {};
let visibility: "visible" | "hidden" = "visible";
let store: Record<string, string> = {};
let ignoreAbort = false; // a response that arrives even though its request was aborted (the abort lost the race)

const answer = (unread: number, ids: string[] = []) => ({ status: 200, type: "basic", json: async () => ({ unread, ids, viewer: VIEWER }) });
/** Resolve the nth outstanding request (default: the oldest). */
async function respond(res: unknown, which = 0) {
  const p = pending.splice(which, 1)[0];
  p.resolve(res);
  await vi.advanceTimersByTimeAsync(0);
  flush(); // what React does after a state update
}
const fire = (type: string) => (listeners[type] ?? []).slice().forEach((f) => f());

beforeEach(() => {
  vi.useFakeTimers();
  rt.slots.length = 0;
  rt.effects.length = 0;
  rt.memos.length = 0;
  rt.queue.length = 0;
  rt.dirty = false;
  latest = null;
  pending = [];
  fetchCalls = [];
  listeners = {};
  visibility = "visible";
  store = {};
  ignoreAbort = false;
  const add = (type: string, fn: () => void) => void (listeners[type] = [...(listeners[type] ?? []), fn]);
  const remove = (type: string, fn: () => void) => void (listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn));
  vi.stubGlobal("window", {
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    clearTimeout: (h: number) => clearTimeout(h),
    addEventListener: add,
    removeEventListener: remove,
    sessionStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) },
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: add,
    removeEventListener: remove,
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal(
    "fetch",
    (url: string, init: RequestInit) =>
      new Promise((resolve, reject) => {
        fetchCalls.push({ url, init });
        pending.push({ init, resolve, reject });
        init.signal?.addEventListener("abort", () => {
          if (!ignoreAbort) reject(new DOMException("aborted", "AbortError"));
        });
      }),
  );
  vi.stubGlobal("AbortController", AbortController);
});
afterEach(async () => {
  unmount();
  await vi.advanceTimersByTimeAsync(0); // an aborted request's continuation runs after teardown, while the stubs still exist
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const START: Props = { initialPersistedUnread: 0, computedUnread: 0, renderRevision: 1 };

describe("the request the provider sends", () => {
  it("asks for the summary with no cache, same-origin credentials and a MANUAL redirect, and a signal it can abort", async () => {
    mount(START);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("/api/notifications/summary");
    expect(fetchCalls[0].init).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "manual" });
    expect(fetchCalls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("an opaque redirect is a signed-out answer: three of them stop the poller, with no extra request after", async () => {
    mount(START);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) {
      await respond({ status: 0, type: "opaqueredirect", json: async () => ({}) });
      fire("focus");
      await vi.advanceTimersByTimeAsync(0);
    }
    const sent = fetchCalls.length;
    await respond({ status: 0, type: "opaqueredirect", json: async () => ({}) }).catch(() => {});
    fire("focus");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchCalls.length).toBeLessThanOrEqual(sent + 1);
    expect(latest?.unread).toBe(0);
  });
});

describe("the server's number wins (a fresh render reaches the machine)", () => {
  it("0 -> a poll says 5 -> a render brings 0 AGAIN with a new revision: the bells show 0, not 5", async () => {
    mount(START);
    await vi.advanceTimersByTimeAsync(0);
    await respond(answer(0)); // the first answer primes
    fire("focus");
    await vi.advanceTimersByTimeAsync(0);
    await respond(answer(5, [ID(1), ID(2), ID(3), ID(4), ID(5)]));
    flush();
    expect(latest?.unread).toBe(5);
    rerender({ initialPersistedUnread: 0, renderRevision: 2 }); // mark-all-read: same number as the first render, new render
    expect(latest?.unread).toBe(0);
  });

  it("the SAME revision again (a plain re-render) does not overwrite a polled count", async () => {
    mount(START);
    await vi.advanceTimersByTimeAsync(0);
    await respond(answer(0));
    fire("focus");
    await vi.advanceTimersByTimeAsync(0);
    await respond(answer(4, [ID(1), ID(2), ID(3), ID(4)]));
    flush();
    expect(latest?.unread).toBe(4);
    rerender({ computedUnread: 1 }); // only the computed part changed; the revision did not
    expect(latest?.unread).toBe(5);
  });

  it("the computed overdue count is added to the persisted count and never dropped", async () => {
    mount({ ...START, initialPersistedUnread: 2, computedUnread: 3 });
    expect(latest?.unread).toBe(5);
  });
});

describe("each probe carries the generation it STARTED under", () => {
  it("a render during a request drops that request's late answer: the count stays at the render's number", async () => {
    mount(START);
    await vi.advanceTimersByTimeAsync(0);
    await respond(answer(0));
    fire("focus");
    await vi.advanceTimersByTimeAsync(0); // a probe is in flight, it has read 3
    expect(pending).toHaveLength(1);
    rerender({ initialPersistedUnread: 0, renderRevision: 2 }); // mark-all-read renders 0 while it is in flight
    // the old request is aborted (its promise rejects) and a stale 3 must never show, even if something delivers it late
    await respond(answer(3, [ID(1), ID(2), ID(3)]), 0).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(latest?.unread).toBe(0);
  });

  it("after a render the poller is NOT dead: the next probe is accepted (a constant generation would be ignored forever)", async () => {
    mount(START);
    await vi.advanceTimersByTimeAsync(0);
    await respond(answer(0));
    rerender({ initialPersistedUnread: 0, renderRevision: 2 }); // generation moves on
    fire("focus");
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1);
    await respond(answer(2, [ID(1), ID(2)]));
    flush();
    expect(latest?.unread).toBe(2);
  });

  it("a probe started AFTER a render is judged by that render's generation (the answer is read against the generation it started under)", async () => {
    mount(START);
    await vi.advanceTimersByTimeAsync(0);
    await respond(answer(0));
    rerender({ initialPersistedUnread: 0, renderRevision: 2 });
    fire("focus");
    await vi.advanceTimersByTimeAsync(0);
    rerender({ initialPersistedUnread: 0, renderRevision: 3 }); // another render while that probe is in flight
    await respond(answer(9, [ID(1)]), 0).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(latest?.unread).toBe(0);
  });
});

describe("a superseded or hidden-tab answer is dropped by the provider itself", () => {
  it("hiding the tab aborts the request in flight; its late answer changes nothing", async () => {
    mount(START);
    await vi.advanceTimersByTimeAsync(0);
    await respond(answer(0));
    fire("focus");
    await vi.advanceTimersByTimeAsync(0);
    const signal = pending[0].init.signal as AbortSignal;
    visibility = "hidden";
    fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(true);
    await respond(answer(7, [ID(1)]), 0).catch(() => {});
    expect(latest?.unread).toBe(0);
  });

  it("a request that never answers is aborted at the timeout and counted as a transient failure, not a stuck poller", async () => {
    mount(START);
    await vi.advanceTimersByTimeAsync(0);
    const signal = pending[0].init.signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(8_001);
    expect(signal.aborted).toBe(true);
    expect(latest?.unread).toBe(0);
  });
});

describe("the provider drops an answer whose request was superseded, even when the abort loses the race", () => {
  it("hide then return starts a NEW request; the OLD request's late answer must not be taken as the new one's", async () => {
    ignoreAbort = true;
    mount(START);
    await vi.advanceTimersByTimeAsync(0);
    await respond(answer(0));
    fire("focus");
    await vi.advanceTimersByTimeAsync(0); // request A in flight
    visibility = "hidden";
    fire("visibilitychange"); // A aborted (but its response still arrives below)
    visibility = "visible";
    fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0); // request B in flight
    expect(pending).toHaveLength(2);
    await respond(answer(7, [ID(1)]), 0); // A's late answer
    expect(latest?.unread).toBe(0);
    await respond(answer(1, [ID(2)]), 0); // B's answer
    expect(latest?.unread).toBe(1);
  });
});

describe("cleanup", () => {
  it("unmount aborts the request in flight and removes every listener, so nothing keeps polling", async () => {
    mount(START);
    await vi.advanceTimersByTimeAsync(0);
    await respond(answer(0));
    fire("focus");
    await vi.advanceTimersByTimeAsync(0);
    const signal = pending[0].init.signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    expect(Object.values(listeners).flat()).toHaveLength(0);
    const before = fetchCalls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchCalls.length).toBe(before);
  });
});
