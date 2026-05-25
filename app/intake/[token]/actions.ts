"use server";

import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyIntakeToken } from "@/lib/intake/tokens";
import { ALL_QUESTION_KEYS, TOTAL_STEPS } from "@/lib/intake/questions";

export type SaveResult = { ok: true } | { ok: false; error: string };

const INTAKE_GENERIC_ERROR =
  "We couldn't save your intake. Please refresh and try again.";

function logInternalIntakeError(event: string, detail: unknown) {
  try {
    console.error(
      JSON.stringify({ event, detail, timestamp: new Date().toISOString() }),
    );
  } catch {
    console.error(event, detail);
  }
}

function tokenError(kind: "expired" | "malformed" | "bad_signature"): string {
  if (kind === "expired") return "This intake link has expired.";
  return "This intake link is no longer valid.";
}

// Whitelist responses to known question keys (or their `_notes` siblings) so
// a client-side tamper can't inject arbitrary JSON fields.
function sanitizeResponses(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const allowed = new Set(ALL_QUESTION_KEYS);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

export async function saveIntakeStepAction(payload: {
  token: string;
  step: number;
  responses: Record<string, unknown>;
}): Promise<SaveResult> {
  if (!payload.token) return { ok: false, error: "Missing token." };
  const v = verifyIntakeToken(payload.token);
  if (!v.ok) return { ok: false, error: tokenError(v.error) };

  const step = Math.floor(Number(payload.step));
  if (!Number.isFinite(step) || step < 1 || step > TOTAL_STEPS) {
    return { ok: false, error: "Invalid step." };
  }
  const responses = sanitizeResponses(payload.responses);

  const admin = createAdminClient();
  const { data: existing, error: lookupErr } = await admin
    .from("client_intake_forms")
    .select("id, status, responses")
    .eq("id", v.intake_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (lookupErr) {
    logInternalIntakeError("intake_lookup_error", { code: lookupErr.code, message: lookupErr.message });
    return { ok: false, error: INTAKE_GENERIC_ERROR };
  }
  if (!existing) return { ok: false, error: "Intake not found." };
  if (existing.status === "submitted" || existing.status === "reviewed") {
    return { ok: false, error: "This intake has already been submitted." };
  }

  // Merge with what's already saved so a save from step 3 doesn't blow away
  // step 1 answers if the client only sent the latest step's fields.
  const merged = {
    ...((existing.responses as Record<string, unknown>) ?? {}),
    ...responses,
  };

  // Atomic status guard: the UPDATE is conditional on
  // `status = 'in_progress'`. If the form is submitted/reviewed
  // BETWEEN our SELECT above and this UPDATE (race), or under any
  // other status, zero rows update. We do NOT return raw DB errors;
  // the no-rows-updated case returns the same "already submitted"
  // message the SELECT path would have returned.
  const { data: updated, error: updateErr } = await admin
    .from("client_intake_forms")
    .update({ responses: merged, current_step: step })
    .eq("id", v.intake_id)
    .eq("status", "in_progress")
    .is("deleted_at", null)
    .select("id");
  if (updateErr) {
    logInternalIntakeError("intake_save_update_error", { code: updateErr.code, message: updateErr.message });
    return { ok: false, error: INTAKE_GENERIC_ERROR };
  }
  if (!updated || updated.length === 0) {
    // Race-loser branch: the row's status changed under us. Treat
    // as terminal-state save attempt.
    return { ok: false, error: "This intake has already been submitted." };
  }

  return { ok: true };
}

export async function submitIntakeAction(payload: {
  token: string;
  responses: Record<string, unknown>;
}): Promise<SaveResult> {
  if (!payload.token) return { ok: false, error: "Missing token." };
  const v = verifyIntakeToken(payload.token);
  if (!v.ok) return { ok: false, error: tokenError(v.error) };

  const responses = sanitizeResponses(payload.responses);

  const admin = createAdminClient();
  const { data: existing, error: lookupErr } = await admin
    .from("client_intake_forms")
    .select("id, status, responses, studio_id, client_id")
    .eq("id", v.intake_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (lookupErr) {
    logInternalIntakeError("intake_lookup_error", { code: lookupErr.code, message: lookupErr.message });
    return { ok: false, error: INTAKE_GENERIC_ERROR };
  }
  if (!existing) return { ok: false, error: "Intake not found." };
  if (existing.status === "submitted" || existing.status === "reviewed") {
    return { ok: true };
  }

  const merged = {
    ...((existing.responses as Record<string, unknown>) ?? {}),
    ...responses,
  };

  // Atomic status guard: only transition to 'submitted' if the row is
  // still 'in_progress'. Two concurrent submit clicks (e.g. browser
  // double-click on a flaky network) race here; the partial unique
  // index isn't applicable, so we rely on the conditional UPDATE.
  // A loser sees zero rows updated; we treat that as idempotent
  // "already submitted" (returning ok: true mirrors the early-exit
  // SELECT branch above, which also returns ok: true).
  const { data: updated, error: updateErr } = await admin
    .from("client_intake_forms")
    .update({
      responses: merged,
      current_step: TOTAL_STEPS,
      status: "submitted",
      submitted_at: new Date().toISOString(),
    })
    .eq("id", v.intake_id)
    .eq("status", "in_progress")
    .is("deleted_at", null)
    .select("id");
  if (updateErr) {
    logInternalIntakeError("intake_submit_update_error", { code: updateErr.code, message: updateErr.message });
    return { ok: false, error: INTAKE_GENERIC_ERROR };
  }
  if (!updated || updated.length === 0) {
    // Concurrent submit race winner already flipped the row. The
    // form IS submitted on the server — we return ok:true so the
    // browser shows the submitted state, matching the pre-update
    // SELECT branch.
    return { ok: true };
  }

  // Fix 9: pull emergency contact from the intake into the client row so the
  // practitioner does not have to retype it. Only writes to fields that are
  // currently null: a practitioner who has already manually populated them
  // takes precedence over what the client typed at intake.
  await syncEmergencyContactToClient(merged, existing.client_id);

  return { ok: true };
}

async function syncEmergencyContactToClient(
  responses: Record<string, unknown>,
  clientId: string,
): Promise<void> {
  const name = stringOrNull(responses.emergency_contact_name);
  const phone = stringOrNull(responses.emergency_contact_phone);
  if (!name && !phone) return;

  const admin = createAdminClient();
  const { data: client, error: lookupErr } = await admin
    .from("clients")
    .select("emergency_contact_name, emergency_contact_phone")
    .eq("id", clientId)
    .maybeSingle();
  if (lookupErr || !client) {
    if (lookupErr) {
      console.error(
        "Failed to look up client for emergency contact sync:",
        lookupErr.message,
      );
    }
    return;
  }

  const patch: Record<string, string> = {};
  if (name && !client.emergency_contact_name) {
    patch.emergency_contact_name = name;
  }
  if (phone && !client.emergency_contact_phone) {
    patch.emergency_contact_phone = phone;
  }
  if (Object.keys(patch).length === 0) return;

  const { error: updateErr } = await admin
    .from("clients")
    .update(patch)
    .eq("id", clientId);
  if (updateErr) {
    console.error(
      "Failed to sync emergency contact to client:",
      updateErr.message,
    );
  }
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
