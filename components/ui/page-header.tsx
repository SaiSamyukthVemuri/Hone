import type { ReactNode } from "react";

import { cx } from "./control-base";

// The page heading, spelled once (UI-R02).
//
// WHY THIS EXISTS
// ---------------
// A census of the authenticated app found the same heading written two
// different ways inside `settings` alone — `text-3xl font-semibold
// tracking-tight` on some pages and `font-[var(--font-fraunces)] text-3xl
// font-bold tracking-tight` on others — and the supporting description written
// with hardcoded `text-neutral-500` rather than the `fg-muted` token that
// exists for it. Every page has a heading; none of them agreed.
//
// This is not an abstraction for naming's sake. Two real surfaces needed it
// before it was written, and the rule it carries — heading, then optional
// description, then an optional action aligned to the baseline — is the
// hierarchy the app already reaches for by hand.
//
// NO "use client". Like Button and Spinner this is markup and classes only, so
// it renders inside a Server Component. #609 guards components/ui/ against a
// visual primitive becoming the reason a clinical page hydrates.
//
// SEMANTIC TOKENS, NOT RAW NEUTRALS. `text-fg` / `text-fg-muted` carry their own
// dark-mode values, so a call site no longer hand-maintains a `dark:` pair per
// heading. That is the single biggest source of surface inconsistency the
// census found.

export type PageHeaderProps = {
  title: ReactNode;
  /** The sentence under the title. Optional — not every page earns one. */
  description?: ReactNode;
  /**
   * A single primary action, baseline-aligned with the title.
   *
   * Deliberately one slot, not a children array: a page header with a row of
   * competing actions is the layout this is meant to stop, and the census found
   * no surface that legitimately needed two.
   */
  action?: ReactNode;
  /**
   * The heading level for the title. **Defaults to 1** — a page header is
   * normally the page's one top-level heading, and /notifications relies on
   * that (no ancestor layout there renders an h1).
   *
   * IT IS NOT ALWAYS 1, AND ASSUMING SO SHIPPED A REGRESSION. `settings/layout.tsx`
   * renders `<h1>Settings</h1>` for every settings route, so a hard-coded h1
   * here gave /settings/data TWO top-level headings and made "Your data" a peer
   * of "Settings" in heading navigation. A page that already sits under a
   * heading passes its real depth instead.
   */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  className?: string;
};

export function PageHeader({
  title,
  description,
  action,
  headingLevel = 1,
  className,
}: PageHeaderProps) {
  // Card's `as: Tag` idiom. Same classes at every level: the level changes the
  // DOCUMENT OUTLINE, never the visual size.
  const Title = `h${headingLevel}` as const;
  return (
    <header
      className={cx(
        "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2",
        className,
      )}
    >
      <div className="min-w-0">
        <Title className="text-3xl font-semibold tracking-tight text-fg">{title}</Title>
        {description ? (
          <p className="mt-1 max-w-[65ch] text-sm leading-relaxed text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
