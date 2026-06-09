"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPortalSession } from "@/lib/portal/session";
import { hashFingerprint } from "@/lib/portal/tokens";
import { buildConsentTemplateSnapshot } from "@/lib/consent/template-snapshot";
import { refreshActiveCardAuthorizationPointersForSignature } from "@/lib/payment-methods/refresh-card-authorization-pointer";

// PR #134. Portal-side consent sign action. Lives in app/portal so
// the middleware allowlist does not need to widen; Next.js server
// actions POST to whatever page route they are bound to and the
// only binding is the portal home (/portal, already allowlisted).
//
// Critical security invariants (mirrors PR #129 spec for replies):
//   * Requires a valid portal session.
//   * Template lookup MUST match all three of:
//       id = templateId
//       studio_id = session.studioId
//       status = 'active'
//     so a forged template id from another studio or a draft /
//     archived template cannot resolve.
//   * The current clients row is re-checked active + non-archived
//     before insert. A portal session cookie outlives an archive
//     by design; this gate stops an archived client from continuing
//     to sign forms with an in-flight cookie.
//   * Insert uses session.studioId / session.clientId / template.id
//     server-resolved values. The client-supplied templateId is
//     only used as a lookup key above and is now redundantly the
//     same value.
//   * Snapshot fields are built from the resolved template by the
//     shared helper; the client cannot supply them, edit them, or
//     produce a forged hash.
//   * Signatures are immutable: this action only INSERTs. There is
//     no update / delete path in this PR. Multiple signatures of
//     the same (client, template) pair are preserved as point-in-
//     time historical rows.

const REPLY_NAME_MIN = 1;
const REPLY_NAME_MAX = 200;

function clientIpFromHeaders(h: Headers): string | null {
  // Same shape lib/rate-limit/public.ts uses; re-implemented to
  // avoid widening a non-exported helper's reach.
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = h.get("x-real-ip");
  if (realIp) return realIp.trim();
  return null;
}

export type SignConsentFormResult =
  | { ok: true; signatureId: string }
  | { ok: false; error: string };

// Photo-consent allow / deny labels (PR #137). The portal radio
// rendered to the client uses these exact strings; the snapshot
// column captures whichever one the client chose so a later audit
// query reads the same text the portal showed.
const PHOTO_CONSENT_ACCEPT_LABEL =
  "I consent to photo use as described above.";
const PHOTO_CONSENT_DENY_LABEL = "I do not consent to photo use.";

export async function signConsentFormAction(
  formData: FormData,
): Promise<SignConsentFormResult> {
  const templateId = (formData.get("template_id") ?? "").toString().trim();
  const signatureNameRaw = (formData.get("signature_name") ?? "")
    .toString()
    .trim();
  const agreed = (formData.get("agreed") ?? "").toString().trim();
  // PR #137. Photo-consent response. For non-photo forms the action
  // ignores this field and writes 'accepted'; for photo_consent
  // forms the response is required and must be exactly
  // 'accepted' or 'denied'. The portal-side radio submits the
  // chosen string; an empty / unknown value is rejected.
  const responseRaw = (formData.get("response") ?? "").toString().trim();

  if (!templateId) {
    return { ok: false, error: "Missing form reference." };
  }
  if (signatureNameRaw.length < REPLY_NAME_MIN) {
    return { ok: false, error: "Type your full name to sign." };
  }
  if (signatureNameRaw.length > REPLY_NAME_MAX) {
    return {
      ok: false,
      error: `Name must be ${REPLY_NAME_MAX} characters or fewer.`,
    };
  }
  // Client-side checkbox state arrives as the literal string 'true'
  // only when ticked; any other shape (missing field, 'false',
  // other) is treated as unconfirmed. The DB row has no analogous
  // boolean column because the row's existence + the checked-only
  // post path IS the agreement.
  if (agreed !== "true") {
    return {
      ok: false,
      error: "Please confirm you have read and agree to this form.",
    };
  }

  const session = await getCurrentPortalSession();
  if (!session) {
    return { ok: false, error: "Your portal session has expired." };
  }

  const admin = createAdminClient();

  // Defence in depth: client row must still be active + belong to
  // this session's studio. A portal cookie outlives an archive
  // action by design; this is the guardrail that stops an
  // archived client from accumulating new signatures.
  const { data: client, error: clientErr } = await admin
    .from("clients")
    .select("id, archived_at")
    .eq("id", session.clientId)
    .eq("studio_id", session.studioId)
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
    return { ok: false, error: "Couldn't sign this form. Please try again." };
  }
  if (!client || client.archived_at != null) {
    return { ok: false, error: "This form is no longer available to sign." };
  }

  // Template lookup with the four security clauses (PR #167 added
  // the is_live gate). Any mismatch -- forged id from another
  // studio, draft, archived, not-live-in-portal, or gone -- returns
  // the same generic error string. The is_live clause matters even
  // though status = 'active' is also required, because the DB CHECK
  // is the structural guarantee that is_live = true cannot coexist
  // with status != 'active'; the application also wants the
  // opposite property (a status = 'active' row that is not live
  // must not be signable from the portal even if a malicious
  // client guessed the template id).
  const { data: template, error: templateErr } = await admin
    .from("consent_form_templates")
    .select("id, title, body, version, status, studio_id, form_type")
    .eq("id", templateId)
    .eq("studio_id", session.studioId)
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
    return { ok: false, error: "Couldn't sign this form. Please try again." };
  }
  if (!template) {
    return { ok: false, error: "This form is no longer available to sign." };
  }

  // PR #137. Resolve the response server-side based on the
  // template's form_type. Photo-consent forms require an explicit
  // 'accepted' or 'denied' choice; every other form_type writes
  // 'accepted' as the default (the act of signing IS the
  // acceptance, and the response column exists primarily to admit
  // photo-consent's third state without weakening the immutable
  // signature posture). An invalid or missing response on a
  // photo-consent form is rejected with a safe error.
  let response: "accepted" | "denied";
  let responseLabelSnapshot: string | null;
  if (template.form_type === "photo_consent") {
    if (responseRaw !== "accepted" && responseRaw !== "denied") {
      return {
        ok: false,
        error: "Please choose your photo consent response.",
      };
    }
    response = responseRaw;
    responseLabelSnapshot =
      response === "accepted"
        ? PHOTO_CONSENT_ACCEPT_LABEL
        : PHOTO_CONSENT_DENY_LABEL;
  } else {
    response = "accepted";
    responseLabelSnapshot = null;
  }

  // Build the snapshot from the server-resolved template; the
  // client cannot supply title / body / version. template_hash
  // remains a TEMPLATE-only fingerprint (PR #134 / migration 0057)
  // and is INTENTIONALLY NOT widened with the response in
  // PR #137 / migration 0060: a re-signing of the same template
  // version should produce the same hash, and the response is
  // captured as its own column for audit + display.
  const snapshot = buildConsentTemplateSnapshot({
    title: template.title,
    body: template.body,
    version: template.version,
  });

  // Best-effort fingerprint hashing for the audit trail. Both are
  // nullable on the row so a missing header is fine. Raw IP / UA
  // never reach the DB.
  const hdrs = await headers();
  const ipHash = hashFingerprint(clientIpFromHeaders(hdrs));
  const uaHash = hashFingerprint(hdrs.get("user-agent"));

  const { data: created, error: insertErr } = await admin
    .from("client_consent_signatures")
    .insert({
      studio_id: session.studioId,
      client_id: session.clientId,
      template_id: template.id,
      template_title_snapshot: snapshot.templateTitleSnapshot,
      template_body_snapshot: snapshot.templateBodySnapshot,
      template_version: snapshot.templateVersion,
      template_hash: snapshot.templateHash,
      signature_name: signatureNameRaw,
      ip_hash: ipHash,
      user_agent_hash: uaHash,
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
    return { ok: false, error: "Couldn't save your signature. Please try again." };
  }

  // PR #177. Card authorization pointer refresh.
  //
  // After a successful insert of a card_authorization signature
  // against the current live template, the active card row's
  // card_authorization_signature_id must be refreshed so its audit
  // pointer matches the current signed artefact. The helper is
  // fail-soft: a DB error there does NOT roll back the signature.
  // The signature is the durable legal record; the pointer is a
  // reconciliation field. If the refresh fails the helper records
  // a critical ops_alert; the visitor still sees their signature
  // saved. We do not surface the refresh failure to the visitor
  // because (a) they have done their part correctly, (b) the
  // operator-side alert already names the reconciliation owner.
  //
  // Non-card_authorization templates (treatment_consent,
  // photo_consent, etc.) skip the refresh entirely; the pointer is
  // a card-row column and is only meaningful when the template is
  // form_type='card_authorization'.
  //
  // Critically: this helper does NOT call any charge-gate helper,
  // so a stale pointer cannot deadlock the portal re-sign path.
  // See lib/consent/current-card-authorization.ts (the
  // getChargeReadyCardAuthorizationStatus block comment) for the
  // deadlock-prevention reasoning.
  if (template.form_type === "card_authorization") {
    const refresh = await refreshActiveCardAuthorizationPointersForSignature({
      studioId: session.studioId,
      clientId: session.clientId,
      signatureId: created.id,
    });
    if (!refresh.ok) {
      // The helper has already recorded the critical ops_alert.
      // Mirror to the structured stderr log so a Vercel-log-only
      // operator sees the same line they would have seen if the
      // alert insert had also failed.
      console.error(
        JSON.stringify({
          event: "consent_sign_pointer_refresh_failed",
          templateId: template.id,
          signatureId: created.id,
          reason: refresh.reason,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  revalidatePath("/portal");
  return { ok: true, signatureId: created.id };
}
