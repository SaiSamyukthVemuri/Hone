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
