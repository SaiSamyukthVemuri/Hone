// Stripe Connect Express account create-or-load + onboarding link.
// Phase 1: onboarding and status only. No charges, no SetupIntents,
// no PaymentIntents, no customer card collection.
//
// Identity discipline: every public function takes a server-resolved
// studioId. Callers MUST use getCurrentPractitionerWithStudio() (or an
// equivalent authenticated resolver) and pass that studio.id in. None
// of the helpers below trust browser-supplied IDs.

import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  STRIPE_CONNECT_COUNTRY,
  getStripe,
  inferStripeLivemode,
} from "./server";

function logInternalStripeError(event: string, detail: unknown) {
  try {
    console.error(
      JSON.stringify({ event, detail, timestamp: new Date().toISOString() }),
    );
  } catch {
    console.error(event, detail);
  }
}

// ---------------------------------------------------------------------------
// createOrLoadConnectedAccountForStudio
// ---------------------------------------------------------------------------
//
// Uses the SECURITY DEFINER RPC `create_or_claim_stripe_account_provisioning`
// (migration 0032) to serialize concurrent calls. Stripe's accounts.create
// is invoked at most once per studio. A second concurrent call sees the
// in-flight or already-provisioned attempt and returns the existing
// stripe_account_id.
//
// Returns the canonical stripe account id for the studio.
// ---------------------------------------------------------------------------
export type CreateOrLoadResult = {
  stripeAccountId: string;
  livemode: boolean;
  alreadyProvisioned: boolean;
};

export async function createOrLoadConnectedAccountForStudio(
  studioId: string,
): Promise<CreateOrLoadResult> {
  const admin = createAdminClient();
  const stripe = getStripe();
  const livemode = inferStripeLivemode();

  const { data: claimRows, error: claimErr } = await admin.rpc(
    "create_or_claim_stripe_account_provisioning",
    { p_studio_id: studioId, p_stripe_livemode: livemode },
  );
  if (claimErr) {
    logInternalStripeError("create_or_claim_provisioning_failed", {
      code: claimErr.code,
      message: claimErr.message,
      studioId,
    });
    throw new Error("Could not start Stripe onboarding. Please try again.");
  }
  const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
  if (!claim) {
    logInternalStripeError("create_or_claim_provisioning_empty", { studioId });
    throw new Error("Could not start Stripe onboarding. Please try again.");
  }

  // Already-provisioned short-circuit. The studio's settings row holds
  // a stripe_account_id; reuse it.
  if (claim.already_provisioned && claim.out_stripe_account_id) {
    return {
      stripeAccountId: claim.out_stripe_account_id,
      livemode: claim.out_stripe_livemode ?? livemode,
      alreadyProvisioned: true,
    };
  }

  // If another worker is mid-claim we wait by returning the existing
  // in-flight account id (if Stripe has already issued one) — Stripe's
  // accounts.create is idempotency-keyed below so the second worker's
  // retry collapses with the first.
  if (!claim.should_execute_stripe_call) {
    // The RPC told us not to call Stripe. If an account id is already
    // recorded against the attempt we can resolve immediately.
    if (claim.out_stripe_account_id) {
      return {
        stripeAccountId: claim.out_stripe_account_id,
        livemode: claim.out_stripe_livemode ?? livemode,
        alreadyProvisioned: false,
      };
    }
    // Otherwise the caller should retry later. We surface a clear
    // user-facing message and DO NOT call Stripe.
    throw new Error(
      "Stripe onboarding is already starting in another window. " +
        "Refresh in a few seconds.",
    );
  }

  // We own the claim. Call Stripe.accounts.create with the RPC-supplied
  // idempotency key so retries collapse on Stripe's side.
  let account: Stripe.Account;
  try {
    account = await stripe.accounts.create(
      {
        type: "express",
        country: STRIPE_CONNECT_COUNTRY,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          hone_studio_id: studioId,
        },
      },
      { idempotencyKey: claim.out_idempotency_key ?? undefined },
    );
  } catch (err) {
    logInternalStripeError("stripe_accounts_create_failed", {
      studioId,
      stripeError: extractStripeError(err),
    });
    // Mark the provisioning attempt failed so a future caller can retry.
    try {
      const { error: markErr } = await admin.rpc(
        "mark_stripe_account_provisioning_failed",
        {
          p_attempt_id: claim.attempt_id,
          p_claim_token: claim.out_processing_claim_token,
          p_error_code: extractStripeErrorCode(err),
          p_error_message: "stripe_accounts_create_failed",
        },
      );
      if (markErr) {
        logInternalStripeError("mark_provisioning_failed_failed", { markErr });
      }
    } catch (markErr) {
      logInternalStripeError("mark_provisioning_failed_threw", { markErr });
    }
    throw new Error("Stripe could not create the connected account.");
  }

  const { error: completeErr } = await admin.rpc(
    "complete_stripe_account_provisioning",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.out_processing_claim_token,
      p_stripe_account_id: account.id,
      p_stripe_livemode: livemode,
    },
  );
  if (completeErr) {
    logInternalStripeError("complete_provisioning_failed", {
      code: completeErr.code,
      message: completeErr.message,
      studioId,
      stripeAccountId: account.id,
    });
    // Stripe account exists on Stripe's side; the local binding failed
    // to install. Surface a clear error; the next call will see the
    // existing attempt row and reconcile.
    throw new Error(
      "Connected account created on Stripe but local binding failed. " +
        "Refresh status from Stripe to reconcile.",
    );
  }

  return {
    stripeAccountId: account.id,
    livemode,
    alreadyProvisioned: false,
  };
}

// ---------------------------------------------------------------------------
// createConnectOnboardingLink
// ---------------------------------------------------------------------------
//
// Creates a one-shot Stripe AccountLink. The returned URL is short-lived
// (currently ~5 minutes from Stripe) and must be redirected to from the
// server action that called this helper.
// ---------------------------------------------------------------------------
export async function createConnectOnboardingLink(params: {
  stripeAccountId: string;
  appOrigin: string;
}): Promise<string> {
  const stripe = getStripe();
  try {
    const link = await stripe.accountLinks.create({
      account: params.stripeAccountId,
      type: "account_onboarding",
      return_url: `${params.appOrigin}/settings/payments/return`,
      refresh_url: `${params.appOrigin}/settings/payments/refresh`,
    });
    return link.url;
  } catch (err) {
    logInternalStripeError("stripe_account_link_failed", {
      stripeAccountId: params.stripeAccountId,
      stripeError: extractStripeError(err),
    });
    throw new Error(
      "Could not start Stripe onboarding. Please try again in a moment.",
    );
  }
}

// ---------------------------------------------------------------------------
// createExpressDashboardLoginLink
// ---------------------------------------------------------------------------
//
// Returns a Stripe-hosted login link to the Express dashboard for an
// already-onboarded connected account. Only call when
// charges_enabled || payouts_enabled is true; Stripe rejects login
// link requests for accounts that haven't completed onboarding.
// ---------------------------------------------------------------------------
export async function createExpressDashboardLoginLink(
  stripeAccountId: string,
): Promise<string> {
  const stripe = getStripe();
  try {
    const link = await stripe.accounts.createLoginLink(stripeAccountId);
    return link.url;
  } catch (err) {
    logInternalStripeError("stripe_login_link_failed", {
      stripeAccountId,
      stripeError: extractStripeError(err),
    });
    throw new Error("Could not open the Stripe dashboard. Try again.");
  }
}

// ---------------------------------------------------------------------------
// refreshAccountStatusFromStripe
// ---------------------------------------------------------------------------
//
// Reads the connected account from Stripe and syncs the cached status
// columns onto studio_payment_settings via the sync_studio_account_status
// RPC. Returns the freshly synced status fields. Callers MUST already
// have a stripe_account_id bound for the studio (i.e. createOrLoad has
// been run at least once).
// ---------------------------------------------------------------------------
export type AccountStatusSnapshot = {
  status: "pending" | "restricted" | "enabled" | "rejected";
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingCompletedAt: string | null;
  requirementsCurrentlyDue: string[];
  requirementsEventuallyDue: string[];
};

export async function refreshAccountStatusFromStripe(params: {
  studioId: string;
  stripeAccountId: string;
}): Promise<AccountStatusSnapshot> {
  const stripe = getStripe();
  const livemode = inferStripeLivemode();

  let account: Stripe.Account;
  try {
    account = await stripe.accounts.retrieve(params.stripeAccountId);
  } catch (err) {
    logInternalStripeError("stripe_accounts_retrieve_failed", {
      stripeAccountId: params.stripeAccountId,
      stripeError: extractStripeError(err),
    });
    throw new Error("Could not refresh status from Stripe. Try again.");
  }

  const snapshot = accountToStatusSnapshot(account);

  const admin = createAdminClient();

  // Preserve-first-completion semantics. sync_studio_account_status
  // uses `coalesce(p_onboarding_completed_at, sps.stripe_onboarding_completed_at)`
  // so a non-null timestamp overwrites the stored value. We never
  // want to bump the first-completion timestamp on subsequent
  // refreshes — that would forge the "when did onboarding finish"
  // record. We therefore SEND null to the RPC if the stored value
  // is already set; only the first observation of charges_enabled
  // (when the stored timestamp is still null) writes a real value.
  const { data: existingSettings } = await admin
    .from("studio_payment_settings")
    .select("stripe_onboarding_completed_at")
    .eq("studio_id", params.studioId)
    .maybeSingle();
  const onboardingCompletedAtForRpc =
    existingSettings?.stripe_onboarding_completed_at != null
      ? null
      : snapshot.onboardingCompletedAt;

  const { error: syncErr } = await admin.rpc("sync_studio_account_status", {
    p_studio_id: params.studioId,
    p_stripe_account_id: params.stripeAccountId,
    p_stripe_livemode: livemode,
    p_status: snapshot.status,
    p_charges_enabled: snapshot.chargesEnabled,
    p_payouts_enabled: snapshot.payoutsEnabled,
    p_onboarding_completed_at: onboardingCompletedAtForRpc,
  });
  if (syncErr) {
    logInternalStripeError("sync_studio_account_status_failed", {
      code: syncErr.code,
      message: syncErr.message,
      studioId: params.studioId,
    });
    throw new Error("Stripe status refresh succeeded but local sync failed.");
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function accountToStatusSnapshot(
  account: Stripe.Account,
): AccountStatusSnapshot {
  const chargesEnabled = account.charges_enabled === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const requirementsCurrentlyDue = (account.requirements?.currently_due ?? []).slice();
  const requirementsEventuallyDue = (account.requirements?.eventually_due ?? []).slice();
  const disabledReason = account.requirements?.disabled_reason ?? null;

  let status: AccountStatusSnapshot["status"];
  if (disabledReason === "rejected.fraud" || disabledReason === "rejected.terms_of_service" || disabledReason === "rejected.other") {
    status = "rejected";
  } else if (chargesEnabled) {
    status = "enabled";
  } else if (requirementsCurrentlyDue.length > 0 || requirementsEventuallyDue.length > 0) {
    status = "restricted";
  } else {
    status = "pending";
  }

  const onboardingCompletedAt = chargesEnabled ? new Date().toISOString() : null;

  return {
    status,
    chargesEnabled,
    payoutsEnabled,
    onboardingCompletedAt,
    requirementsCurrentlyDue,
    requirementsEventuallyDue,
  };
}

function extractStripeError(err: unknown): Record<string, unknown> {
  if (typeof err === "object" && err !== null) {
    // Avoid serializing the entire error (may contain raw key fragments).
    const anyErr = err as Record<string, unknown>;
    return {
      type: anyErr.type ?? null,
      code: anyErr.code ?? null,
      statusCode: anyErr.statusCode ?? null,
      requestId: anyErr.requestId ?? null,
      // Intentionally do NOT include err.raw or err.message that may
      // contain user-supplied fields.
    };
  }
  return { type: "unknown" };
}

function extractStripeErrorCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return "stripe_unknown";
}
