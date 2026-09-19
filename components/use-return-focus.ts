"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * UI-05 · the destructive-action focus contract.
 *
 * NOT in `components/ui/`. That directory is the server-compatible primitive
 * set, and tests/components/ui-foundations.test.ts enforces it: no `use
 * client`, no stateful React API. This is a client hook by necessity, so it
 * lives beside the cards that use it rather than weakening that boundary.
 *
 * `ConfirmDialog` restores focus to whatever was active when it opened. That is
 * right for every outcome where the OPENER SURVIVES the action — cancel,
 * failure, and any confirm that leaves the control on screen — and it must stay
 * that way, because pulling focus off a control the user can still see would be
 * the worse behaviour.
 *
 * It is wrong for exactly one case, and all three UI-05 surfaces have it: the
 * confirmed action REMOVES the opener.
 *
 *   * `portal-messages-card` — the row moves into the archived list, which
 *     renders `onArchive={null}`, so the Archive button is gone.
 *   * `client-tags-card`     — the tag's own Remove button is gone.
 *   * `treatment-schedule-editor` — the whole stage row unmounts, taking its
 *     Remove button AND its dialog with it.
 *
 * `focus()` on a detached node does nothing, so focus falls to `<body>` and a
 * keyboard or screen-reader user is dropped at the top of the document, with no
 * signal that anything happened. Reproduced in a real browser on each surface
 * before this existed.
 *
 * The repair, shared so the three cannot drift apart:
 *
 *   * `anchorRef` goes on an element that OUTLIVES the action — a card or
 *     section heading, never the row. It needs `tabIndex={-1}` to be a
 *     programmatic focus target, which deliberately keeps it out of the Tab
 *     order.
 *   * `arm()` is called ONLY on the success path. Cancel and failure never arm,
 *     so the primitive's own restoration is left completely untouched there.
 *   * `settledOn` is THE DIALOG'S OWN OPEN STATE, read in whichever component
 *     owns the dialog. The effect is keyed on it, so the handoff lands after
 *     React has flushed the dialog's close cleanup and beats the opener
 *     restoration rather than racing it.
 *
 * WHY THE OPEN STATE AND NOT "THE LIST CHANGED", which is the obvious guess and
 * is wrong. Measured on the schedule editor: after a successful removal the row
 * does NOT unmount — the server action revalidates and React REPLACES the
 * button's DOM node. A visually identical Remove button is on screen while the
 * node the dialog saved is detached, so `focus()` is a silent no-op and the
 * user still lands on `<body>`. Keying on a list length therefore never fires
 * at all, which is exactly what the instrumented run showed.
 *
 * `anchorRef` may be supplied by a PARENT, for the case where the dialog is
 * owned by a row but the only element guaranteed to outlive the action lives
 * above it — the schedule editor, whose dialog is mounted inside the stage row.
 */
export function useReturnFocus<T extends HTMLElement>(
  settledOn: unknown,
  externalAnchorRef?: RefObject<T | null>,
) {
  const ownAnchorRef = useRef<T | null>(null);
  const anchorRef = externalAnchorRef ?? ownAnchorRef;
  const armed = useRef(false);

  const arm = useCallback(() => {
    armed.current = true;
  }, []);

  useEffect(() => {
    if (!armed.current) return;
    armed.current = false;
    anchorRef.current?.focus();
  }, [settledOn]);

  return { anchorRef, arm };
}
