import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  buildConsentTemplateSnapshot,
  withRenderedTemplateHash,
} from "@/lib/consent/template-snapshot";
import {
  PHOTO_CONSENT_ACCEPT_LABEL,
  PHOTO_CONSENT_DENY_LABEL,
} from "@/lib/consent/sign-consent-form";
import {
  INTAKE_CONSENT_FORM_TYPES,
  INTAKE_CONSENT_RESPONSES,
  isIntakeConsentFormType,
  normalizeIntakeConsentClaims,
  type IntakeConsentFormClaim,
  type IntakeConsentFormRecord,
  type IntakeConsentFormType,
  type IntakeConsentResponsesRecord,
} from "@/lib/intake/consent-forms";

// Server-side authority for live consent forms inside the intake.
//
// Two jobs, and only the server may do either:
//
//   1. RESOLVE which forms apply — the studio's own currently live, active
//      treatment/photo templates — and produce the render payload with a
//      canonical hash attached to each.
//   2. VALIDATE the client's claims against a FRESH re-read of those same
//      templates at submit time, and build the records that get stored.
//
// Everything stored is derived from the database row this module re-read.
// The browser contributes exactly one value per form: the client's choice.
//
// NO SIGNATURE IS CREATED HERE. This module never writes to
// `client_consent_signatures` and never fabricates a typed name. Its only
// dependency on the portal signing module is the pair of server-owned photo
// labels, imported so an intake denial reads identically to a portal denial.

// The live-form contract, in one place:
//
//   studio_id = the intake's OWN studio (never a browser-supplied id)
//   is_live   = true
//   status    = 'active'
//   form_type IN (treatment_consent, photo_consent)
//
// is_live AND status are BOTH required. Migration 0072's CHECK makes the
// second structurally redundant, but the portal query keeps it for
// defense-in-depth and so does this one: a future migration that weakens the
// CHECK must not silently expose draft consent text to a client mid-intake.
//
// Ordering is `created_at` ascending, tie-broken by id — the same ordering
// getActiveConsentTemplatesForPortal uses, so a studio's forms appear in the
// intake in the same sequence as in the portal. The id tiebreak makes the
// order total, so two templates created in the same transaction cannot swap
// places between the render and the submit.
type LiveConsentTemplateRow = {
  id: string;
  title: string;
  description: string | null;
  body: string;
  form_type: string;
  version: number;
};

async function loadLiveIntakeConsentTemplates(
  studioId: string,
): Promise<LiveConsentTemplateRow[] | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("consent_form_templates")
    .select("id, title, description, body, form_type, version")
    .eq("studio_id", studioId)
    .eq("is_live", true)
    .eq("status", "active")
    .in("form_type", [...INTAKE_CONSENT_FORM_TYPES])
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    console.error(
      JSON.stringify({
        event: "intake_consent_templates_load_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    // null means "could not resolve", which the submit gate treats as a
    // refusal. It must never be confused with "this studio has none live",
    // which is an empty array and is a legitimate pass.
    return null;
  }
  // The `.in()` filter is the authority; this re-narrows in TypeScript so a
  // row with an unexpected form_type can never reach the render payload.
  return (data ?? []).filter((row) =>
    isIntakeConsentFormType(row.form_type),
  ) as LiveConsentTemplateRow[];
}

// ---------------------------------------------------------------------------
// Existing PORTAL completions
// ---------------------------------------------------------------------------
//
// A client who already completed the EXACT CURRENT form through the portal
// must not be made to answer the identical form again inside intake.
//
// STRICTLY READ-ONLY. This module never inserts, updates or deletes a
// signature, never fabricates a typed name, and never copies a signature into
// `intake_consent_responses`. The two evidence channels stay historically
// distinct: a portal signature remains a portal signature, and the intake
// record contains only what was completed DURING the intake.
//
// WHAT COUNTS AS CURRENT. The stored `template_hash` must equal the canonical
// hash of the template row as it stands right now. That is deliberately
// stricter than the version comparison `consentRowState` uses
// (`sig.template_version < template.version`): the hash covers title, body AND
// version, so a studio that edited the body WITHOUT bumping the version — which
// a version check would miss entirely — also invalidates the old completion.
// It reuses the same buildConsentTemplateSnapshot authority the signing side
// wrote the column with, so there is no second hashing scheme to drift.
export type IntakeConsentPortalCompletion = {
  response: "accepted" | "denied";
  signedAtIso: string;
  templateVersion: number;
};

type SignatureRow = {
  template_id: string;
  template_hash: string;
  template_version: number;
  response: string;
  signed_at: string;
};

async function loadCurrentPortalCompletions(input: {
  studioId: string;
  clientId: string;
  rows: LiveConsentTemplateRow[];
}): Promise<Map<string, IntakeConsentPortalCompletion>> {
  const out = new Map<string, IntakeConsentPortalCompletion>();
  if (input.rows.length === 0) return out;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_consent_signatures")
    .select("template_id, template_hash, template_version, response, signed_at")
    // Scoped to BOTH ids, so another client's or another studio's signature can
    // never satisfy this intake's forms.
    .eq("studio_id", input.studioId)
    .eq("client_id", input.clientId)
    .in(
      "template_id",
      input.rows.map((r) => r.id),
    )
    // Newest first, so the first match per template is the latest signature —
    // the same first-write-wins pass getLatestSignaturesByTemplateForPortal
    // uses.
    .order("signed_at", { ascending: false });
  if (error) {
    console.error(
      JSON.stringify({
        event: "intake_consent_portal_completions_load_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    // Fail SAFE, not open: an unreadable signature history means we simply do
    // not credit any portal completion, so the client is asked to complete the
    // form in intake. That is a duplicate request in the worst case — never a
    // skipped consent.
    return out;
  }

  const sigs = (data ?? []) as SignatureRow[];
  for (const row of input.rows) {
    const canonical = buildConsentTemplateSnapshot({
      title: row.title,
      body: row.body,
      version: row.version,
    }).templateHash;
    const match = sigs.find(
      (s) => s.template_id === row.id && s.template_hash === canonical,
    );
    if (!match) continue;
    if (row.form_type === "photo_consent") {
      // Either answer completes a photo form, and a portal DENY stays a DENY.
      if (match.response !== "accepted" && match.response !== "denied") continue;
      out.set(row.id, {
        response: match.response,
        signedAtIso: match.signed_at,
        templateVersion: match.template_version,
      });
      continue;
    }
    // A treatment consent is completed only by an acceptance. A 'denied'
    // treatment signature (which the portal does not produce) would not count.
    if (match.response !== "accepted") continue;
    out.set(row.id, {
      response: "accepted",
      signedAtIso: match.signed_at,
      templateVersion: match.template_version,
    });
  }
  return out;
}

// One form as the wizard renders it. The body is the studio's own text,
// verbatim — never truncated, never clamped, never re-authored here.
export type IntakeConsentFormForRender = {
  templateId: string;
  formType: IntakeConsentFormType;
  title: string;
  description: string | null;
  body: string;
  version: number;
  // The canonical hash of exactly this (title, body, version). The browser
  // carries it back as a COMPARAND at submit time.
  renderedTemplateHash: string;
  // Present when the client ALREADY completed this exact current form through
  // the portal. The wizard renders a read-only completed state instead of an
  // interactive control, and the submit gate does not require an answer.
  portalCompletion: IntakeConsentPortalCompletion | null;
};

// Resolve the forms to display for an intake. Returns [] when the studio has
// none live — a legitimate state that must leave intake submission behaving
// exactly as it did before this feature.
export async function getIntakeConsentFormsForRender(
  studioId: string,
  clientId: string,
): Promise<IntakeConsentFormForRender[]> {
  const rows = await loadLiveIntakeConsentTemplates(studioId);
  if (!rows) return [];
  const portal = await loadCurrentPortalCompletions({
    studioId,
    clientId,
    rows,
  });
  return rows.map((row) => {
    const withHash = withRenderedTemplateHash({
      title: row.title,
      body: row.body,
      version: row.version,
    });
    return {
      templateId: row.id,
      formType: row.form_type as IntakeConsentFormType,
      title: row.title,
      description: row.description,
      body: row.body,
      version: row.version,
      renderedTemplateHash: withHash.renderedTemplateHash,
      portalCompletion: portal.get(row.id) ?? null,
    };
  });
}

export type IntakeConsentGateRejection =
  | "lookup_failed"
  | "missing_response"
  | "stale_template"
  | "treatment_not_accepted"
  | "photo_not_answered";

export type IntakeConsentGateResult =
  // `record` is null when the studio has zero live intake consent forms.
  // Nothing is stored and submission proceeds unchanged.
  | { ok: true; record: IntakeConsentResponsesRecord | null }
  | { ok: false; error: string; reason: IntakeConsentGateRejection };

// Refusal copy. Calm, actionable, and naming no key, id, version or database
// detail. The client did nothing wrong in any of these branches.
//
// The stale message reuses the approved first sentence of
// STALE_CONSENT_FORM_MESSAGE verbatim; only the trailing clause differs,
// because the portal's "...before signing." is false here — nothing in intake
// is signed, and the whole point of this feature is that it never claims to
// be. Keeping the shared sentence means the two surfaces stay recognisably
// the same message without the intake surface asserting a signature.
export const INTAKE_CONSENT_STALE_MESSAGE =
  "This form changed while you were reviewing it. Please refresh and review the current version before continuing.";

const ERR_TREATMENT =
  "Please confirm you have read and agree to each consent form before submitting.";
const ERR_PHOTO = "Please choose your photo consent response before submitting.";
const ERR_MISSING =
  "Please complete the consent forms before submitting your intake.";
const ERR_LOOKUP =
  "We couldn't load the studio's consent forms. Please refresh and try again.";

function reject(
  reason: IntakeConsentGateRejection,
  error: string,
): IntakeConsentGateResult {
  return { ok: false, error, reason };
}

// Build the stored record for one form. Every snapshot field comes from the
// freshly re-read DATABASE ROW; the claim supplies only `response`.
function buildRecord(
  row: LiveConsentTemplateRow,
  response: "accepted" | "denied",
  respondedAtIso: string | null,
): IntakeConsentFormRecord {
  const snapshot = buildConsentTemplateSnapshot({
    title: row.title,
    body: row.body,
    version: row.version,
  });
  const isPhoto = row.form_type === "photo_consent";
  const record: IntakeConsentFormRecord = {
    template_id: row.id,
    form_type: row.form_type as IntakeConsentFormType,
    template_version: snapshot.templateVersion,
    title_snapshot: snapshot.templateTitleSnapshot,
    body_snapshot: snapshot.templateBodySnapshot,
    template_hash: snapshot.templateHash,
    response,
    // Server-owned label, reusing the portal's exact constants.
    response_label_snapshot: isPhoto
      ? response === "accepted"
        ? PHOTO_CONSENT_ACCEPT_LABEL
        : PHOTO_CONSENT_DENY_LABEL
      : null,
  };
  if (respondedAtIso) record.responded_at = respondedAtIso;
  return record;
}

function findClaim(
  claims: IntakeConsentFormClaim[],
  templateId: string,
): IntakeConsentFormClaim | undefined {
  return claims.find((c) => c.template_id === templateId);
}

// THE FINAL SUBMIT GATE.
//
// Re-resolves the studio's CURRENT live forms — it does not trust the set the
// browser rendered, so a form that went live after the client opened the
// wizard is still required, and a form retired since is no longer required.
//
// For every current live form the client's claim must:
//   * exist;
//   * carry the form type the database actually has (a type flipped between
//     render and submit is a stale render, not a re-classification);
//   * carry the canonical hash of the CURRENT title/body/version — this is
//     what makes a v1 acknowledgement fail to satisfy v2;
//   * carry a response valid for that type.
//
// Treatment consent is satisfied ONLY by `accepted`. Photo consent is
// satisfied by `accepted` OR `denied` — a denial is a completed answer and
// must never block submission.
export async function validateIntakeConsentResponses(input: {
  studioId: string;
  clientId: string;
  responses: Record<string, unknown>;
  respondedAtIso: string | null;
}): Promise<IntakeConsentGateResult> {
  const rows = await loadLiveIntakeConsentTemplates(input.studioId);
  if (!rows) return reject("lookup_failed", ERR_LOOKUP);

  // No live treatment/photo forms: this studio has nothing to complete.
  // Submission behaves exactly as it did before this feature existed, and
  // nothing is written into the responses map.
  if (rows.length === 0) return { ok: true, record: null };

  const claims =
    normalizeIntakeConsentClaims(input.responses[INTAKE_CONSENT_RESPONSES.id])
      ?.forms ?? [];

  // Existing portal completions of the EXACT current form. Either channel
  // satisfies a form:
  //   treatment : portal accepted   OR intake accepted
  //   photo     : portal accepted/denied OR intake accepted/denied
  // Nothing else does — and an OLD portal signature is not a completion,
  // because loadCurrentPortalCompletions matched on the current hash.
  const portal = await loadCurrentPortalCompletions({
    studioId: input.studioId,
    clientId: input.clientId,
    rows,
  });

  const records: IntakeConsentFormRecord[] = [];
  for (const row of rows) {
    // A current portal completion satisfies this form outright. It is
    // deliberately NOT copied into the intake record: the signature stays the
    // portal's evidence, and `intake_consent_responses` continues to mean
    // "completed during the intake" and nothing else.
    if (portal.has(row.id)) continue;

    const claim = findClaim(claims, row.id);
    if (!claim) return reject("missing_response", ERR_MISSING);

    // Stale-render checks, both fail-closed.
    if (claim.form_type !== row.form_type) {
      return reject("stale_template", INTAKE_CONSENT_STALE_MESSAGE);
    }
    const canonical = buildConsentTemplateSnapshot({
      title: row.title,
      body: row.body,
      version: row.version,
    }).templateHash;
    if (claim.rendered_template_hash !== canonical) {
      return reject("stale_template", INTAKE_CONSENT_STALE_MESSAGE);
    }

    if (row.form_type === "treatment_consent") {
      if (claim.response !== "accepted") {
        return reject("treatment_not_accepted", ERR_TREATMENT);
      }
      records.push(buildRecord(row, "accepted", input.respondedAtIso));
      continue;
    }

    // photo_consent — BOTH answers complete the form.
    if (claim.response !== "accepted" && claim.response !== "denied") {
      return reject("photo_not_answered", ERR_PHOTO);
    }
    records.push(buildRecord(row, claim.response, input.respondedAtIso));
  }

  // Every live form was satisfied by an existing portal completion, so the
  // client completed nothing during this intake. Write no record rather than
  // an empty one — an absent key honestly means "nothing was completed here".
  if (records.length === 0) return { ok: true, record: null };

  return {
    ok: true,
    record: { version: INTAKE_CONSENT_RESPONSES.version, forms: records },
  };
}

// Draft counterpart. A save never refuses for consent — an unanswered or
// half-answered form is a normal in-progress state — but what gets STORED is
// still server-derived: only claims matching a current live template, with a
// current hash, produce a draft record, and the snapshot text always comes
// from the database row.
//
// A stale or forged draft claim is simply dropped, so an in-progress row can
// never park fabricated consent text for a practitioner to read.
export async function buildIntakeConsentDraftRecord(input: {
  studioId: string;
  responses: Record<string, unknown>;
}): Promise<IntakeConsentResponsesRecord | null> {
  const raw = input.responses[INTAKE_CONSENT_RESPONSES.id];
  if (raw === undefined || raw === null) return null;
  const claims = normalizeIntakeConsentClaims(raw)?.forms ?? [];
  if (claims.length === 0) {
    // The client cleared their answers: store an empty set rather than
    // leaving a stale record behind (the server merge is a spread).
    return { version: INTAKE_CONSENT_RESPONSES.version, forms: [] };
  }
  const rows = await loadLiveIntakeConsentTemplates(input.studioId);
  if (!rows || rows.length === 0) return null;

  const records: IntakeConsentFormRecord[] = [];
  for (const row of rows) {
    const claim = findClaim(claims, row.id);
    if (!claim) continue;
    if (claim.form_type !== row.form_type) continue;
    const canonical = buildConsentTemplateSnapshot({
      title: row.title,
      body: row.body,
      version: row.version,
    }).templateHash;
    if (claim.rendered_template_hash !== canonical) continue;
    // Draft records carry no responded_at: a draft is a choice so far, not a
    // completion.
    records.push(buildRecord(row, claim.response, null));
  }
  return { version: INTAKE_CONSENT_RESPONSES.version, forms: records };
}
