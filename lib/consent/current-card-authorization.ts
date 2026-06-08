import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";

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
  const { data: template } = await admin
    .from("consent_form_templates")
    .select("id, version")
    .eq("studio_id", args.studioId)
    .eq("is_live", true)
    .eq("status", "active")
    .eq("form_type", "card_authorization")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!template) {
    return { kind: "no_live_template" };
  }

  // Latest signature for that template by this client. The
  // snapshot model on client_consent_signatures (migration 0057)
  // stores template_version at sign time; this is the field that
  // tells us whether the signature is current.
  const { data: signature } = await admin
    .from("client_consent_signatures")
    .select("id, template_version, signed_at")
    .eq("studio_id", args.studioId)
    .eq("client_id", args.clientId)
    .eq("template_id", template.id)
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
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
