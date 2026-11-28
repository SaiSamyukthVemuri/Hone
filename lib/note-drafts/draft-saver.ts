import type { NoteDraftFields, NoteDraftSaveResult } from "./types";

// The draft state machine. Framework-free so ordering, retry and conflict behaviour are unit-tested with fake timers.
//
// ORDERING: exactly one request is ever in flight, so responses cannot arrive out of order; a change made during a save
// queues ONE follow-up carrying the newest text. The server also compare-and-sets on `revision`, so a second window
// cannot be silently overwritten.

export type DraftPhase = "idle" | "unsaved" | "saving" | "saved" | "error" | "conflict" | "cleared";

export type DraftState = {
  phase: DraftPhase;
  /** ISO time the server acknowledged the last write (only set after an ack). */
  savedAt: string | null;
  /** The other window's draft, set only while phase is "conflict". */
  theirs: NoteDraftFields | null;
};

export type DraftSend = (fields: NoteDraftFields, expectedRevision: number) => Promise<NoteDraftSaveResult>;

export type DraftSaverOptions = {
  send: DraftSend;
  onState: (state: DraftState) => void;
  initialRevision?: number;
  debounceMs?: number;
  /** Retry delays after a failed save, then repeats the last. */
  retryMs?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export class DraftSaver {
  private revision: number;
  private pending: NoteDraftFields | null = null;
  private inFlight = false;
  private timer: unknown = null;
  private failures = 0;
  private disposed = false;
  /** True after THIS tab saved the real record (settle): a late write of ours coming back cleared is expected and silent. */
  private selfSettled = false;
  private state: DraftState = { phase: "idle", savedAt: null, theirs: null };
  private idleWaiters: Array<() => void> = [];
  private readonly o: Required<Omit<DraftSaverOptions, "initialRevision">>;

  constructor(options: DraftSaverOptions) {
    this.revision = options.initialRevision ?? 0;
    this.o = {
      send: options.send,
      onState: options.onState,
      debounceMs: options.debounceMs ?? 1500,
      retryMs: options.retryMs ?? [2000, 4000, 8000, 16000, 30000],
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
  }

  private set(next: Partial<DraftState>) {
    this.state = { ...this.state, ...next };
    if (!this.disposed) this.o.onState(this.state);
  }

  private clear() {
    if (this.timer != null) this.o.clearTimer(this.timer);
    this.timer = null;
  }

  /** The person typed. */
  change(fields: NoteDraftFields) {
    if (this.disposed) return;
    this.pending = fields;
    this.selfSettled = false;
    if (this.state.phase === "conflict" || this.state.phase === "cleared") return; // keep their text; resolution is explicit
    this.set({ phase: this.inFlight ? "saving" : "unsaved" });
    this.clear();
    this.timer = this.o.setTimer(() => void this.run(), this.o.debounceMs);
  }

  /** Save now (blur, tab hidden, section or client switch). Resolves when nothing is pending or in flight. */
  async flush(): Promise<void> {
    this.clear();
    await this.run();
    if (this.inFlight) await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  private async run(): Promise<void> {
    this.clear();
    if (this.inFlight || this.pending == null || this.disposed) return;
    if (this.state.phase === "conflict" || this.state.phase === "cleared") return;
    const fields = this.pending;
    this.pending = null;
    this.inFlight = true;
    this.set({ phase: "saving" });
    let result: NoteDraftSaveResult;
    try {
      result = await this.o.send(fields, this.revision);
    } catch {
      result = { status: "error" };
    }
    this.inFlight = false;
    if (result.status === "ok") {
      this.revision = result.revision;
      this.failures = 0;
      if (this.pending != null) {
        this.set({ phase: "saving" });
        void this.run();
        return;
      }
      this.set({ phase: "saved", savedAt: result.savedAt, theirs: null });
    } else if (result.status === "conflict") {
      this.revision = result.revision;
      // Keep OUR newest text; never merge. Resolution is explicit (useTheirs / keepMine).
      this.pending = this.pending ?? fields;
      this.set({ phase: "conflict", theirs: result.fields });
    } else if (result.status === "cleared") {
      this.revision = 0;
      if (this.selfSettled) {
        // This tab's own Save cleared the draft and a late autosave of ours came back: expected, silent, writes nothing.
        this.pending = null;
        this.set({ phase: "idle", savedAt: null, theirs: null });
      } else {
        // ANOTHER window saved the record (or the revised note already has its revision). KEEP this tab's text, never reset the
        // form, and ask: keep it as a new draft or discard it.
        this.pending = this.pending ?? fields;
        this.set({ phase: "cleared", theirs: null });
      }
    } else if (result.status === "gone") {
      // The stored draft no longer exists (saved, discarded or expired elsewhere): write ours as a new one.
      this.revision = 0;
      this.pending = this.pending ?? fields;
      void this.run();
      return;
    } else {
      // refused / invalid / error: the text stays on screen; retry with backoff, never claim saved.
      this.pending = this.pending ?? fields;
      const delay = this.o.retryMs[Math.min(this.failures, this.o.retryMs.length - 1)];
      this.failures += 1;
      this.set({ phase: "error" });
      if (result.status === "error") this.timer = this.o.setTimer(() => void this.run(), delay);
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Manual retry after an error. */
  retry() {
    this.failures = 0;
    void this.run();
  }

  /** Conflict: overwrite the other window's draft with ours (re-save on the current revision). */
  keepMine() {
    if (this.state.phase !== "conflict") return;
    this.set({ phase: "unsaved", theirs: null });
    void this.run();
  }

  /** Cleared by another window: keep our text as a NEW draft (expected revision 0). */
  keepAsNew() {
    if (this.state.phase !== "cleared") return;
    this.revision = 0;
    this.set({ phase: "unsaved" });
    void this.run();
  }

  /** Conflict: adopt the other window's draft. Returns it so the caller can fill the form. */
  useTheirs(): NoteDraftFields | null {
    const theirs = this.state.theirs;
    this.pending = null;
    this.set({ phase: "saved", theirs: null });
    return theirs;
  }

  /** The real record was saved or the draft discarded: nothing more to send. */
  settle() {
    this.selfSettled = true;
    this.pending = null;
    this.clear();
    this.revision = 0;
    this.set({ phase: "idle", savedAt: null, theirs: null });
  }

  hasUnsavedWork(): boolean {
    return this.pending != null || this.inFlight || this.state.phase === "error" || this.state.phase === "conflict" || this.state.phase === "cleared";
  }

  dispose() {
    this.disposed = true;
    this.clear();
  }
}
