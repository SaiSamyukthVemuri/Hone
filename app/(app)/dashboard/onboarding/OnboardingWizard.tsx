"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
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

  // PERF-01C. THIS celebration, once played, is consumed for this mounted
  // wizard — independently of when refreshed server state arrives.
  //
  // `markCelebrationShownAction` no longer revalidates the dashboard (that is
  // what re-suspended the wizard's transition and disabled its buttons), so a
  // MOUNTED wizard keeps carrying `model.shouldCelebrate === true` until a
  // genuinely new server model lands. Closing the success step and reopening it
  // from the pinned card is synchronous, so without this the confetti replayed
  // even though `celebrated_at` was already stamped. Codex raised it on #658.
  //
  // The SERVER STAMP REMAINS THE DURABLE AUTHORITY: on any fresh render
  // `model.shouldCelebrate` is false because `celebrated_at` is set, and the
  // action still refuses to stamp unless the live model is genuinely complete,
  // so this local flag cannot consume a celebration the owner never earned.
  // SPENT ONLY ON A CONFIRMED SERVER STAMP, and DERIVED rather than assigned.
  //
  // Two earlier attempts were wrong in opposite directions. Marking it consumed
  // inside the effect that fires the stamp removed the confetti on the very next
  // render — the owner never saw the celebration they earned. Spending it on
  // close instead fixed that, but recorded mere VISUAL PLAYBACK: the action's
  // result was discarded, so a stamp the server REFUSED (`not_ready`, because
  // the live model is no longer complete) still consumed the celebration while
  // `celebrated_at` stayed null. The server would still owe it and the client
  // would never show it again. Codex raised that on #658 and was right.
  //
  // So the two facts are tracked separately — the owner has SEEN it and been
  // shown a close, and the SERVER has confirmed the durable stamp — and
  // suppression is their conjunction, computed during render. Because it is
  // derived, BOTH orderings fall out for free: the action resolving before the
  // close, and the owner closing before the action resolves. There is no
  // ordering-dependent branch to get wrong.
  const shown = useRef(false);
  const [closedAfterShowing, setClosedAfterShowing] = useState(false);
  const [stampConfirmed, setStampConfirmed] = useState(false);
  const celebrationSpent = closedAfterShowing && stampConfirmed;
  const showConfetti =
    active.key === "done" && model.shouldCelebrate && !celebrationSpent;

  // A FRESH SERVER MODEL THAT STILL SAYS THE CELEBRATION IS OWED clears any
  // local suppression. If the stamp had really landed, the next model would
  // report shouldCelebrate=false; it saying TRUE means the server still owes it,
  // and the server is the authority. Same prop-identity signal the completion
  // bridge uses in OnboardingSurface: a server render ships a new model object,
  // a client-only re-render reuses the prop.
  //
  // ...EXCEPT WHILE THE STAMP IS STILL IN FLIGHT. Closing also fires
  // dismissOnboardingAction, which DOES revalidate /dashboard. That render can
  // read `celebrated_at` BEFORE this stamp commits and hand back a model still
  // saying shouldCelebrate=true — a model that is STALE WITH RESPECT TO THE
  // REQUEST ALREADY IN FLIGHT. Letting it clear `closedAfterShowing` lost the
  // recorded close, the stamp then set only `stampConfirmed`, and the
  // conjunction stayed false: a synchronous reopen replayed the confetti.
  // Codex raised this on #658 and was right; it is race (B) again, one level in.
  //
  // A model may only retire local state once it could actually have observed
  // the outcome, so the reset waits for the request to settle.
  const stampInFlight = useRef(false);
  const lastModel = useRef(model);
  if (lastModel.current !== model) {
    lastModel.current = model;
    if (
      model.shouldCelebrate &&
      !stampInFlight.current &&
      (closedAfterShowing || stampConfirmed)
    ) {
      shown.current = false;
      setClosedAfterShowing(false);
      setStampConfirmed(false);
    }
  }

  useEffect(() => {
    if (open && showConfetti) {
      shown.current = true;
      stampInFlight.current = true;
      startTransition(async () => {
        // The RESULT is what makes it spendable. A refusal leaves the
        // celebration owed, exactly as the server sees it.
        try {
          const res = await markCelebrationShownAction();
          if (res.ok) setStampConfirmed(true);
        } finally {
          // Cleared in `finally` so a thrown action cannot strand the flag and
          // block every later model from retiring stale local state.
          stampInFlight.current = false;
        }
      });
    }
    // Fire once when landing on a celebratory success step.
  }, [open, showConfetti]);
  useEffect(() => {
    // Closing records only that the owner has SEEN it. On its own this suppresses
    // nothing — `shown` keeps a close BEFORE any celebration from counting, and
    // the confirmed stamp is the other half of the conjunction.
    if (!open && shown.current) setClosedAfterShowing(true);
  }, [open]);

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
