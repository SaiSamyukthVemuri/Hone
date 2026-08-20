import type { ReactNode } from "react";

import { cx } from "./control-base";

// One shape for the app's status pills (UI0).
//
// Production carries seven named private pill implementations plus roughly
// sixty anonymous inline ones across 74 files, in four padding scales
// (px-2 py-0.5, px-2.5 py-0.5, px-2.5 py-1, px-4 py-2) and four type sizes,
// with three competing emerald pairs all meaning "good". The shape and the
// spacing were the accidental part; the MEANING never was.
//
// DIVISION OF AUTHORITY — this is the important line and it is deliberate:
//
//   The primitive owns SHAPE, SPACING and TYPE.
//   The caller owns MEANING.
//
// There is no `status="intake_reviewed"` here and there must not be. Hone's
// domains — appointment status, intake status, card-on-file, consent, payment,
// launch readiness — are genuinely different vocabularies, and collapsing them
// into one enum is how a card-on-file "unknown" quietly starts rendering as an
// intake "incomplete". Each caller keeps its own state machine and its own
// labels, and only says how the result should be painted.
//
// Clinical caution deliberately NOT folded in: app/(app)/dashboard/page.tsx
// carries a written convention (allergies/cautions render rose, never amber)
// that is a patient-safety distinction, not a styling one. It stays owned by
// the dashboard until the Dashboard V2 PR, which is where that convention's
// tokens belong.
//
// Non-interactive by construction: renders a <span>, so it is always safe
// inside a row-body <Link> without creating nested interactive content.
// Server-safe: no state, no directive.

export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

const TONE: Record<StatusTone, string> = {
  neutral: "bg-status-neutral-surface text-status-neutral-fg",
  info: "bg-info-surface text-info-fg",
  success: "bg-success-surface text-success-fg",
  warning: "bg-warning-surface text-warning-fg",
  danger: "bg-danger-surface text-danger-fg",
};

type Props = {
  children: ReactNode;
  tone?: StatusTone;
  className?: string;
};

export function StatusPill({ children, tone = "neutral", className }: Props) {
  return (
    <span
      className={cx(
        // h-fit + flex-none keep the pill from stretching when it sits on a
        // flex line beside a wrapping title, which is where most of them live.
        "inline-flex h-fit flex-none items-center rounded-full px-2 py-0.5",
        "text-[10px] font-medium uppercase tracking-wider",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
