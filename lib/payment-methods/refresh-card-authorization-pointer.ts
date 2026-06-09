import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { recordOpsAlert } from "@/lib/ops/alerts";

// ---------------------------------------------------------------------------
// PR #177. Card authorization pointer refresh helper.
// ---------------------------------------------------------------------------
//
// The load-bearing write that closes the audit-trail gap recorded in
// docs/16 §5.11 (PR #176 finding). Callers invoke this helper after a
// fresh client_consent_signatures row has been inserted for
// form_type='card_authorization' to bring the active card row's
// audit pointer back in line with the legal artefact that authorizes
// it.
//
// Contract on the caller side
// ---------------------------
// The caller MUST have verified, before invocation:
//   1. A row was inserted into public.client_consent_signatures by
//      the same request.
//   2. The signature is against a template with
//      form_type='card_authorization' AND is_live=true AND
//      status='active'.
//   3. The signature's template_version equals the live template's
//      current version.
// The caller (today: app/portal/consent-actions.ts after
// signConsentFormAction's INSERT) has all of this state on hand.
//
// What this helper does
// ---------------------
// Updates every active, non-removed client_payment_methods row for
//   (studio_id, client_id, stripe_livemode=inferStripeLivemode())
// to set card_authorization_signature_id = signatureId, but ONLY
// when the existing pointer != signatureId (including the NULL case).
// The selection step is read-first so the returned rowsUpdated count
// is the actual delta, not just the row count of an over-broad UPDATE.
//
// In schema today, the partial unique index
// client_payment_methods_one_active_per_pair caps that set to ONE row
// per (studio, client). The helper still iterates the candidate set
// so a future relaxation of the unique index (e.g. a multi-card UX)
// does not silently change refresh semantics.
//
// What this helper does NOT do
// ----------------------------
// * Does NOT call getCardAuthorizationStatus or the charge-only
//   helper. A future deadlock between portal re-sign and the
//   tightened charge gate would be a critical bug; this helper
//   avoids it by construction. See docs/16 §5.11 (resolved) for the
//   deadlock-prevention reasoning.
// * Does NOT call Stripe.
// * Does NOT delete or remove rows.
// * Does NOT cross studio_id, client_id, or stripe_livemode.
// * Does NOT touch rows that are status != 'active' or
//   removed_at IS NOT NULL.
// * Does NOT roll back the signature insert on failure. The
//   signature is durable; this helper is best-effort reconciliation.
//   On a DB error the helper records a critical ops_alert and
//   returns {ok:false} so the caller can surface a safe warning
//   without unwinding the signature.
//
// Forward-compat note
// -------------------
// The fail-soft contract here mirrors the lib/billing/payment-receipt
// pattern from PR #175 (PR #175 patch: sent-but-record-update-failed).
// A future writer that wants to make this transactional would need
// to refactor signConsentFormAction to wrap the signature insert and
// the pointer refresh in a single RPC; that is intentionally NOT in
// PR #177's scope.

const ROUTE =
  "lib/payment-methods/refresh-card-authorization-pointer:refreshActiveCardAuthorizationPointersForSignature";

export type RefreshCardAuthorizationPointerResult =
  | {
      ok: true;
      rowsUpdated: number;
    }
  | {
      ok: false;
      reason: "database_error";
      message: string;
    };

export async function refreshActiveCardAuthorizationPointersForSignature(args: {
  studioId: string;
  clientId: string;
  signatureId: string;
}): Promise<RefreshCardAuthorizationPointerResult> {
  const admin = createAdminClient();
  const livemode = inferStripeLivemode();

  // Step 1. Find the candidate card row(s). Scope is the strictest
  // possible: same studio, same client, same livemode as the running
  // process. Removed cards are explicitly excluded; only active cards
  // are eligible. The schema's partial unique caps the result at one
  // row today, but iterating the set keeps a future multi-card UX
  // safe.
  const { data: candidates, error: selectErr } = await admin
    .from("client_payment_methods")
    .select("id, card_authorization_signature_id")
    .eq("studio_id", args.studioId)
    .eq("client_id", args.clientId)
    .eq("stripe_livemode", livemode)
    .eq("status", "active")
    .is("removed_at", null);

  if (selectErr) {
    await recordOpsAlert({
      severity: "critical",
      event: "card_authorization_pointer_refresh_failed",
      message:
        "Failed to read active card_payment_methods rows when refreshing card_authorization_signature_id pointer. The signature was saved but the pointer was not refreshed. Manual reconciliation required.",
      studioId: args.studioId,
      clientId: args.clientId,
      route: ROUTE,
      safeDetails: {
        signature_id: args.signatureId,
        db_phase: "select_candidates",
        db_code: selectErr.code ?? null,
      },
    });
    return {
      ok: false,
      reason: "database_error",
      message:
        "Your signature was saved, but we could not refresh the card-on-file authorization record. The studio will reconcile this.",
    };
  }

  // No active card at all: nothing to refresh. The signature is
  // saved; future Add Card will stamp the current signature directly
  // (see app/portal/payment-method-actions.ts, createCardSetupIntentAction).
  // This branch is the "fresh client" case and must NOT fail the
  // signing path.
  if (!candidates || candidates.length === 0) {
    return { ok: true, rowsUpdated: 0 };
  }

  // Filter to rows whose pointer is actually stale relative to the
  // new signature id. `!== signatureId` treats NULL as stale (NULL
  // pointer becomes the new signature id) and an equal pointer as
  // no-op.
  const staleIds = candidates
    .filter(
      (c) =>
        (c.card_authorization_signature_id as string | null) !==
        args.signatureId,
    )
    .map((c) => c.id as string);

  if (staleIds.length === 0) {
    return { ok: true, rowsUpdated: 0 };
  }

  const { data: updated, error: updateErr } = await admin
    .from("client_payment_methods")
    .update({ card_authorization_signature_id: args.signatureId })
    .in("id", staleIds)
    .select("id");

  if (updateErr) {
    await recordOpsAlert({
      severity: "critical",
      event: "card_authorization_pointer_refresh_failed",
      message:
        "Failed to write the refreshed card_authorization_signature_id pointer after signature insert. Manual reconciliation required.",
      studioId: args.studioId,
      clientId: args.clientId,
      route: ROUTE,
      safeDetails: {
        signature_id: args.signatureId,
        stale_card_ids: staleIds.join(","),
        db_phase: "update_pointer",
        db_code: updateErr.code ?? null,
      },
    });
    return {
      ok: false,
      reason: "database_error",
      message:
        "Your signature was saved, but we could not refresh the card-on-file authorization record. The studio will reconcile this.",
    };
  }

  return { ok: true, rowsUpdated: updated?.length ?? 0 };
}
