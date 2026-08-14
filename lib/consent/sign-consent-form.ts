import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildConsentTemplateSnapshot } from "./template-snapshot";

// The ONE consent-signing ceremony.
//
// Extracted verbatim from app/portal/consent-actions.ts (PR #134 / #137 /
// #167 / #177) so there is exactly one implementation of the ceremony in the
// tree. The portal action is now a thin wrapper over this core; a future
// caller (e.g. the intake surface) must reuse this and MUST NOT build a
// second consent engine.
//
// WHAT THIS CORE OWNS
// -------------------
//   * the four-clause template lookup (id + studio_id + is_live + status)
//   * the optional allowedFormTypes narrowing
//   * the render-time integrity comparison (see below)
//   * the archived-client re-check
//   * typed-name shape validation
//   * server-owned photo accept/deny label selection
//   * the server-derived snapshot + canonical hash
//   * the INSERT
//
// WHAT IT DELIBERATELY DOES NOT OWN
// ---------------------------------
// Identity resolution, cache revalidation, and the card-authorization
// pointer refresh all stay with the caller. The core receives an already
// server-trusted (studioId, clientId) pair and never derives one itself, so
// each surface keeps responsibility for proving who is signing.
//
// It also does NOT construct a service-role client. The Supabase client is
// injected by the caller. That is deliberate: it keeps this file off the
// tests/security/service-role-allowlist.ts inventory, so the allowlist keeps
// naming the surfaces that actually resolve identity rather than a shared
// helper that cannot. (Do not write the admin factory's name with parentheses
// anywhere in this file: the allowlist detector is a literal grep for that
// token and would flag this module as an unallowlisted call site.)
//
// THE RENDER-TIME INTEGRITY COMPARISON (the reason this PR exists)
// ---------------------------------------------------------------
// A studio can edit a live template between the moment a client renders it
// and the moment they submit: updateConsentTemplateAction rewrites
// title/body and bumps version while touching NEITHER status NOR is_live, so
// the template stays active + live and the four-clause lookup still resolves
// it. Before this change the ceremony then snapshotted the CURRENT row, which
// could attach the client's typed name to text they never read.
//
// The fix is a comparand, not a payload. The render surface computes the
// canonical hash of the exact (title, body, version) it displayed and sends
// it back. The server re-resolves the template, recomputes the canonical hash
// from ITS OWN row, and compares. A mismatch writes NOTHING.
//
// `renderedTemplateHash` is the ONLY browser-supplied value that touches the
// snapshot decision, and it is never stored, never trusted as data, and
// never echoed into the row. It is discarded after the comparison. Every
// stored field is still re-derived server-side from the resolved template.

export type ConsentSignatureIdentity = {
  studioId: string;
  clientId: string;
};

// The bounded set of browser-derived interaction fields. Anything not on this
// type is not read from the request by the ceremony.
export type ConsentSignatureInteraction = {
  templateId: string;
  typedName: string;
  agreed: boolean;
  // Only consulted for form_type='photo_consent'; ignored otherwise.
  response: string | null;
  // Comparands only. Never stored.
  //
  // The hash covers (title, body, version). form_type is carried SEPARATELY
  // rather than folded into the hash because template_hash is a persisted
  // column on every historical client_consent_signatures row and its canonical
  // format is a documented stored contract -- widening it would silently
  // invalidate every future hash-vs-history verification.
  renderedTemplateHash: string;
  renderedFormType: string;
};

export type RecordConsentSignatureInput = {
  // Injected by the caller; this module never constructs one. Typed as the
  // real client rather than a hand-rolled structural stand-in so a drift in
  // the query shape is a compile error here, not a runtime surprise.
  admin: SupabaseClient;
  identity: ConsentSignatureIdentity;
  interaction: ConsentSignatureInteraction;
  // When supplied, the resolved template's form_type must be a member.
  // Omitted means "any live/active form type", which is the portal's
  // pre-existing behaviour and must stay that way.
  allowedFormTypes?: ReadonlyArray<string>;
  // Best-effort forensic columns; both are nullable on the row.
  ipHash: string | null;
  userAgentHash: string | null;
};

export type RecordConsentSignatureResult =
  | {
      ok: true;
      signatureId: string;
      templateId: string;
      formType: string;
      templateVersion: number;
    }
  | { ok: false; error: string; reason: ConsentSignatureRejection };

export type ConsentSignatureRejection =
  | "missing_template"
  | "name_missing"
  | "name_too_long"
  | "not_agreed"
  | "missing_rendered_hash"
  | "client_lookup_failed"
  | "client_unavailable"
  | "template_lookup_failed"
  | "template_unavailable"
  | "form_type_not_allowed"
  | "photo_response_missing"
  | "stale_template"
  | "stale_form_type"
  | "insert_failed";

const NAME_MIN = 1;
const NAME_MAX = 200;

// Photo-consent allow / deny labels (PR #137). The rendered radio uses these
// exact strings and the snapshot column captures whichever one the client
// chose, so a later audit query reads the same text the surface showed.
// SERVER-OWNED: never taken from the request.
export const PHOTO_CONSENT_ACCEPT_LABEL =
  "I consent to photo use as described above.";
export const PHOTO_CONSENT_DENY_LABEL = "I do not consent to photo use.";

// Product-approved refusal copy for the stale-render race. Product wording
// only. This is NOT legal language and must never be described as such. It
// is deliberately calm and actionable: the client did nothing wrong.
export const STALE_CONSENT_FORM_MESSAGE =
  "This form changed while you were reviewing it. Please refresh and review the current version before signing.";

// Generic refusals, preserved byte-for-byte from the portal action so the
// extraction is not a UX change.
const ERR_MISSING_TEMPLATE = "Missing form reference.";
const ERR_NAME_MISSING = "Type your full name to sign.";
const ERR_NAME_TOO_LONG = `Name must be ${NAME_MAX} characters or fewer.`;
const ERR_NOT_AGREED = "Please confirm you have read and agree to this form.";
const ERR_UNAVAILABLE = "This form is no longer available to sign.";
const ERR_GENERIC = "Couldn't sign this form. Please try again.";
const ERR_PHOTO_RESPONSE = "Please choose your photo consent response.";
const ERR_INSERT = "Couldn't save your signature. Please try again.";

function reject(
  reason: ConsentSignatureRejection,
  error: string,
): RecordConsentSignatureResult {
  return { ok: false, error, reason };
}

export async function recordConsentSignature(
  input: RecordConsentSignatureInput,
): Promise<RecordConsentSignatureResult> {
  const { admin, identity, interaction, allowedFormTypes } = input;

  const templateId = interaction.templateId.trim();
  const signatureName = interaction.typedName.trim();
  const renderedTemplateHash = interaction.renderedTemplateHash.trim();
  const renderedFormType = interaction.renderedFormType.trim();

  // ---- shape validation (order preserved from the portal action) ----
  if (!templateId) return reject("missing_template", ERR_MISSING_TEMPLATE);
  if (signatureName.length < NAME_MIN) {
    return reject("name_missing", ERR_NAME_MISSING);
  }
  if (signatureName.length > NAME_MAX) {
    return reject("name_too_long", ERR_NAME_TOO_LONG);
  }
  if (!interaction.agreed) return reject("not_agreed", ERR_NOT_AGREED);

  // A submission with no comparand cannot be proven to match what was
  // rendered, so it is refused rather than trusted. Fail CLOSED: an older
  // client bundle posting nothing is a stale render by definition.
  if (!renderedTemplateHash || !renderedFormType) {
    return reject("missing_rendered_hash", STALE_CONSENT_FORM_MESSAGE);
  }

  // ---- client re-check ----
  // Defence in depth: the client row must still be active and belong to this
  // studio. A portal cookie outlives an archive by design; this is the
  // guardrail that stops an archived client accumulating new signatures.
  const { data: client, error: clientErr } = await admin
    .from("clients")
    .select("id, archived_at")
    .eq("id", identity.clientId)
    .eq("studio_id", identity.studioId)
    .maybeSingle();
  if (clientErr) {
    console.error(
      JSON.stringify({
        event: "consent_sign_client_lookup_failed",
        code: clientErr.code,
        message: clientErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return reject("client_lookup_failed", ERR_GENERIC);
  }
  if (!client || client.archived_at != null) {
    return reject("client_unavailable", ERR_UNAVAILABLE);
  }

  // ---- the four-clause template lookup ----
  // Any mismatch -- forged id from another studio, draft, archived, not live
  // in the portal, or gone -- returns the same generic error. The is_live
  // clause matters even though status='active' is also required, because the
  // application wants the property that an active-but-not-live row is
  // unsignable even if a caller guessed the template id.
  const { data: template, error: templateErr } = await admin
    .from("consent_form_templates")
    .select("id, title, body, version, status, studio_id, form_type")
    .eq("id", templateId)
    .eq("studio_id", identity.studioId)
    .eq("is_live", true)
    .eq("status", "active")
    .maybeSingle();
  if (templateErr) {
    console.error(
      JSON.stringify({
        event: "consent_sign_template_lookup_failed",
        code: templateErr.code,
        message: templateErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return reject("template_lookup_failed", ERR_GENERIC);
  }
  if (!template) return reject("template_unavailable", ERR_UNAVAILABLE);

  // ---- form-type narrowing ----
  // The lookup above is form_type-AGNOSTIC by design (the portal signs every
  // live type through one ceremony). A caller that must not be able to sign
  // certain types supplies allowedFormTypes, and the narrowing happens HERE,
  // in the core, never at the render layer -- a UI filter is not a control,
  // because the template id is browser-supplied.
  if (allowedFormTypes && !allowedFormTypes.includes(template.form_type)) {
    return reject("form_type_not_allowed", ERR_UNAVAILABLE);
  }

  // ---- the snapshot, built from the SERVER-resolved row ----
  const snapshot = buildConsentTemplateSnapshot({
    title: template.title,
    body: template.body,
    version: template.version,
  });

  // ---- THE INTEGRITY COMPARISON ----
  // snapshot.templateHash is the canonical hash of the row we just resolved.
  // renderedTemplateHash is the canonical hash of what the client actually
  // read. If they differ the template changed under the client, so we write
  // NOTHING and say so. Note this is compared AFTER the snapshot is built so
  // both sides come from the identical canonical function -- comparing a
  // hash against a differently-derived hash would be the classic way to make
  // this check silently vacuous.
  if (snapshot.templateHash !== renderedTemplateHash) {
    return reject("stale_template", STALE_CONSENT_FORM_MESSAGE);
  }

  // form_type is compared separately because it is NOT in the hash, and it is
  // the field that decides whether the client's accept/deny choice is honoured
  // at all: a flip out of 'photo_consent' sends an explicit DENY down the
  // else-branch below, which writes response='accepted'. Through the shipped
  // editor this is already covered by accident (updateConsentTemplateAction
  // always bumps version, which moves the hash), but a same-studio member can
  // PATCH form_type directly via the Data API -- migration 0057 grants
  // authenticated studio members UPDATE on consent_form_templates with no
  // column restriction -- leaving the hash intact. Fail closed.
  if (template.form_type !== renderedFormType) {
    return reject("stale_form_type", STALE_CONSENT_FORM_MESSAGE);
  }

  // ---- photo response resolution (server-owned labels) ----
  let response: "accepted" | "denied";
  let responseLabelSnapshot: string | null;
  if (template.form_type === "photo_consent") {
    const raw = (interaction.response ?? "").trim();
    if (raw !== "accepted" && raw !== "denied") {
      return reject("photo_response_missing", ERR_PHOTO_RESPONSE);
    }
    response = raw;
    responseLabelSnapshot =
      response === "accepted"
        ? PHOTO_CONSENT_ACCEPT_LABEL
        : PHOTO_CONSENT_DENY_LABEL;
  } else {
    response = "accepted";
    responseLabelSnapshot = null;
  }

  // ---- the insert ----
  // Signatures are immutable: INSERT only. There is no update or delete path.
  // Multiple signatures of the same (client, template) pair are preserved as
  // point-in-time historical rows. studio_id / client_id come from the
  // caller-resolved identity, never from the request.
  const { data: created, error: insertErr } = await admin
    .from("client_consent_signatures")
    .insert({
      studio_id: identity.studioId,
      client_id: identity.clientId,
      template_id: template.id,
      template_title_snapshot: snapshot.templateTitleSnapshot,
      template_body_snapshot: snapshot.templateBodySnapshot,
      template_version: snapshot.templateVersion,
      template_hash: snapshot.templateHash,
      signature_name: signatureName,
      ip_hash: input.ipHash,
      user_agent_hash: input.userAgentHash,
      response,
      response_label_snapshot: responseLabelSnapshot,
    })
    .select("id")
    .single();
  if (insertErr || !created) {
    console.error(
      JSON.stringify({
        event: "consent_sign_insert_failed",
        code: insertErr?.code,
        message: insertErr?.message,
        templateId: template.id,
        timestamp: new Date().toISOString(),
      }),
    );
    return reject("insert_failed", ERR_INSERT);
  }

  return {
    ok: true,
    signatureId: created.id,
    // The SERVER-resolved id, so a caller logging or branching on it never
    // echoes the browser's spelling of the same uuid.
    templateId: template.id,
    formType: template.form_type,
    templateVersion: snapshot.templateVersion,
  };
}
