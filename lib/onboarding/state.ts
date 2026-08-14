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
  "studio_id, status, current_step, completed_steps, skipped_steps, dismissed_at, completed_at, celebrated_at, welcome_email_status, welcome_email_attempt_id, welcome_email_last_attempted_at, welcome_email_last_sent_at, created_at, updated_at";

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

// Explicitly advance past a framing step (welcome/done), records the
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

// Bounded DB-error marker for the trusted completion/celebration commands.
// NEVER logs the raw Supabase/Postgres error, the studio, the user, or any DB
// text, only onboarding_action_db_error:<op>:<safe_code>.
function logOnboardingDbError(op: "complete" | "celebrate", code: string): void {
  console.error(`onboarding_action_db_error:${op}:${code}`);
}

// Acknowledge the success step: required setup is done and the owner finished.
// TRUSTED-SERVER-ONLY: calls the service-role admin_complete_onboarding command
// through the admin client (the browser cannot reach it). The command re-verifies
// active ownership + the flag and does the atomic completed_at CAS, reporting
// whether THIS call performed the first transition (so the action schedules the
// analytics dispatch exactly once). Never returns the raw DB error.
export async function completeOnboarding(
  userId: string,
  studioId: string,
): Promise<{ ok: boolean; transitioned: boolean }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_complete_onboarding", {
    p_user_id: userId,
    p_studio_id: studioId,
  });
  if (error) {
    logOnboardingDbError("complete", "rpc_failed");
    return { ok: false, transitioned: false };
  }
  return { ok: true, transitioned: data === true };
}

// The one-time celebration has been shown, never re-fire it. TRUSTED-SERVER-ONLY:
// celebrated_at is a protected field (the guard trigger blocks direct browser
// writes), so this calls the service-role admin_mark_onboarding_celebrated command
// (active-owner + flag verified), which stamps celebrated_at exactly once. The
// action gates the call on live required completion. Never returns the raw DB error.
export async function markCelebrated(
  userId: string,
  studioId: string,
): Promise<{ ok: boolean }> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("admin_mark_onboarding_celebrated", {
    p_user_id: userId,
    p_studio_id: studioId,
  });
  if (error) {
    logOnboardingDbError("celebrate", "rpc_failed");
    return { ok: false };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Welcome-email helpers (service-role, trusted send adapter). The claim is an
// attempt-id single-flight lock; the RESULT stamp is a compare-and-set on that
// attempt-id, so a stale attempt can never overwrite a newer retry and status is
// never a "delivered" state (no provider delivery evidence exists). Every
// Supabase { error } is propagated so a DB failure cannot masquerade as success.
// ---------------------------------------------------------------------------

// { attemptId } is set only for the winning caller. attemptId === null with
// error === false means another live attempt is in progress. error === true
// means the claim RPC itself failed (do NOT send).
export type WelcomeEmailClaim = {
  attemptId: string | null;
  error: boolean;
};

export async function claimWelcomeEmailAttempt(
  admin: ReturnType<typeof createAdminClient>,
  studioId: string,
): Promise<WelcomeEmailClaim> {
  const { data, error } = await admin.rpc("claim_welcome_email_attempt", {
    p_studio_id: studioId,
  });
  if (error) return { attemptId: null, error: true };
  return { attemptId: (data as string | null) ?? null, error: false };
}

// Compare-and-set the final result on the current attempt only. Returns whether
// the result was applied (false = superseded by a newer attempt, or a write
// error).
export async function recordWelcomeEmailResult(
  admin: ReturnType<typeof createAdminClient>,
  studioId: string,
  attemptId: string,
  status: Exclude<WelcomeEmailStatus, "sending">,
): Promise<{ applied: boolean; error: boolean }> {
  const { data, error } = await admin.rpc("record_welcome_email_result", {
    p_studio_id: studioId,
    p_attempt_id: attemptId,
    p_status: status,
  });
  if (error) return { applied: false, error: true };
  return { applied: data === true, error: false };
}
