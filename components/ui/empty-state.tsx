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
  className?: string;
};

export function EmptyState({
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
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
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="max-w-[48ch] text-sm leading-relaxed text-fg-muted">
        {description}
      </p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
