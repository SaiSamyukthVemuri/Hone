"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

// Clinical Record — Phase 2. Amend / correct a FINALIZED session via the trusted,
// atomic SECURITY DEFINER RPCs (migration 0120). Actor/studio/timestamp/version are
// all server/DB-derived; nothing here is trusted from the client except ids, the
// reason, and the (validated, allow-listed) correction payload. Gated by the
// studio-scoped `clinical_corrections_enabled` flag (default OFF); the RPC is
// authoritative — these checks are UX only.

export type AmendResult =
  | { ok: true; amendmentId: string; contentHash: string }
  | { ok: false; error: string };

export type CorrectResult =
  | { ok: true; snapshotId: string; newVersion: number; contentHash: string }
  | { ok: false; error: string };

async function guardEnabled(): Promise<{ error: string } | null> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { error: "Inactive practitioners cannot amend or correct records." };
  }
  if (!studio.clinical_corrections_enabled) {
    return { error: "Corrections & amendments are not enabled for this studio yet." };
  }
  return null;
}

export async function amendSessionAction(formData: FormData): Promise<AmendResult> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const snapshotId = formData.get("applies_to_snapshot_id");
  const amendmentType = formData.get("amendment_type");
  const reason = formData.get("reason");
  const body = formData.get("body");
  if (typeof sessionId !== "string" || !sessionId) return { ok: false, error: "Missing session." };
  if (typeof clientId !== "string" || !clientId) return { ok: false, error: "Missing client." };
  if (typeof snapshotId !== "string" || !snapshotId) return { ok: false, error: "Missing version." };
  if (typeof amendmentType !== "string" || !amendmentType) return { ok: false, error: "Missing amendment type." };
  if (typeof reason !== "string" || reason.trim().length === 0) return { ok: false, error: "A reason is required." };
  if (typeof body !== "string" || body.trim().length === 0) return { ok: false, error: "Add the information you want to append." };

  const guard = await guardEnabled();
  if (guard) return { ok: false, error: guard.error };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("amend_finalized_session", {
    p_session_id: sessionId,
    p_applies_to_snapshot_id: snapshotId,
    p_amendment_type: amendmentType,
    p_reason: reason,
    p_body: body,
    p_structured_addition: null,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, error: "Amendment returned no result." };

  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  return { ok: true, amendmentId: row.amendment_id as string, contentHash: row.content_hash as string };
}

export async function correctSessionAction(formData: FormData): Promise<CorrectResult> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const expectedVersionRaw = formData.get("expected_record_version");
  const reason = formData.get("reason");
  const payloadRaw = formData.get("payload");
  if (typeof sessionId !== "string" || !sessionId) return { ok: false, error: "Missing session." };
  if (typeof clientId !== "string" || !clientId) return { ok: false, error: "Missing client." };
  if (typeof reason !== "string" || reason.trim().length === 0) return { ok: false, error: "A correction reason is required." };
  const expectedVersion =
    typeof expectedVersionRaw === "string" && expectedVersionRaw.trim() !== ""
      ? Number(expectedVersionRaw)
      : null;
  if (expectedVersion === null || Number.isNaN(expectedVersion)) {
    return { ok: false, error: "Missing the current version (concurrency token)." };
  }
  let payload: unknown;
  try {
    payload = typeof payloadRaw === "string" ? JSON.parse(payloadRaw) : null;
  } catch {
    return { ok: false, error: "Invalid correction payload." };
  }
  if (!payload || typeof payload !== "object" || Object.keys(payload).length === 0) {
    return { ok: false, error: "Select at least one field to correct." };
  }

  const guard = await guardEnabled();
  if (guard) return { ok: false, error: guard.error };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("correct_finalized_session", {
    p_session_id: sessionId,
    p_expected_record_version: expectedVersion,
    p_reason: reason,
    p_payload: payload,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, error: "Correction returned no result." };

  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
  return {
    ok: true,
    snapshotId: row.snapshot_id as string,
    newVersion: row.new_version as number,
    contentHash: row.content_hash as string,
  };
}
