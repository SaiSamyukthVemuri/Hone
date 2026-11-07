// Save status for charting that is not yet on the server.
//
// Four states, and `saved` has exactly one way in: a save that was started
// (`saving`) and then reported success. An edit after `saved` is `unsaved`
// again, and a failure keeps its message and can only leave through a retry
// (`saveStarted`) or `reset`. Nothing moves from `failed` to `saved` on its own.

export type SaveState =
  | { status: "unsaved" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "failed"; message: string };

export type SaveEvent =
  | { type: "edit" }
  | { type: "saveStarted" }
  | { type: "saveSucceeded" }
  | { type: "saveFailed"; message: string }
  | { type: "reset" };

/** Nothing has been entered yet, so there is nothing to lose. */
export const INITIAL_SAVE_STATE: SaveState = { status: "saved" };

export function saveStateReducer(state: SaveState, event: SaveEvent): SaveState {
  switch (event.type) {
    case "edit":
      // An edit during a save leaves that save in flight; the change it did not
      // carry is still unsaved, so the status must not claim otherwise.
      return { status: "unsaved" };
    case "saveStarted":
      return { status: "saving" };
    case "saveSucceeded":
      return state.status === "saving" ? { status: "saved" } : state;
    case "saveFailed":
      return state.status === "saving"
        ? { status: "failed", message: event.message }
        : state;
    case "reset":
      return INITIAL_SAVE_STATE;
  }
}

/** True while leaving the page would lose something. */
export function isUnfinished(state: SaveState): boolean {
  return state.status !== "saved";
}
