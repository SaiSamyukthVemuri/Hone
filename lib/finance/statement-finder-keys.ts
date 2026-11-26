// The Find-a-client combobox's keyboard behaviour, as a PURE reducer so it is tested without a browser. The component only wires events to it.
// Selection is always by the option's client id, never by its position or its name.

export type FinderKeyState = { query: string; open: boolean; active: number | null };
export type FinderKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "Enter" | "Escape" | "Tab";
export type FinderKeyResult = { state: FinderKeyState; select: number | null; preventDefault: boolean };

export const FINDER_INITIAL: FinderKeyState = { query: "", open: false, active: null };

/** Typing opens the list (when there is text) and clears the highlight, so Enter never opens a client the owner did not point at. */
export function onFinderInput(query: string): FinderKeyState {
  return { query, open: query.trim().length > 0, active: null };
}

export function onFinderKey(state: FinderKeyState, key: FinderKey, optionCount: number): FinderKeyResult {
  const none = (s: FinderKeyState, preventDefault = false): FinderKeyResult => ({ state: s, select: null, preventDefault });
  const hasOptions = optionCount > 0;
  switch (key) {
    case "ArrowDown":
      if (!hasOptions) return none(state);
      return none({ ...state, open: true, active: state.active === null ? 0 : (state.active + 1) % optionCount }, true);
    case "ArrowUp":
      if (!hasOptions) return none(state);
      return none({ ...state, open: true, active: state.active === null ? optionCount - 1 : (state.active - 1 + optionCount) % optionCount }, true);
    case "Home":
      return state.open && hasOptions ? none({ ...state, active: 0 }, true) : none(state);
    case "End":
      return state.open && hasOptions ? none({ ...state, active: optionCount - 1 }, true) : none(state);
    case "Enter":
      // Only an explicitly highlighted option is chosen; Enter on an unhighlighted list does nothing.
      if (state.open && state.active !== null && state.active < optionCount) return { state: { ...state, open: false }, select: state.active, preventDefault: true };
      return none(state, state.open);
    case "Escape":
      return state.open ? none({ ...state, open: false, active: null }, true) : none(state.query ? { ...state, query: "" } : state);
    case "Tab":
      return none({ ...state, open: false, active: null });
  }
}
