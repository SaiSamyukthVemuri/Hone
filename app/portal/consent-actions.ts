"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPortalSession } from "@/lib/portal/session";
import { hashFingerprint } from "@/lib/portal/tokens";
import { recordConsentSignature } from "@/lib/consent/sign-consent-form";
import { refreshActiveCardAuthorizationPointersForSignature } from "@/lib/payment-methods/refresh-card-authorization-pointer";

// PR #134. Portal-side consent sign action. Lives in app/portal so
// the middleware allowlist does not need to widen; Next.js server
// actions POST to whatever page route they are bound to and the
// only binding is the portal home (/portal, already allowlisted).
//
// THIS FILE IS NOW A THIN WRAPPER. The ceremony itself -- template
// resolution, the four-clause lookup, the archived-client re-check,
// typed-name validation, the server-owned photo labels, the
// server-derived snapshot + canonical hash, the render-time
// integrity comparison, and the INSERT -- lives in
// lib/consent/sign-consent-form.ts so there is exactly ONE
// implementation in the tree.
//
// What stays HERE, deliberately, because it is portal-specific:
//   * identity: getCurrentPortalSession() is what scopes this call.
//     The core never resolves identity itself; each surface owns
//     proving who is signing.
//   * the createAdminClient() call. The core takes an injected
//     client so it stays off the service-role allowlist inventory,
//     which should keep naming the surfaces that resolve identity.
//   * the card_authorization pointer refresh (PR #177), fail-soft.
//   * revalidatePath("/portal").
//
// Critical security invariants (mirrors PR #129 spec for replies),
// all now enforced inside the core:
//   * Requires a valid portal session.
//   * Template lookup MUST match all four of:
//       id = templateId
//       studio_id = session.studioId
//       is_live = true
//       status = 'active'
//     so a forged template id from another studio or a draft /
//     archived / not-live template cannot resolve.
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
//   * Signatures are immutable: INSERT only. There is no update /
//     delete path. Multiple signatures of the same (client,
//     template) pair are preserved as point-in-time historical rows.
//
// NEW IN THIS PR -- the stale-form refusal. The rendered template
// hash arrives as `rendered_template_hash` and is a COMPARAND only:
// the core recomputes the canonical hash of the row it resolved and
// refuses if they differ. This is the ONLY behavioural change to the
// portal; everything else is byte-equivalent.

export type SignConsentFormResult =
  | { ok: true; signatureId: string }
  | { ok: false; error: string };

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

export async function signConsentFormAction(
  formData: FormData,
): Promise<SignConsentFormResult> {
  const templateId = (formData.get("template_id") ?? "").toString().trim();
  const signatureNameRaw = (formData.get("signature_name") ?? "")
    .toString()
    .trim();
  // Client-side checkbox state arrives as the literal string 'true'
  // only when ticked; any other shape (missing field, 'false',
  // other) is treated as unconfirmed. The DB row has no analogous
  // boolean column because the row's existence + the checked-only
  // post path IS the agreement.
  const agreed = (formData.get("agreed") ?? "").toString().trim();
  // PR #137. Photo-consent response. For non-photo forms the core
  // ignores this field and writes 'accepted'; for photo_consent
  // forms the response is required and must be exactly 'accepted'
  // or 'denied'.
  const responseRaw = (formData.get("response") ?? "").toString().trim();
  // Comparand for the stale-render check. Never stored, never
  // trusted as data.
  const renderedTemplateHash = (formData.get("rendered_template_hash") ?? "")
    .toString()
    .trim();

  const session = await getCurrentPortalSession();
  if (!session) {
    return { ok: false, error: "Your portal session has expired." };
  }

  const hdrs = await headers();

  const result = await recordConsentSignature({
    admin: createAdminClient(),
    identity: { studioId: session.studioId, clientId: session.clientId },
    interaction: {
      templateId,
      typedName: signatureNameRaw,
      agreed: agreed === "true",
      response: responseRaw.length > 0 ? responseRaw : null,
      renderedTemplateHash,
    },
    // The portal signs EVERY live form type, including
    // card_authorization. Passing no restriction preserves that
    // exactly; narrowing here would silently change portal
    // behaviour.
    ipHash: hashFingerprint(clientIpFromHeaders(hdrs)),
    userAgentHash: hashFingerprint(hdrs.get("user-agent")),
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
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
  if (result.formType === "card_authorization") {
    const refresh = await refreshActiveCardAuthorizationPointersForSignature({
      studioId: session.studioId,
      clientId: session.clientId,
      signatureId: result.signatureId,
    });
    if (!refresh.ok) {
      // The helper has already recorded the critical ops_alert.
      // Mirror to the structured stderr log so a Vercel-log-only
      // operator sees the same line they would have seen if the
      // alert insert had also failed.
      console.error(
        JSON.stringify({
          event: "consent_sign_pointer_refresh_failed",
          templateId,
          signatureId: result.signatureId,
          reason: refresh.reason,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  revalidatePath("/portal");
  return { ok: true, signatureId: result.signatureId };
}
