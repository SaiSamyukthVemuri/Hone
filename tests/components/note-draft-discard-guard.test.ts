// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// Insurance final1716 (HON-130 r4): a second Discard during a slow one must not start a second request or unlock the editor early, and text
// typed between the two must survive.
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { useNoteDraft } = await import("@/lib/note-drafts/use-note-draft");
const { latestDraft, resetDraftRegistry } = await import("@/lib/note-drafts/draft-registry");

const key = { clientId: "c1", kind: "consultation" as const, target: "new" };

describe("useNoteDraft.discard re-entry", () => {
  afterEach(() => resetDraftRegistry());

  it("two overlapping discards make ONE request, stay locked until it answers, ignore text typed between them, and a failed answer keeps the text", async () => {
    let answer!: (r: { ok: boolean }) => void;
    const discard = vi.fn(() => new Promise<{ ok: boolean }>((r) => (answer = r)));
    const save = vi.fn(async () => ({ status: "error" as const }));
    const actions = { scope: "p1:s1", save, discard, peek: async () => ({ ok: true, draft: null }) };
    let api!: ReturnType<typeof useNoteDraft>;
    const Probe = () => {
      api = useNoteDraft(key, null, actions as never, true);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => api.change({ body: "typed before" }));

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => { first = api.discard(); });
    await act(async () => api.change({ body: "typed between the two" })); // ignored while a Discard is out
    await act(async () => { second = api.discard(); });
    expect(api.discarding).toBe(true);
    expect(discard).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ ok: false }); });
    expect(await first).toBe(false);
    expect(await second).toBe(false); // the second caller got the SAME answer
    expect(api.discarding).toBe(false);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(latestDraft(key, null, "p1:s1")?.fields).toEqual({ body: "typed before" }); // nothing typed during the Discard was taken or lost
    await act(async () => api.change({ body: "typed after" }));
    expect(latestDraft(key, null, "p1:s1")?.fields).toEqual({ body: "typed after" });
    await act(async () => root.unmount());
  });

  it("after the Discard has ended, a NEW Discard is a new request", async () => {
    const discard = vi.fn(async () => ({ ok: false }));
    const actions = { scope: "p1:s1", save: vi.fn(async () => ({ status: "error" as const })), discard, peek: async () => ({ ok: true, draft: null }) };
    let api!: ReturnType<typeof useNoteDraft>;
    const Probe = () => {
      api = useNoteDraft(key, null, actions as never, true);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await api.discard(); });
    await act(async () => { await api.discard(); });
    expect(discard).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });
});
