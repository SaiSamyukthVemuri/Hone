// THE ONE OWNER OF "IS MULTIPLEX LOADED, APPLIED, OR FAILED" for a new treatment area. A pure reducer: the host form holds it in one useReducer, and
// the connected panel only EXECUTES (it loads, applies and reports back under the token it was given). Nothing else keeps a copy of this state.
//
//   off      MultiPlex is not wanted (a legacy mode, or never chosen). Save is normal.
//   loading  a click minted `seq`; the context is loading and/or the choice is being applied. Save is HELD.
//   ready    MultiPlex is applied. Save is normal.
//   failed   the load or the apply did not finish; ALWAYS retryable by clicking MultiPlex again. Save REFUSES with one plain message.
//
// The token is the `seq` a click minted. An answer carries the token it answers and is ignored unless it matches the CURRENT loading token, so a
// stale answer (a legacy mode was chosen, MultiPlex was undone, a newer click replaced it) can never hold or refuse a Save. `off` is left ONLY by a
// click-minted token: a saved area, "Choose machine" and an automatic open never put the form into `loading`.

export type MultiplexFailReason = "error" | "no_route" | "not_applied" | "panel_gone" | "stale_identity";

export type MultiplexLoadState = {
  phase: "off" | "loading" | "ready" | "failed";
  /** The last token minted (0 = none). While `loading` it is THE token an answer must carry. */
  seq: number;
  /** What the panel is asked to do with `seq`: select MultiPlex (true) or leave it (false). */
  want: boolean;
  reason: MultiplexFailReason | null;
};

export type MultiplexLoadEvent =
  | { t: "select" } // the MultiPlex pill clicked while MultiPlex is not selected (first click, retry, or re-select)
  | { t: "undo" } // the MultiPlex pill clicked while it is selected
  | { t: "legacy" } // a Thermolysis / Blend / Galvanic pill clicked
  | { t: "settled"; token: number; result: "ok" | "no_route" | "error" }
  | { t: "applied"; token: number }
  | { t: "notApplied"; token: number }
  | { t: "panelGone"; token: number }
  | { t: "identityWritten" };

export const MULTIPLEX_LOAD_INITIAL: MultiplexLoadState = { phase: "off", seq: 0, want: false, reason: null };

/** ONE message for every failed reason: it names the way out, and the UI offers exactly that (the pill stays, and another mode is a click away). */
export const MULTIPLEX_LOAD_FAILED_MESSAGE = "MultiPlex could not be loaded, so nothing was saved. Pick MultiPlex again, or choose another mode.";
export const MULTIPLEX_LOADING_MESSAGE = "Loading MultiPlex…";

export function multiplexLoadStep(s: MultiplexLoadState, e: MultiplexLoadEvent): MultiplexLoadState {
  switch (e.t) {
    case "select":
      // a second click while loading is a double open: the SAME token, no second load
      if (s.phase === "loading") return s;
      return { phase: "loading", seq: s.seq + 1, want: true, reason: null };
    case "undo":
    case "legacy":
      // always a NEW token, even from `off`: a MultiPlex click whose load is pending is replaced here, so its late answer matches nothing
      return { phase: "off", seq: s.seq + 1, want: false, reason: null };
    case "settled":
      if (s.phase !== "loading" || e.token !== s.seq) return s;
      // ok does not leave `loading`: the answer is applied or refused next, and exactly one of those is reported
      if (e.result === "ok") return s;
      return { ...s, phase: "failed", reason: e.result };
    case "applied":
      if (s.phase !== "loading" || e.token !== s.seq) return s;
      return { ...s, phase: "ready", reason: null };
    case "notApplied":
      if (s.phase !== "loading" || e.token !== s.seq) return s;
      return { ...s, phase: "failed", reason: "not_applied" };
    case "panelGone":
      if (s.phase !== "loading" || e.token !== s.seq) return s;
      return { ...s, phase: "failed", reason: "panel_gone" };
    case "identityWritten":
      // an identity written while a load is in flight: that load must not apply after it
      if (s.phase !== "loading") return s;
      return { ...s, phase: "failed", reason: "stale_identity" };
  }
}

/** What Save and Save visit do in a state. ONE function, so the two paths cannot disagree. */
export function multiplexSaveGate(s: MultiplexLoadState): "open" | "held" | "refused" {
  return s.phase === "loading" ? "held" : s.phase === "failed" ? "refused" : "open";
}
