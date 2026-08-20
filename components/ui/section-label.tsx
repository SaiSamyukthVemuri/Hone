import type { ReactNode } from "react";

import { cx } from "./control-base";

// The small-caps label that heads almost every information block in Hone.
//
// It is the single most duplicated visual idea in the app: a census of
// production found `uppercase tracking-wider` co-occurring 292 times across
// 68 distinct spellings, including three byte-identical private
// `SectionLabel()` definitions (components/before-today-card.tsx,
// components/last-treatment-memory-card.tsx,
// components/appointment-prep-memory-card.tsx) that never imported one another,
// plus a fourth extracted as `LABEL_CLS` in app/(app)/records/record-forms.tsx.
// The team already agreed on the tracking; only the SIZE drifted.
//
// Two sizes, not four. They are named for what they label rather than for a
// Tailwind step, because the distinction is semantic: a caption sits inside a
// card next to the value it names, a section header introduces a block.
//
// Server-safe: no state, no directive.

export type SectionLabelTone = "muted" | "inherit";

type Props = {
  children: ReactNode;
  /**
   * "section" (default, 12px) heads a block — the 86-instance canonical
   * spelling. "caption" (11px) names a field inside a card; 11px was the
   * single largest off-scale size in the app (206 uses) and is a real tier,
   * not drift.
   */
  size?: "section" | "caption";
  /**
   * "muted" (default) is the neutral-500 the app already uses for this label.
   * "inherit" keeps the parent's colour, for the cases where the label sits
   * inside an already-tinted callout and must not fight it.
   */
  tone?: SectionLabelTone;
  /** Renders semantic heading markup where the label really is a heading. */
  as?: "span" | "p" | "h2" | "h3" | "h4" | "dt";
  className?: string;
};

const SIZE = {
  section: "text-xs",
  caption: "text-[11px]",
} as const;

export function SectionLabel({
  children,
  size = "section",
  tone = "muted",
  as: Tag = "span",
  className,
}: Props) {
  return (
    <Tag
      className={cx(
        SIZE[size],
        "font-medium uppercase tracking-wider",
        tone === "muted" && "text-fg-muted",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
