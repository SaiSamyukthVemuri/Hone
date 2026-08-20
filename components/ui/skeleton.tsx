import { cx } from "./control-base";

// Shape-neutral loading placeholder (UI0).
//
// Prepared here, wired up in the perceived-speed PR. Production currently has
// ZERO `loading.tsx` files, ZERO `<Suspense>` boundaries and ZERO skeletons, so
// a dynamic route gets no partial prefetch and a tap holds the previous screen,
// fully painted, until the server responds. This primitive is the piece that
// PR needs; deliberately no route is wired to it here, so route-level loading
// behaviour lands as one reviewable change rather than as a side effect of a
// foundations PR.
//
// CSS only. No shimmer library, no gradient sweep — `animate-pulse` is a
// Tailwind built-in and the `hone-skeleton` marker lets app/globals.css stop
// the animation outright under `prefers-reduced-motion`.
//
// The placeholder paints at `--color-line`, the same value that draws a
// surface edge: a skeleton is structure, not content, and should never be
// mistaken for a filled field.
//
// Server-safe: no state, no directive.

type Props = {
  /**
   * Size and shape come from layout classes — `h-4 w-32`, `h-11 w-full`,
   * `size-10 rounded-full`. A skeleton should be cut to the shape of the real
   * content it stands in for, so it does not own its own dimensions.
   */
  className?: string;
};

export function Skeleton({ className }: Props) {
  return (
    <span
      // Decorative. The accessible "this region is loading" statement belongs
      // to the container (a route's loading.tsx, or an aria-busy region), not
      // to each individual bar — otherwise a screen reader reads a dozen
      // meaningless placeholders.
      aria-hidden="true"
      className={cx(
        "hone-skeleton block animate-pulse rounded-md bg-line",
        className,
      )}
    />
  );
}
