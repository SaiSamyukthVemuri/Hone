"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyIntakeToken } from "@/lib/intake/tokens";
import {
  ALL_QUESTION_KEYS,
  findMissingRequiredAnswers,
  TOTAL_STEPS,
} from "@/lib/intake/questions";
import {
  buildElectrolysisAcknowledgementDraftRecord,
  ELECTROLYSIS_ACKNOWLEDGEMENT,
  normalizeElectrolysisAcknowledgementClaim,
  validateElectrolysisAcknowledgement,
} from "@/lib/intake/acknowledgements";
import { limitTokenRoute, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit/public";
import { recordPractitionerNotification } from "@/lib/notifications/practitioner-notifications";

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

// Collapse ALL token-validation failures (expired / malformed / bad
// signature) into ONE message so the response can't be used to learn
// whether a token was a real-but-aged HMAC vs random garbage. Matches the
// generic-collapse pattern the cancel / reschedule flows already use.
const INTAKE_TOKEN_INVALID =
  "This intake link is no longer valid. Please contact the studio if you need a new one.";

// Whitelist responses to known question keys (or their `_notes` siblings) so
// a client-side tamper can't inject arbitrary JSON fields.
//
// Exactly ONE key outside that set is admitted: the versioned electrolysis
// acknowledgement record (ELECTROLYSIS_ACKNOWLEDGEMENT.id). It is not a
// question, so the whitelist would otherwise strip it and the client's
// assertion about which wording they read could never reach the server.
//
// Admitting it is NOT trusting it. The value is narrowed here to a bounded
// {id, version, wording, accepted} claim — unknown fields dropped, non-
// strings rejected, oversize strings rejected — and NOTHING client-authored
// is ever persisted: the draft path overwrites the claim with a
// server-derived record (below), and the submit path validates the claim by
// exact equality against the canonical constant before doing the same. The
// claim is evidence to check, never content to store.
function sanitizeResponses(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const allowed = new Set(ALL_QUESTION_KEYS);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (allowed.has(key)) out[key] = value;
  }
  const ackClaim = normalizeElectrolysisAcknowledgementClaim(
    (input as Record<string, unknown>)[ELECTROLYSIS_ACKNOWLEDGEMENT.id],
  );
  if (ackClaim) out[ELECTROLYSIS_ACKNOWLEDGEMENT.id] = ackClaim;
  return out;
}

export async function saveIntakeStepAction(payload: {
  token: string;
  step: number;
  responses: Record<string, unknown>;
}): Promise<SaveResult> {
  if (!payload.token) return { ok: false, error: "Missing token." };

  // Rate limit before token verification + DB work. Independent of token
  // validity, fails open when Upstash is unconfigured or down.
  const gate = await limitTokenRoute({
    routeClass: "intake_save",
    token: payload.token,
    headers: await headers(),
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  const v = verifyIntakeToken(payload.token);
  if (!v.ok) return { ok: false, error: INTAKE_TOKEN_INVALID };

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

  // Draft semantics are unchanged: an unticked acknowledgement stays
  // unticked and saving is never refused for it. What IS enforced here is
  // that the stored record's id / version / wording are server-derived, so
  // the only thing a draft can carry from the browser is the boolean. A
  // forged draft save therefore cannot park fabricated acknowledgement text
  // in an in-progress row for the practitioner to read.
  //
  // The claim is written on every save the wizard makes, so unticking the
  // box overwrites the record rather than leaving a stale accepted one
  // behind — the merge above is a spread and would otherwise preserve it.
  const draftAck = buildElectrolysisAcknowledgementDraftRecord(
    normalizeElectrolysisAcknowledgementClaim(
      merged[ELECTROLYSIS_ACKNOWLEDGEMENT.id],
    ),
  );
  if (draftAck) merged[ELECTROLYSIS_ACKNOWLEDGEMENT.id] = draftAck;

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

  // Rate limit before token verification + DB write. Independent of token
  // validity, fails open. No submit occurs when limited.
  const gate = await limitTokenRoute({
    routeClass: "intake_submit",
    token: payload.token,
    headers: await headers(),
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  const v = verifyIntakeToken(payload.token);
  if (!v.ok) return { ok: false, error: INTAKE_TOKEN_INVALID };

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

  // Server-side required-fields check. Runs ONLY on this submit/write
  // path; already-submitted intakes (handled by the early-exit branch
  // above) are not re-validated when viewed. A client that bypassed
  // the wizard's per-step validateStep (or a future API caller) is
  // blocked here. Conditionally-hidden questions don't count as
  // missing; findMissingRequiredAnswers honors the same conditional
  // predicate the wizard uses.
  const missing = findMissingRequiredAnswers(merged);
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        "Please answer all required questions before submitting your intake.",
    };
  }

  // Versioned electrolysis acknowledgement — the independent server gate.
  //
  // This runs BELOW the already-submitted early return (so a legacy intake
  // submitted before this acknowledgement existed is never re-validated,
  // never rewritten, and never retroactively marked incomplete) and ABOVE
  // the UPDATE (so a rejection performs zero writes).
  //
  // It trusts nothing from the browser: not the disabled-button state, not
  // the client-side validation, and not the submitted wording version. Two
  // independent keys must agree — the required checkbox must be exactly
  // `true`, AND the claim must match the canonical id, version and wording
  // by exact equality. A forged payload with a wrong id, an unknown or
  // downgraded version, altered wording, or `accepted: false` is refused
  // here rather than quietly corrected.
  //
  // What gets stored is rebuilt from the constant with a server-stamped
  // `accepted_at`; the validated claim is evidence that the client's browser
  // rendered this exact text, never the bytes we persist.
  const ack = validateElectrolysisAcknowledgement(
    merged,
    new Date().toISOString(),
  );
  if (!ack.ok) {
    // Two calm, public-safe messages. The stale-wording branch has to be
    // actionable: a client whose tab was open across a wording change is
    // legitimately in this state and needs to be told to reload. Neither
    // message names a key, a version, or a database detail.
    const staleWording =
      ack.reason === "unknown_version" ||
      ack.reason === "wording_mismatch" ||
      ack.reason === "wrong_id";
    return {
      ok: false,
      error: staleWording
        ? "The electrolysis acknowledgement has been updated. Please refresh this page and confirm the current wording before submitting."
        : "Please confirm the electrolysis acknowledgement before submitting your intake.",
    };
  }
  merged[ELECTROLYSIS_ACKNOWLEDGEMENT.id] = ack.record;

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

  // Populate the client profile from the intake submission so the
  // practitioner doesn't have to retype any of it. Field-by-field rules
  // below preserve practitioner-entered values where present and never
  // delete allergies. Failures inside the sync are logged and swallowed;
  // the intake submit is the source of truth and is not rolled back.
  await syncIntakeToClient(merged, existing.client_id);

  // Fire-and-forget in-app notification for the studio (PR #164 helper,
  // studio-wide visibility). This runs ONLY in this winner branch: the
  // early-exit (already submitted/reviewed) and the race-loser (zero rows
  // updated) branches above both return before reaching here, so a
  // resubmit / double-click / retry never double-notifies — the atomic
  // status transition is the dedup. The helper never throws and never rolls
  // back the (already-committed) submit; an insert failure logs to
  // ops_alerts. The payload carries ONLY the client name (already shown to
  // studio members) + safe text — never intake answers, and never the intake
  // token; href is the authenticated intake review page.
  const { data: client } = await admin
    .from("clients")
    .select("name")
    .eq("id", existing.client_id)
    .eq("studio_id", existing.studio_id)
    .maybeSingle();
  const clientName =
    typeof client?.name === "string" ? client.name.trim() : "";
  recordPractitionerNotification({
    studioId: existing.studio_id,
    practitionerId: null,
    eventType: "intake_submitted",
    title: "Intake submitted",
    body: clientName
      ? `${clientName} submitted an intake form.`
      : "A client submitted an intake form.",
    appointmentId: null,
    clientId: existing.client_id,
    href: `/clients/${existing.client_id}/intake`,
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// syncIntakeToClient
// ---------------------------------------------------------------------------
// Field rules (Chloe feedback):
//
//   emergency_contact_name / _phone, date_of_birth, pronouns, address:
//     FILL-ONLY-IF-NULL. A practitioner who has already manually populated
//     a field takes precedence over the intake answer; we never overwrite.
//
//   allergies: APPEND-ONLY. Never overwrite, never delete. If the client
//     row already has an allergies string, the intake's allergy summary
//     is appended below a dated "From client intake" marker so the
//     practitioner can see both the original record and the new intake
//     answers without losing either. The EpiPen flag (requires_epipen)
//     is the first line of the intake block so it stays prominent on
//     append; the broader allergy display in the client profile already
//     renders this in a red section, and the intake review page also
//     keeps its own dedicated EpiPen banner.
// ---------------------------------------------------------------------------
async function syncIntakeToClient(
  responses: Record<string, unknown>,
  clientId: string,
): Promise<void> {
  const emergencyName = stringOrNull(responses.emergency_contact_name);
  const emergencyPhone = stringOrNull(responses.emergency_contact_phone);
  const dob = stringOrNull(responses.date_of_birth);
  const pronouns = stringOrNull(responses.pronouns);
  const address = stringOrNull(responses.address);
  const intakeAllergyText = buildIntakeAllergyText(responses);

  // Bail early if the intake had nothing to contribute to the profile.
  if (
    !emergencyName &&
    !emergencyPhone &&
    !dob &&
    !pronouns &&
    !address &&
    !intakeAllergyText
  ) {
    return;
  }

  const admin = createAdminClient();
  const { data: client, error: lookupErr } = await admin
    .from("clients")
    .select(
      "emergency_contact_name, emergency_contact_phone, date_of_birth, pronouns, address, allergies",
    )
    .eq("id", clientId)
    .maybeSingle();
  if (lookupErr || !client) {
    if (lookupErr) {
      console.error(
        "Failed to look up client for intake sync:",
        lookupErr.message,
      );
    }
    return;
  }

  const patch: Record<string, string> = {};
  if (emergencyName && !client.emergency_contact_name) {
    patch.emergency_contact_name = emergencyName;
  }
  if (emergencyPhone && !client.emergency_contact_phone) {
    patch.emergency_contact_phone = emergencyPhone;
  }
  if (dob && !client.date_of_birth) {
    patch.date_of_birth = dob;
  }
  if (pronouns && !client.pronouns) {
    patch.pronouns = pronouns;
  }
  if (address && !client.address) {
    patch.address = address;
  }
  if (intakeAllergyText) {
    // Append-only merge. If existing.allergies is empty, write the intake
    // summary alone. Otherwise concatenate beneath a dated marker so the
    // practitioner can see "the original record said X, the intake added
    // Y" and reconcile manually; we never auto-resolve.
    const existingAllergies = typeof client.allergies === "string"
      ? client.allergies.trim()
      : "";
    if (existingAllergies.length === 0) {
      patch.allergies = intakeAllergyText;
    } else {
      const dateLabel = formatTodayLocal();
      patch.allergies = `${existingAllergies}\n\nFrom client intake (${dateLabel}):\n${intakeAllergyText}`;
    }
  }
  if (Object.keys(patch).length === 0) return;

  const { error: updateErr } = await admin
    .from("clients")
    .update(patch)
    .eq("id", clientId);
  if (updateErr) {
    console.error("Failed to sync intake to client:", updateErr.message);
  }
}

// Builds a single human-readable allergy summary from the intake's allergy
// answers. Returns null when the client reported no relevant allergies.
// The EpiPen line is intentionally first so it stays prominent on append.
function buildIntakeAllergyText(
  responses: Record<string, unknown>,
): string | null {
  const lines: string[] = [];
  const hasAllergies = responses.has_allergies === "yes";
  const requiresEpipen = responses.requires_epipen === "yes";
  const allergyNotes = stringOrNull(responses.has_allergies_notes);
  const metalAllergy = responses.metal_allergy === "yes";
  const metalTypes = Array.isArray(responses.metal_allergy_types)
    ? (responses.metal_allergy_types as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  const metalOther = stringOrNull(responses.metal_allergy_other_text);
  const latexAllergy = responses.latex_allergy === "yes";
  const anestheticAllergy = responses.anesthetic_allergy === "yes";

  if (requiresEpipen) {
    lines.push("EpiPen required.");
  }
  if (hasAllergies && allergyNotes) {
    lines.push(`Allergies: ${allergyNotes}`);
  } else if (hasAllergies) {
    lines.push("Allergies reported (no details provided).");
  }
  if (metalAllergy) {
    const detail: string[] = [];
    if (metalTypes.length > 0) detail.push(metalTypes.join(", "));
    if (metalOther) detail.push(metalOther);
    lines.push(
      detail.length > 0
        ? `Metal allergy: ${detail.join("; ")}`
        : "Metal allergy.",
    );
  }
  if (latexAllergy) lines.push("Latex allergy.");
  if (anestheticAllergy) lines.push("Topical anesthetic allergy.");

  if (lines.length === 0) return null;
  return lines.join("\n");
}

// Format today as a calm "YYYY-MM-DD" marker for the appended allergy
// block. Server-local; the precise zone doesn't matter for a readability
// marker on a manually-curated text field.
function formatTodayLocal(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).padStart(4, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
