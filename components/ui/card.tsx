import type { ReactNode } from "react";

import { cx } from "./control-base";

// The bordered surface, spelled once (UI-R02).
//
// WHY THIS EXISTS
// ---------------
// The census found the same surface written many ways — `rounded-lg border
// border-neutral-200 dark:border-neutral-800` and seven near-variants — each
// hand-maintaining its own `dark:` pair. Hone already ships semantic tokens for
// exactly this (`surface`, `line`, `surface-sunken`), and they carry their own
// dark values, so a call site that uses them stops maintaining two palettes.
//
// Two real surfaces needed this before it was written: the notifications list
// and the settings sections. It is not a wrapper for naming consistency.
//
// NO "use client" — markup and classes only (#609).
//
// DELIBERATELY NOT A LAYOUT COMPONENT. It owns the surface — radius, border,
// ground — and nothing else. Padding is a `padded` boolean rather than a free
// prop because the census's real problem was surfaces disagreeing, not spacing
// needing another vocabulary. A list that draws its own dividers passes
// `padded={false}` and keeps its geometry.

export type CardTone = "default" | "sunken";

const TONE: Record<CardTone, string> = {
  default: "bg-surface border-line",
  // For wells and secondary panels — the same ground `SURFACE_PRESS` uses, so a
  // pressed row and a sunken panel cannot drift apart.
  sunken: "bg-surface-sunken border-line",
};

export type CardProps = {
  children: ReactNode;
  tone?: CardTone;
  /** False when the content draws its own edges (a divided list). */
  padded?: boolean;
  className?: string;
  /** Escape hatch for a semantic element — `section`, `ul`, `li`. */
  as?: "div" | "section" | "ul" | "li" | "article";
  "aria-label"?: string;
  /**
   * Anchor target. Global Search resolves an individual control ("export",
   * "delete all studio data") to its exact card rather than the page top, so a
   * card that is a search destination needs a stable id. Second real
   * requirement for this prop, not speculation.
   */
  id?: string;
};

export function Card({
  children,
  tone = "default",
  padded = true,
  className,
  as: Tag = "div",
  ...rest
}: CardProps) {
  return (
    <Tag
      {...rest}
      className={cx(
        "rounded-lg border",
        TONE[tone],
        padded && "px-5 py-4",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
