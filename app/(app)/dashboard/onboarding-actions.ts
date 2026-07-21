"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { captureServerEvent } from "@/lib/analytics/server";
import {
  setCurrentStep,
  markStepAdvanced,
  markStepSkipped,
  dismissOnboarding,
  reopenOnboarding,
  completeOnboarding,
  markCelebrated,
} from "@/lib/onboarding/state";
import {
  ONBOARDING_STEP_ORDER,
  type OnboardingStepKey,
} from "@/lib/onboarding/steps";

// Thin owner-gated server actions driving the onboarding wizard. Every action
// is fail-closed: it no-ops unless the caller is the studio OWNER AND the
// studio has onboarding_v2_enabled = true, so a stray call on a flag-off studio
// (or by a non-owner) changes nothing. Analytics are post-response, bounded,
// user-actor with only the allowlisted studio_id.

export type OnboardingActionResult = { ok: boolean; error?: string };

type OwnerCtx = { studioId: string; practitionerId: string };

const NOT_ALLOWED: OnboardingActionResult = {
  ok: false,
  error: "not_allowed",
};

async function requireOnboardingOwner(): Promise<OwnerCtx | null> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") return null;
  if (studio.onboarding_v2_enabled !== true) return null; // fail closed
  return { studioId: studio.id, practitionerId: practitioner.id };
}

function isStepKey(value: string): value is OnboardingStepKey {
  return (ONBOARDING_STEP_ORDER as string[]).includes(value);
}

// Persist the resume pointer as the owner navigates the wizard (Back/Next).
export async function setOnboardingStepAction(
  step: string,
): Promise<OnboardingActionResult> {
  const ctx = await requireOnboardingOwner();
  if (!ctx) return NOT_ALLOWED;
  if (!isStepKey(step)) return { ok: false, error: "bad_step" };
  const res = await setCurrentStep(ctx.studioId, step);
  revalidatePath("/dashboard");
  return res;
}

// Acknowledge the welcome step -> move to the first setup step. Also the
// wizard_started funnel event.
export async function acknowledgeWelcomeAction(): Promise<OnboardingActionResult> {
  const ctx = await requireOnboardingOwner();
  if (!ctx) return NOT_ALLOWED;
  const res = await markStepAdvanced(ctx.studioId, "welcome", "service");
  captureServerEvent({
    actor: { kind: "user", id: ctx.practitionerId },
    event: "onboarding_wizard_started",
    properties: { studio_id: ctx.studioId },
  });
  revalidatePath("/dashboard");
  return res;
}

// Skip the optional payments step.
export async function skipPaymentsAction(): Promise<OnboardingActionResult> {
  const ctx = await requireOnboardingOwner();
  if (!ctx) return NOT_ALLOWED;
  const res = await markStepSkipped(ctx.studioId, "payments", "done");
  revalidatePath("/dashboard");
  return res;
}

// Acknowledge the success step -> onboarding complete + wizard_completed event.
export async function completeOnboardingAction(): Promise<OnboardingActionResult> {
  const ctx = await requireOnboardingOwner();
  if (!ctx) return NOT_ALLOWED;
  const res = await completeOnboarding(ctx.studioId);
  captureServerEvent({
    actor: { kind: "user", id: ctx.practitionerId },
    event: "onboarding_wizard_completed",
    properties: { studio_id: ctx.studioId },
  });
  revalidatePath("/dashboard");
  return res;
}

// Owner closed the wizard overlay (progress preserved; re-openable from the card).
export async function dismissOnboardingAction(): Promise<OnboardingActionResult> {
  const ctx = await requireOnboardingOwner();
  if (!ctx) return NOT_ALLOWED;
  const res = await dismissOnboarding(ctx.studioId);
  revalidatePath("/dashboard");
  return res;
}

// Re-open the wizard from the pinned card.
export async function reopenOnboardingAction(): Promise<OnboardingActionResult> {
  const ctx = await requireOnboardingOwner();
  if (!ctx) return NOT_ALLOWED;
  const res = await reopenOnboarding(ctx.studioId);
  revalidatePath("/dashboard");
  return res;
}

// The one-time celebration has been shown — never fire it again.
export async function markCelebrationShownAction(): Promise<OnboardingActionResult> {
  const ctx = await requireOnboardingOwner();
  if (!ctx) return NOT_ALLOWED;
  const res = await markCelebrated(ctx.studioId);
  revalidatePath("/dashboard");
  return res;
}
