// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// HON-130: the occupied-destination rule of "Keep as new note" and the reopened "this note was revised" editor, rendered for real.
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
const { ClinicalNotesSection } = await import("@/components/clinical-notes-section");
const { endIdentity } = await import("@/lib/note-drafts/draft-registry");

const C = "33333333-3333-4333-8333-333333333333";
const N1 = "77777777-7777-4777-8777-777777777777";
const N2 = "88888888-8888-4888-8888-888888888888";
const G1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const G2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const note = (id: string, supersedes: string | null) => ({
  id, client_id: C, studio_id: "s", practitioner_id: "p", kind: "consultation", body: `body ${id}`, areas: [], occurred_at: "2026-11-01T00:00:00Z",
  created_at: "2026-11-01T00:00:00Z", supersedes_note_id: supersedes, author_name: "P", is_superseded: false,
});
const section = (notes: ReturnType<typeof note>[]) => ({ kind: "consultation" as const, label: "Consultation", description: "d", placeholder: "p", notes, total: notes.length } as never);
const noop = async () => ({ ok: false as const, code: "error" as const, error: "x" });

afterEach(() => endIdentity());

async function mount(opts: { notes: ReturnType<typeof note>[]; drafts: unknown[]; peek: () => Promise<unknown>; discard?: () => Promise<{ ok: boolean }>; save?: () => Promise<unknown> }) {
  const save = vi.fn<(input: unknown) => Promise<unknown>>(opts.save ?? (async () => ({ status: "ok", revision: 1, savedAt: "t", generation: G2 })));
  const discard = vi.fn(opts.discard ?? (async () => ({ ok: true })));
  const peek = vi.fn(opts.peek);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ClinicalNotesSection, {
        clientId: C, sections: [section(opts.notes)], addAction: noop, reviseAction: noop,
        drafts: opts.drafts as never, draftActions: { scope: "p:s", save: save as never, discard: discard as never, peek: peek as never },
      }),
    ),
  );
  return { host, root, save, discard, peek };
}
const click = async (el: Element | undefined | null) => { await act(async () => { (el as HTMLElement).click(); }); };
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

describe("a draft of a note that already has its revision", () => {
  it("reopens as 'the note was revised' with Keep as new note, never as a plain restore, and is not autosaved", async () => {
    const notes = [note(N1, null), note(N2, N1)]; // N1 was revised by N2
    const draft = { key: { clientId: C, kind: "consultation", target: N1 }, fields: { body: "my old revision text" }, revision: 2, savedAt: "2026-11-02T10:00:00Z", generation: G1 };
    const { host, root, save } = await mount({ notes, drafts: [draft], peek: async () => ({ ok: true, draft: null }) });
    expect(host.textContent).toMatch(/revised/i);
    expect(button(host, "Keep as new draft")).toBeTruthy();
    expect(host.textContent).not.toMatch(/Draft restored/i);
    expect(save).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

describe("Keep as new note never overwrites an occupied destination", () => {
  const notes = [note(N1, null), note(N2, N1)];
  const mine = { key: { clientId: C, kind: "consultation", target: N1 }, fields: { body: "MOVING TEXT" }, revision: 2, savedAt: "t", generation: G1 };
  const theirs = { key: { clientId: C, kind: "consultation", target: "new" }, fields: { body: "ALREADY HERE" }, revision: 4, savedAt: "t", generation: G2 };

  it("shows BOTH texts with Cancel / Append / Replace, writes nothing, and ends nothing until a choice", async () => {
    const { host, root, save, discard, peek } = await mount({ notes, drafts: [mine], peek: async () => ({ ok: true, draft: theirs }) });
    await click(button(host, "Keep as new draft"));
    expect(peek).toHaveBeenCalledTimes(1); // the destination is checked on the server
    const dialog = host.querySelector('[data-testid="note-move-dialog"]');
    expect(dialog?.textContent).toContain("MOVING TEXT");
    expect(dialog?.textContent).toContain("ALREADY HERE");
    for (const label of ["Cancel", "Append", "Replace"]) expect(button(host, label)).toBeTruthy();
    expect(discard).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await click(button(host.querySelector('[data-testid="note-move-dialog"]') as HTMLElement, "Cancel")); // the dialog's own Cancel, not the editor's
    expect(host.querySelector('[data-testid="note-move-dialog"]')).toBeNull();
    expect(discard).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("Append keeps both texts in the destination's own lifecycle; the source draft is ended", async () => {
    const { host, root, discard } = await mount({ notes, drafts: [mine], peek: async () => ({ ok: true, draft: theirs }) });
    await click(button(host, "Keep as new draft"));
    await click(button(host, "Append"));
    expect(discard).toHaveBeenCalledWith({ clientId: C, kind: "consultation", target: N1 }, "p:s", G1);
    const text = (host.querySelector("textarea") as HTMLTextAreaElement).value;
    expect(text).toContain("ALREADY HERE");
    expect(text).toContain("MOVING TEXT");
    await act(async () => root.unmount());
  });

  it("a destination that cannot be checked blocks the move and keeps the text (fail closed)", async () => {
    const { host, root, discard } = await mount({ notes, drafts: [mine], peek: async () => ({ ok: false, draft: null }) });
    await click(button(host, "Keep as new draft"));
    expect(host.textContent).toMatch(/Couldn't check where to keep this text/);
    expect(discard).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="note-move-dialog"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("r4 P2b: edits typed into the revised editor BEFORE Keep as new note are what moves, not the text the editor opened with", async () => {
    vi.useFakeTimers();
    const { host, root, save } = await mount({ notes, drafts: [mine], peek: async () => ({ ok: true, draft: null }) });
    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(ta, "EDITED after reopening");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(host, "Keep as new draft"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const call = save.mock.calls.map((c) => c[0] as { key: { target: string }; fields: { body?: string } }).find((c) => c.key.target === "new");
    expect(call?.fields.body).toBe("EDITED after reopening");
    vi.useRealTimers();
    await act(async () => root.unmount());
  });

  it("r4 (Codex P2): edits typed into the revised editor survive switching away (unmount) and back, and Keep as new still carries them", async () => {
    vi.useFakeTimers();
    const first = await mount({ notes, drafts: [mine], peek: async () => ({ ok: true, draft: null }) });
    const ta = first.host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(ta, "EDITED before switching section");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => first.root.unmount()); // a section or client switch
    const { host, root, save } = await mount({ notes, drafts: [mine], peek: async () => ({ ok: true, draft: null }) });
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("EDITED before switching section");
    await click(button(host, "Keep as new draft"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const bodies = save.mock.calls.map((c) => c[0] as { key: { target: string }; fields: { body?: string } }).filter((c) => c.key.target === "new").map((c) => c.fields.body);
    expect(bodies).toContain("EDITED before switching section");
    vi.useRealTimers();
    await act(async () => root.unmount());
  });

  it("r4 (Codex P2): after a SUCCESSFUL Discard of a superseded-target draft, Keep as new does not carry the discarded edits", async () => {
    vi.useFakeTimers();
    const { host, root, save } = await mount({ notes, drafts: [mine], peek: async () => ({ ok: true, draft: null }) });
    const ta = host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(ta, "EDITED then discarded");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(host, "Discard draft") ?? button(host, "Discard"));
    expect(host.textContent).not.toMatch(/EDITED then discarded/);
    await click(button(host, "Keep as new draft"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const bodies = save.mock.calls.map((c) => c[0] as { key: { target: string }; fields: { body?: string } }).filter((c) => c.key.target === "new").map((c) => c.fields.body);
    expect(bodies).not.toContain("EDITED then discarded");
    vi.useRealTimers();
    await act(async () => root.unmount());
  });

  it("a free destination moves straight away as a NEW lifecycle (expected revision 0, a different generation)", async () => {
    vi.useFakeTimers();
    const { host, root, save } = await mount({ notes, drafts: [mine], peek: async () => ({ ok: true, draft: null }) });
    await click(button(host, "Keep as new draft"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const call = save.mock.calls.map((c) => c[0] as { key: { target: string }; expectedRevision: number; generation: string }).find((c) => c.key.target === "new");
    expect(call?.expectedRevision).toBe(0);
    expect(call?.generation).not.toBe(G1);
    vi.useRealTimers();
    await act(async () => root.unmount());
  });
});
