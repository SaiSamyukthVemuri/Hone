// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ReactNode } from "react";
import { act } from "react";

const { createRoot } = await import("react-dom/client");
const { ChartingStateProvider, useRetainedState, useDiscardRetained, createRetainedStore } = await import(
  "@/components/charting-state-provider"
);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

type Api = { value: { a: string; n: number }; set: (u: (d: { a: string; n: number }) => { a: string; n: number }) => void };
function Probe({ k, api, init }: { k: string | null; api: { current: Api | null }; init: () => { a: string; n: number } }) {
  const [value, set] = useRetainedState(k, init);
  api.current = { value, set };
  return h("span", null, JSON.stringify(value));
}
function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

describe("useRetainedState", () => {
  it("is plain useState when no key is given, even under a provider", () => {
    const api = { current: null as Api | null };
    const init = vi.fn(() => ({ a: "x", n: 1 }));
    mount(h(ChartingStateProvider, null, h(Probe, { k: null, api, init })));
    expect(api.current!.value).toEqual({ a: "x", n: 1 });
    act(() => api.current!.set((d) => ({ ...d, n: d.n + 1 })));
    expect(api.current!.value.n).toBe(2);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("is plain useState with a key but no provider", () => {
    const api = { current: null as Api | null };
    mount(h(Probe, { k: "b1", api, init: () => ({ a: "x", n: 1 }) }));
    act(() => api.current!.set((d) => ({ ...d, a: "y" })));
    expect(api.current!.value.a).toBe("y");
  });

  it("composes two functional updates in one tick, as useState does", () => {
    const api = { current: null as Api | null };
    mount(h(ChartingStateProvider, null, h(Probe, { k: "b1", api, init: () => ({ a: "x", n: 0 }) })));
    act(() => {
      api.current!.set((d) => ({ ...d, n: d.n + 1 }));
      api.current!.set((d) => ({ ...d, n: d.n + 1 }));
    });
    expect(api.current!.value.n).toBe(2);
  });

  it("keeps the value when the child is removed and re-added under one provider", () => {
    const api = { current: null as Api | null };
    function Shell({ show }: { show: boolean }) {
      return h(ChartingStateProvider, null, show ? h(Probe, { k: "b1", api, init: () => ({ a: "initial", n: 0 }) }) : h("i"));
    }
    mount(h(Shell, { show: true }));
    act(() => api.current!.set((d) => ({ ...d, a: "typed" })));
    act(() => root!.render(h(Shell, { show: false })));
    act(() => root!.render(h(Shell, { show: true })));
    expect(api.current!.value.a).toBe("typed");
  });

  it("keys are independent, and discard returns an editor to its initial values", () => {
    const a = { current: null as Api | null };
    const b = { current: null as Api | null };
    const disc = { current: null as ((k: string) => void) | null };
    function D() {
      disc.current = useDiscardRetained();
      return null;
    }
    mount(
      h(ChartingStateProvider, null, h(Probe, { k: "b1", api: a, init: () => ({ a: "one", n: 0 }) }), h(Probe, { k: "b2", api: b, init: () => ({ a: "two", n: 0 }) }), h(D)),
    );
    act(() => a.current!.set((d) => ({ ...d, a: "edited" })));
    expect(b.current!.value.a).toBe("two");
    act(() => disc.current!("b1"));
    expect(a.current!.value.a).toBe("one");
  });
});
