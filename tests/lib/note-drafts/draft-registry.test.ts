import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireEntry, latestDraft, markNone, resetDraftRegistry, seedEntry, type DraftActions } from "@/lib/note-drafts/draft-registry";
import type { NoteDraftKey, NoteDraftSaveResult, StoredNoteDraft } from "@/lib/note-drafts/types";

// HON-130 (Codex on #1879): the saver outlives the editor, so text typed during an outage is held for the remount, a reopened form shows the
// LATEST draft (not the page's older one), and a draft that is gone stays gone.
const key: NoteDraftKey = { clientId: "c1", kind: "consultation", target: "new" };
const stored = (revision: number, body: string): StoredNoteDraft => ({ key, fields: { body }, revision, savedAt: "2026-11-28T10:00:00.000Z" });
const ok = (revision: number): NoteDraftSaveResult => ({ status: "ok", revision, savedAt: "2026-11-28T10:02:00.000Z" });
function actions(save: DraftActions["save"]): DraftActions {
  return { save, discard: async () => ({ ok: true }) };
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
    expect(latestDraft(key, null)).toMatchObject({ fields: { body: "typed offline" }, unsaved: true });
    expect(again.saver.snapshot().phase).toBe("error"); // the failure is still visible, not forgotten
  });

  it("Cancel then Add note again reopens with the LATEST saved text, not the page's older draft", async () => {
    const save = vi.fn(async () => ok(5));
    const entry = acquireEntry(key, stored(2, "old text from page load"), actions(save), () => undefined);
    entry.saver.change({ body: "newer text" });
    await entry.saver.flush();
    expect(latestDraft(key, stored(2, "old text from page load"))).toMatchObject({ fields: { body: "newer text" }, revision: 5, unsaved: false });
  });

  it("a draft that is gone (saved or discarded) is not brought back by the page's stale prop; a NEWER server draft is", () => {
    const entry = acquireEntry(key, stored(2, "old"), actions(async () => ok(3)), () => undefined);
    entry.saver.settle();
    markNone(key);
    expect(latestDraft(key, stored(2, "old"))).toBeNull();
    expect(latestDraft(key, stored(9, "written elsewhere later"))).toMatchObject({ fields: { body: "written elsewhere later" } });
  });

  it("seedEntry holds text for a NEW key and sends it from revision 0 (Keep as new note)", async () => {
    const save = vi.fn(async () => ok(1));
    const newKey: NoteDraftKey = { ...key, target: "new" };
    seedEntry(newKey, { body: "moved text" }, actions(save));
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ key: newKey, fields: { body: "moved text" }, expectedRevision: 0 }));
  });
});
