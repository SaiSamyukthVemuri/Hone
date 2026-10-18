/**
 * The lifecycle of ONE SAVE of machine settings, as a pure state machine.
 *
 * WHY THIS IS A MODULE AND NOT `useState` CALLS IN THE FORM. What this decides
 * is whether a clinical capture gets written, written twice, or reported as
 * written when nobody knows - and this repository has no jsdom or
 * testing-library, so logic living inside a component is provable only by
 * mounting a browser. Three defects in this exact code path were found by
 * review rather than by a test, for precisely that reason. So the rules live
 * here, where they can be asserted directly, and the component holds the
 * state and renders it.
 *
 * WHAT CHANGED UNDERNEATH IT. A Save used to be several independent RPC calls,
 * one per settings group, so the form had to track which groups had succeeded,
 * which had been refused and which had an unknown outcome - and a retry had to
 * send only the untold remainder. `record_treatment_setup_submission` makes a
 * Save ONE atomic call: every group commits or none does. That removes the
 * per-group bookkeeping entirely, and it makes a retry a sensible thing to
 * offer rather than a blind replay.
 *
 * THE RETRY KEY IS THE POINT, and its lifetime is the one subtle thing here.
 * It identifies a SAVE, not an attempt:
 *
 *   * minted when a Save starts and there is none;
 *   * REUSED by every retry of that same Save, which is what makes the retry
 *     safe - if the first attempt actually committed and only its answer was
 *     lost, the retry returns the original submission instead of appending a
 *     second immutable capture;
 *   * cleared on an acknowledged success, and cleared when the practitioner
 *     changes the draft, because a changed draft is a DIFFERENT save.
 *
 * Both halves of that matter. A key regenerated on every click makes
 * idempotency useless - every attempt looks like a new Save. A key that never
 * changes makes a deliberate second capture impossible - she re-reads the
 * machine, enters the same numbers, and the save is silently absorbed.
 */

export type SaveOutcome =
  | {
      kind: "saved";
      /** Captures the submission holds, as the DATABASE counted them. */
      groups: number;
      readings: number;
      /**
       * True when this call matched an EXISTING submission by its retry key.
       *
       * It means the earlier attempt committed and its answer was lost - so
       * nothing new was written and nothing was duplicated. The distinction is
       * reported rather than smoothed over: "saved" and "this was already
       * saved" are different facts about the record.
       */
      reused: boolean;
    }
  | { kind: "refused"; error?: string }
  /**
   * The transport failed, so the server's answer is unknown.
   *
   * NOT a failure. The write may well have committed; the answer was lost on
   * the way back. The only safe response is a retry carrying the same key.
   */
  | { kind: "unknown" };

export type SaveState = {
  /** The retry key for the Save in progress, or null when none is open. */
  key: string | null;
  /** Captures acknowledged in this mount. Drives the confirmation copy. */
  captures: number;
  /** An acknowledged write exists for this draft. */
  recorded: boolean;
  /**
   * The last attempt's outcome is unknown.
   *
   * Retrying is SAFE and is offered. Editing is not: a changed draft would
   * mint a new key, and if the unresolved attempt did commit, that second save
   * records settings twice. So the draft is held until the retry settles.
   */
  unresolved: boolean;
  message: string | null;
};

export function initialSaveState(): SaveState {
  return {
    key: null,
    captures: 0,
    recorded: false,
    unresolved: false,
    message: null,
  };
}

export const UNKNOWN_NOTE =
  "The connection failed, so whether these settings were recorded is not " +
  "known - they may have been. Press Save again: this save carries a retry " +
  "key, so if it did record, saving again returns the same capture rather " +
  "than recording it twice.";

export const REUSED_NOTE =
  "These settings were already recorded - the earlier save did commit, and " +
  "its answer was lost. Nothing was recorded twice.";

export const SAVED_NOTE = "Saved to this treatment.";

export const REFUSED_NOTE = "Could not save those settings.";

/**
 * The key to send with this attempt.
 *
 * `mint` is injected rather than called here so the module stays pure and a
 * test can pin the key. In the browser it is `crypto.randomUUID()`.
 */
export function keyForSave(state: SaveState, mint: () => string): string {
  return state.key ?? mint();
}

/**
 * May the practitioner still change what she is about to save?
 *
 * `inFlight` IS REQUIRED, and that is the point (Codex, #860 4305022472 and
 * 4305022475). This function has been the single authority on "may the draft
 * move" since the state machine was written, and it answered from the SETTLED
 * state alone — so every caller had to remember to add `pending ||` itself,
 * and the one production caller did not.
 *
 * The window it missed is the request's own duration. The payload is
 * snapshotted at submit; if she edits while the request is outstanding then a
 * success silently discards what she typed, and a LOST response is worse — the
 * retained key is bound to a digest of the OLD payload, so the retry the
 * screen advertises is refused as a mismatch, with nothing left but
 * cancel-and-recreate: a duplicate clinical record.
 *
 * This is the same invariant as the five controls before it — a control that
 * can discard the retry key belongs inside the freeze the key depends on —
 * and it had recurred often enough that a convention was the wrong mechanism.
 * A required parameter makes the compiler ask the question instead, so a
 * caller cannot silently omit it.
 */
export function canEditDraft(state: SaveState, inFlight: boolean): boolean {
  return !inFlight && !state.unresolved && !state.recorded;
}

/** May she press Save? */
export function canSubmit(state: SaveState): boolean {
  // An unresolved attempt MAY be retried - that is what the retry key buys.
  // An acknowledged save may not: recording it again is a second capture of
  // settings entered once, which is indistinguishable in the record from a
  // genuine mid-treatment change. She records a change explicitly instead.
  return !state.recorded;
}

/**
 * What one recorder result MEANS, as a `SaveOutcome`.
 *
 * EXTRACTED SO THE CHAIN CAN BE TESTED. It lived inline in
 * `MachineReadingEntry`, which this repository cannot mount - there is no
 * jsdom - so the only available evidence that a transport failure reaches
 * the unknown outcome was a source scan. A scan proves the text mentions
 * the field; it cannot prove the value arrives, and this lane has now lost
 * the same kind of value five times at a hop every scan called fine.
 *
 * `sentGroups` is the fallback tally for a server that reported none.
 */
export function outcomeFromRecordResult(
  out: {
    ok: boolean;
    code?: string;
    error?: string;
    captures?: number;
    written?: number;
    reused?: boolean;
  },
  sentGroups: number,
): SaveOutcome {
  if (out.ok) {
    return {
      kind: "saved",
      // THE DATABASE'S OWN TALLY where it gave one. Counting the groups sent
      // would be wrong on a reused submission - it reports what the ORIGINAL
      // save recorded, which is the only true answer.
      groups: out.captures ?? sentGroups,
      readings: out.written ?? 0,
      reused: out.reused === true,
    };
  }
  // THE SAME OUTCOME AS A THROW, because it is the same event: the write may
  // have committed and only the answer was lost. This keeps the key and
  // freezes the draft, which is what makes pressing Save again safe
  // (Codex, #860 4301722737).
  if (out.code === "unknown") return { kind: "unknown" };
  return { kind: "refused", error: out.error };
}

/**
 * The state after an attempt made with `key` returns `outcome`.
 *
 * ONE LAW GOVERNS `unresolved` HERE, and it is worth stating once rather than
 * leaving it implicit in three branches (Codex, #860 4308887493):
 *
 *   **`unresolved` is MONOTONIC except under `saved`.** A `refused` or
 *   `unknown` outcome may SET it or carry it, never clear it. Only `saved`
 *   clears it, because only an authoritative response for the SAME key answers
 *   the question "did the original commit?" - and `reused: true` is exactly
 *   that answer arriving late.
 *
 * The reason is asymmetric cost. Wrongly keeping the flag holds a draft she
 * must reconcile by reloading; wrongly clearing it appends a second immutable
 * capture of settings recorded once, which cannot be edited or withdrawn.
 */
export function afterOutcome(
  state: SaveState,
  key: string,
  outcome: SaveOutcome,
): SaveState {
  switch (outcome.kind) {
    case "saved":
      return {
        // The Save is closed. The next one is a different save and mints its
        // own key.
        key: null,
        // COUNTED FROM THE SERVER'S OWN TALLY, including on a reuse. A reused
        // submission was written by an attempt whose answer never arrived, so
        // these captures have never been counted here.
        captures: state.captures + outcome.groups,
        recorded: true,
        unresolved: false,
        message: outcome.reused ? REUSED_NOTE : SAVED_NOTE,
      };
    case "refused":
      return {
        // KEPT. A refusal is an acknowledged non-write, so retrying under the
        // same key is correct - and if she edits to fix what was refused, the
        // draft change clears it. While `unresolved` stands, `afterDraftChanged`
        // keeps it instead, which is what stops the key being dropped between a
        // refused retry and a later successful one.
        key,
        captures: state.captures,
        recorded: state.recorded,
        // CARRIED, NEVER CLEARED (Codex, #860 4308887493).
        //
        // A refusal proves THIS attempt wrote nothing. It proves nothing about
        // an EARLIER attempt whose answer was lost, so it cannot answer that
        // attempt's question. Hardcoding `false` here applied round 6's
        // pre-write-refusal reasoning - "nothing was written, so nothing is
        // ambiguous" - to the one state where something ambiguous already
        // existed: it re-enabled editing, `afterDraftChanged` then dropped the
        // retained key, and a later save once access recovered minted a fresh
        // one and appended a SECOND IMMUTABLE CAPTURE of settings recorded
        // once.
        //
        // So the refusal's MESSAGE is surfaced without the refusal unfreezing
        // anything: she is told why the retry was refused and the draft stays
        // held, because the original's outcome is still unknown. The way out is
        // reconciliation - a reload, where the recorded-setups panel shows what
        // actually committed - not an edit.
        unresolved: state.unresolved,
        message: outcome.error ?? REFUSED_NOTE,
      };
    case "unknown":
      return {
        // KEPT, and this is the one case where keeping it is load-bearing:
        // the retry's safety IS this key.
        key,
        captures: state.captures,
        recorded: state.recorded,
        unresolved: true,
        message: UNKNOWN_NOTE,
      };
  }
}

/**
 * The state after the practitioner changes the draft.
 *
 * A changed draft is a DIFFERENT save, so the key is dropped and the next
 * attempt mints a new one. An unresolved attempt is the exception and is left
 * exactly as it was - see `SaveState.unresolved`.
 */
export function afterDraftChanged(state: SaveState): SaveState {
  if (state.unresolved) return state;
  if (state.key === null && state.message === null) return state;
  return { ...state, key: null, message: null };
}

/**
 * The state for a deliberate NEW capture after a save.
 *
 * The key is dropped: this is a new save of newly read values, and inheriting
 * the previous key would make the database absorb it as a retry of settings
 * she has just re-read off the machine.
 *
 * THE CAPTURE COUNT SURVIVES, deliberately. It is what this mount has recorded
 * against the treatment, not what the current draft has, and the confirmation
 * copy distinguishes a first capture from a later revision with it. Resetting
 * it would make the second capture announce itself as the first.
 */
export function afterRecordAnother(state: SaveState): SaveState {
  return { ...initialSaveState(), captures: state.captures };
}

/**
 * Did the DATABASE answer, or did we never hear back?
 *
 * THE DEFECT THIS EXISTS FOR (Codex, #860 4301722737, 4301722740). A lost
 * response is not always a thrown exception: when the connection to PostgREST
 * drops AFTER the command commits, supabase-js can report the transport
 * failure in the returned `error` field instead of rejecting the promise -
 * `lib/booking/queries.ts` already records that it surfaces as
 * "TypeError: fetch failed". Both machine save paths treated every `error` as
 * a definitive refusal, which unfreezes the draft and releases the retry key.
 * An edit then mints a new key, and if the first attempt had committed, the
 * next save appends a DUPLICATE IMMUTABLE capture - the exact outcome the
 * whole retry-key mechanism exists to prevent, reached through the one error
 * shape nobody was classifying.
 *
 * THE RULE: an error is a definitive answer only if it demonstrably came FROM
 * the database or from PostgREST. A Postgres error carries a five-character
 * SQLSTATE (`23505`, `P0001`, `42501`); PostgREST's own errors carry a
 * `PGRST...` code. Anything else - an empty code, a missing one, a bare
 * `TypeError` - means the request's fate is UNKNOWN.
 *
 * IT FAILS IN THE SAFE DIRECTION, and that asymmetry is deliberate.
 *   * A genuine refusal misread as unknown costs one redundant retry: the
 *     retry is answered with the same refusal, which carries a SQLSTATE, and
 *     the state machine then unfreezes normally. It self-corrects.
 *   * An unknown outcome misread as a refusal costs a DUPLICATE CLINICAL
 *     RECORD, which is immutable and indistinguishable from a real
 *     mid-treatment change.
 * So anything not provably from the database is treated as unknown.
 */
export function isDefinitiveDatabaseAnswer(
  error: { code?: string | null } | null | undefined,
): boolean {
  const code = error?.code?.trim() ?? "";
  if (code === "") return false;
  // SQLSTATE: exactly five characters, digits and uppercase letters.
  if (/^[0-9A-Z]{5}$/.test(code)) return true;
  // PostgREST's own error codes mean the request reached PostgREST and was
  // answered by it, which is equally definitive.
  return code.startsWith("PGRST");
}
