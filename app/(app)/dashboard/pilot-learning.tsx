import { buildPilotFeedbackMailto } from "@/lib/pilot/feedback-mailto";

// Pilot Love Loop V1 (PR #250). A compact, optional "Pilot learning"
// card so the practitioner can tell us when Hone created a moment worth
// remembering. Pure server component: both actions are plain mailto:
// anchors (no automated send, no contact access, no invitations, no
// referral links, no tracking links, no external provider). Manual
// feedback only — opens the practitioner's own mail client.

export function PilotLearningCard() {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div>
        <h2 className="text-lg font-medium">Pilot learning</h2>
        <p className="text-sm text-neutral-500">
          Notice a moment where Hone helped you remember something? Send it to
          Sam.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <a
          href={buildPilotFeedbackMailto("dashboard_pilot_learning", "general")}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Send feedback
        </a>
        <a
          href={buildPilotFeedbackMailto(
            "dashboard_pilot_learning",
            "another_electrologist",
          )}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Know another electrologist?
        </a>
      </div>
    </section>
  );
}
