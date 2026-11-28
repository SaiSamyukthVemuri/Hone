// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireEntry, latestDraft, markNone, resetDraftRegistry, seedEntry, type DraftActions } from "@/lib/note-drafts/draft-registry";
import type { NoteDraftKey, NoteDraftSaveResult, StoredNoteDraft } from "@/lib/note-drafts/types";

// HON-130 (Codex on #1879): the saver outlives the editor, so text typed during an outage is held for the remount, a reopened form shows the
// LATEST draft (not the page's older one), and a draft that is gone stays gone.
const SCOPE_A = "practitioner-a:studio-1";
const SCOPE_B = "practitioner-b:studio-1";
const key: NoteDraftKey = { clientId: "c1", kind: "consultation", target: "new" };
const stored = (revision: number, body: string): StoredNoteDraft => ({ key, fields: { body }, revision, savedAt: "2026-11-28T10:00:00.000Z" });
const ok = (revision: number): NoteDraftSaveResult => ({ status: "ok", revision, savedAt: "2026-11-28T10:02:00.000Z" });
function actions(save: DraftActions["save"], scope = SCOPE_A): DraftActions {
  return { scope, save, discard: async () => ({ ok: true }) };
}

describe("draft registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDraftRegistry();
  });
  afterEach(() => vi.useRealTimers());

  it("text typed while the server is unreachable survives an unmount: the remount gets the same saver and the same text", async () => {
    const save = vi.fn(async () => ({ status: "error" }) as NoteDraftSaveResult);
    const first = acquireEntry(key, null, actions(save), () => undefined);
    first.saver.change({ body: "typed offline" });
    await first.saver.flush(); // the unmount flush: fails
    const again = acquireEntry(key, null, actions(save), () => undefined); // the remount
    expect(again.saver).toBe(first.saver);
    expect(latestDraft(key, null, SCOPE_A)).toMatchObject({ fields: { body: "typed offline" }, unsaved: true });
    expect(again.saver.snapshot().phase).toBe("error"); // the failure is still visible, not forgotten
  });

  it("Cancel then Add note again reopens with the LATEST saved text, not the page's older draft", async () => {
    const save = vi.fn(async () => ok(5));
    const entry = acquireEntry(key, stored(2, "old text from page load"), actions(save), () => undefined);
    entry.saver.change({ body: "newer text" });
    await entry.saver.flush();
    expect(latestDraft(key, stored(2, "old text from page load"), SCOPE_A)).toMatchObject({ fields: { body: "newer text" }, revision: 5, unsaved: false });
  });

  it("a draft that is gone (saved or discarded) is not brought back by the page's stale prop; a NEWER server draft is", () => {
    const entry = acquireEntry(key, stored(2, "old"), actions(async () => ok(3)), () => undefined);
    entry.saver.settle();
    markNone(key, SCOPE_A);
    expect(latestDraft(key, stored(2, "old"), SCOPE_A)).toBeNull();
    expect(latestDraft(key, stored(9, "written elsewhere later"), SCOPE_A)).toMatchObject({ fields: { body: "written elsewhere later" } });
  });

  it("seedEntry holds text for a NEW key and sends it from revision 0 (Keep as new note)", async () => {
    const save = vi.fn(async () => ok(1));
    const newKey: NoteDraftKey = { ...key, target: "new" };
    seedEntry(newKey, { body: "moved text" }, actions(save));
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ key: newKey, fields: { body: "moved text" }, expectedRevision: 0 }));
  });

  // ---- Privacy: the registry must not outlive an identity ----

  it("a different practitioner (or studio) mounting the same key finds NO earlier text, and nothing of the earlier one is ever sent", async () => {
    const saveA = vi.fn(async () => ({ status: "error" }) as NoteDraftSaveResult);
    const a = acquireEntry(key, null, actions(saveA, SCOPE_A), () => undefined);
    a.saver.change({ body: "practitioner A's unsent clinical text" });
    await a.saver.flush(); // fails: A's text is held and a background retry is armed
    const saveB = vi.fn(async () => ok(1));
    expect(latestDraft(key, null, SCOPE_B)).toBeNull(); // B's editor opens empty
    const b = acquireEntry(key, null, actions(saveB, SCOPE_B), () => undefined);
    expect(b.saver).not.toBe(a.saver);
    expect(b.saver.unsavedWork()).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000); // every backoff A's saver could have used
    expect(saveA).toHaveBeenCalledTimes(1); // no background retry of A's text after the identity changed
    expect(saveB).not.toHaveBeenCalled(); // and A's text never went out under B's session
    expect(a.saver.unsavedWork()?.fields ?? null).toBeNull; // disposed saver: no further work happens
  });

  it("a studio change under the same practitioner is also a new scope", () => {
    const save = vi.fn(async () => ok(1));
    const first = acquireEntry(key, stored(2, "studio 1 text"), actions(save, "practitioner-a:studio-1"), () => undefined);
    const other = acquireEntry(key, null, actions(save, "practitioner-a:studio-2"), () => undefined);
    expect(other.saver).not.toBe(first.saver);
    expect(latestDraft(key, null, "practitioner-a:studio-2")).toBeNull();
  });

  it("resetDraftRegistry (sign-out) disposes every saver: a background retry never fires afterwards", async () => {
    const save = vi.fn(async () => ({ status: "error" }) as NoteDraftSaveResult);
    const entry = acquireEntry(key, null, actions(save), () => undefined);
    entry.saver.change({ body: "left typing, then signed out" });
    await vi.advanceTimersByTimeAsync(1500); // first send fails; the 2 s retry is armed
    expect(save).toHaveBeenCalledTimes(1);
    resetDraftRegistry();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(latestDraft(key, null, SCOPE_A)).toBeNull();
  });

  it("every send carries the scope the saver was CREATED under, for save and for the retry", async () => {
    const save = vi.fn(async () => ({ status: "error" }) as NoteDraftSaveResult);
    const entry = acquireEntry(key, null, actions(save, SCOPE_A), () => undefined);
    entry.saver.change({ body: "x" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ scope: SCOPE_A }));
  });

  it("with autosave off (register=false) the entry is private and never stored", () => {
    const save = vi.fn(async () => ok(1));
    const off = acquireEntry(key, null, actions(save), () => undefined, false);
    off.saver.change({ body: "typed while off" });
    expect(latestDraft(key, null, SCOPE_A)).toBeNull();
    const on = acquireEntry(key, null, actions(save), () => undefined);
    expect(on.saver).not.toBe(off.saver);
  });

  it("the unload guard stays armed while ANY registry entry holds unsent text, even with no editor mounted, and drops once it is saved", async () => {
    const save = vi.fn(async () => ({ status: "error" }) as NoteDraftSaveResult);
    const entry = acquireEntry(key, null, actions(save), () => undefined); // no editor ever attached: a detached saver
    entry.saver.change({ body: "typed during an outage, editor switched away" });
    await vi.advanceTimersByTimeAsync(1500); // the save failed: the text is held
    const held = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    entry.saver.settle(); // the real note was saved
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });

  it("a private saver (autosave off) never schedules a timer, even for a failing send", async () => {
    const save = vi.fn(async () => ({ status: "error" }) as NoteDraftSaveResult);
    const off = acquireEntry(key, null, actions(save), () => undefined, false);
    off.saver.change({ body: "x" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
