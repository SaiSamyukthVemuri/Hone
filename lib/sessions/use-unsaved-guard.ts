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

/** The slice of the Navigation API the traversal guard uses (Chromium, Safari). */
type NavigationApiLike = NavigationLike & {
  addEventListener?: (type: "navigate", listener: (e: Event) => void) => void;
  removeEventListener?: (type: "navigate", listener: (e: Event) => void) => void;
  traverseTo?: (key: string) => unknown;
};
type NavigateEventLike = Event & {
  navigationType?: string;
  hashChange?: boolean;
  destination?: { key?: string };
};

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

type Registered = { attempt: { current: (proceed: () => void, dirtyCount: number) => void } };

/**
 * ONE COORDINATOR FOR EVERY DIRTY FORM (Codex, #1369 4505287597, after four rounds on per-form listeners).
 * Each form used to mount its own beforeunload, click, popstate and Navigation-API listeners, so with two dirty
 * forms a Back opened two dialogs and confirming one armed only that form's replay flag while the other form
 * cancelled the replay. The listeners now exist ONCE, at module level, while at least one form is registered
 * dirty. A departure attempt asks the FIRST registered form (registration order) to show its dialog: Leave
 * discards every dirty form (the page goes away), Stay keeps them all, and exactly one replay is let through.
 */
const registry = new Map<symbol, Registered>();
let teardown: (() => void) | null = null;

/** Registered forms, for tests. */
export function registeredGuardCount(): number {
  return registry.size;
}

function askFirst(proceed: () => void) {
  const first = registry.values().next().value as Registered | undefined;
  first?.attempt.current(proceed, registry.size);
}

function installCoordinator(): () => void {
  // A DEPARTURE THE PRACTITIONER ALREADY CONFIRMED in the app's dialog must not be asked about again by the
  // browser (Codex, #1369 4475784173): the confirmed navigation is a full document load, which fires
  // beforeunload. The flag is set only by the confirmed callbacks below and lapses on its own.
  let confirmed = false;
  let confirmedTimer: ReturnType<typeof setTimeout> | undefined;
  function confirmDeparture() {
    confirmed = true;
    clearTimeout(confirmedTimer);
    confirmedTimer = setTimeout(() => {
      confirmed = false;
    }, 2000);
  }
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (confirmed) return;
    e.preventDefault();
    e.returnValue = "";
  }
  function onClick(e: MouseEvent) {
    const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!shouldInterceptClick(true, e, anchor, window.location)) return;
    e.preventDefault();
    e.stopPropagation();
    const href = anchor!.href;
    askFirst(() => {
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
  function armOwnMove() {
    ownMove = true;
    clearTimeout(ownMoveTimer);
    ownMoveTimer = setTimeout(() => {
      ownMove = false;
    }, 500);
  }
  function moveHistory(delta: number) {
    if (delta === 0) return;
    armOwnMove();
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
    askFirst(() => {
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
  // WHERE THE NAVIGATION API EXISTS, THE TRAVERSAL IS CANCELLED BEFORE IT HAPPENS. The app router's own popstate
  // listener is registered before any component's, so it renders the destination (and unmounts this form, with its
  // typed data) before a popstate guard is reached; a held move cannot be put back from there. A cancelled
  // traversal changes nothing, so Stay needs no restore and Leave replays the same traversal by its key. Where a
  // browser will not let the traversal be cancelled (no Navigation API, or no recent user activation) the
  // popstate path above is the best-effort fallback.
  const nav = (window as unknown as { navigation?: NavigationApiLike }).navigation;
  let confirmedTraverse = false;
  let confirmedTraverseTimer: ReturnType<typeof setTimeout> | undefined;
  function onNavigate(e: Event) {
    const ev = e as NavigateEventLike;
    if (ev.navigationType !== "traverse" || !ev.cancelable || ev.hashChange) return;
    if (confirmedTraverse) {
      confirmedTraverse = false;
      return;
    }
    const key = ev.destination?.key;
    if (!key || !nav?.traverseTo) return;
    ev.preventDefault();
    askFirst(() => {
      confirmDeparture();
      confirmedTraverse = true;
      // The replayed traversal raises popstate too: it is the guard's own move, not a second departure.
      armOwnMove();
      clearTimeout(confirmedTraverseTimer);
      confirmedTraverseTimer = setTimeout(() => {
        confirmedTraverse = false;
      }, 500);
      nav.traverseTo?.(key);
    });
  }
  nav?.addEventListener?.("navigate", onNavigate);
  window.addEventListener("beforeunload", onBeforeUnload);
  document.addEventListener("click", onClick, true);
  window.addEventListener("popstate", onPopState);
  return () => {
    clearTimeout(confirmedTimer);
    clearTimeout(ownMoveTimer);
    clearTimeout(confirmedTraverseTimer);
    nav?.removeEventListener?.("navigate", onNavigate);
    window.removeEventListener("beforeunload", onBeforeUnload);
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("popstate", onPopState);
  };
}

/**
 * `onLeaveAttempt` is called INSTEAD of leaving: the caller shows its own
 * dialog and calls `proceed` only if the practitioner chooses to leave. A
 * native confirm is not used (it is retired repo-wide, and iOS Safari can
 * suppress it). With several dirty forms only the first-registered form's
 * `onLeaveAttempt` is called, once per departure, and it is told how many forms are dirty
 * so its dialog can speak for all of them.
 */
export function useUnsavedGuard(
  dirty: boolean,
  onLeaveAttempt: (proceed: () => void, dirtyCount: number) => void,
): void {
  const attemptRef = useRef(onLeaveAttempt);
  attemptRef.current = onLeaveAttempt;

  useEffect(() => {
    if (!dirty) return;
    const id = Symbol("unsaved-guard");
    registry.set(id, { attempt: attemptRef });
    if (!teardown) teardown = installCoordinator();
    return () => {
      registry.delete(id);
      if (registry.size === 0 && teardown) {
        teardown();
        teardown = null;
      }
    };
  }, [dirty]);
}
