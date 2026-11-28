// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The signed-in shell's guard: when the shell unmounts (sign-out is a soft navigation to /login), every draft saver is disposed.
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { DraftRegistryGuard } = await import("@/app/(app)/DraftRegistryGuard");
const { acquireEntry, latestDraft } = await import("@/lib/note-drafts/draft-registry");

describe("DraftRegistryGuard", () => {
  it("unmounting the shell drops every saver and the text it held", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => ({ status: "error" as const }));
    const key = { clientId: "c1", kind: "consultation" as const, target: "new" };
    const entry = acquireEntry(key, null, { scope: "p1:s1", save, discard: async () => ({ ok: true }) }, () => undefined);
    entry.saver.change({ body: "unsent" });
    await entry.saver.flush();
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(DraftRegistryGuard)));
    expect(latestDraft(key, null, "p1:s1")).not.toBeNull();
    await act(async () => root.unmount()); // sign-out
    expect(latestDraft(key, null, "p1:s1")).toBeNull();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
