import {
  buildPilotFeedbackMailto,
  type PilotSurface,
} from "@/lib/pilot/feedback-mailto";

// Pilot Love Loop V1 (PR #250). A visually quiet "Was this useful?"
// footer for a high-value surface. Pure server component: every action
// is a plain mailto: anchor (no client JS, no modal, no popup, no
// external script, no analytics). Opens the practitioner's own mail
// client pre-filled with generic, non-sensitive context only.

export function PilotFeedbackPrompt({
  surface,
  promptText = "Was this useful?",
}: {
  surface: PilotSurface;
  promptText?: string;
}) {
  const link =
    "underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900 hover:decoration-neutral-600 dark:hover:text-neutral-100";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-neutral-100 pt-3 text-xs text-neutral-500 dark:border-neutral-800/60">
      <span>{promptText}</span>
      <a href={buildPilotFeedbackMailto(surface, "useful")} className={link}>
        Yes
      </a>
      <a href={buildPilotFeedbackMailto(surface, "not_useful")} className={link}>
        Not really
      </a>
      <a
        href={buildPilotFeedbackMailto(surface, "general")}
        className={`${link} text-neutral-400 dark:text-neutral-500`}
      >
        Tell us what it helped with
      </a>
    </div>
  );
}
