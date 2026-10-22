"use server";

import { isDeepStrictEqual } from "node:util";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyIntakeToken } from "@/lib/intake/tokens";
import {
  findInvalidChoiceAnswers,
  getQuestionByKey,
  findMissingRequiredAnswers,
  isValidIntakeDate,
  type Step,
} from "@/lib/intake/questions";
import { questionnaireForRow, QUESTIONNAIRE_UNAVAILABLE } from "@/lib/intake/questionnaire";
import { sanitizeQuestionResponses } from "@/lib/intake/responses";
import {
  INTAKE_CONSENT_RESPONSES,
  normalizeIntakeConsentClaims,
} from "@/lib/intake/consent-forms";
import {
  buildIntakeConsentDraftRecord,
  validateIntakeConsentResponses,
} from "@/lib/intake/consent-gate";
import { limitTokenRoute, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit/public";
import { recordPractitionerNotification } from "@/lib/notifications/practitioner-notifications";
import { intakeRevision, INTAKE_CONFLICT, INTAKE_TERMINAL } from "@/lib/intake/revision";
import { writeIntakeRevision } from "@/lib/intake/write-revision";

export type SaveResult = { ok: true; revision: string } | { ok: false; error: string; code?: "conflict" | "terminal" | "unavailable" };


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
// Exactly ONE key outside that set is admitted: the live consent responses
// claim (INTAKE_CONSENT_RESPONSES.id). It is not a question, so the whitelist
// would otherwise strip it and the client's assertion about which form text
// they read could never reach the server.
//
// Admitting it is NOT trusting it. The value is narrowed here to a bounded
// per-form {template_id, form_type, rendered_template_hash, response} claim,
// and NOTHING client-authored is persisted: every stored snapshot field is
// re-derived from the studio's own database row (lib/intake/consent-gate.ts).
// The claim is evidence to check, never content to store.
//
// RETIRED (#518): there used to be a SECOND carve-out here for the versioned
// electrolysis acknowledgement record. Now that the acknowledgement is no
// longer collected, that carve-out would be an orphaned forgery channel: a
// browser-authorable path to a reserved key that no server gate validates any
// more. It is deliberately GONE, not merely unused, so:
//
//   * a new `electrolysis_acknowledgement` cannot be authored from a browser;
//   * a HISTORICAL one cannot be overwritten (the key is stripped on the way
//     in, and the server merge is `{...stored, ...incoming}`, so what is
//     already stored survives untouched);
//   * `ack_electrolysis_nature` is likewise stripped, because retiring the
//     question removed it from ALL_QUESTION_KEYS.
//
// Historical evidence stays readable; no new evidence is accepted.
function sanitizeResponses(input: unknown, steps: ReadonlyArray<Step>): Record<string, unknown> {
  const out = sanitizeQuestionResponses(input, steps);
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const consentClaims = normalizeIntakeConsentClaims(
    (input as Record<string, unknown>)[INTAKE_CONSENT_RESPONSES.id],
  );
  if (consentClaims) out[INTAKE_CONSENT_RESPONSES.id] = consentClaims;
  return out;
}

export async function saveIntakeStepAction(payload: {
  token: string;
  expectedRevision?: unknown;
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
  if (!Number.isFinite(step) || step < 1) {
    return { ok: false, error: "Invalid step." };
  }
  const expectedRevision = intakeRevision(payload.expectedRevision);
  if (expectedRevision === null) return { ok: false, code: "conflict", error: INTAKE_CONFLICT };

  const admin = createAdminClient();
  const { data: existing, error: lookupErr } = await admin
    .from("client_intake_forms")
    // studio_id is needed to re-resolve the studio's own live consent
    // templates when normalising a draft consent response below. It is read
    // from the intake row the verified token addresses, never from the
    // request, so a claim can only ever be checked against ITS OWN studio's
    // forms.
    .select("id, status, responses, studio_id, client_id, revision, questionnaire_snapshot")
    .eq("id", v.intake_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (lookupErr) {
    logInternalIntakeError("intake_lookup_error", { code: lookupErr.code, message: lookupErr.message });
    return { ok: false, error: INTAKE_GENERIC_ERROR };
  }
  if (!existing) return { ok: false, error: "Intake not found." };
  if (existing.status === "submitted" || existing.status === "reviewed") {
    return { ok: false, code: "terminal", error: INTAKE_TERMINAL };
  }

  // Merge with what's already saved so a save from step 3 doesn't blow away
  // step 1 answers if the client only sent the latest step's fields.
  const catalogue = questionnaireForRow(existing.questionnaire_snapshot);
  if (catalogue.kind === "invalid") return { ok: false, error: QUESTIONNAIRE_UNAVAILABLE };
  if (!catalogue.steps.some(s => s.id === step)) return { ok: false, error: "Invalid step." };
  const responses = sanitizeResponses(payload.responses, catalogue.steps);

  if (intakeRevision(existing.revision) !== expectedRevision) {
    return { ok: false, code: "conflict", error: INTAKE_CONFLICT };
  }

  const merged = {
    ...((existing.responses as Record<string, unknown>) ?? {}),
    ...responses,
  };

  // Incomplete drafts remain legal; a supplied yes/no value must be canonical.
  // Use the saved parent for applicability, but do not strand an unrelated
  // step because an untouched historic value needs correction on a later step.
  // Both editors post whole maps. Validate changed draft values, not unchanged
  // legacy answers carried through navigation; full submit stays strict.
  // Deep equality also preserves unchanged malformed JSON historical values.
  const invalidYesNo = findInvalidChoiceAnswers(merged, catalogue.steps).filter(
    (key) => Object.hasOwn(responses, key)
      && !isDeepStrictEqual(responses[key], (existing.responses as Record<string, unknown> | null)?.[key])
      && getQuestionByKey(key, catalogue.steps)?.type === "yes_no",
  );
  if (invalidYesNo.length > 0) {
    return { ok: false, error: "Please choose Yes or No for each yes/no answer before saving." };
  }

  // Same draft posture for the live consent forms: a save is NEVER refused
  // for an unanswered or half-answered consent form: that is a normal
  // in-progress state, but what lands in the row is server-derived. Only a
  // claim matching one of THIS studio's current live templates, carrying the
  // current canonical hash, produces a draft entry, and every snapshot field
  // comes from the database row rather than the browser. A stale or forged
  // claim is dropped, so an in-progress row can never hold fabricated consent
  // text for a practitioner to read.
  //
  // Written whenever the client sent a consent key at all, so clearing an
  // answer overwrites the stored record instead of leaving a stale one behind
  // (the merge above is a spread).
  if (merged[INTAKE_CONSENT_RESPONSES.id] !== undefined) {
    const draftConsent = await buildIntakeConsentDraftRecord({
      studioId: existing.studio_id as string,
      responses: merged,
      // The row as it stands BEFORE this save. `merged` is not a substitute:
      // the browser's claims have already overwritten the consent key there,
      // so an answer to a form the intake no longer collects exists only here.
      storedResponses: existing.responses as Record<string, unknown> | null,
    });
    if (draftConsent) merged[INTAKE_CONSENT_RESPONSES.id] = draftConsent;
    else delete merged[INTAKE_CONSENT_RESPONSES.id];
  }

  return writeIntakeRevision(admin, {
    intakeId: v.intake_id, studioId: existing.studio_id, clientId: existing.client_id,
    expectedRevision, responses: merged, step, operation: "save",
  });
}

export async function submitIntakeAction(payload: {
  token: string;
  expectedRevision?: unknown;
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

  const expectedRevision = intakeRevision(payload.expectedRevision);
  if (expectedRevision === null) return { ok: false, code: "conflict", error: INTAKE_CONFLICT };

  const admin = createAdminClient();
  const { data: existing, error: lookupErr } = await admin
    .from("client_intake_forms")
    .select("id, status, responses, studio_id, client_id, revision, questionnaire_snapshot")
    .eq("id", v.intake_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (lookupErr) {
    logInternalIntakeError("intake_lookup_error", { code: lookupErr.code, message: lookupErr.message });
    return { ok: false, error: INTAKE_GENERIC_ERROR };
  }
  if (!existing) return { ok: false, error: "Intake not found." };
  if (existing.status === "submitted" || existing.status === "reviewed") {
    return { ok: false, code: "terminal", error: INTAKE_TERMINAL };
  }

  const catalogue = questionnaireForRow(existing.questionnaire_snapshot);
  if (catalogue.kind === "invalid") return { ok: false, error: QUESTIONNAIRE_UNAVAILABLE };
  const responses = sanitizeResponses(payload.responses, catalogue.steps);

  if (intakeRevision(existing.revision) !== expectedRevision) {
    return { ok: false, code: "conflict", error: INTAKE_CONFLICT };
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
  const missing = findMissingRequiredAnswers(merged, catalogue.steps);
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        "Please answer all required questions before submitting your intake.",
    };
  }

  // Server-side CHOICE-VALUE check, immediately after the required check and on
  // the same terms: this write path only, never a re-validation of an intake
  // that is already submitted (that case returned above).
  //
  // The required check above proves an answer EXISTS. It does not prove the
  // answer is one we offered: the response sanitizer is a key whitelist that
  // passes values through untouched, so without this a crafted payload could
  // put arbitrary text where a clinical enum belongs (e.g. a diabetes type of
  // anything at all) and the review surface would render it as the client's
  // answer. Not relying on the browser having only drawn two buttons is the
  // entire point.
  //
  // Draft saves allow incomplete answers by design: the same posture the consent draft
  // takes a few lines down. A draft is never authoritative; THIS is the gate,
  // and it re-checks the whole merged map, so a bad value planted by an earlier
  // save is caught here rather than waved through.
  const invalidChoices = findInvalidChoiceAnswers(merged, catalogue.steps);
  if (invalidChoices.length > 0) {
    return {
      ok: false,
      error:
        "Please choose one of the listed options for every question before submitting your intake.",
    };
  }

  // RETIRED (#518): the versioned electrolysis acknowledgement gate used to
  // run here. It is gone with the acknowledgement itself: a submission no
  // longer requires it and no longer constructs one. The live consent gate
  // below, added by #529, is now the consent authority for a new intake.
  //
  // Deliberately NOT replaced with a "legacy row still needs it" branch: an
  // in-progress intake started before retirement must be able to finish, and
  // its stored acknowledgement (if any) is preserved by the merge above.

  // Live consent forms: the server-side consent gate.
  //
  // Placed below the already-submitted early return (so an intake
  // submitted before this feature is never re-validated, never rewritten and
  // never retroactively marked incomplete) and above the UPDATE (so a
  // rejection performs zero writes).
  //
  // It re-resolves the studio's CURRENT live treatment/photo templates from
  // the database rather than trusting the set the browser rendered, so:
  //   * a form that went live after the client opened the wizard is still
  //     required;
  //   * a v1 acknowledgement cannot satisfy a v2 template: the canonical
  //     hash differs and the submit fails closed with a refresh prompt;
  //   * every treatment consent must be explicitly accepted;
  //   * every photo consent must be explicitly ANSWERED, and a denial is a
  //     complete answer that must never block the submission.
  //
  // A studio with no live treatment/photo forms yields record = null and
  // submission proceeds exactly as it did before this feature existed.
  //
  // Nothing here trusts the disabled Submit button, the client-side React
  // state, a hidden input, or any browser-supplied version or text.
  const consent = await validateIntakeConsentResponses({
    studioId: existing.studio_id,
    // Same posture as studio_id: read from the intake row, never the request.
    clientId: existing.client_id,
    responses: merged,
    respondedAtIso: new Date().toISOString(),
    // As above: the pre-merge row, so submitting cannot drop a photo answer
    // this client gave while the intake still asked for one.
    storedResponses: existing.responses as Record<string, unknown> | null,
  });
  if (!consent.ok) return { ok: false, error: consent.error };
  if (consent.record) {
    merged[INTAKE_CONSENT_RESPONSES.id] = consent.record;
  } else {
    // Nothing was completed during this intake: either the studio has no live
    // forms, or every one of them was already completed in the portal. Drop any
    // record a draft save left behind (the wizard posts an empty claim set in
    // that state) so the stored row does not carry a hollow consent entry the
    // review surface has to interpret.
    delete merged[INTAKE_CONSENT_RESPONSES.id];
  }

  const written = await writeIntakeRevision(admin, {
    intakeId: v.intake_id, studioId: existing.studio_id, clientId: existing.client_id,
    expectedRevision, responses: merged, step: catalogue.steps[catalogue.steps.length - 1].id, operation: "submit",
    profile: intakeProfileContributions(merged),
  });
  if (!written.ok) return written;

  // Fire-and-forget in-app notification for the studio (PR #164 helper,
  // studio-wide visibility). This runs ONLY in this winner branch: the
  // early-exit (already submitted/reviewed) and the race-loser (zero rows
  // updated) branches above both return before reaching here, so a
  // resubmit / double-click / retry never double-notifies, the atomic
  // status transition is the dedup. The helper never throws and never rolls
  // back the (already-committed) submit; an insert failure logs to
  // ops_alerts. The payload carries ONLY the client name (already shown to
  // studio members) + safe text, never intake answers, and never the intake
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

  return { ok: true, revision: written.revision };
}

// ---------------------------------------------------------------------------
// Server-derived contributions for0243 atomic profile synchronization
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
function intakeProfileContributions(responses: Record<string, unknown>): Record<string, string | null> {
  return {
    emergency_contact_name: stringOrNull(responses.emergency_contact_name),
    emergency_contact_phone: stringOrNull(responses.emergency_contact_phone),
    date_of_birth: profileBirthDate(responses.date_of_birth),
    pronouns: stringOrNull(responses.pronouns),
    address: stringOrNull(responses.address),
    allergy_text: buildIntakeAllergyText(responses),
  };
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


// 0243 casts this contribution to date INSIDE the submit transaction, so a
// value the cast rejects would roll back the whole submission. Only a strict
// calendar ISO date the wizard itself accepts is contributed; anything else
// stays in the intake responses and leaves the profile field untouched, as the
// old after-submit sync did when it swallowed the failure.
function profileBirthDate(value: unknown): string | null {
  const date = stringOrNull(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return isValidIntakeDate(date, Date.now()) ? date : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
