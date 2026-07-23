"use client";

import { useState, useTransition } from "react";
import type { OnboardingModel } from "@/lib/onboarding/steps";
import { OnboardingProgressCard } from "./OnboardingProgressCard";
import { OnboardingWizard } from "./OnboardingWizard";
import {
  completeOnboardingAction,
  dismissOnboardingAction,
  reopenOnboardingAction,
} from "../onboarding-actions";

// Owns the wizard open/closed state so the pinned card can re-open the wizard
// without a server round-trip, while each transition also persists the state
// (dismissed / completed / reopened) server-side.
export function OnboardingSurface({
  model,
  initialOpen,
}: {
  model: OnboardingModel;
  initialOpen: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [, startTransition] = useTransition();

  function handleDismiss() {
    setOpen(false);
    startTransition(() => {
      void dismissOnboardingAction();
    });
  }

  function handleComplete() {
    setOpen(false);
    startTransition(() => {
      void completeOnboardingAction();
    });
  }

  function handleContinue() {
    setOpen(true);
    startTransition(() => {
      void reopenOnboardingAction();
    });
  }

  return (
    <>
      {!model.isComplete && (
        <OnboardingProgressCard model={model} onContinue={handleContinue} />
      )}
      <OnboardingWizard
        model={model}
        open={open}
        onDismiss={handleDismiss}
        onComplete={handleComplete}
      />
    </>
  );
}
