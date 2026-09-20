"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * UX-01 QW4 · the keyboard contract every in-app modal owes.
 *
 * NOT in `components/ui/`. That directory is the server-compatible primitive
 * set and `tests/components/ui-foundations.test.ts` enforces it: no
 * `"use client"`, no stateful React API. This is a client hook by necessity, so
 * it lives beside `use-return-focus.ts` for the same reason rather than
 * weakening that boundary.
 *
 * WHAT IT REPAIRS. Two surfaces declared themselves modals — `role="dialog"`,
 * `aria-modal="true"` — and implemented none of what that promises:
 * `app/(app)/calendar/PostcareSendButton.tsx` and
 * `app/(app)/settings/studio/PostcareEditingHelpers.tsx`. Neither moved focus
 * in, neither restored it, and neither listened for Escape, so a keyboard user
 * could open either one and not get out of it. `aria-modal` also removes the
 * rest of the page from the accessibility tree, so a screen-reader user was
 * sealed inside a dialog with no advertised exit.
 *
 * ESCAPE IS IDLE-GATED, and that is the load-bearing detail rather than a
 * refinement. The postcare dialog's confirm hands an email to a provider; the
 * settings dialog's confirm writes studio copy. Closing either one mid-flight
 * would abandon a request whose outcome the practitioner still needs to see,
 * and the panel is the only place that outcome is reported. `busy` therefore
 * suppresses Escape entirely — the same ruling `components/confirm-dialog.tsx`
 * already encodes for the same reason.
 *
 * WHY THIS IS A NEW HOME AND NOT A REFACTOR OF `confirm-dialog`. That component
 * owns an identical mechanism, and sharing one implementation would be the
 * better end state. It is deliberately NOT done here:
 * `tests/components/confirm-dialog.test.ts` is a SOURCE test — it asserts
 * "captures the opener", "implements a focus trap" and "Escape closes only when
 * NOT pending" by pattern-matching that file's own text. Moving the mechanism
 * out would fail those assertions and require rewriting a shipped guard, which
 * is a change UX-01 QW4 does not authorize. This hook is the shared home going
 * forward; adopting it in `confirm-dialog` is a separate, guarded change.
 *
 * The caller attaches both returned refs:
 *   * `panelRef` — the dialog PANEL, not the backdrop. It needs
 *     `tabIndex={-1}` so it can be a programmatic focus target of last resort.
 *   * `initialFocusRef` — optional; where focus should land on open. When it is
 *     absent or its node is gone, focus falls back to the panel, which is
 *     correct: inside the dialog is always better than wherever it was.
 */
export function useDialogKeyboard<
  P extends HTMLElement = HTMLElement,
  F extends HTMLElement = HTMLElement,
>(opts: {
  open: boolean;
  /** While true, Escape is suppressed so an in-flight request is never abandoned. */
  busy?: boolean;
  onClose: () => void;
}): { panelRef: RefObject<P | null>; initialFocusRef: RefObject<F | null> } {
  const { open, busy = false, onClose } = opts;
  const panelRef = useRef<P | null>(null);
  const initialFocusRef = useRef<F | null>(null);
  const openerRef = useRef<Element | null>(null);

  // Capture the opener, move focus in, and restore it on close.
  //
  // Keyed ONLY on `open`, deliberately. Keying on `busy` as well would re-run
  // the cleanup every time a request starts or finishes and yank focus back to
  // the page mid-dialog — the same trap `confirm-dialog` documents.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    // A frame's grace: the panel is being mounted in this same commit, so the
    // node may not be attached at effect time on the first open.
    const target = initialFocusRef.current ?? panelRef.current;
    target?.focus();
    return () => {
      const opener = openerRef.current;
      // `focus()` on a detached node is a silent no-op that drops the user at
      // <body>. Where the OPENER ITSELF is removed by the action, the caller
      // wants `use-return-focus` instead; here the opener survives.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  // Idle-gated Escape + focus trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!busy) onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) {
        // Everything disabled mid-submit: park focus on the panel so Tab
        // cannot walk out behind the modal.
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  return { panelRef, initialFocusRef };
}

/** Same selector `confirm-dialog` uses, so the two traps cannot disagree. */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
