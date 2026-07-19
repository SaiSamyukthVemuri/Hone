"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getPostHogClient } from "@/lib/posthog-server";

// Clinical Record — Phase 1. "Finalize & sign" a session: calls the trusted,
// atomic, idempotent SECURITY DEFINER RPC (migration 0119) which builds the
// immutable snapshot, flips the session to 'finalized', and locks the clinical
// content at the DB. Actor/studio/timestamp/version are all server/DB-derived;
// nothing here is trusted from the client except the session/client ids and the
// optimistic-concurrency token. Gated by the studio-scoped feature flag.

export type FinalizeResult =
  | { ok: true; snapshotId: string; versionNo: number; alreadyFinalized: boolean }
  | { ok: false; error: string };

export async function finalizeSessionAction(
  formData: FormData,
): Promise<FinalizeResult> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const expectedVersionRaw = formData.get("record_version");
  if (typeof sessionId !== "string" || !sessionId) {
    return { ok: false, error: "Missing session." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client." };
  }
  const expectedVersion =
    typeof expectedVersionRaw === "string" && expectedVersionRaw.trim() !== ""
      ? Number(expectedVersionRaw)
      : null;

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot finalize records." };
  }
  // Studio-scoped feature flag (default OFF). Never global.
  if (!studio.clinical_finalization_enabled) {
    return {
      ok: false,
      error: "Finalization is not enabled for this studio yet.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("finalize_session", {
    p_session_id: sessionId,
    p_expected_record_version:
      expectedVersion === null || Number.isNaN(expectedVersion)
        ? null
        : expectedVersion,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, error: "Finalization returned no result." };

  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);

  const alreadyFinalized = Boolean(row.already_finalized);

  if (!alreadyFinalized) {
    const posthog = getPostHogClient();
    posthog.capture({
      distinctId: practitioner.id,
      event: "session_finalized",
      properties: { studio_id: studio.id },
    });
    await posthog.flush();
  }

  return {
    ok: true,
    snapshotId: row.snapshot_id as string,
    versionNo: row.version_no as number,
    alreadyFinalized,
  };
}
