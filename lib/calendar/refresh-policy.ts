// HON-48 — five people share one calendar, and the page they are looking at
// only re-reads the schedule when THEY act (every router.refresh() in the
// calendar is in an action handler). A colleague's committed booking, move,
// cancellation or block therefore stayed invisible on the other four screens
// until a manual reload. The requirement is that other authorized sessions see
// committed changes "through the existing refresh/update mechanism; no
// speculative new realtime platform": the existing mechanism is the server
// render behind router.refresh(), so this decides WHEN a passive screen may
// ask for one. No subscription, no new endpoint, no new data path.
//
// Pure so every rule is proved without a browser. The component
// (CalendarAutoRefresh) only reads the DOM and calls this.
//
// What it will NEVER do: refresh while someone is working. A refresh keeps
// client state, but it can still move the grid under a pointer, so it is held
// off while a dialog/drawer is open (new appointment, move, block edit), while
// a field is focused, while the tab is hidden, and while offline.

/** A visible, idle tab asks for the latest schedule this often. */
export const AUTO_REFRESH_INTERVAL_MS = 60_000;
/** Coming back to the tab asks sooner, but never more than this often. */
export const FOCUS_REFRESH_MIN_GAP_MS = 15_000;

/**
 * A change signal (lib/calendar/schedule-signal.ts) asks for a refresh almost at
 * once, but never more than this often: a burst of signals, a catch-up after a
 * reconnect and the echo of this screen's own write all fold into one refresh per
 * gap, so a signal can never cause a refresh storm (at most 4 per second per
 * screen). 250 ms, down from 1 s: measured, most of the commit-to-visible median
 * was this gap, not the signal (which arrives in milliseconds).
 */
export const SIGNAL_REFRESH_MIN_GAP_MS = 250;

export type AutoRefreshTrigger = "interval" | "focus" | "signal";

export type AutoRefreshInputs = {
  trigger: AutoRefreshTrigger;
  /** document.visibilityState === "visible" */
  visible: boolean;
  /** navigator.onLine */
  online: boolean;
  /** a modal dialog or drawer is open */
  dialogOpen: boolean;
  /** a text field, select or contenteditable has focus */
  editing: boolean;
  nowMs: number;
  /** when this screen last loaded or refreshed */
  lastRefreshMs: number;
};

export function shouldAutoRefresh(i: AutoRefreshInputs): boolean {
  if (!i.visible || !i.online || i.dialogOpen || i.editing) return false;
  const gap = i.nowMs - i.lastRefreshMs;
  if (!Number.isFinite(gap) || gap < 0) return false;
  const minGap =
    i.trigger === "interval"
      ? AUTO_REFRESH_INTERVAL_MS
      : i.trigger === "focus"
        ? FOCUS_REFRESH_MIN_GAP_MS
        : SIGNAL_REFRESH_MIN_GAP_MS;
  return gap >= minGap;
}
