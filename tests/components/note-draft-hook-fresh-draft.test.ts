// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// Codex P2 on #1879: after a Save or Discard the registry marks the key "no draft". New text typed afterwards is a NEW draft and must not be
// dropped by a remount because of that old marker.
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { useNoteDraft } = await import("@/lib/note-drafts/use-note-draft");
const { latestDraft, resetDraftRegistry } = await import("@/lib/note-drafts/draft-registry");

const key = { clientId: "c1", kind: "consultation" as const, target: "new" };
const actions = { scope: "p1:s1", save: vi.fn(async () => ({ status: "error" as const })), discard: async () => ({ ok: true }) };

describe("useNoteDraft", () => {
  afterEach(() => resetDraftRegistry());

  it("text typed after settle() is a new draft: a remount still sees it", async () => {
    let api!: ReturnType<typeof useNoteDraft>;
    const Probe = () => {
      api = useNoteDraft(key, null, actions, true);
      return null;
    };
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    api.settle(); // the real note was saved: the registry says "no draft"
    expect(latestDraft(key, null, "p1:s1")).toBeNull();
    await act(async () => api.change({ body: "a new draft after the save" }));
    expect(latestDraft(key, null, "p1:s1")?.fields).toEqual({ body: "a new draft after the save" });
    await act(async () => root.unmount());
  });

  it("with enabled=false nothing is registered", async () => {
    let api!: ReturnType<typeof useNoteDraft>;
    const Probe = () => {
      api = useNoteDraft(key, null, actions, false);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => api.change({ body: "typed" }));
    expect(latestDraft(key, null, "p1:s1")).toBeNull();
    await act(async () => root.unmount());
  });

  it("moveOut (Keep as new note) stops sending, deletes THIS key's stored draft and returns the newest text", async () => {
    const discard = vi.fn(async () => ({ ok: true }));
    const save = vi.fn(async () => ({ status: "error" as const }));
    const local = { scope: "p1:s1", save, discard };
    let api!: ReturnType<typeof useNoteDraft>;
    const Probe = () => {
      api = useNoteDraft({ clientId: "c1", kind: "consultation", target: "note-1" }, null, local, true);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => api.change({ body: "text to move" }));
    let moved: unknown;
    await act(async () => {
      moved = await api.moveOut();
    });
    expect(moved).toEqual({ body: "text to move" });
    expect(discard).toHaveBeenCalledWith({ clientId: "c1", kind: "consultation", target: "note-1" }, "p1:s1");
    expect(latestDraft({ clientId: "c1", kind: "consultation", target: "note-1" }, null, "p1:s1")).toBeNull(); // the old key holds nothing
    await act(async () => root.unmount());
  });

  it("text typed during a SLOW delete is carried to the new form, not lost", async () => {
    let finishDelete!: () => void;
    const discard = vi.fn(() => new Promise<{ ok: boolean }>((r) => (finishDelete = () => r({ ok: true }))));
    const local = { scope: "p1:s1", save: vi.fn(async () => ({ status: "error" as const })), discard };
    const k = { clientId: "c1", kind: "consultation" as const, target: "note-2" };
    let api!: ReturnType<typeof useNoteDraft>;
    const Probe = () => {
      api = useNoteDraft(k, null, local, true);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => api.change({ body: "before the click" }));
    let moved: unknown;
    let moving!: Promise<unknown>;
    await act(async () => {
      moving = api.moveOut().then((f) => (moved = f));
    });
    await act(async () => api.change({ body: "typed while the delete was out" })); // lands in the quiesced saver
    await act(async () => {
      finishDelete();
      await moving;
    });
    expect(moved).toEqual({ body: "typed while the delete was out" });
    await act(async () => root.unmount());
  });

  it("a delete that never answers falls through after 8 s and the text is still carried", async () => {
    vi.useFakeTimers();
    const discard = vi.fn(() => new Promise<{ ok: boolean }>(() => undefined));
    const local = { scope: "p1:s1", save: vi.fn(async () => ({ status: "error" as const })), discard };
    const k = { clientId: "c1", kind: "consultation" as const, target: "note-3" };
    let api!: ReturnType<typeof useNoteDraft>;
    const Probe = () => {
      api = useNoteDraft(k, null, local, true);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => api.change({ body: "must survive a dead server" }));
    let moved: unknown = "pending";
    await act(async () => {
      void api.moveOut().then((f) => (moved = f));
    });
    expect(moved).toBe("pending");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });
    expect(moved).toEqual({ body: "must survive a dead server" });
    vi.useRealTimers();
    await act(async () => root.unmount());
  });

  it("the editor is read-only while the text is being moved", async () => {
    let finishDelete!: () => void;
    const discard = vi.fn(() => new Promise<{ ok: boolean }>((r) => (finishDelete = () => r({ ok: true }))));
    const local = { scope: "p1:s1", save: vi.fn(async () => ({ status: "error" as const })), discard };
    const k = { clientId: "c1", kind: "consultation" as const, target: "note-4" };
    let api!: ReturnType<typeof useNoteDraft>;
    const Probe = () => {
      api = useNoteDraft(k, null, local, true);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    expect(api.moving).toBe(false);
    let moving!: Promise<unknown>;
    await act(async () => {
      moving = api.moveOut();
    });
    expect(api.moving).toBe(true);
    await act(async () => {
      finishDelete();
      await moving;
    });
    expect(api.moving).toBe(false);
    await act(async () => root.unmount());
  });
});
