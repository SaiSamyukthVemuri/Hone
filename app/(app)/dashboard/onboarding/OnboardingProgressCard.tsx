"use client";

import Link from "next/link";
import type {
  OnboardingModel,
  OnboardingStepState,
} from "@/lib/onboarding/steps";

// Pinned "Finish setting up your studio" card. Lives at the TOP of the
// dashboard (above the fold) whenever onboarding-v2 is on and setup isn't
// complete. Reuses the app's neutral card + checklist vocabulary. The primary
// action re-opens the guided wizard; per-row links are a secondary shortcut.

const ACTIONABLE: ReadonlyArray<OnboardingStepState["key"]> = [
  "service",
  "availability",
  "booking",
  "payments",
];

function Mark({ status }: { status: OnboardingStepState["status"] }) {
  if (status === "done") {
    return (
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-[11px] text-white"
        aria-hidden
      >
        ✓
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-300 text-[11px] text-neutral-400 dark:border-neutral-700"
        aria-hidden
      >
        –
      </span>
    );
  }
  return (
    <span
      className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-300 text-[11px] text-neutral-400 dark:border-neutral-700"
      aria-hidden
    >
      ·
    </span>
  );
}

export function OnboardingProgressCard({
  model,
  onContinue,
}: {
  model: OnboardingModel;
  onContinue: () => void;
}) {
  const rows = model.steps.filter((s) => ACTIONABLE.includes(s.key));
  const pct = Math.round((model.doneCount / model.totalCount) * 100);

  return (
    <section
      className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
      aria-label="Studio setup progress"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Finish setting up your studio</h2>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            {model.doneCount} of {model.totalCount} complete
          </p>
        </div>
        <button
          type="button"
          onClick={onContinue}
          className="inline-flex min-h-[40px] items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {model.doneCount > 0 ? "Continue setup" : "Start setup"}
        </button>
      </div>

      <div
        className="mt-4 h-2 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Setup completion"
      >
        <div
          className="h-full rounded-full bg-neutral-900 transition-[width] dark:bg-white"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ul className="mt-4 divide-y divide-neutral-100 dark:divide-neutral-800">
        {rows.map((step) => (
          <li
            key={step.key}
            className="flex items-center justify-between gap-3 py-2.5"
          >
            <span className="flex items-center gap-2.5">
              <Mark status={step.status} />
              <span
                className={`text-sm ${
                  step.status === "done"
                    ? "text-neutral-500 line-through decoration-neutral-300 dark:text-neutral-500"
                    : "text-neutral-800 dark:text-neutral-100"
                }`}
              >
                {step.title}
                {step.optional && step.status !== "done" ? (
                  <span className="ml-1.5 text-xs text-neutral-400">
                    optional
                  </span>
                ) : null}
              </span>
            </span>
            {step.status !== "done" && step.resolvedHref ? (
              <Link
                href={step.resolvedHref}
                className="text-xs font-medium text-neutral-600 underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
              >
                Set up
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
