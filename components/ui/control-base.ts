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
 * THE TACTILE PRESS LAYER — opt-in, and a LAYER, not a complete treatment.
 *
 * WHAT IT IS FOR
 * --------------
 * A compact LEAF control that owns its own positioning context: a button, a
 * pill, a segmented-control segment. It adds the physical sense of a press and
 * nothing else.
 *
 * IT IS NOT A PRESS TREATMENT BY ITSELF. Under `prefers-reduced-motion` the
 * scale collapses to a no-op, so a control composing ONLY this has no press
 * feedback at all for exactly the users least able to tolerate a control that
 * looks untapped. THE CALLER MUST SUPPLY A COLOUR TREATMENT. Every Button
 * variant does — primary/secondary/quiet/danger each carry their own
 * `active:bg-*`, chosen for their own background — and that colour is what
 * survives when the motion is removed. Guarded in
 * tests/components/ui-r01-interaction-foundations.test.ts.
 *
 * THE POSITIONING RESTRICTION, EXPLICITLY: while `:active`, a scaled control IS
 * a containing block for `position: fixed` descendants and DOES form a new
 * stacking context. Do not use it on a control that anchors a fixed-position
 * menu, popover, tooltip or portal-less overlay.
 *
 * 0.98 — not lower. Below about 0.97 a 44px control reads as a bounce rather
 * than a press, and text inside it starts to visibly resample. A transform is
 * paint-time, so the LAYOUT box is untouched: a pressed control cannot reflow
 * its neighbours. Proved in the browser against a NEIGHBOUR's position, not
 * merely against its own box.
 */
export const LEAF_CONTROL_PRESS = cx(
  "active:scale-[0.98] motion-reduce:active:scale-100",
  PRESS_TRANSITION,
);

/**
 * Press treatment for the NEUTRAL-SURFACE families, and ONLY those.
 *
 * COMPATIBLE: a list row, a card, a container link, a quiet/ghost control, an
 * outlined control — anything already sitting on `surface` and carrying
 * foreground-coloured text.
 *
 * NOT COMPATIBLE, and this is why the name changed: a FILLED control. Sinking
 * a dark button to `surface-sunken` (oklch 98.5%, near-white) underneath
 * `text-on-accent` (#fff) is white on near-white — the label disappears for as
 * long as the control is pressed. Those families carry their own `active:bg-*`
 * instead; see Button's VARIANT map.
 *
 * THERE IS NO UNIVERSAL PRESS CLASS, AND UI-R01 STOPPED PRETENDING OTHERWISE.
 * An earlier export named CONTROL_PRESS was retired rather than renamed. Three
 * successive attempts to make one blind-adoptable constant each traded one
 * requirement for another — `scale` and `opacity` both created a stacking
 * context; a background change fixed that and broke contrast on filled
 * controls; removing the background from the leaf layer fixed the conflict and
 * removed reduced-motion feedback. A treatment that is safe on any element AND
 * visible on any background has to know what it is painting on, and a constant
 * adopted without reading the call site cannot. The name invited exactly the
 * blind adoption that is unsafe, so it is gone.
 *
 * UI-R03 therefore classifies a control into a FAMILY first and applies that
 * family's treatment — it does not apply one class to 108 files.
 *
 * Creates no containing block and no stacking context: a background-colour
 * change does neither, which is why the surface families can share one string.
 */
export const SURFACE_PRESS = cx("active:bg-surface-sunken", PRESS_TRANSITION);
