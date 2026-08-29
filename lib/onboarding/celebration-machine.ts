import type { OnboardingModel } from "./steps";

// PERF-01C. The one-time celebration, as an explicit state machine.
//
// WHY A MACHINE RATHER THAN A HANDFUL OF FLAGS
// --------------------------------------------
// Five successive review findings on #658 were one defect wearing different
// clothes: CLIENT-LOCAL STATE OUTLIVING OR OUTRANKING FRESH SERVER AUTHORITY.
//
//   1. `completedLocally` never cleared        -> a latch, not a bridge
//   2. celebration spent on visual playback    -> a REFUSED stamp still consumed it
//   3. a stale in-flight model discarded the close -> the conjunction never completed
//   4. a model deferred during a stamp was never revisited
//   5. a durable stamp was DISCARDED because its showing had been superseded
//
// (4) is why flags are the wrong tool. A model arriving while the stamp was in
// flight was correctly SKIPPED — it cannot have observed the outcome of a
// request still running — but the skip lived in a REF and the model was consumed
// as `lastModel`. A ref mutation is not a render, so nothing reconsidered it
// when the request settled. Deferral without resolution is discarding on a delay.
//
// (5) is why the SCOPE of each fact matters, and it is the correction that
// shaped this file. Two things were being conflated:
//
//   * WHETHER THE SERVER DURABLY STAMPED is a fact about the STUDIO. Once
//     `celebrated_at` is written it stays written. It is monotonic, and only the
//     server may retract it.
//   * WHICH SHOWING THE OWNER CLOSED is a fact about one showing of the confetti.
//
// The first version of this machine made BOTH showing-scoped, so a stamp that
// succeeded after its showing had been superseded was thrown away — and a later
// failing showing could then replay confetti the server had already recorded.
// Only the close is showing-scoped now.
//
// THE THREE RULES
// ---------------
//   A. A SERVER MODEL DEFERRED BECAUSE A REQUEST WAS IN FLIGHT IS RESOLVED BY
//      THAT REQUEST'S OUTCOME — never merely skipped.
//        STAMP_SUCCEEDED         -> the model provably predates the write, so it
//                                   is stale and is DISCARDED.
//        STAMP_REFUSED_OR_FAILED -> nothing was written, so the model is still
//                                   truthful and is APPLIED.
//
//   B. A CONFIRMED STAMP IS DURABLE AND MONOTONIC. A later refusal cannot unset
//      it, and neither can its own showing being superseded. Only a fresh server
//      model saying the celebration is still owed retracts it — because that is
//      the server itself saying `celebrated_at` is not set.
//
//   C. SUPPRESSION REQUIRES THE OWNER TO HAVE CLOSED THE SHOWING THEY ARE BEING
//      SHOWN. `closed === live`, not a bare boolean. This is what stops an old
//      close from spending a later, distinct celebration attempt — the failure
//      that survives even rule A when no fresh model ever arrives.
//
// AUTHORITY
// ---------
// The SERVER decides whether a celebration is owed (`model.shouldCelebrate`) and
// whether the durable stamp landed (`markCelebrationShownAction` -> ok). The
// CLIENT may only remember three transient things: which showing is on screen,
// which showing the owner closed, and that a request is outstanding.

/**
 * A showing id. 0 is the null id: "no showing", never a real generation.
 * Ids are allocated by the caller so an async settlement can carry the id of the
 * request it belongs to, and a superseded reply can be told apart from the
 * current one.
 */
export type ShowingId = number;

export type CelebrationState = {
  /** The showing currently on screen. Allocated per distinct showing. */
  live: ShowingId;
  /** The showing the owner closed after being shown it. */
  closed: ShowingId;
  /**
   * The server has durably recorded the stamp. A fact about the studio, not
   * about a showing: monotonic, and retracted only by the server.
   */
  stampConfirmed: boolean;
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
  /** The confetti mounted for a distinct showing. This is also the transition an
   *  owner reopening the wizard produces: reopening needs no event of its own,
   *  because what matters is that a NEW showing begins, with its own id. */
  | { type: "CELEBRATION_SHOWN"; showing: ShowingId }
  | { type: "STAMP_STARTED"; showing: ShowingId }
  | { type: "STAMP_SUCCEEDED"; showing: ShowingId }
  | { type: "STAMP_REFUSED_OR_FAILED"; showing: ShowingId }
  | { type: "OWNER_CLOSED_AFTER_SHOWING" };

export const INITIAL_CELEBRATION_STATE: CelebrationState = {
  live: 0,
  closed: 0,
  stampConfirmed: false,
  inFlight: 0,
  deferred: null,
  seen: null,
};

/**
 * Spent when the server durably stamped AND the owner closed the showing they
 * are currently being shown.
 *
 * `closed === live` is the load-bearing half. A close belonging to an earlier
 * showing cannot suppress a later one, so a celebration the owner is looking at
 * right now can never be spent by a close they made before it existed.
 */
export function isCelebrationSpent(state: CelebrationState): boolean {
  return state.closed !== 0 && state.closed === state.live && state.stampConfirmed;
}

/**
 * Hand authority back to the server. A model still reporting the celebration as
 * owed means `celebrated_at` is not set, which contradicts any local belief that
 * the stamp landed — so that belief is dropped along with the recorded close.
 *
 * `live` deliberately survives. Retiring it too would orphan a showing that is
 * still on screen: the confetti stays mounted, no CELEBRATION_SHOWN fires again
 * because nothing the effect depends on changed, and the owner's next close
 * would record against showing 0 and be dropped.
 */
function retire(
  state: CelebrationState,
  model: OnboardingModel,
): CelebrationState {
  if (!model.shouldCelebrate) return state;
  if (state.closed === 0 && !state.stampConfirmed) return state;
  return { ...state, closed: 0, stampConfirmed: false };
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
      // Deferred during a stamp: this model cannot have observed the outcome of
      // a request still running, so it may not retire anything yet — but it is
      // KEPT, and the settlement below resolves it.
      if (state.inFlight !== 0) return { ...seen, deferred: event.model };
      return retire(seen, event.model);
    }

    case "CELEBRATION_SHOWN":
      return { ...state, live: event.showing };

    case "STAMP_STARTED":
      return { ...state, inFlight: event.showing };

    case "STAMP_SUCCEEDED": {
      // RULE B. The write happened, so record it regardless of whether this
      // showing has since been superseded — the studio's `celebrated_at` does
      // not care which showing asked for it. Suppression is still gated on
      // `closed === live`, so retaining it cannot spend a showing the owner has
      // not closed.
      const confirmed = { ...state, stampConfirmed: true };
      // Only the CURRENT request may clear the in-flight slot or resolve what is
      // deferred behind it.
      if (state.inFlight !== event.showing) return confirmed;
      // The stamp landed, so anything deferred behind it was read before the
      // write and is provably stale.
      return { ...confirmed, inFlight: 0, deferred: null };
    }

    case "STAMP_REFUSED_OR_FAILED": {
      // A superseded failure says nothing about the request now outstanding, and
      // must never retract an earlier durable success.
      if (state.inFlight !== event.showing) return state;
      const settled = { ...state, inFlight: 0, deferred: null };
      // Nothing was written by THIS request, so a model deferred behind it is
      // still telling the truth. This is the transition a ref-clear never made.
      return state.deferred ? retire(settled, state.deferred) : settled;
    }

    case "OWNER_CLOSED_AFTER_SHOWING":
      // A close before any celebration was shown spends nothing.
      if (state.live === 0) return state;
      return { ...state, closed: state.live };
  }
}
