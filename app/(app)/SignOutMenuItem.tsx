"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { cx } from "@/components/ui/control-base";

// SIGNOUT-02 · the logout control acknowledges the press it received.
//
// THE DEFECT, MEASURED. On the production tree this control painted NOTHING
// between the press and the whole shell being replaced. Six runs against the
// local stack, desktop AccountMenu, production build:
//
//   click -> Server Action POST sent .... med  91ms
//   POST duration (supabase.auth.signOut) med 418ms
//   click -> /login rendered ............ med 533ms
//   click -> first painted change ....... NONE, in all six runs
//
// So for the better part of a second the practitioner held a control that
// looked exactly as it had before they touched it. DESIGN.md LAW 4: "A press
// is confirmed before its result arrives. A control that has been activated
// must never look idle."
//
// The first measurement of that last row reported 68-112ms rather than NONE,
// and it was wrong in a way worth recording: Playwright moves the mouse onto
// the control as part of `.click()`, which fires `:hover`, and this row already
// had `hover:bg-neutral-100`. The probe was measuring the hover fill arriving —
// a state a phone never enters at all. Hovering first and letting the
// transition settle before sampling is what turned the column honest.
//
// THIS SLICE MAKES NOTHING FASTER AND DOES NOT CLAIM TO. The 418ms is
// `supabase.auth.signOut()` talking to the auth server, which is provider work
// and out of scope. What changes is that the ~530ms is now ACKNOWLEDGED rather
// than silent.
//
// WHY THIS IS NOT `PendingButton`, which is the contract-2b leaf for exactly
// this job. PendingButton wraps Button, and Button is a BUTTON-SHAPED
// primitive: `buttonClasses` composes CONTROL_MIN_TOUCH, which carries
// `justify-center`, plus `px-4` and a variant fill. This control is a menu ROW
// — full-width, left-aligned, 40/44px, and visually a sibling of the `<Link>`
// rows directly above it. Dressing Button as that row means overriding
// `justify-center` and `px-4` through `cx`, which is a plain `join` and not
// tailwind-merge, so the winner would be decided by Tailwind's emission order
// rather than by the call site. The result would also make Sign out the one row
// in the panel that does not match its neighbours.
//
// So this uses the SAME mechanism and the same state machine — `useFormStatus`
// in a leaf inside the form, contract 2b's hook — wearing the skin this control
// actually has. It is not a second acknowledgement architecture; it is the
// existing one applied to a control Button cannot dress.
//
// THE SIGNOUT-01 CONTRACT IS PRESERVED, and this is the part to be careful
// about. That defect was an `onClick={close}` on the submit button: React
// flushed the discrete update synchronously, the <form> detached mid-click, and
// the submission was cancelled against a disconnected form. There is no
// `onClick` here and there must never be one. `useFormStatus` is also the
// reason this is a separate component at all — the hook reports nothing unless
// it runs INSIDE the <form> it reads, so the leaf is structurally required, not
// a stylistic choice.
//
// `disabled` arriving with `pending` cannot cancel the dispatch: pending only
// becomes true once React has already taken the action, which is strictly after
// the submit button's activation behaviour ran. That ordering is the whole
// reason PendingButton is safe, and it is proved for THIS surface — pointer and
// keyboard, both shells — by e2e/signout-session-destruction.spec.ts, which
// reads auth.sessions and auth.refresh_tokens rather than the URL bar.

/**
 * The menu-row shape, identical to the `<Link>` rows this control sits with.
 *
 * `cursor-pointer` IS NOT COSMETIC HERE, and leaving it out was a real defect
 * on the one surface this slice exists for. button.tsx spells out why:
 * "Tailwind v4's preflight leaves a <button> at `cursor: default`. Restoring
 * the pointer is also what makes iOS Safari apply :active to the control, so
 * the press acknowledgement above actually paints on a phone."
 *
 * The sibling rows are `<a>` elements and get the pointer for free; this is a
 * `<button>` and does not. Without it the `active:` step below could simply
 * never paint on an iPhone — a touch device, where :hover never fires either,
 * so the control would be back to acknowledging nothing at all.
 *
 * The browser lane CANNOT catch this: it is chromium-only, and the phone-width
 * tests are Chromium wearing an iPhone user agent, not Safari. The source pin
 * in tests/components/signout-02-acknowledgement.test.ts is the guard, which
 * is the same arrangement button.tsx relies on for the same reason.
 */
const ROW =
  "flex w-full cursor-pointer items-center rounded-md px-3 py-2 text-left";

/**
 * The press, and the reason it is a COLOUR step rather than the house
 * `LEAF_CONTROL_PRESS` scale.
 *
 * Two reasons, both in control-base.ts's own words. It documents that the
 * scale "collapses to a no-op" under `prefers-reduced-motion` and that "THE
 * CALLER MUST SUPPLY A COLOUR TREATMENT" — the colour is what survives. And it
 * warns off controls that are not compact leaves; a full-width menu row
 * shrinking by 2% reads as the panel flexing, not as a press.
 *
 * `hone-transition-press` transitions `background-color`, and reduced motion
 * collapses it to 1ms rather than removing it, so the acknowledgement is
 * instant there rather than absent. The third step (100 -> 200) is distinct
 * from the hover fill on purpose: with a mouse, hover has already painted
 * `bg-neutral-100`, so a press that repeated it would show nothing at all —
 * the same trap Button's variants record.
 */
const PRESS =
  "active:bg-neutral-200 dark:active:bg-neutral-800 hone-transition-press";

const IDLE = "hover:bg-neutral-100 dark:hover:bg-neutral-900";

/**
 * In flight. Holds the row's own ground so the control reads as occupied, and
 * mutes the ink to say the control is no longer pressable — it is genuinely
 * `disabled`, so that is truthful rather than decorative.
 */
const BUSY =
  "bg-neutral-100 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400";

/**
 * SIGNOUT-02b · the pending state has to outlive this component.
 *
 * THE DEFECT THIS CLOSES, measured rather than argued. `useFormStatus` only
 * reports for the form it runs inside, and that form lives in a panel rendered
 * from the shell's `open` state. So pressing Escape — or clicking outside, or
 * the menu trigger — unmounted the form mid-logout, and reopening the menu
 * built a FRESH leaf that knew nothing: enabled, labelled "Sign out", no
 * `aria-busy`. Pressing it put a second logout on the wire. Measured:
 * `[294, 2404]` — two requests, the second 2.1s after the first.
 *
 * The duplicate half is NOT a regression from SIGNOUT-02; the same path
 * measured `[288, 2355]` on the pre-SIGNOUT-02 runtime, which had no guard at
 * all. What SIGNOUT-02 owed and had not yet paid was making the guard and the
 * acknowledgement survive the panel boundary.
 *
 * TWO HALVES, because either alone leaves a hole:
 *
 *   * `onPendingChange` lifts the fact into the SHELL, which is persistent —
 *     it is the panel that unmounts, not AccountMenu/MobileMenu. The shell
 *     then refuses to dismiss while a logout is in flight, which keeps this
 *     leaf mounted and its `useFormStatus` live.
 *   * `busy` comes back DOWN, so even if a fresh leaf is ever mounted while a
 *     logout is still running, it renders as busy instead of as an invitation
 *     to sign out twice.
 *
 * ONLY TRANSITIONS ARE REPORTED, and that is load-bearing. Reporting the
 * initial `false` on mount would have a freshly-reopened leaf immediately
 * clear the shell's flag — reinstating the exact defect this closes, and doing
 * it invisibly.
 *
 * SIGNOUT-01 IS UNTOUCHED BY THIS. There is still no `onClick` anywhere on the
 * submit path, and nothing here unmounts the form during a click: the change
 * makes the form STRICTLY less likely to unmount, which is the same direction
 * SIGNOUT-01's fix pushed.
 */
export function SignOutMenuItem({
  minHeight,
  busy = false,
  onPendingChange,
}: {
  minHeight: string;
  /** Remembered by the shell, so a remounted leaf is still truthful. */
  busy?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { pending } = useFormStatus();
  const reported = useRef(false);
  useEffect(() => {
    if (pending === reported.current) return;
    reported.current = pending;
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  const inFlight = pending || busy;
  return (
    <button
      type="submit"
      // THE DUPLICATE-ACTIVATION GUARD, and not an advisory one: a second
      // press cannot reach a disabled control. Same ruling as PendingButton.
      disabled={inFlight}
      aria-busy={inFlight || undefined}
      data-signout-pending={inFlight ? "true" : undefined}
      className={cx(ROW, minHeight, PRESS, inFlight ? BUSY : IDLE)}
    >
      {/* TRUTHFUL, AND NOT A CLAIM OF SUCCESS. "Signing out…" says a request is
          in flight; it never says the session is gone. The state clears only
          because the real action settled — there is no timer here, no fake
          progress, and nothing that would still be showing if the action
          failed. If signOut() throws, pending clears and the control becomes
          pressable again, which is the honest outcome.

          A visible label swap is the width-CHANGING form Button warns about,
          and it is safe here for a structural reason: the control is `w-full`
          inside a fixed-width panel and left-aligned, so a longer string
          cannot resize it or move anything beside it. The geometry-stable
          spinner Button prefers exists to protect a control that is sized by
          its own text. This one is not. */}
      {inFlight ? "Signing out…" : "Sign out"}
    </button>
  );
}
