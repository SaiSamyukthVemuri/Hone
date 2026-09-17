import type { ReactNode } from "react";

import { cx } from "./control-base";

// The empty state, spelled once (UI-R02).
//
// WHY THIS EXISTS, AND WHY IT IS HONE'S OWN
// -----------------------------------------
// The census found ad-hoc empty states across the app — "No notifications
// yet.", "No active services.", "No archived clients.", "No blocked time." and
// more — each a bespoke dashed box with its own hardcoded neutrals and its own
// `dark:` pair. There was no primitive at all.
//
// ASTRYX-PILOT-01 proposed adopting Astryx's `EmptyState` here, and it is the
// one candidate with a genuine gap: Hone really has no equivalent, and Astryx's
// is one of the 33 server-safe components. UI-R02 still wrote Hone's own, for
// two reasons recorded in the UI-R02 handoff: the Astryx overlay candidates
// could not be browser-proved in this repository (no isolated no-DB harness
// exists), so no Astryx component is adopted in this slice; and an empty state
// is ~20 lines of markup whose value is the COPY DISCIPLINE, not the mechanics.
// Taking a dependency for that would be paying a bundle and a client-boundary
// cost for a box.
//
// NO "use client" (#609).
//
// THE COPY RULE THIS ENCODES: an empty state says what is missing AND what
// makes it appear. "No notifications yet." alone tells a practitioner nothing
// actionable; the census found several that stop there. `description` is
// therefore a required prop, not an optional one.

export type EmptyStateProps = {
  /** What is not here. One short sentence. */
  title: ReactNode;
  /**
   * What will make it appear. REQUIRED on purpose — an empty state that only
   * says "nothing here" is the defect this primitive exists to stop.
   */
  description: ReactNode;
  /** An optional way out — usually the action that creates the first item. */
  action?: ReactNode;
  /**
   * Renders the title as a REAL HEADING at this level, so an empty state joins
   * the document outline instead of being invisible to heading navigation.
   *
   * WHY THIS IS OPT-IN. Omitted is the default and keeps the current
   * non-heading `<p>`, so adding this prop cannot silently restructure the
   * outline of a call site that never asked for it.
   *
   * WHY NO h1. PageHeader already renders the page's single `h1`, and the one
   * EmptyState call site today (notifications) sits on a page that uses it. An
   * empty state claiming `h1` would compete with the page title, so the type
   * makes that unrepresentable rather than merely discouraged.
   *
   * WHY NO role="status". An empty state is not inherently a live-region
   * event: it is usually the page's resting state, not a change announced
   * mid-session. Defaulting to a live region would give every caller
   * announcement semantics none of them opted into. A surface that genuinely
   * needs one — a list that empties in place — should establish that with its
   * own proof rather than inherit it here.
   */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  className?: string;
};

export function EmptyState({
  title,
  description,
  action,
  headingLevel,
  className,
}: EmptyStateProps) {
  // Card's `as: Tag` idiom, applied to a heading level: React renders a
  // lowercase string as an intrinsic element, so no h2..h6 lookup table is
  // needed and the union stays exhaustive by construction.
  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  return (
    <div
      className={cx(
        // Dashed, to read as an absence rather than as content. Tokened, so it
        // stops carrying a hand-written dark: pair.
        "flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong",
        "bg-surface-sunken px-5 py-12 text-center",
        className,
      )}
    >
      {/* SAME CLASSES EITHER WAY, deliberately. The level changes the DOCUMENT
          OUTLINE and nothing else — a caller opting into semantics must not be
          handed a typography change it did not ask for. */}
      <Title className="text-sm font-medium text-fg">{title}</Title>
      <p className="max-w-[48ch] text-sm leading-relaxed text-fg-muted">
        {description}
      </p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
