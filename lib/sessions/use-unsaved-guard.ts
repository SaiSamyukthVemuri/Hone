"use client";

import { useEffect, useRef } from "react";
import { isLeavingNavigation } from "@/components/settings/unsaved-changes";

// Loss protection for charting that is not saved yet. Same approach as the
// Settings guard (components/settings/unsaved-changes.tsx), whose
// isLeavingNavigation it reuses, but self-contained so a form can use it
// without the provider:
//   - `beforeunload` while dirty (tab close, reload, typed URL);
//   - a capture-phase click guard for same-origin links that leave the page;
//   - a popstate guard for the Back button.
//
// NOT COVERED, stated rather than hidden: app code that calls router.push or
// router.replace (no click, no event), server redirects and middleware
// redirects, and a navigation the browser performs without a click (address
// bar, bookmarks beyond beforeunload).
//
// BACK AND FORWARD ARE BOTH GUARDED, and put back by the distance actually travelled
// (Codex, #1369 4478075121): popstate carries no direction, and a fixed `history.go(1)`
// is wrong for Forward (and a no-op at the end of the stack). The direction comes from
// the history entry's INDEX: the Navigation API's `currentEntry.index` where the browser
// has it, otherwise an index this guard stamps into `history.state` as it goes. Where
// neither is known the guard falls back to treating the move as one step Back, which is
// what it always did.


export type ClickLike = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** The history key this guard stamps its entry index under (fallback when the Navigation API is absent). */
export const GUARD_INDEX_KEY = "__unsavedGuardIdx";

/**
 * How far, and which way, history moved: positive is Forward, negative is Back.
 * Unknown on either side is ONE STEP BACK, the guard's original assumption. Zero is
 * returned as-is (a same-entry popstate such as a hash change): there is nothing to put
 * back, and the caller must not wait for a restore event that will never come.
 */
export function historyDelta(previous: number | null, next: number | null): number {
  if (previous === null || next === null) return -1;
  return next - previous;
}

type NavigationLike = { currentEntry?: { index?: number } | null };

/** The current history entry's index, or null when the browser does not tell us. */
export function currentHistoryIndex(win: {
  navigation?: NavigationLike;
  history: Pick<History, "state">;
}): number | null {
  const fromNavigation = win.navigation?.currentEntry?.index;
  if (typeof fromNavigation === "number" && fromNavigation >= 0) return fromNavigation;
  const stamped = (win.history.state as Record<string, unknown> | null)?.[GUARD_INDEX_KEY];
  return typeof stamped === "number" ? stamped : null;
}

/** Pure decision: should this click on `anchor` be held while dirty? */
export function shouldInterceptClick(
  dirty: boolean,
  click: ClickLike,
  anchor: Pick<HTMLAnchorElement, "href" | "target" | "download"> | null,
  current: Pick<Location, "origin" | "pathname" | "search">,
): boolean {
  if (!dirty || !anchor) return false;
  if (click.defaultPrevented || click.button !== 0) return false;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  return isLeavingNavigation(anchor, current);
}

/**
 * `onLeaveAttempt` is called INSTEAD of leaving: the caller shows its own
 * dialog and calls `proceed` only if the practitioner chooses to leave. A
 * native confirm is not used (it is retired repo-wide, and iOS Safari can
 * suppress it).
 */
export function useUnsavedGuard(
  dirty: boolean,
  onLeaveAttempt: (proceed: () => void) => void,
): void {
  const attemptRef = useRef(onLeaveAttempt);
  attemptRef.current = onLeaveAttempt;

  // A DEPARTURE THE PRACTITIONER ALREADY CONFIRMED in the app's dialog must not
  // be asked about again by the browser (Codex, #1369 4475784173): the confirmed
  // navigation is a full document load, which fires beforeunload. The flag is
  // set only by the confirmed callbacks below and lapses on its own, so a
  // navigation that does not happen leaves the guard armed.
  const confirmedRef = useRef(false);
  function confirmDeparture() {
    confirmedRef.current = true;
    setTimeout(() => {
      confirmedRef.current = false;
    }, 2000);
  }

  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (confirmedRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    }
    function onClick(e: MouseEvent) {
      const anchor = (e.target as Element | null)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!shouldInterceptClick(true, e, anchor, window.location)) return;
      e.preventDefault();
      e.stopPropagation();
      const href = anchor!.href;
      attemptRef.current(() => {
        confirmDeparture();
        window.location.assign(href);
      });
    }
    // WHERE THE PAGE SITS IN HISTORY, kept current so a popstate can be given a direction.
    let here = currentHistoryIndex(window as never);
    // Our own history.go() raises popstate again; those are not the user's. It is armed only for a
    // move that WILL raise one: a go() that lands nowhere (the end of the stack) raises nothing, and
    // a flag left set would let the NEXT real navigation through unguarded. So it also lapses on a timer.
    let ownMove = false;
    let ownMoveTimer: ReturnType<typeof setTimeout> | undefined;
    function moveHistory(delta: number) {
      if (delta === 0) return;
      ownMove = true;
      clearTimeout(ownMoveTimer);
      ownMoveTimer = setTimeout(() => {
        ownMove = false;
      }, 500);
      window.history.go(delta);
    }
    function onPopState() {
      if (ownMove) {
        ownMove = false;
        clearTimeout(ownMoveTimer);
        // Back where it began (or on to where it was going, after Leave): follow it.
        here = currentHistoryIndex(window as never) ?? here;
        return;
      }
      const there = currentHistoryIndex(window as never);
      const delta = historyDelta(here, there);
      // A popstate that stayed on the same entry (a hash change) is not a departure.
      if (delta === 0) return;
      // The entry has already changed; put it back by the distance it travelled, then ask.
      moveHistory(-delta);
      attemptRef.current(() => {
        confirmDeparture();
        moveHistory(delta);
      });
    }
    // FALLBACK INDEX for browsers without the Navigation API: stamp this entry, merged into whatever
    // state the router keeps there. Only when absent, so a revisit keeps the number it had.
    if (here === null) {
      try {
        window.history.replaceState({ ...(window.history.state ?? {}), [GUARD_INDEX_KEY]: window.history.length }, "");
        here = currentHistoryIndex(window as never);
      } catch {
        /* a sandboxed frame: the guard degrades to one step Back */
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      clearTimeout(ownMoveTimer);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
    };
  }, [dirty]);
}
