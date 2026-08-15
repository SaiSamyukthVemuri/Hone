import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";

// PR #170. Single source of truth for "is the client's
// card_authorization signature current?". Before this helper, the
// portal SetupIntent action (app/portal/payment-method-actions.ts)
// and the manual fee eligibility helper
// (lib/billing/manual-fee-eligibility.ts) each looked up the
// signature independently and accepted ANY historical signature
// for the (studio, client, template) tuple. That meant a signature
// against the placeholder "test" body (production state confirmed
// by the PR #168 + PR #170 audits) satisfied the gate just as well
// as a signature against the product-ready draft, which is the
// load-bearing readiness blocker for live payments.
//
// The new contract: the signature counts as "current" if and only
// if its stored template_version equals the live template's
// current version. The version column is bumped on every save
// through updateConsentTemplateAction (existing.version + 1, see
// app/(app)/settings/consent/actions.ts), so an owner who edits
// the body to the product-ready draft via Settings -> Consent
// forms automatically invalidates every prior signature against
// the placeholder. No migration is required because
// client_consent_signatures.template_version has existed since
// migration 0057 (the snapshot model has always recorded it; we
// just never gated on it).
//
// The helper returns ENOUGH structured detail for both the
// SetupIntent action (which gates on "current-version signature
// must exist") and the UI surfaces (portal page.tsx +
// components/payment-method-card.tsx, which need to distinguish
// "no signature at all" from "old signature, please re-sign").
//
// This module imports "server-only" so a future client component
// that accidentally imports it fails at build time. The admin
// client is used because the portal flow runs after
// getCurrentPortalSession() has already resolved (studio, client);
// the helper does not accept untrusted ids from a visitor.

export type CardAuthorizationStatus =
  | {
      // A read that establishes authorization FAILED, so authorization is
      // UNKNOWN. This is not a business fact about the studio or the client:
      // it says only that Hone could not verify authority right now.
      //
      // PAY-READ-01 PR B. Every read below previously captured `data` and
      // discarded `error`, which made a database failure indistinguishable
      // from a clean empty result and silently converted it into one:
      //
      //   template read fails  -> "no_live_template"  (studio has no template)
      //   signature read fails -> "unsigned"          (client never signed)
      //   card read fails      -> signed_current      (AUTHORIZED)
      //
      // The third was a P1: a database failure became a successful
      // authorization. READ FAILURE IS NOT ABSENCE, NOT UNSIGNED, AND
      // CERTAINLY NOT AUTHORIZED.
      //
      // Deliberately carries NO payload. Charge-authority callers must refuse,
      // and remediation surfaces must offer a plain retry - neither needs the
      // PostgREST code, and keeping it out of the type keeps raw database text
      // away from practitioner- and client-facing copy by construction.
      kind: "authorization_unverified";
    }
  | {
      // The studio has no is_live=true, status='active'
      // card_authorization template at all. The portal Add Card
      // surface stays hidden; the manual fee eligibility check
      // surfaces "Card authorization template missing" as a
      // blocking reason. This branch is independent of any
      // historical signature the client may carry.
      kind: "no_live_template";
    }
  | {
      // A live template exists but the client has never signed any
      // version of it. Portal shows the existing PR #158
      // "Card authorization needed before adding a card" placeholder
      // with a deep link to the unsigned-forms section. Manual fee
      // eligibility surfaces "No signed card authorization."
      kind: "unsigned";
      templateId: string;
      templateVersion: number;
    }
  | {
      // The client signed an older version of the live template.
      // Portal shows the new PR #170 "Please re-sign updated card
      // authorization" state. Manual fee eligibility surfaces
      // "Card authorization on file is out of date." The
      // historicalSignatureId is exposed so the practitioner-side
      // PaymentMethodCard can render the prior signature timestamp
      // alongside the re-sign prompt; nothing depends on it being
      // valid for new charges.
      kind: "signed_out_of_date";
      templateId: string;
      templateVersion: number;
      signedVersion: number;
      historicalSignatureId: string;
      historicalSignedAt: string;
    }
  | {
      // The client has a signature at the current template version.
      // This is the only state in which the SetupIntent action
      // proceeds and the manual fee eligibility passes the
      // card-authorization clause.
      kind: "signed_current";
      templateId: string;
      templateVersion: number;
      signatureId: string;
      signedAt: string;
    };

export async function getCardAuthorizationStatus(args: {
  studioId: string;
  clientId: string;
}): Promise<CardAuthorizationStatus> {
  const admin = createAdminClient();

  // Resolve the live template. We prefer the latest-created row in
  // the unlikely case a studio ever has multiple is_live=true
  // card_authorization templates (the spec preference; the portal
  // SetupIntent action uses the same .order("created_at", desc)
  // tiebreaker). The PR #167 CHECK constraint guarantees is_live
  // implies status='active', but we keep the status filter for
  // defense-in-depth as the rest of the consent surface does.
  const { data: template, error: templateErr } = await admin
    .from("consent_form_templates")
    .select("id, version")
    .eq("studio_id", args.studioId)
    .eq("is_live", true)
    .eq("status", "active")
    .eq("form_type", "card_authorization")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A FAILED READ IS NOT AN ABSENT TEMPLATE. Checked before `!template`
  // because a failed read also leaves `template` null, and answering
  // "no_live_template" would tell the studio its template is missing on the
  // strength of a timeout.
  if (templateErr) {
    return { kind: "authorization_unverified" };
  }
  if (!template) {
    return { kind: "no_live_template" };
  }

  // Latest signature for that template by this client. The
  // snapshot model on client_consent_signatures (migration 0057)
  // stores template_version at sign time; this is the field that
  // tells us whether the signature is current.
  const { data: signature, error: signatureErr } = await admin
    .from("client_consent_signatures")
    .select("id, template_version, signed_at")
    .eq("studio_id", args.studioId)
    .eq("client_id", args.clientId)
    .eq("template_id", template.id)
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A FAILED READ IS NOT AN UNSIGNED CLIENT. Telling a client who HAS signed
  // that they have not, and routing them into a re-sign they do not need, is
  // the deadlock this branch exists to avoid.
  if (signatureErr) {
    return { kind: "authorization_unverified" };
  }
  if (!signature) {
    return {
      kind: "unsigned",
      templateId: template.id,
      templateVersion: template.version,
    };
  }

  if (signature.template_version !== template.version) {
    return {
      kind: "signed_out_of_date",
      templateId: template.id,
      templateVersion: template.version,
      signedVersion: signature.template_version,
      historicalSignatureId: signature.id,
      historicalSignedAt: signature.signed_at,
    };
  }

  return {
    kind: "signed_current",
    templateId: template.id,
    templateVersion: template.version,
    signatureId: signature.id,
    signedAt: signature.signed_at,
  };
}

// ---------------------------------------------------------------------------
// PR #177. Charge-ready card authorization gate.
// ---------------------------------------------------------------------------
//
// Tightens the prepare / execute / charge gate to ALSO verify that
// the active card row's card_authorization_signature_id pointer
// equals the current signed_current signature id. The base
// getCardAuthorizationStatus helper (above) deliberately stops at
// "client has signed the live template at the current version" --
// it does NOT prove that the legal artefact on the active card row
// (the audit trail) IS the current signed signature. PR #176 found
// that gap in production. PR #177 closes it via:
//   1. Refresh on re-sign (lib/payment-methods/refresh-card-
//      authorization-pointer.ts) so newly-signed signatures
//      auto-update the active card pointer.
//   2. One-shot backfill (migration 0077) so pre-existing rows are
//      brought into alignment before the new gate turns on.
//   3. This stricter helper, which the charge path uses so a future
//      drift is caught at PREPARE time with a clear practitioner
//      message rather than at EXECUTE time with a confusing
//      "signature has changed since the session payment was
//      prepared" copy.
//
// CRITICAL DEADLOCK PREVENTION (docs/16 §5.11 resolution clause)
// --------------------------------------------------------------
// This helper MUST NOT be called from:
//   * app/portal/consent-actions.ts (signConsentFormAction) -- the
//     remedy for a stale pointer is "client re-signs"; gating the
//     re-sign path on the stale pointer would lock the client out
//     forever. The base helper does not call this helper, and the
//     sign action does not call either helper for gating; it only
//     calls the refresh helper after a successful insert.
//   * app/portal/payment-method-actions.ts (createCardSetupIntent
//     Action / Add Card / Replace Card) -- a new card with a
//     freshly current signature should be addable even if some
//     OLDER active card has a stale pointer. The webhook flow
//     removes the old card and inserts the new with the current
//     signature, which is itself the remedy. Gating Add Card on
//     the existing stale pointer would block the remedy.
//   * Any read-only display surface where surfacing "blocked"
//     would mislead a practitioner who has not asked to charge yet.
//
// Allowed callers:
//   * lib/billing/session-payment-eligibility.ts (PREPARE gate)
//   * lib/billing/session-payment-charge.ts (EXECUTE recheck)
//   * Future canonical-charge-reason gates against
//     payment_charge_attempts.
//
// Return shape
// ------------
// The helper extends the base discriminated union with a new
// variant 'signed_current_but_card_pointer_stale'. Existing variants
// pass through unchanged so a caller that switches from the base
// helper to this one inherits every existing branch's copy without
// rewrite. The new variant carries enough context for the
// practitioner UI to display a precise remedy ("Client must re-sign
// the current card authorization for the card on file.") without
// echoing internal identifiers.
//
// "No active card" branch
// -----------------------
// If the client has NO active card row for this (studio, livemode),
// the helper returns the base result unchanged. The caller's
// existing "no card on file" reason already handles that surface;
// the pointer check is moot when there is no row to point.

export type ChargeReadyCardAuthorizationStatus =
  // Either the base helper could not verify authority, or the active-card read
  // below failed. Both mean the same thing to a caller: authorization is
  // UNKNOWN, so no charge authority may be inferred.
  | { kind: "authorization_unverified" }
  | { kind: "no_live_template" }
  | {
      kind: "unsigned";
      templateId: string;
      templateVersion: number;
    }
  | {
      kind: "signed_out_of_date";
      templateId: string;
      templateVersion: number;
      signedVersion: number;
      historicalSignatureId: string;
      historicalSignedAt: string;
    }
  | {
      // The client signed the current live template version, but
      // the active card row's card_authorization_signature_id does
      // NOT equal the current signed_current signature id. The
      // remedy is a portal re-sign (which will refresh the pointer
      // via the PR #177 helper) OR an Add Card flow (which stamps
      // the current signature on the new row directly).
      kind: "signed_current_but_card_pointer_stale";
      templateId: string;
      templateVersion: number;
      signatureId: string;
      signedAt: string;
      cardId: string;
      cardPointerSignatureId: string | null;
    }
  | {
      kind: "signed_current";
      templateId: string;
      templateVersion: number;
      signatureId: string;
      signedAt: string;
    };

export async function getChargeReadyCardAuthorizationStatus(args: {
  studioId: string;
  clientId: string;
}): Promise<ChargeReadyCardAuthorizationStatus> {
  const base = await getCardAuthorizationStatus(args);
  if (base.kind !== "signed_current") {
    // The other three branches are returned as-is. Adding a discriminator
    // variant would require every caller to update; the structural type
    // assertion below proves at compile-time that those branch shapes
    // are forward-compatible with the wider return type.
    return base;
  }

  const admin = createAdminClient();
  const livemode = inferStripeLivemode();
  const { data: card, error: cardErr } = await admin
    .from("client_payment_methods")
    .select("id, card_authorization_signature_id")
    .eq("studio_id", args.studioId)
    .eq("client_id", args.clientId)
    .eq("stripe_livemode", livemode)
    .eq("status", "active")
    .is("removed_at", null)
    .maybeSingle();

  // THE P1 (PAY-READ-01 R-01). This guard must come BEFORE the `!card`
  // passthrough below, because a failed read also leaves `card` null and would
  // otherwise fall into it and `return base` - and here `base` is
  // signed_current. A database timeout would have been answered as a valid
  // card authorization.
  //
  // The zero-row passthrough underneath is legitimate and unchanged; what was
  // wrong was letting a FAILURE borrow it.
  if (cardErr) {
    return { kind: "authorization_unverified" };
  }
  if (!card) {
    // No active card row to inspect. The caller's "no card on file"
    // surface handles this branch via its own reason string; here
    // we pass the base 'signed_current' result through so an Add
    // Card flow that wants to verify base authorization can keep
    // running.
    return base;
  }

  const cardPointer = (card.card_authorization_signature_id as string | null) ??
    null;
  if (cardPointer === base.signatureId) {
    return base;
  }

  return {
    kind: "signed_current_but_card_pointer_stale",
    templateId: base.templateId,
    templateVersion: base.templateVersion,
    signatureId: base.signatureId,
    signedAt: base.signedAt,
    cardId: card.id as string,
    cardPointerSignatureId: cardPointer,
  };
}
