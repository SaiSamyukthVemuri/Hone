// The Hone spinner primitive (UI-R01).
//
// ONE SPINNER, EXTRACTED — NOT A SECOND SYSTEM.
// ---------------------------------------------
// components/pending-link.tsx already shipped exactly this mark for navigation
// pending, and it already got the hard part right. This file is that mark
// LIFTED OUT, and pending-link.tsx now imports it. There is no new spinner in
// the app as a result of UI-R01; there is one spinner where there were
// previously one-and-a-half.
//
// NO "use client". Like Button, this is pure markup and CSS: no state, no
// effect, no browser API. It renders inside a Server Component and is equally
// safe compiled into a client island. A visual foundation must never be the
// reason a server-rendered clinical page starts hydrating (#609).
//
// REDUCED MOTION IS A SHAPE CHANGE, NOT A COLOUR CHANGE.
// `motion-reduce:animate-none` alone would leave a static ring with a
// transparent quarter — which reads as a broken circle, not as "working".
// `motion-reduce:border-t-current` closes that quarter, so the still frame is a
// complete, deliberate ring. The state is still communicated when nothing moves.
//
// SIZE IS FIXED, IN BOTH AXES. `size-4`/`size-5` are square and absolute, so a
// spinner can be swapped into a control's footprint without the control
// changing width. Geometry stability (UI-R01 requirement 6) depends on that.
//
// NO THIRD-PARTY PACKAGE. Hone ships no clsx, no tailwind-merge, no cva, no
// animation library, and this layer does not change that.

import { cx } from "./control-base";

export type SpinnerSize = "sm" | "md";

const SIZE: Record<SpinnerSize, string> = {
  sm: "size-4",
  md: "size-5",
};

/**
 * The spinning mark, spelled once.
 *
 * Exported as a class string as well as a component because
 * `PendingContainerLink` composes it into an absolutely-positioned scrim where
 * a bare `<span>` is what it needs, and because a call site that is already
 * building a class list should not have to mount a component to get the look.
 */
export function spinnerClasses(size: SpinnerSize = "sm", className?: string): string {
  return cx(
    SIZE[size],
    "animate-spin rounded-full border-2 border-current border-t-transparent",
    "motion-reduce:animate-none motion-reduce:border-t-current",
    className,
  );
}

export type SpinnerProps = {
  size?: SpinnerSize;
  className?: string;
  /**
   * The words a screen reader should hear.
   *
   * DEFAULT IS SILENCE, and that default is the important one. A spinner is
   * almost always rendered NEXT TO something that already announces the state —
   * Button's `aria-busy`, PendingLink's mounted `role="status"` region. A
   * spinner that also announces produces a double announcement, so the mark is
   * `aria-hidden` unless a caller explicitly says it is the only voice in the
   * control. Requirement 2: aria-hidden when paired with visible/live pending
   * text.
   */
  label?: string;
};

export function Spinner({ size = "sm", className, label }: SpinnerProps) {
  if (label) {
    return (
      <span role="status" className={cx("inline-flex items-center", className)}>
        <span aria-hidden="true" className={spinnerClasses(size)} />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return <span aria-hidden="true" className={spinnerClasses(size, className)} />;
}
