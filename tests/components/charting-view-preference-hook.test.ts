// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement as h } from "react";

const { createRoot } = await import("react-dom/client");
const { useChartingViewPreference } = await import("@/components/use-charting-view-preference");
const { NOT_REMEMBERED_MESSAGE } = await import("@/lib/charting/view-preference");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Api = ReturnType<typeof useChartingViewPreference>;
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});
function mount(initial: "current" | "new", save: (v: "current" | "new") => Promise<{ ok: boolean }>) {
  const api = { current: null as unknown as Api };
  function P() {
    api.current = useChartingViewPreference(initial, save);
    return null;
  }
  host = document.createElement("div");
  root = createRoot(host);
  act(() => root!.render(h(P)));
  return api;
}

describe("useChartingViewPreference", () => {
  it("starts on the given view with no notice", () => {
    const api = mount("current", async () => ({ ok: true }));
    expect(api.current.view).toBe("current");
    expect(api.current.notice).toBeNull();
  });
  it("switches at once and, when the save works, shows no notice", async () => {
    const saved: string[] = [];
    const api = mount("current", async (v) => (saved.push(v), { ok: true }));
    await act(async () => api.current.setView("new"));
    expect(api.current.view).toBe("new");
    expect(api.current.notice).toBeNull();
    expect(saved).toEqual(["new"]);
  });
  it("when the save fails the view still switches and the notice says it was not remembered", async () => {
    const api = mount("current", async () => ({ ok: false }));
    await act(async () => api.current.setView("new"));
    expect(api.current.view).toBe("new");
    expect(api.current.notice).toBe(NOT_REMEMBERED_MESSAGE);
  });
  it("a save that throws is the same as a failed save", async () => {
    const api = mount("new", async () => {
      throw new Error("offline");
    });
    await act(async () => api.current.setView("current"));
    expect(api.current.view).toBe("current");
    expect(api.current.notice).toBe(NOT_REMEMBERED_MESSAGE);
  });
  it("a later success clears the notice, and a late reply from an older choice cannot bring it back", async () => {
    const pending: Array<(r: { ok: boolean }) => void> = [];
    const api = mount("current", () => new Promise((r) => pending.push(r)));
    await act(async () => api.current.setView("new"));
    await act(async () => api.current.setView("current"));
    await act(async () => pending[1]!({ ok: true })); // newest succeeds
    expect(api.current.notice).toBeNull();
    await act(async () => pending[0]!({ ok: false })); // an older one fails late
    expect(api.current.notice).toBeNull();
  });
  it("ignores a value that is not one of the two views", async () => {
    const saved: unknown[] = [];
    const api = mount("current", async (v) => (saved.push(v), { ok: true }));
    await act(async () => api.current.setView("bogus" as never));
    expect(api.current.view).toBe("current");
    expect(saved).toEqual([]);
  });
});
