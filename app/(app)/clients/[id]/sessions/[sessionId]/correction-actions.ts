"use server";

import { revalidatePath } from "next/cache";
import { randomUUID, createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { recordOpsAlert } from "@/lib/ops/alerts";

// Clinical Record — Phase 2. Amend / correct a FINALIZED session via the trusted,
// atomic SECURITY DEFINER RPCs (migration 0120). Actor/studio/timestamp/version are
// all server/DB-derived; nothing here is trusted from the client except ids, the
// reason, and the (validated, allow-listed) correction payload. Gated by the
// studio-scoped `clinical_corrections_enabled` flag (default OFF); the RPC is
// authoritative — these checks are UX only.
//
// DIAGNOSTICS (PR: amendment-path reliability): every request carries a
// correlation id; each stage is logged with SAFE operational metadata only (never
// body/reason/clinical values/PHI). Unexpected infrastructure errors raise an
// ops-alert; ordinary user validation errors do not. The result is an explicit
// discriminated union that ALWAYS carries `requestId` so a UI failure can be
// correlated with the server log. RPC success is verified against the persisted
// row before reporting success (an RPC that "returns success" but leaves no row is
// treated as an inconsistency, not a success).

export type ClinicalActionErrorType =
  | "validation"
  | "flag_off"
  | "auth"
  | "not_found"
  | "rpc_error"
  | "inconsistent"
  | "unexpected";

export type AmendResult =
  | { ok: true; amendmentId: string; contentHash: string; requestId: string }
  | { ok: false; error: string; errorType: ClinicalActionErrorType; requestId: string };

export type CorrectResult =
  | { ok: true; snapshotId: string; newVersion: number; contentHash: string; requestId: string }
  | { ok: false; error: string; errorType: ClinicalActionErrorType; requestId: string };

// --- safe diagnostics helpers (no PHI) -------------------------------------

// A one-way, non-reversible short suffix of an id — enough to correlate a UI
// failure with the server log without writing the raw id.
function idSuffix(id: string | null | undefined): string {
  if (!id) return "none";
  return createHash("sha256").update(id).digest("hex").slice(0, 10);
}

type Stage =
  | "received"
  | "validated"
  | "authz_started"
  | "authz_passed"
  | "rpc_requested"
  | "rpc_error"
  | "rpc_success"
  | "persistence_verified"
  | "revalidated"
  | "inconsistent"
  | "unexpected";

// Structured, PHI-free operational log. NEVER receives body/reason/clinical
// values/client names/snapshot JSON.
function logStage(
  action: string,
  requestId: string,
  stage: Stage,
  extra?: Record<string, string | number | boolean | null | undefined>,
): void {
  console.log(
    JSON.stringify({ event: "clinical_action", action, requestId, stage, ...extra }),
  );
}

// PostgREST/Postgres error message, truncated. These are structural/validation
// messages (no PHI), but truncate defensively for the log.
function safeErr(message: string | null | undefined): string {
  return (message ?? "").slice(0, 300);
}

// A plpgsql `raise ... using errcode = 'check_violation'` surfaces as code 23514.
// Those are the RPC's own SAFE, human validation messages (e.g. "A reason is
// required", "Session is not finalized"), fine to show the practitioner. Every
// other code is treated as an infrastructure/integration error (generic message +
// ops-alert), never leaking a raw driver string to the UI.
function isBusinessRaise(code: string | null | undefined): boolean {
  return code === "23514";
}

// ---------------------------------------------------------------------------
export async function amendSessionAction(formData: FormData): Promise<AmendResult> {
  const requestId = randomUUID();
  const action = "amend_finalized_session";
  const fail = (error: string, errorType: ClinicalActionErrorType): AmendResult => ({
    ok: false,
    error,
    errorType,
    requestId,
  });
  try {
    logStage(action, requestId, "received");
    const sessionId = formData.get("session_id");
    const clientId = formData.get("client_id");
    const snapshotId = formData.get("applies_to_snapshot_id");
    const amendmentType = formData.get("amendment_type");
    const reason = formData.get("reason");
    const body = formData.get("body");
    if (typeof sessionId !== "string" || !sessionId) return fail("Missing session.", "validation");
    if (typeof clientId !== "string" || !clientId) return fail("Missing client.", "validation");
    if (typeof snapshotId !== "string" || !snapshotId) return fail("Missing version to amend.", "validation");
    if (typeof amendmentType !== "string" || !amendmentType) return fail("Choose an amendment type.", "validation");
    if (typeof reason !== "string" || reason.trim().length === 0) return fail("A reason is required.", "validation");
    if (typeof body !== "string" || body.trim().length === 0) return fail("Add the information you want to append.", "validation");
    logStage(action, requestId, "validated", {
      sessionSuffix: idSuffix(sessionId),
      amendmentType,
    });

    // --- authorization (never trust the client) ---
    logStage(action, requestId, "authz_started");
    let studioId: string;
    let active: boolean;
    let flagOn: boolean;
    try {
      const { practitioner, studio } = await getCurrentPractitionerWithStudio();
      studioId = studio.id;
      active = practitioner.active;
      flagOn = studio.clinical_corrections_enabled === true;
    } catch (e) {
      logStage(action, requestId, "unexpected", {
        errorCode: "authz_lookup_failed",
        error: safeErr(e instanceof Error ? e.message : String(e)),
      });
      await recordOpsAlert({
        severity: "warning",
        event: "clinical_amend_authz_failed",
        message: `Amendment authorization lookup failed (req ${requestId})`,
        route: "amendSessionAction",
        safeDetails: { requestId },
      });
      return fail("We couldn't verify your studio access. Nothing was saved.", "auth");
    }
    if (!active) return fail("Inactive practitioners cannot amend records.", "auth");
    if (!flagOn) return fail("Corrections & amendments are not enabled for this studio yet.", "flag_off");
    logStage(action, requestId, "authz_passed", { studioSuffix: idSuffix(studioId) });

    // --- trusted RPC (via PostgREST, the real application path) ---
    const supabase = await createClient();
    logStage(action, requestId, "rpc_requested");
    const { data, error } = await supabase.rpc("amend_finalized_session", {
      p_session_id: sessionId,
      p_applies_to_snapshot_id: snapshotId,
      p_amendment_type: amendmentType,
      p_reason: reason,
      p_body: body,
      p_structured_addition: null,
    });
    if (error) {
      const business = isBusinessRaise(error.code);
      logStage(action, requestId, "rpc_error", {
        errorCode: error.code ?? "unknown",
        business,
        error: safeErr(error.message),
      });
      if (!business) {
        await recordOpsAlert({
          severity: "warning",
          event: "clinical_amend_rpc_error",
          message: `Amendment RPC failed code=${error.code ?? "?"} (req ${requestId})`,
          studioId,
          route: "amendSessionAction",
          safeDetails: { requestId, code: error.code ?? null },
        });
      }
      return fail(
        business
          ? error.message
          : "The amendment couldn't be saved right now. Nothing was saved — please try again or contact support with the reference below.",
        "rpc_error",
      );
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.amendment_id !== "string") {
      logStage(action, requestId, "inconsistent", { note: "rpc_ok_no_row" });
      await recordOpsAlert({
        severity: "warning",
        event: "clinical_amend_inconsistent",
        message: `Amendment RPC returned no row (req ${requestId})`,
        studioId,
        route: "amendSessionAction",
        safeDetails: { requestId },
      });
      return fail("The amendment did not return a result. Nothing was saved.", "inconsistent");
    }
    logStage(action, requestId, "rpc_success", { amendmentSuffix: idSuffix(row.amendment_id) });

    // Verify the row actually persisted (an RPC that reports success but leaves no
    // discoverable row is an inconsistency, NOT a success).
    const { count, error: verifyErr } = await supabase
      .from("clinical_record_amendments")
      .select("id", { count: "exact", head: true })
      .eq("id", row.amendment_id);
    if (verifyErr || (count ?? 0) < 1) {
      logStage(action, requestId, "inconsistent", { note: "row_not_found_after_insert" });
      await recordOpsAlert({
        severity: "warning",
        event: "clinical_amend_inconsistent",
        message: `Amendment not found after insert (req ${requestId})`,
        studioId,
        route: "amendSessionAction",
        safeDetails: { requestId },
      });
      return fail(
        "We couldn't confirm the amendment was saved. Check the history before retrying.",
        "inconsistent",
      );
    }
    logStage(action, requestId, "persistence_verified");

    revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
    logStage(action, requestId, "revalidated");
    return {
      ok: true,
      amendmentId: row.amendment_id as string,
      contentHash: (row.content_hash as string) ?? "",
      requestId,
    };
  } catch (e) {
    logStage(action, requestId, "unexpected", {
      error: safeErr(e instanceof Error ? e.message : String(e)),
    });
    await recordOpsAlert({
      severity: "warning",
      event: "clinical_amend_unexpected",
      message: `Amendment unexpected error (req ${requestId})`,
      route: "amendSessionAction",
      safeDetails: { requestId },
    });
    return { ok: false, error: "Something went wrong. Nothing was saved.", errorType: "unexpected", requestId };
  }
}

// ---------------------------------------------------------------------------
export async function correctSessionAction(formData: FormData): Promise<CorrectResult> {
  const requestId = randomUUID();
  const action = "correct_finalized_session";
  const fail = (error: string, errorType: ClinicalActionErrorType): CorrectResult => ({
    ok: false,
    error,
    errorType,
    requestId,
  });
  try {
    logStage(action, requestId, "received");
    const sessionId = formData.get("session_id");
    const clientId = formData.get("client_id");
    const expectedVersionRaw = formData.get("expected_record_version");
    const reason = formData.get("reason");
    const payloadRaw = formData.get("payload");
    if (typeof sessionId !== "string" || !sessionId) return fail("Missing session.", "validation");
    if (typeof clientId !== "string" || !clientId) return fail("Missing client.", "validation");
    if (typeof reason !== "string" || reason.trim().length === 0) return fail("A correction reason is required.", "validation");
    const expectedVersion =
      typeof expectedVersionRaw === "string" && expectedVersionRaw.trim() !== ""
        ? Number(expectedVersionRaw)
        : null;
    if (expectedVersion === null || Number.isNaN(expectedVersion)) {
      return fail("Missing the current version (concurrency token).", "validation");
    }
    let payload: unknown;
    try {
      payload = typeof payloadRaw === "string" ? JSON.parse(payloadRaw) : null;
    } catch {
      return fail("Invalid correction payload.", "validation");
    }
    if (!payload || typeof payload !== "object" || Object.keys(payload).length === 0) {
      return fail("Select at least one field to correct.", "validation");
    }
    logStage(action, requestId, "validated", { sessionSuffix: idSuffix(sessionId), expectedVersion });

    logStage(action, requestId, "authz_started");
    let studioId: string;
    let active: boolean;
    let flagOn: boolean;
    try {
      const { practitioner, studio } = await getCurrentPractitionerWithStudio();
      studioId = studio.id;
      active = practitioner.active;
      flagOn = studio.clinical_corrections_enabled === true;
    } catch (e) {
      logStage(action, requestId, "unexpected", {
        errorCode: "authz_lookup_failed",
        error: safeErr(e instanceof Error ? e.message : String(e)),
      });
      await recordOpsAlert({
        severity: "warning",
        event: "clinical_correct_authz_failed",
        message: `Correction authorization lookup failed (req ${requestId})`,
        route: "correctSessionAction",
        safeDetails: { requestId },
      });
      return fail("We couldn't verify your studio access. Nothing was saved.", "auth");
    }
    if (!active) return fail("Inactive practitioners cannot correct records.", "auth");
    if (!flagOn) return fail("Corrections & amendments are not enabled for this studio yet.", "flag_off");
    logStage(action, requestId, "authz_passed", { studioSuffix: idSuffix(studioId) });

    const supabase = await createClient();
    logStage(action, requestId, "rpc_requested");
    const { data, error } = await supabase.rpc("correct_finalized_session", {
      p_session_id: sessionId,
      p_expected_record_version: expectedVersion,
      p_reason: reason,
      p_payload: payload,
    });
    if (error) {
      const business = isBusinessRaise(error.code);
      logStage(action, requestId, "rpc_error", {
        errorCode: error.code ?? "unknown",
        business,
        error: safeErr(error.message),
      });
      if (!business) {
        await recordOpsAlert({
          severity: "warning",
          event: "clinical_correct_rpc_error",
          message: `Correction RPC failed code=${error.code ?? "?"} (req ${requestId})`,
          studioId,
          route: "correctSessionAction",
          safeDetails: { requestId, code: error.code ?? null },
        });
      }
      return fail(
        business
          ? error.message
          : "The correction couldn't be saved right now. Nothing was saved — please try again or contact support with the reference below.",
        "rpc_error",
      );
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.snapshot_id !== "string") {
      logStage(action, requestId, "inconsistent", { note: "rpc_ok_no_row" });
      await recordOpsAlert({
        severity: "warning",
        event: "clinical_correct_inconsistent",
        message: `Correction RPC returned no row (req ${requestId})`,
        studioId,
        route: "correctSessionAction",
        safeDetails: { requestId },
      });
      return fail("The correction did not return a result. Nothing was saved.", "inconsistent");
    }
    logStage(action, requestId, "rpc_success", { snapshotSuffix: idSuffix(row.snapshot_id) });

    revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
    revalidatePath(`/clients/${clientId}`);
    logStage(action, requestId, "revalidated");
    return {
      ok: true,
      snapshotId: row.snapshot_id as string,
      newVersion: row.new_version as number,
      contentHash: (row.content_hash as string) ?? "",
      requestId,
    };
  } catch (e) {
    logStage(action, requestId, "unexpected", {
      error: safeErr(e instanceof Error ? e.message : String(e)),
    });
    await recordOpsAlert({
      severity: "warning",
      event: "clinical_correct_unexpected",
      message: `Correction unexpected error (req ${requestId})`,
      route: "correctSessionAction",
      safeDetails: { requestId },
    });
    return { ok: false, error: "Something went wrong. Nothing was saved.", errorType: "unexpected", requestId };
  }
}
