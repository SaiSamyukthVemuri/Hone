"use client";

import { useEffect, useId, useState, useTransition } from "react";
import Link from "next/link";
import {
  ONBOARDING_STEP_ORDER,
  type OnboardingModel,
  type OnboardingStepKey,
  type OnboardingStepState,
} from "@/lib/onboarding/steps";
import { OnboardingModal } from "./OnboardingModal";
import { Celebration } from "./Celebration";
import {
  acknowledgeWelcomeAction,
  markCelebrationShownAction,
  setOnboardingStepAction,
  skipPaymentsAction,
} from "../onboarding-actions";

const PRIMARY_BTN =
  "inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200";
const SECONDARY_BTN =
  "inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900";

function ProgressBar({
  steps,
  activeIndex,
}: {
  steps: OnboardingStepState[];
  activeIndex: number;
}) {
  return (
    <ol className="grid grid-cols-6 gap-1.5" aria-label="Setup progress">
      {steps.map((s, i) => {
        const filled = s.status === "done" || i <= activeIndex;
        return (
          <li key={s.key}>
            <div
              className={`h-1.5 w-full rounded-full ${
                filled
                  ? "bg-neutral-900 dark:bg-white"
                  : "bg-neutral-200 dark:bg-neutral-800"
              }`}
              aria-hidden
            />
          </li>
        );
      })}
    </ol>
  );
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={SECONDARY_BTN}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard unavailable: the link is visible to copy manually.
        }
      }}
    >
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}

function StatusChip({ status }: { status: OnboardingStepState["status"] }) {
  if (status === "done") {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        ✓ Done
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
        Skipped
      </span>
    );
  }
  return null;
}

// Controlled wizard: the parent OnboardingSurface owns `open` so the pinned card
// can re-open it without a server round-trip. onDismiss = closed by the owner
// (X / backdrop / Escape); onComplete = finished from the success step.
export function OnboardingWizard({
  model,
  open,
  onDismiss,
  onComplete,
}: {
  model: OnboardingModel;
  open: boolean;
  onDismiss: () => void;
  onComplete: () => void;
}) {
  const [activeStep, setActiveStep] = useState<OnboardingStepKey>(
    model.currentStep,
  );
  const [pending, startTransition] = useTransition();
  const titleId = useId();
  const descId = useId();

  const active = model.steps.find((s) => s.key === activeStep) ?? model.steps[0];
  const activeIndex = ONBOARDING_STEP_ORDER.indexOf(active.key);
  const stepNumber = activeIndex + 1;
  const total = model.totalCount;
  const nextKey = ONBOARDING_STEP_ORDER[activeIndex + 1];
  const prevKey = ONBOARDING_STEP_ORDER[activeIndex - 1];

  const showConfetti = active.key === "done" && model.shouldCelebrate;
  useEffect(() => {
    if (open && showConfetti) {
      startTransition(() => {
        void markCelebrationShownAction();
      });
    }
    // Fire once when landing on a celebratory success step.
  }, [open, showConfetti]);

  function goTo(step: OnboardingStepKey) {
    setActiveStep(step);
    startTransition(() => {
      void setOnboardingStepAction(step);
    });
  }

  function persistPointer() {
    startTransition(() => {
      void setOnboardingStepAction(active.key);
    });
  }

  return (
    <OnboardingModal
      open={open}
      onClose={onDismiss}
      labelledById={titleId}
      describedById={descId}
    >
      <div className="relative">
        {showConfetti && <Celebration />}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <ProgressBar steps={model.steps} activeIndex={activeIndex} />
            <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              Step {stepNumber} of {total}
              {active.key === "welcome" ? " · about 5 minutes" : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close setup"
            className="-m-2 flex h-11 w-11 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="mt-5">
        <div className="flex items-center gap-3">
          <h2
            id={titleId}
            className="font-[var(--font-fraunces)] text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50"
          >
            {active.title}
          </h2>
          <StatusChip status={active.status} />
        </div>
        <p
          id={descId}
          className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300"
        >
          {active.blurb}
        </p>

        {active.key === "welcome" && (
          <ul className="mt-4 grid gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            {[
              "Bookings and a public booking page",
              "Client history and treatment memory",
              "Session notes and treatment photos",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2">
                <span className="mt-0.5 text-neutral-400" aria-hidden>
                  ·
                </span>
                {line}
              </li>
            ))}
          </ul>
        )}

        {active.key === "booking" && model.publicBookingUrl && (
          <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            <span className="break-all text-neutral-700 dark:text-neutral-200">
              {model.publicBookingUrl}
            </span>
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {active.key === "welcome" && (
          <button
            type="button"
            className={PRIMARY_BTN}
            disabled={pending}
            onClick={() => {
              startTransition(() => {
                void acknowledgeWelcomeAction();
              });
              setActiveStep("service");
            }}
          >
            Get started
          </button>
        )}

        {(active.key === "service" ||
          active.key === "availability" ||
          active.key === "booking") && (
          <>
            {active.status === "done" ? (
              <button
                type="button"
                className={PRIMARY_BTN}
                disabled={pending}
                onClick={() => nextKey && goTo(nextKey)}
              >
                Continue
              </button>
            ) : (
              active.cta && (
                <Link
                  href={active.cta.href}
                  className={PRIMARY_BTN}
                  onClick={persistPointer}
                >
                  {active.cta.label}
                </Link>
              )
            )}
            {active.key === "booking" && model.publicBookingUrl && (
              <>
                <Link
                  href={model.publicBookingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={SECONDARY_BTN}
                  onClick={persistPointer}
                >
                  Open booking page
                </Link>
                <CopyLinkButton url={model.publicBookingUrl} />
              </>
            )}
          </>
        )}

        {active.key === "payments" && (
          <>
            {active.status === "done" ? (
              <button
                type="button"
                className={PRIMARY_BTN}
                disabled={pending}
                onClick={() => goTo("done")}
              >
                Continue
              </button>
            ) : (
              <>
                {active.cta && (
                  <Link
                    href={active.cta.href}
                    className={PRIMARY_BTN}
                    onClick={persistPointer}
                  >
                    {active.cta.label}
                  </Link>
                )}
                <button
                  type="button"
                  className={SECONDARY_BTN}
                  disabled={pending}
                  onClick={() => {
                    startTransition(() => {
                      void skipPaymentsAction();
                    });
                    setActiveStep("done");
                  }}
                >
                  Skip for now
                </button>
              </>
            )}
          </>
        )}

        {active.key === "done" && (
          <>
            <button
              type="button"
              className={PRIMARY_BTN}
              disabled={pending}
              onClick={onComplete}
            >
              Go to dashboard
            </button>
            {model.publicBookingUrl && (
              <CopyLinkButton url={model.publicBookingUrl} />
            )}
          </>
        )}

        {activeIndex > 0 && active.key !== "done" && prevKey && (
          <button
            type="button"
            className="ml-auto text-sm text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
            disabled={pending}
            onClick={() => goTo(prevKey)}
          >
            Back
          </button>
        )}
      </div>
    </OnboardingModal>
  );
}
