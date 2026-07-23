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
  getOnboardingRow,
  toPersisted,
} from "@/lib/onboarding/state";
import { getOnboardingSignals } from "@/lib/onboarding/signals";
import {
  ONBOARDING_STEP_ORDER,
  buildOnboardingModel,
  type OnboardingModel,
  type OnboardingStepKey,
} from "@/lib/onboarding/steps";

// Thin owner-gated server actions driving the onboarding wizard. Every action
// is fail-closed: it no-ops unless the caller is the studio OWNER AND the
// studio has onboarding_v2_enabled = true, so a stray call on a flag-off studio
// (or by a non-owner) changes nothing. Analytics are post-response, bounded,
// user-actor with only the allowlisted studio_id.

export type OnboardingActionResult = { ok: boolean; error?: string };

// The full studio row is carried so completion actions can rebuild the live
// onboarding model server-side (getOnboardingSignals needs the studio, not just
// its id) rather than trusting the client's claim that setup is finished.
type OwnerStudio = Awaited<
  ReturnType<typeof getCurrentPractitionerWithStudio>
>["studio"];
type OwnerCtx = {
  studioId: string;
  practitionerId: string;
  // The authenticated user id, resolved server-side from the session — passed to
  // the service-role completion/celebration commands (never from the browser).
  userId: string;
  studio: OwnerStudio;
};

const NOT_ALLOWED: OnboardingActionResult = {
  ok: false,
  error: "not_allowed",
};

async function requireOnboardingOwner(): Promise<OwnerCtx | null> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") return null;
  if (studio.onboarding_v2_enabled !== true) return null; // fail closed
  if (!practitioner.user_id) return null; // an active owner maps to an auth user
  return {
    studioId: studio.id,
    practitionerId: practitioner.id,
    userId: practitioner.user_id,
    studio,
  };
}

// Rebuild the authoritative onboarding model from REAL signals + the persisted
// row — the same assembly the dashboard renders. Completion decisions are made
// from this, never from the client, so a forged "I'm done" call cannot mark an
// unbookable studio complete or fire the celebration early. (First-transition
// detection is NOT read here — it is the atomic result of the completion RPC.)
async function loadLiveModel(ctx: OwnerCtx): Promise<OnboardingModel> {
  const [signals, row] = await Promise.all([
    getOnboardingSignals(ctx.studio),
    getOnboardingRow(ctx.studioId),
  ]);
  return buildOnboardingModel(signals, toPersisted(row));
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

// Acknowledge the success step -> onboarding complete + wizard_completed dispatch.
// Server-authoritative and TRUSTED-SERVER-ONLY: (1) resolve the authenticated
// user + active owner membership; (2) rebuild the live model; (3) reject unless
// the required data steps are ACTUALLY green (a client that calls this early — or
// a replayed/forged request — cannot stamp completion on an unbookable studio);
// (4) call the service-role admin_complete_onboarding command through the admin
// client (which re-verifies ownership + flag and does the atomic completed_at
// CAS). The analytics DISPATCH is scheduled once — only when THIS call performed
// the first transition (the loser of two concurrent calls gets transitioned=false
// and schedules nothing). Analytics are best-effort (fire-and-forget, no outbox),
// so this guarantees one dispatch is scheduled, not one durable delivery.
export async function completeOnboardingAction(): Promise<OnboardingActionResult> {
  const ctx = await requireOnboardingOwner();
  if (!ctx) return NOT_ALLOWED;

  const model = await loadLiveModel(ctx);
  if (!model.requiredComplete) {
    // Setup isn't actually finished — refuse to record completion.
    return { ok: false, error: "not_ready" };
  }

  const res = await completeOnboarding(ctx.userId, ctx.studioId);
  if (!res.ok) {
    // Fixed owner-facing code — never the raw DB error (bounded marker logged
    // inside completeOnboarding).
    return { ok: false, error: "complete_failed" };
  }

  // Schedule the analytics dispatch only when THIS call performed the atomic
  // first transition.
  if (res.transitioned) {
    captureServerEvent({
      actor: { kind: "user", id: ctx.practitionerId },
      event: "onboarding_wizard_completed",
      properties: { studio_id: ctx.studioId },
    });
  }

  revalidatePath("/dashboard");
  return { ok: true };
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

// The one-time celebration has been shown — never fire it again. Guarded by the
// live model: the celebration is only ever suppressible once required setup is
// genuinely green (a stray call on an incomplete studio must NOT consume the
// one-time stamp, or the owner would never see their celebration). The stamp
// itself is a TRUSTED-SERVER-ONLY, stamp-once command (celebrated_at is a
// protected field), so a legitimate repeat is a harmless no-op.
export async function markCelebrationShownAction(): Promise<OnboardingActionResult> {
  const ctx = await requireOnboardingOwner();
  if (!ctx) return NOT_ALLOWED;

  const model = await loadLiveModel(ctx);
  if (!model.requiredComplete) {
    return { ok: false, error: "not_ready" };
  }

  const res = await markCelebrated(ctx.userId, ctx.studioId);
  if (!res.ok) return { ok: false, error: "celebrate_failed" };
  revalidatePath("/dashboard");
  return { ok: true };
}
