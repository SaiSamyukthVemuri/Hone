import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftSaver, type DraftState } from "@/lib/note-drafts/draft-saver";
import type { NoteDraftSaveResult } from "@/lib/note-drafts/types";

// HON-130: the draft state machine. One request in flight, newest text wins, honest states, no false conflict on a lost response.
function setup(send: (f: { body?: string }, rev: number) => Promise<NoteDraftSaveResult>, initialRevision = 0) {
  const states: DraftState[] = [];
  const saver = new DraftSaver({ send, onState: (s) => states.push(s), initialRevision, debounceMs: 1500, retryMs: [2000, 4000] });
  return { saver, states, last: () => states[states.length - 1] };
}
const ok = (revision: number): NoteDraftSaveResult => ({ status: "ok", revision, savedAt: "2026-11-28T10:02:00.000Z" });

describe("DraftSaver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces: one save 1.5 s after the last keystroke, and only then says saved", async () => {
    const send = vi.fn(async () => ok(1));
    const { saver, last } = setup(send);
    saver.change({ body: "a" });
    saver.change({ body: "ab" });
    expect(last().phase).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(1400);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ body: "ab" }, 0);
    expect(last().phase).toBe("saved");
    expect(last().savedAt).toBe("2026-11-28T10:02:00.000Z");
  });

  it("never shows saved before the server acknowledged: saving while in flight", async () => {
    let release!: (r: NoteDraftSaveResult) => void;
    const send = vi.fn(() => new Promise<NoteDraftSaveResult>((r) => (release = r)));
    const { saver, last } = setup(send);
    saver.change({ body: "x" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(last().phase).toBe("saving");
    release(ok(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe("saved");
  });

  it("one request in flight; a change during a save queues exactly one follow-up with the NEWEST text and the new revision (no out-of-order overwrite)", async () => {
    const releases: Array<(r: NoteDraftSaveResult) => void> = [];
    const send = vi.fn((_f: { body?: string }, _rev: number) => new Promise<NoteDraftSaveResult>((r) => releases.push(r)));
    const { saver } = setup(send);
    saver.change({ body: "one" });
    await vi.advanceTimersByTimeAsync(1500);
    saver.change({ body: "two" });
    saver.change({ body: "three" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1); // nothing overlaps
    releases[0](ok(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual([{ body: "three" }, 1]);
  });

  it("a failed save keeps the text, says error, retries with backoff, and only then saved", async () => {
    const send = vi
      .fn<(f: { body?: string }, r: number) => Promise<NoteDraftSaveResult>>()
      .mockResolvedValueOnce({ status: "error" })
      .mockResolvedValueOnce(ok(1));
    const { saver, last } = setup(send);
    saver.change({ body: "keep me" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(last().phase).toBe("error");
    expect(saver.hasUnsavedWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(send.mock.calls[1][0]).toEqual({ body: "keep me" });
    expect(last().phase).toBe("saved");
  });

  it("a thrown request is an error, not a crash, and manual retry works", async () => {
    const send = vi.fn<(f: { body?: string }, r: number) => Promise<NoteDraftSaveResult>>().mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce(ok(1));
    const { saver, last } = setup(send);
    saver.change({ body: "t" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(last().phase).toBe("error");
    saver.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe("saved");
  });

  it("a conflict keeps OUR text, shows theirs, and never auto-merges; Keep mine re-saves on the current revision", async () => {
    const send = vi
      .fn<(f: { body?: string }, r: number) => Promise<NoteDraftSaveResult>>()
      .mockResolvedValueOnce({ status: "conflict", revision: 5, fields: { body: "theirs" }, savedAt: "t" })
      .mockResolvedValueOnce(ok(6));
    const { saver, last } = setup(send, 2);
    saver.change({ body: "mine" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(last().phase).toBe("conflict");
    expect(last().theirs).toEqual({ body: "theirs" });
    saver.change({ body: "mine more" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1); // no silent retry while in conflict
    saver.keepMine();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls[1]).toEqual([{ body: "mine more" }, 5]);
    expect(last().phase).toBe("saved");
  });

  it("Use theirs adopts the other window's draft and stops sending ours", async () => {
    const send = vi.fn(async () => ({ status: "conflict", revision: 3, fields: { body: "theirs" }, savedAt: "t" }) as NoteDraftSaveResult);
    const { saver } = setup(send);
    saver.change({ body: "mine" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(saver.useTheirs()).toEqual({ body: "theirs" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a cleared draft (the real record was saved) stops all writing and writes no text", async () => {
    let release!: (r: NoteDraftSaveResult) => void;
    const send = vi.fn(() => new Promise<NoteDraftSaveResult>((r) => (release = r)));
    const { saver, last } = setup(send, 4);
    saver.change({ body: "autosave in flight" });
    await vi.advanceTimersByTimeAsync(1500);
    saver.settle(); // THIS tab saved the record while that autosave was still in flight
    release({ status: "cleared" });
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe("idle"); // silent: expected, nothing more written
    expect(send).toHaveBeenCalledTimes(1);
    expect(saver.hasUnsavedWork()).toBe(false);
  });

  it("another window saved the record: this tab KEEPS its text and offers keep-as-new or discard, never resets", async () => {
    const send = vi.fn<(f: { body?: string }, r: number) => Promise<NoteDraftSaveResult>>().mockResolvedValueOnce({ status: "cleared" }).mockResolvedValueOnce(ok(1));
    const { saver, last } = setup(send, 4);
    saver.change({ body: "tab A text" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(last().phase).toBe("cleared");
    expect(saver.hasUnsavedWork()).toBe(true);
    saver.change({ body: "tab A more" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1); // nothing is written while the question is open
    saver.keepAsNew();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls[1]).toEqual([{ body: "tab A more" }, 0]);
    expect(last().phase).toBe("saved");
  });

  it("gone (draft removed elsewhere) re-creates as a new draft at revision 0", async () => {
    const send = vi.fn<(f: { body?: string }, r: number) => Promise<NoteDraftSaveResult>>().mockResolvedValueOnce({ status: "gone" }).mockResolvedValueOnce(ok(1));
    const { saver } = setup(send, 3);
    saver.change({ body: "again" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(send.mock.calls[1]).toEqual([{ body: "again" }, 0]);
  });

  it("flush saves immediately and resolves when settled (section / client switch)", async () => {
    const send = vi.fn(async () => ok(1));
    const { saver } = setup(send);
    saver.change({ body: "leaving" });
    await saver.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(saver.hasUnsavedWork()).toBe(false);
  });
});
