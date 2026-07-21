import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import type {
  StudioOnboarding,
  WelcomeEmailStatus,
} from "@/lib/types/database";
import type { OnboardingPersisted, OnboardingStepKey } from "./steps";

// Persisted onboarding-v2 state (public.studio_onboarding). Owner-context reads
// and writes go through the RLS SSR client (member-read / owner-write). The
// provisioning-time welcome-email stamp uses the admin client that the studio-
// creation action already holds (the owner practitioner row does not exist yet
// at that moment), so it introduces NO new service-role call site.

const TABLE = "studio_onboarding";
const COLUMNS =
  "studio_id, status, current_step, completed_steps, skipped_steps, dismissed_at, completed_at, celebrated_at, welcome_email_status, welcome_email_variant, welcome_email_last_sent_at, created_at, updated_at";

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

export function toPersisted(
  row: StudioOnboarding | null,
): OnboardingPersisted {
  return {
    currentStep: row?.current_step ?? "welcome",
    completedSteps: row?.completed_steps ?? [],
    skippedSteps: row?.skipped_steps ?? [],
    dismissedAt: row?.dismissed_at ?? null,
    completedAt: row?.completed_at ?? null,
    celebratedAt: row?.celebrated_at ?? null,
  };
}

// Member-scoped read (RLS). Returns null when there is no row yet.
export async function getOnboardingRow(
  studioId: string,
): Promise<StudioOnboarding | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq("studio_id", studioId)
    .maybeSingle();
  return (data as StudioOnboarding | null) ?? null;
}

// ---------------------------------------------------------------------------
// Owner-context writers. Each upserts on studio_id under owner RLS, so an
// opted-in studio that has no row yet gets one on first interaction. Partial
// upsert: only the provided columns are written; the rest keep defaults (insert)
// or prior values (update).
// ---------------------------------------------------------------------------

type OnboardingPatch = {
  status?: StudioOnboarding["status"];
  current_step?: string;
  completed_steps?: string[];
  skipped_steps?: string[];
  dismissed_at?: string | null;
  completed_at?: string | null;
  celebrated_at?: string | null;
};

async function upsertOwner(
  studioId: string,
  patch: OnboardingPatch,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase
    .from(TABLE)
    .upsert({ studio_id: studioId, ...patch }, { onConflict: "studio_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// Record the resume pointer (the wizard step the owner is currently on).
export async function setCurrentStep(
  studioId: string,
  stepKey: OnboardingStepKey,
): Promise<{ ok: boolean; error?: string }> {
  return upsertOwner(studioId, { current_step: stepKey, status: "in_progress" });
}

// Explicitly advance past a framing step (welcome/done) — records the
// acknowledgement and moves the pointer.
export async function markStepAdvanced(
  studioId: string,
  stepKey: OnboardingStepKey,
  nextStep: OnboardingStepKey,
): Promise<{ ok: boolean; error?: string }> {
  const row = await getOnboardingRow(studioId);
  const completed = uniq([...(row?.completed_steps ?? []), stepKey]);
  return upsertOwner(studioId, {
    completed_steps: completed,
    current_step: nextStep,
    status: "in_progress",
  });
}

// Skip an optional step (payments).
export async function markStepSkipped(
  studioId: string,
  stepKey: OnboardingStepKey,
  nextStep: OnboardingStepKey,
): Promise<{ ok: boolean; error?: string }> {
  const row = await getOnboardingRow(studioId);
  const skipped = uniq([...(row?.skipped_steps ?? []), stepKey]);
  return upsertOwner(studioId, {
    skipped_steps: skipped,
    current_step: nextStep,
    status: "in_progress",
  });
}

// Owner closed the wizard overlay. Progress preserved; re-openable from the
// pinned dashboard card.
export async function dismissOnboarding(
  studioId: string,
): Promise<{ ok: boolean; error?: string }> {
  return upsertOwner(studioId, { dismissed_at: new Date().toISOString() });
}

// Re-open the wizard from the pinned card.
export async function reopenOnboarding(
  studioId: string,
): Promise<{ ok: boolean; error?: string }> {
  return upsertOwner(studioId, { dismissed_at: null, status: "in_progress" });
}

// Acknowledge the success step: required setup is done and the owner finished.
export async function completeOnboarding(
  studioId: string,
): Promise<{ ok: boolean; error?: string }> {
  const row = await getOnboardingRow(studioId);
  const completed = uniq([...(row?.completed_steps ?? []), "done"]);
  return upsertOwner(studioId, {
    status: "completed",
    completed_at: row?.completed_at ?? new Date().toISOString(),
    completed_steps: completed,
  });
}

// The one-time celebration has been shown — never re-fire it.
export async function markCelebrated(
  studioId: string,
): Promise<{ ok: boolean; error?: string }> {
  const row = await getOnboardingRow(studioId);
  if (row?.celebrated_at) return { ok: true };
  return upsertOwner(studioId, {
    celebrated_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Welcome-email helpers (service-role, trusted send adapter). The claim gives
// single-attempt idempotency (concurrent resend / double-click -> one send);
// the status stamp records the send outcome (Sent / Failed) — never a
// "delivered" state (no provider delivery evidence exists). No account-variant
// is recorded: one truthful invitation email serves both new and existing
// accounts.
// ---------------------------------------------------------------------------
export async function claimWelcomeEmailAttempt(
  admin: ReturnType<typeof createAdminClient>,
  studioId: string,
): Promise<boolean> {
  const { data } = await admin.rpc("claim_welcome_email_attempt", {
    p_studio_id: studioId,
  });
  return data === true;
}

export async function stampWelcomeEmailStatus(
  admin: ReturnType<typeof createAdminClient>,
  studioId: string,
  status: WelcomeEmailStatus,
): Promise<void> {
  await admin
    .from(TABLE)
    .upsert(
      { studio_id: studioId, welcome_email_status: status },
      { onConflict: "studio_id" },
    );
}
