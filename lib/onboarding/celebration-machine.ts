import type { OnboardingModel } from "./steps";

// PERF-01C. The one-time celebration, as an explicit state machine.
//
// WHY A MACHINE RATHER THAN A HANDFUL OF FLAGS
// --------------------------------------------
// Four successive review findings on #658 were the same defect wearing
// different clothes: CLIENT-LOCAL STATE OUTLIVING OR OUTRANKING FRESH SERVER
// AUTHORITY.
//
//   1. `completedLocally` never cleared        -> a latch, not a bridge
//   2. celebration spent on visual playback    -> a REFUSED stamp still consumed it
//   3. a stale in-flight model discarded the close -> the conjunction never completed
//   4. a model deferred during a stamp was never revisited -> this file
//
// (4) is the one that proves flags are the wrong tool. The previous fix
// correctly SKIPPED a model that arrived while the stamp was in flight, because
// such a model cannot have observed the outcome of a request still running. But
// it recorded that model as "seen" and cleared the in-flight marker in a REF.
// A ref mutation is not a render: nothing re-considered the skipped model, and
// the deferred transition was lost. Deferral without resolution is discarding
// on a delay.
//
// So the rule the machine enforces is total rather than partial:
//
//   A SERVER MODEL DEFERRED BECAUSE A REQUEST WAS IN FLIGHT IS RESOLVED BY THAT
//   REQUEST'S OUTCOME. It is never merely skipped.
//
//     STAMP_SUCCEEDED          -> the deferred model provably predates the write,
//                                 so it is stale and is DISCARDED.
//     STAMP_REFUSED_OR_FAILED  -> nothing was written, so the deferred model is
//                                 still truthful and is APPLIED.
//
// AUTHORITY
// ---------
// The SERVER decides whether a celebration is owed (`model.shouldCelebrate`)
// and whether the durable stamp landed (`markCelebrationShownAction` -> ok).
// The CLIENT may only remember three transient things: this celebration was
// shown, the owner closed it, and a request is outstanding.
//
// GENERATIONS ARE WHAT MAKE THE CONJUNCTION HONEST
// ------------------------------------------------
// Suppression is not "closed && stamped" but "closed AND stamped FOR THE SAME
// SHOWING". Every distinct showing of the confetti is allocated a monotonically
// increasing id, and both the close and the confirmed stamp record the showing
// they belong to.
//
// Without that, the P3 failure survives even the deferral fix: a refused stamp
// leaves an old close latched, the owner reopens, the retry succeeds, and the
// OLD close combines with the NEW stamp to spend a celebration the owner is
// still looking at. Comparing ids makes that arithmetically impossible, and it
// holds even when no fresh server model ever arrives to retire anything. The
// two mechanisms are independent barriers against the same failure.

/**
 * A showing id. 0 is the null id: "no showing", never a real generation.
 * Ids are allocated by the caller so an async settlement can carry the id of
 * the request it belongs to and a superseded reply can be ignored.
 */
export type ShowingId = number;

export type CelebrationState = {
  /** The showing the owner is currently being shown, or has not yet resolved. */
  live: ShowingId;
  /** The showing the owner closed after being shown it. */
  closed: ShowingId;
  /** The showing whose durable server stamp came back ok. */
  stamped: ShowingId;
  /** The showing whose stamp request is still outstanding. */
  inFlight: ShowingId;
  /**
   * A server model that arrived while a stamp was outstanding. HELD, not
   * dropped: it is resolved when that request settles and its staleness can
   * actually be decided.
   */
  deferred: OnboardingModel | null;
  /** Identity of the last server model already folded in. */
  seen: OnboardingModel | null;
};

export type CelebrationEvent =
  /** A server render delivered a model. Identity is the signal: a server render
   *  ships a new object over the RSC payload, a client-only re-render reuses it. */
  | { type: "SERVER_MODEL_ARRIVED"; model: OnboardingModel }
  /** The confetti mounted for a distinct showing. Also the transition an
   *  OWNER_REOPENED produces when the celebration is still owed. */
  | { type: "CELEBRATION_SHOWN"; showing: ShowingId }
  | { type: "STAMP_STARTED"; showing: ShowingId }
  | { type: "STAMP_SUCCEEDED"; showing: ShowingId }
  | { type: "STAMP_REFUSED_OR_FAILED"; showing: ShowingId }
  | { type: "OWNER_CLOSED_AFTER_SHOWING" }
  | { type: "OWNER_REOPENED" };

export const INITIAL_CELEBRATION_STATE: CelebrationState = {
  live: 0,
  closed: 0,
  stamped: 0,
  inFlight: 0,
  deferred: null,
  seen: null,
};

/**
 * The celebration is spent only when the owner closed a showing AND the server
 * confirmed the durable stamp FOR THAT SAME SHOWING.
 *
 * Same-showing is the load-bearing half. A refused stamp never sets `stamped`,
 * so it can never complete the conjunction; and a close belonging to an earlier
 * showing can never be completed by a later showing's stamp.
 */
export function isCelebrationSpent(state: CelebrationState): boolean {
  return state.closed !== 0 && state.closed === state.stamped;
}

/**
 * Hand authority back to the server: a positive model means the celebration is
 * still owed, so the local SUPPRESSION is dropped.
 *
 * Only a model that actually claims the celebration is owed retires anything,
 * and only when there is something latched to retire.
 *
 * `live` deliberately survives. Retiring it too would orphan a showing that is
 * still on screen — the confetti stays mounted, no CELEBRATION_SHOWN fires again
 * because nothing the effect depends on changed, and the owner's next close
 * would record against showing 0 and be dropped. Keeping it costs nothing:
 * suppression compares ids, so a close belonging to this showing still cannot be
 * completed by a later showing's stamp.
 */
function retire(
  state: CelebrationState,
  model: OnboardingModel,
): CelebrationState {
  if (!model.shouldCelebrate) return state;
  if (state.closed === 0 && state.stamped === 0) return state;
  return { ...state, closed: 0, stamped: 0 };
}

export function celebrationReducer(
  state: CelebrationState,
  event: CelebrationEvent,
): CelebrationState {
  switch (event.type) {
    case "SERVER_MODEL_ARRIVED": {
      // A client-only re-render reuses the prop and says nothing new.
      if (state.seen === event.model) return state;
      const seen = { ...state, seen: event.model };
      // SERVER_MODEL_DEFERRED_DURING_STAMP. This model cannot have observed the
      // outcome of a request that is still running, so it may not retire
      // anything yet — but it is KEPT, and the settlement below resolves it.
      if (state.inFlight !== 0) return { ...seen, deferred: event.model };
      return retire(seen, event.model);
    }

    case "CELEBRATION_SHOWN":
      return { ...state, live: event.showing };

    case "STAMP_STARTED":
      return { ...state, inFlight: event.showing };

    case "STAMP_SUCCEEDED": {
      // A settlement for a superseded showing decides nothing about this one.
      if (state.inFlight !== event.showing) return state;
      // The stamp landed, so any model deferred behind it was read before the
      // write and is provably stale. Discarding it is what stops a stale
      // positive model from undoing a successful consumption.
      return { ...state, stamped: event.showing, inFlight: 0, deferred: null };
    }

    case "STAMP_REFUSED_OR_FAILED": {
      if (state.inFlight !== event.showing) return state;
      const settled = { ...state, inFlight: 0, deferred: null };
      // Nothing was written, so a model deferred behind this request is still
      // telling the truth. THIS is the transition the old ref-clear never made.
      return state.deferred ? retire(settled, state.deferred) : settled;
    }

    case "OWNER_CLOSED_AFTER_SHOWING":
      // A close before any celebration was shown spends nothing.
      if (state.live === 0) return state;
      return { ...state, closed: state.live };

    case "OWNER_REOPENED":
      // A showing the owner already closed is finished; it must not stay live
      // and collect a second close. Reopening starts a fresh attempt, and
      // CELEBRATION_SHOWN gives that attempt its own id.
      return state.closed !== 0 && state.closed === state.live
        ? { ...state, live: 0 }
        : state;
  }
}
