// Shared class fragments for the Hone UI primitives (UI0).
//
// WHY THIS FILE EXISTS
// --------------------
// The authenticated app had no shared visual layer. A source census of
// production (96a76c4a) found 5,534 `className` usages resolving to 2,008
// distinct literal class strings: 236 button call sites spelled 154 ways, 202
// small-caps section labels in 68 spellings, and — the reason this file leads
// with a touch-target constant — 281 of the 399 interactive elements whose box
// can be computed from their classes render under 44px tall.
//
// Every rule the team keeps rediscovering in review lives here ONCE, and the
// primitives compose it. The rule belongs in the primitive, not in the call
// site; a call site can forget, a base string cannot.
//
// This module is intentionally dependency-free. Hone ships no clsx, no
// tailwind-merge, no cva, and this layer does not change that.

/**
 * Joins class fragments, dropping falsy entries. Deliberately NOT a
 * tailwind-merge: it does not resolve conflicting utilities.
 *
 * Consequence callers must know: `className` on a primitive is for ADDITIVE
 * concerns (width, margin, grid placement, `whitespace-nowrap`). It cannot
 * reliably override a variant's colour or padding, because Tailwind resolves
 * conflicts by CSS source order, not by the order of names in the attribute.
 * If a call site needs a different look, it needs a variant — not an override.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * The 44px interaction floor.
 *
 * `inline-flex` is load-bearing and must travel WITH the min-height: CSS
 * `min-height` has no effect on an inline box. Several existing `min-h-[44px]`
 * call sites in the tree only work because some distant ancestor happens to be
 * a flex container (app/_components/marketing/MobileNav.tsx is one such
 * rescuer). A primitive must not depend on its parent's display mode, so the
 * two ship together and neither is separable from the other.
 */
export const CONTROL_MIN_TOUCH =
  "inline-flex items-center justify-center min-h-[44px]";

/**
 * Relaxes the visible height to 32px ONLY where the pointer is precise.
 *
 * Gated on `(pointer: fine)` rather than a width breakpoint on purpose: an
 * iPad in portrait is 768px wide and is still a thumb, so a `sm:`/`md:` gate
 * would quietly drop the floor on a touch device. Every coarse pointer — phone
 * and tablet alike — keeps the full 44px; only a mouse or trackpad gets the
 * compact box. Typography is NOT reduced to achieve density.
 */
export const CONTROL_COMPACT_FINE_POINTER = "pointer-fine:min-h-8";

/**
 * The one canonical focus treatment, shared by Button and every field control.
 *
 * - `focus-visible:`, not `focus:` — the app currently has 145 `focus:border-*`
 *   rules that also fire on mouse click, which reads as unexplained jitter.
 * - The indicator is a 2px ring plus a 2px offset: it changes the control's
 *   GEOMETRY, so it does not depend on colour perception alone.
 * - `outline-hidden`, NOT `outline-none`. In Tailwind v4 these are two
 *   different utilities and only one of them is safe here:
 *
 *     outline-none    -> outline-style: none
 *     outline-hidden  -> outline-style: none
 *                        + @media (forced-colors: active) {
 *                            outline: 2px solid transparent; outline-offset: 2px }
 *
 *   v4 renamed v3's forgiving `outline-none` to `outline-hidden` and gave the
 *   old name the hard removal. That distinction is load-bearing for this
 *   constant, because our replacement indicator is entirely `box-shadow`, and
 *   forced-colors mode (Windows High Contrast) forces `box-shadow: none` on
 *   every element. With the bare removal the control would be left with no
 *   focus indicator at all in exactly the mode a user relies on most. The
 *   transparent outline survives, and forced-colors repaints it in a system
 *   colour.
 *
 *   tests/components/ui-foundations.test.ts proves this against CSS compiled by
 *   the installed Tailwind, not against the spelling: restoring `outline-none`
 *   removes the forced-colors block from the emitted rule and turns it red.
 */
export const FOCUS_RING =
  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2 " +
  "focus-visible:ring-focus-ring focus-visible:ring-offset-surface";

/**
 * Press acknowledgement (120ms) and ordinary state change (180ms). Both are
 * CSS-only marker classes defined in app/globals.css, which is also where
 * `prefers-reduced-motion` collapses them to 1ms. No animation library.
 */
export const PRESS_TRANSITION = "hone-transition-press";
export const UI_TRANSITION = "hone-transition-ui";

/** Disabled/pending look, spelled once. 168 of 191 existing sites use opacity-50. */
export const CONTROL_DISABLED =
  "disabled:cursor-not-allowed disabled:opacity-50";

/**
 * THE UNIVERSAL press acknowledgement — safe on ANY control, by construction.
 *
 * WHY THIS EXISTS (UI-R01)
 * ------------------------
 * The UI-R00 recon measured the app at production a47eca0f: `hover:` appears in
 * 107 of the 118 files that contain a `<button>`, and `active:` in 10. Hover is
 * solved; press is not. That single asymmetry is the whole "Hone feels dead"
 * report — on a desktop the control looks alive until you press it, and on a
 * phone `:hover` never fires at all, so it is dead from first contact.
 *
 * NO TRANSFORM, AND THAT IS THE POINT.
 * ------------------------------------
 * This primitive is intended for broad adoption — UI-R03 applies it to ~108
 * control files it has not individually read. An earlier draft used
 * `active:scale-[0.98]` here, and review was right to refuse it: a non-`none`
 * `scale`/`transform` establishes a CONTAINING BLOCK for `position: fixed`
 * descendants and a NEW STACKING CONTEXT, for as long as the control is
 * pressed. A dropdown, popover or tooltip anchored inside such a control would
 * silently reparent on press. A comment warning future callers is not
 * sufficient protection for a primitive whose entire purpose is to be adopted
 * without reading each call site, so the safety is encoded in the API instead:
 * the universal one cannot transform, and the tactile one must be opted into.
 *
 * `opacity-90` is deliberately slight — enough to read as a press, distinct
 * from `opacity-50`, which is the DISABLED look in CONTROL_DISABLED. It changes
 * no geometry, creates no containing block, needs no positioning context, and
 * works identically with a mouse and a finger.
 *
 * REDUCED MOTION needs no special case here: an opacity change is a state
 * change, not motion. The shared marker collapses its duration to 1ms in
 * app/globals.css and the acknowledgement survives intact.
 *
 * A call site that ALSO has an `active:` background simply gets both, which is
 * harmless and is what Button does today.
 *
 * GUARDED: tests/components/ui-r01-interaction-foundations.test.ts asserts this
 * constant carries no scale/transform/translate. Adding one is a contract
 * change and must be made deliberately, not by convenience.
 */
export const CONTROL_PRESS = cx("active:opacity-90", PRESS_TRANSITION);

/**
 * The TACTILE press, for a compact LEAF control that owns its own positioning
 * context — a button, a pill, a segmented-control segment.
 *
 * OPT-IN, and the opt-in IS the contract. By using this a caller states that
 * either the control has no positioned descendants, or it already establishes
 * the containing block those descendants resolve against (Button is `relative`
 * and its pending mark is `absolute inset-0` INSIDE it, so it qualifies).
 *
 * THE RESTRICTION, EXPLICITLY: while `:active`, this control is a containing
 * block for `position: fixed` descendants and forms a new stacking context. Do
 * NOT use it on a control that anchors a fixed-position menu, popover, tooltip
 * or portal-less overlay, and do NOT reach for it on a row, card or any
 * container — SURFACE_PRESS exists for those.
 *
 * 0.98 — not lower. Below about 0.97 a 44px control reads as a bounce rather
 * than a press, and text inside it starts to visibly resample. A transform is
 * paint-time, so the LAYOUT box is untouched either way: a pressed control
 * cannot reflow its neighbours. Proved in the browser against a neighbour's
 * position, not merely against its own box.
 *
 * It COMPOSES the universal treatment rather than replacing it, so reduced
 * motion — which drops the scale — still leaves a real acknowledgement behind.
 */
export const LEAF_CONTROL_PRESS = cx(
  CONTROL_PRESS,
  "active:scale-[0.98] motion-reduce:active:scale-100",
);

/**
 * Press acknowledgement for a CONTAINER control — a clickable row, a card, a
 * list item, a `PendingContainerLink` body.
 *
 * NO TRANSFORM, on purpose. The brief says not to apply transforms blindly to
 * complex layout/container controls, and there are two concrete reasons here:
 *
 *   1. Scaling a full-width row scales its text and its borders with it, which
 *      reads as the row "breathing" rather than being pressed.
 *   2. A transform creates a containing block for `position: fixed` descendants
 *      and a new stacking context. Rows in this app host absolutely-positioned
 *      scrims (PendingContainerLink) and menus; silently changing their
 *      containing block is the kind of thing that is found later, in a bug.
 *
 * So a container acknowledges with its surface instead. Still no layout change.
 */
export const SURFACE_PRESS = cx("active:bg-surface-sunken", PRESS_TRANSITION);
