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
// bar, bookmarks beyond beforeunload). The Back button is guarded by putting one
// history entry back and asking, which cannot stop a multi-step history jump.


export type ClickLike = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

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
    // Our own history.go() raises popstate again; those are not the user's.
    let ownMove = false;
    function onPopState() {
      if (ownMove) {
        ownMove = false;
        return;
      }
      // The entry has already changed; put it back, then ask.
      ownMove = true;
      window.history.go(1);
      attemptRef.current(() => {
        confirmDeparture();
        ownMove = true;
        window.history.go(-1);
      });
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
    };
  }, [dirty]);
}
