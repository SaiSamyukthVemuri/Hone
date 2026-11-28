import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftSaver, type DraftState } from "@/lib/note-drafts/draft-saver";
import type { NoteDraftSaveResult } from "@/lib/note-drafts/types";

// HON-130: the draft state machine. One request in flight, newest text wins, honest states, no false conflict on a lost response.
const GEN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GEN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GEN_NEW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
type Send = (f: { body?: string }, rev: number, generation: string) => Promise<NoteDraftSaveResult>;
function setup(send: Send, initialRevision = 0) {
  const states: DraftState[] = [];
  const saver = new DraftSaver({ send, onState: (s) => states.push(s), initialRevision, generation: GEN_A, newGeneration: () => GEN_NEW, debounceMs: 1500, retryMs: [2000, 4000] });
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
    expect(send).toHaveBeenCalledWith({ body: "ab" }, 0, GEN_A);
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
    const send = vi.fn((_f: { body?: string }, _rev: number, _g: string) => new Promise<NoteDraftSaveResult>((r) => releases.push(r)));
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
    expect(send.mock.calls[1]).toEqual([{ body: "three" }, 1, GEN_A]);
  });

  it("a failed save keeps the text, says error, retries with backoff, and only then saved", async () => {
    const send = vi
      .fn<Send>()
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
    const send = vi.fn<Send>().mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce(ok(1));
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
      .fn<Send>()
      .mockResolvedValueOnce({ status: "conflict", revision: 5, fields: { body: "theirs" }, savedAt: "t", generation: GEN_B })
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
    expect(send.mock.calls[1]).toEqual([{ body: "mine more" }, 5, GEN_B]); // takes the other window's lifecycle over
    expect(last().phase).toBe("saved");
  });

  it("Use theirs adopts the other window's draft and stops sending ours", async () => {
    const send = vi.fn(async () => ({ status: "conflict", revision: 3, fields: { body: "theirs" }, savedAt: "t", generation: GEN_B }) as NoteDraftSaveResult);
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
    release({ status: "cleared", revision: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe("idle"); // silent: expected, nothing more written
    expect(send).toHaveBeenCalledTimes(1);
    expect(saver.hasUnsavedWork()).toBe(false);
  });

  it("another window saved the record: this tab KEEPS its text and offers keep-as-new or discard, never resets", async () => {
    const send = vi.fn<Send>().mockResolvedValueOnce({ status: "cleared", revision: 6 }).mockResolvedValueOnce(ok(7));
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
    expect(send.mock.calls[1]).toEqual([{ body: "tab A more" }, 0, GEN_NEW]); // a NEW lifecycle: new generation, expected revision 0
    expect(last().phase).toBe("saved");
  });

  it("gone (draft removed elsewhere) re-creates as a new draft at revision 0", async () => {
    const send = vi.fn<Send>().mockResolvedValueOnce({ status: "gone" }).mockResolvedValueOnce(ok(1));
    const { saver } = setup(send, 3);
    saver.change({ body: "again" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(send.mock.calls[1]).toEqual([{ body: "again" }, 0, GEN_A]);
  });

  it("flush saves immediately and resolves when settled (section / client switch)", async () => {
    const send = vi.fn(async () => ok(1));
    const { saver } = setup(send);
    saver.change({ body: "leaving" });
    await saver.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(saver.hasUnsavedWork()).toBe(false);
  });

  // ---- Codex findings on #1879 ----

  it("P1: a flush that FAILS resolves false and the text is still held, never treated as saved", async () => {
    const send = vi.fn(async () => ({ status: "error" }) as NoteDraftSaveResult);
    const { saver } = setup(send);
    saver.change({ body: "typed during an outage" });
    const saved = await saver.flush();
    expect(saved).toBe(false);
    expect(saver.unsavedWork()).toEqual({ fields: { body: "typed during an outage" }, revision: 0 });
    expect(saver.hasUnsavedWork()).toBe(true);
  });

  it("P1: a flush that succeeds resolves true and holds nothing", async () => {
    const { saver } = setup(async () => ok(1));
    saver.change({ body: "fine" });
    expect(await saver.flush()).toBe(true);
    expect(saver.unsavedWork()).toBeNull();
  });

  it("P1: a request still in flight keeps its text recoverable (a timed-out unmount flush)", async () => {
    const send = vi.fn(() => new Promise<NoteDraftSaveResult>(() => undefined));
    const { saver } = setup(send);
    saver.change({ body: "in flight" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(saver.unsavedWork()?.fields).toEqual({ body: "in flight" });
  });

  it("a FIRST write that meets an ended lifecycle is NOT continued silently: the tab keeps its text and asks (cleared), nothing more is written", async () => {
    const send = vi.fn<Send>().mockResolvedValueOnce({ status: "cleared", revision: 3 });
    const { saver, last } = setup(send, 0);
    saver.change({ body: "new note after an earlier save" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(last().phase).toBe("cleared");
    expect(saver.unsavedWork()?.fields).toEqual({ body: "new note after an earlier save" });
  });

  it("r4 P2a: a late OK acknowledgement from before settle() is dropped: no revision, no 'saved', no old text restored as acknowledged", async () => {
    let release!: (r: NoteDraftSaveResult) => void;
    const send = vi.fn((_f: { body?: string }, _rev: number, _g: string) => new Promise<NoteDraftSaveResult>((r) => (release = r)));
    const { saver, last } = setup(send, 0);
    saver.change({ body: "saved text" });
    await vi.advanceTimersByTimeAsync(1500); // in flight under GEN_A
    saver.settle(); // the real Save committed meanwhile; the next lifecycle is GEN_NEW at revision 0
    release(ok(7));
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.currentRevision()).toBe(0);
    expect(saver.currentGeneration()).toBe(GEN_NEW);
    expect(last().phase).toBe("idle");
    expect(saver.latestFields()).toBeNull(); // the saved text is not reinstated as acknowledged
  });

  it("r4 P2a: text typed after settle() while the old request was out is sent under the NEW generation at revision 0", async () => {
    const releases: Array<(r: NoteDraftSaveResult) => void> = [];
    const send = vi.fn((_f: { body?: string }, _rev: number, _g: string) => new Promise<NoteDraftSaveResult>((r) => releases.push(r)));
    const { saver } = setup(send, 0);
    saver.change({ body: "old" });
    await vi.advanceTimersByTimeAsync(1500);
    saver.settle();
    saver.change({ body: "next note" });
    releases[0](ok(3)); // late ack of the old lifecycle
    await vi.advanceTimersByTimeAsync(1600);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ body: "next note" }, 0, GEN_NEW);
  });

  it("P1: a late FIRST autosave of THIS tab after its own Save comes back cleared and writes nothing more", async () => {
    let release!: (r: NoteDraftSaveResult) => void;
    const send = vi.fn(() => new Promise<NoteDraftSaveResult>((r) => (release = r)));
    const { saver, last } = setup(send, 0);
    saver.change({ body: "typed, first autosave in flight" });
    await vi.advanceTimersByTimeAsync(1500);
    saver.settle(); // Save committed meanwhile
    release({ status: "cleared", revision: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(last().phase).toBe("idle");
    expect(saver.unsavedWork()).toBeNull();
  });

  it("P1: Discard waits for the request in flight before it may delete, so a late save cannot recreate the draft", async () => {
    let release!: (r: NoteDraftSaveResult) => void;
    const send = vi.fn(() => new Promise<NoteDraftSaveResult>((r) => (release = r)));
    const { saver } = setup(send);
    saver.change({ body: "x" });
    await vi.advanceTimersByTimeAsync(1500);
    let quiesced = false;
    void saver.quiesce().then(() => (quiesced = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(quiesced).toBe(false); // the in-flight save has not answered yet
    release(ok(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(quiesced).toBe(true);
    saver.change({ body: "typed while discarding" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1); // nothing new is sent while quiesced
  });

  it("P2: a discard that fails keeps the queued text and sends it again on resume", async () => {
    const send = vi.fn(async () => ok(1));
    const { saver } = setup(send);
    saver.change({ body: "keep me" });
    await saver.quiesce();
    saver.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledWith({ body: "keep me" }, 0, GEN_A);
  });

  it("P2: after a SUCCESSFUL discard (settle) nothing queued is ever sent", async () => {
    const send = vi.fn(async () => ok(1));
    const { saver } = setup(send);
    saver.change({ body: "typed" });
    await saver.quiesce();
    saver.settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("Discard while typing during an in-flight save does not hang: quiesce resolves when the response lands with newer text queued", async () => {
    let release!: (r: NoteDraftSaveResult) => void;
    const send = vi.fn(() => new Promise<NoteDraftSaveResult>((r) => (release = r)));
    const { saver } = setup(send);
    saver.change({ body: "first" });
    await vi.advanceTimersByTimeAsync(1500); // request 1 is out
    saver.change({ body: "first, then more" }); // typing during the in-flight save queues text
    let quiesced = false;
    void saver.quiesce().then(() => (quiesced = true)); // the Discard pauses the saver
    release(ok(1)); // the response lands: queued text is waiting, but paused, so nothing re-sends
    await vi.advanceTimersByTimeAsync(0);
    expect(quiesced).toBe(true);
    expect(send).toHaveBeenCalledTimes(1); // nothing new was sent while paused
  });

  it("quiesce also resolves when the in-flight request ends in a gone or cleared answer that would re-enter run()", async () => {
    let release!: (r: NoteDraftSaveResult) => void;
    const send = vi.fn(() => new Promise<NoteDraftSaveResult>((r) => (release = r)));
    const { saver } = setup(send);
    saver.change({ body: "x" });
    await vi.advanceTimersByTimeAsync(1500);
    let quiesced = false;
    void saver.quiesce().then(() => (quiesced = true));
    release({ status: "gone" });
    await vi.advanceTimersByTimeAsync(0);
    expect(quiesced).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("settle starts a NEW lifecycle: the next typing names a new generation at revision 0", async () => {
    const send = vi.fn<Send>(async () => ok(1));
    const { saver } = setup(send);
    saver.change({ body: "a" });
    await vi.advanceTimersByTimeAsync(1500);
    saver.settle();
    saver.change({ body: "b" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(send.mock.calls.map((c) => [c[1], c[2]])).toEqual([[0, GEN_A], [0, GEN_NEW]]);
  });

  it("Use theirs adopts their generation so the next write continues THEIR lifecycle", async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce({ status: "conflict", revision: 3, fields: { body: "theirs" }, savedAt: "t", generation: GEN_B })
      .mockResolvedValueOnce(ok(4));
    const { saver } = setup(send);
    saver.change({ body: "mine" });
    await vi.advanceTimersByTimeAsync(1500);
    saver.useTheirs();
    expect(saver.currentGeneration()).toBe(GEN_B);
    saver.change({ body: "theirs and more" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(send.mock.calls[1]).toEqual([{ body: "theirs and more" }, 3, GEN_B]);
  });
});
