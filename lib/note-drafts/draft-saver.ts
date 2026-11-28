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

export type DraftSend = (fields: NoteDraftFields, expectedRevision: number, generation: string) => Promise<NoteDraftSaveResult>;

export type DraftSaverOptions = {
  send: DraftSend;
  onState: (state: DraftState) => void;
  initialRevision?: number;
  /** The draft lifecycle this saver writes under (a restored draft's own, else a new one). Every send names it. */
  generation?: string;
  /** Mints the generation of the NEXT lifecycle (after a Save, a Discard, a move, or Keep as new). */
  newGeneration?: () => string;
  debounceMs?: number;
  /** Retry delays after a failed save, then repeats the last. */
  retryMs?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export class DraftSaver {
  private revision: number;
  /** The lifecycle this saver writes under. Identity, not ordering: the revision orders writes inside one lifecycle. */
  private generation: string;
  private readonly mint: () => string;
  /** The other lifecycle's generation while in `conflict`: Keep mine takes that draft over, Use theirs adopts it. */
  private theirGeneration: string | null = null;
  private pending: NoteDraftFields | null = null;
  /** The fields of the request currently in flight (so a timed-out unmount can still hold them). */
  private inFlightFields: NoteDraftFields | null = null;
  /** Quiesced for a discard: nothing new is sent until resume() or settle(). */
  private paused = false;
  private inFlight = false;
  private timer: unknown = null;
  private failures = 0;
  private disposed = false;
  private lastAcked: NoteDraftFields | null = null;
  /** True after THIS tab saved the real record (settle): a late write of ours coming back cleared is expected and silent. */
  private selfSettled = false;
  private state: DraftState = { phase: "idle", savedAt: null, theirs: null };
  private idleWaiters: Array<() => void> = [];
  private readonly o: Required<Omit<DraftSaverOptions, "initialRevision" | "generation" | "newGeneration">>;
  private listener: (state: DraftState) => void;

  constructor(options: DraftSaverOptions) {
    this.mint = options.newGeneration ?? (() => crypto.randomUUID());
    this.generation = options.generation ?? this.mint();
    this.revision = options.initialRevision ?? 0;
    this.listener = options.onState;
    this.o = {
      send: options.send,
      onState: (state) => this.listener(state),
      debounceMs: options.debounceMs ?? 1500,
      retryMs: options.retryMs ?? [2000, 4000, 8000, 16000, 30000],
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
  }

  /** Start from a draft the server already holds (a restored one), so its text counts as the latest. */
  adopt(fields: NoteDraftFields) {
    this.lastAcked = fields;
  }

  /** Point state updates at a new listener (a remounted component re-attaches to the same saver). */
  setListener(fn: (state: DraftState) => void) {
    this.listener = fn;
  }

  snapshot(): DraftState {
    return this.state;
  }

  /** The generation of the draft this saver is writing (named by the real Save so the same transaction ends it). */
  currentGeneration(): string {
    return this.generation;
  }

  /** The revision the server last acknowledged (0 = none). */
  currentRevision(): number {
    return this.revision;
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
    if (this.paused) return; // quiesced for a discard: the text is held, nothing is scheduled
    this.set({ phase: this.inFlight ? "saving" : "unsaved" });
    this.clear();
    this.timer = this.o.setTimer(() => void this.run(), this.o.debounceMs);
  }

  /**
   * Save now (blur, tab hidden, section or client switch). Resolves when nothing is in flight, with TRUE only if everything typed was
   * acknowledged by the server. After a failure, a conflict or a clear it resolves FALSE and the text is still held (see unsavedWork()):
   * the caller must keep it recoverable, never treat the flush as a save.
   */
  async flush(): Promise<boolean> {
    this.clear();
    await this.run();
    if (this.inFlight) await new Promise<void>((r) => this.idleWaiters.push(r));
    return this.pending == null && !this.inFlight;
  }

  /** The newest text the server has NOT acknowledged (queued or in flight), with the revision to continue from; null when none. */
  unsavedWork(): { fields: NoteDraftFields; revision: number } | null {
    const fields = this.pending ?? this.inFlightFields;
    return fields ? { fields, revision: this.revision } : null;
  }

  /** The newest text this saver knows of (acknowledged or not). */
  latestFields(): NoteDraftFields | null {
    return this.pending ?? this.inFlightFields ?? this.lastAcked;
  }

  /** Stop sending and wait for an in-flight request to finish, keeping the queued text. Pair with resume() or settle(). */
  async quiesce(): Promise<void> {
    this.paused = true;
    this.clear();
    if (this.inFlight) await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  /** A discard failed: send again what was queued. */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.pending != null) {
      this.set({ phase: "error" });
      this.failures = 0;
      void this.run();
    }
  }

  private async run(): Promise<void> {
    this.clear();
    if (this.paused && !this.inFlight) {
      // Quiesced and nothing in flight: anyone waiting for idle (a Discard that paused us while a request was out) must be released HERE,
      // because the paths that re-enter run() after a response (queued text, retry, gone, cleared) return before the end-of-run release.
      this.releaseWaiters();
      return;
    }
    if (this.inFlight || this.pending == null || this.disposed || this.paused) return;
    if (this.state.phase === "conflict" || this.state.phase === "cleared") return;
    const fields = this.pending;
    this.pending = null;
    this.inFlightFields = fields;
    this.inFlight = true;
    this.set({ phase: "saving" });
    let result: NoteDraftSaveResult;
    try {
      result = await this.o.send(fields, this.revision, this.generation);
    } catch {
      result = { status: "error" };
    }
    this.inFlight = false;
    this.inFlightFields = null;
    if (result.status === "ok") {
      this.revision = result.revision;
      this.lastAcked = fields;
      this.failures = 0;
      if (this.pending != null) {
        this.set({ phase: "saving" });
        void this.run();
        return;
      }
      this.set({ phase: "saved", savedAt: result.savedAt, theirs: null });
    } else if (result.status === "conflict") {
      this.revision = result.revision;
      this.theirGeneration = result.generation;
      // Keep OUR newest text; never merge. Resolution is explicit (useTheirs / keepMine).
      this.pending = this.pending ?? fields;
      this.set({ phase: "conflict", theirs: result.fields });
    } else if (result.status === "cleared") {
      if (this.selfSettled) {
        // This tab's own Save cleared the draft and a late autosave of ours came back: expected, silent, writes nothing.
        this.revision = 0;
        this.pending = null;
        this.set({ phase: "idle", savedAt: null, theirs: null });
      } else {
        // This lifecycle is OVER: another window saved the record or discarded the draft, or the revised note already has its revision. KEEP this
        // tab's text, never reset the form, and ask: keep it as a new draft (a NEW generation) or discard it. A revision of 0 means the revise
        // target itself has its revision: only a NEW note can hold the text.
        this.revision = result.revision;
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
      if (result.status === "error" && !this.disposed) this.timer = this.o.setTimer(() => void this.run(), delay);
    }
    this.releaseWaiters();
  }

  private releaseWaiters() {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Manual retry after an error. */
  retry() {
    this.failures = 0;
    void this.run();
  }

  /** Conflict: overwrite the other window's draft with ours: take its lifecycle over and re-save on its current revision. */
  keepMine() {
    if (this.state.phase !== "conflict") return;
    if (this.theirGeneration) this.generation = this.theirGeneration;
    this.theirGeneration = null;
    this.set({ phase: "unsaved", theirs: null });
    void this.run();
  }

  /**
   * Cleared by another window: keep our text as a draft again. Continues from the tombstone's revision. When the cleared key was a REVISION
   * of a note that now has its revision, the caller moves the text to a NEW-note key instead (see `retarget` in the hook): this saver is
   * then disposed and the new key's saver starts from revision 0.
   */
  keepAsNew() {
    if (this.state.phase !== "cleared") return;
    // A NEW lifecycle: a new generation and expected revision 0. The server begins it on the tombstone (never revives the ended one).
    this.generation = this.mint();
    this.revision = 0;
    this.set({ phase: "unsaved" });
    void this.run();
  }

  /** Conflict: adopt the other window's draft. Returns it so the caller can fill the form. */
  useTheirs(): NoteDraftFields | null {
    const theirs = this.state.theirs;
    if (this.theirGeneration) this.generation = this.theirGeneration;
    this.theirGeneration = null;
    this.pending = null;
    this.lastAcked = theirs;
    this.set({ phase: "saved", theirs: null });
    return theirs;
  }

  /** The real record was saved or the draft discarded: nothing more to send. */
  settle() {
    this.selfSettled = true;
    this.paused = false;
    this.pending = null;
    this.lastAcked = null;
    this.clear();
    // The next typing is a NEW draft lifecycle: a new generation and expected revision 0 (the server begins it on the tombstone).
    this.generation = this.mint();
    this.revision = 0;
    this.theirGeneration = null;
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
