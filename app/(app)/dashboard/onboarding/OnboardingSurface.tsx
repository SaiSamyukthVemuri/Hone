"use client";

import { useRef, useState, useTransition } from "react";
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
  // PERF-01C. The setup surface must disappear the moment completion is
  // RECORDED, and it may not wait for the dashboard to re-render.
  //
  // `model.isComplete` is server-rendered, so before this the card only went
  // away once `revalidatePath("/dashboard")` had produced a new tree. That
  // refresh is a React transition, and with the streamed secondary stack
  // suspending under an unchanged boundary key React keeps the CURRENT screen
  // until it resolves — so the card lingered after "Go to dashboard".
  // e2e/onboarding.spec.ts caught it.
  //
  // COMPLETION REMAINS SERVER-AUTHORITATIVE. This flag is set only when the
  // action REPORTS ok, and the action still refuses (`not_ready`) unless the
  // required steps are genuinely green and the atomic CAS succeeded. A refusal
  // leaves the card exactly where it was, which is the fail-closed direction.
  // The server model stays the authority on the next render; this only stops
  // the view lagging behind a decision the server already made.
  const [completedLocally, setCompletedLocally] = useState(false);
  // ...AND IT IS A BRIDGE, NOT A LATCH. It spans exactly one gap: the moment
  // between the server RECORDING completion and the next server model arriving.
  // The first fresh model retires it, and the server is sole authority again.
  //
  // Without this the override never cleared. A same-route navigation preserves
  // this component's state, so if completion later became FALSE — the owner
  // removes their last service or availability in another tab, and
  // buildOnboardingModel correctly recomputes isComplete=false — the stale flag
  // would keep suppressing the setup card against the server's answer. Codex
  // raised it on PR #658 and was right.
  //
  // RETIRED ON ANY NEW MODEL, not only a COMPLETE one. Keying retirement on
  // `model.isComplete` was the first attempt and it was insufficient: if the
  // next model is also incomplete — exactly the removed-service case — the
  // bridge would never retire and the card would stay wrongly hidden. The new
  // e2e negative control catches that. Every server render ships a fresh model
  // object over the RSC payload, while a client-only re-render reuses the same
  // prop, so identity is the honest signal for "the server has spoken again".
  const lastModel = useRef(model);
  if (lastModel.current !== model) {
    lastModel.current = model;
    if (completedLocally) setCompletedLocally(false);
  }

  function handleDismiss() {
    setOpen(false);
    startTransition(() => {
      void dismissOnboardingAction();
    });
  }

  function handleComplete() {
    setOpen(false);
    startTransition(async () => {
      const res = await completeOnboardingAction();
      // Only on a RECORDED completion. A refusal keeps the card.
      if (res.ok) setCompletedLocally(true);
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
      {!model.isComplete && !completedLocally && (
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
