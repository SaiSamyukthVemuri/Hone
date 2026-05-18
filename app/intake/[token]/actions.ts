"use server";

import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyIntakeToken } from "@/lib/intake/tokens";
import { ALL_QUESTION_KEYS, TOTAL_STEPS } from "@/lib/intake/questions";

export type SaveResult = { ok: true } | { ok: false; error: string };

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
  if (lookupErr) return { ok: false, error: lookupErr.message };
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

  const { error: updateErr } = await admin
    .from("client_intake_forms")
    .update({ responses: merged, current_step: step })
    .eq("id", v.intake_id);
  if (updateErr) return { ok: false, error: updateErr.message };

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
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!existing) return { ok: false, error: "Intake not found." };
  if (existing.status === "submitted" || existing.status === "reviewed") {
    return { ok: true };
  }

  const merged = {
    ...((existing.responses as Record<string, unknown>) ?? {}),
    ...responses,
  };

  const { error: updateErr } = await admin
    .from("client_intake_forms")
    .update({
      responses: merged,
      current_step: TOTAL_STEPS,
      status: "submitted",
      submitted_at: new Date().toISOString(),
    })
    .eq("id", v.intake_id);
  if (updateErr) return { ok: false, error: updateErr.message };

  return { ok: true };
}
