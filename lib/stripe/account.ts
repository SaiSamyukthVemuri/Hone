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
import { notifyCriticalOpsAlert } from "@/lib/ops/alert-email";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { getStripe, inferStripeLivemode } from "./server";

import {
  ACCOUNT_COUNTRY_MISMATCH_ERROR,
  PAYMENT_COUNTRY_UNVERIFIED_ERROR,
} from "./account-messages";

export { ACCOUNT_COUNTRY_MISMATCH_ERROR, PAYMENT_COUNTRY_UNVERIFIED_ERROR };

// ---------------------------------------------------------------------------
// recordStripeAccountObservation (PAY-CCY-03)
// ---------------------------------------------------------------------------
//
// Stripe is the authority on a connected account's country; the studio's
// jurisdiction (0214) is the authority on the country it SHOULD be in. This
// records what Stripe said (record_stripe_account_jurisdiction: country
// write-once, default currency refreshed) and reports whether the two agree.
// A disagreement raises a critical alert and is returned, never repaired: no
// path in Hone replaces a connected account. Charging fails closed on it in
// the eligibility helper, the charge-time lineage check and the 0214 insert
// guard.
export type AccountObservation =
  | { kind: "match"; accountCountry: string }
  | {
      kind: "mismatch";
      accountCountry: string | null;
      paymentCountry: string | null;
      reason: "country_mismatch" | "country_conflict";
    }
  | { kind: "not_recorded"; reason: "not_bound" | "invalid_input" | "rpc_failed" };

export async function recordStripeAccountObservation(args: {
  studioId: string;
  stripeAccountId: string;
  livemode: boolean;
  account: Pick<Stripe.Account, "country" | "default_currency">;
  route: string;
}): Promise<AccountObservation> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("record_stripe_account_jurisdiction", {
    p_studio_id: args.studioId,
    p_stripe_account_id: args.stripeAccountId,
    p_stripe_livemode: args.livemode,
    p_country: args.account.country ?? null,
    p_default_currency: args.account.default_currency ?? null,
  });
  if (error) {
    logInternalStripeError("record_stripe_account_jurisdiction_failed", {
      code: error.code,
      message: error.message,
      studioId: args.studioId,
    });
    return { kind: "not_recorded", reason: "rpc_failed" };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        out_result: string;
        out_account_country: string | null;
        out_payment_country: string | null;
        out_matches: boolean | null;
      }
    | null;
  if (!row || row.out_result === "not_bound" || row.out_result === "invalid_input") {
    return {
      kind: "not_recorded",
      reason: row?.out_result === "invalid_input" ? "invalid_input" : "not_bound",
    };
  }
  if (row.out_result !== "country_conflict" && row.out_matches === true) {
    return { kind: "match", accountCountry: row.out_account_country ?? "" };
  }
  const reason =
    row.out_result === "country_conflict" ? "country_conflict" : "country_mismatch";
  // 0238 owns the durable row and serializes open incidents. Never call
  // recordOpsAlert here: that would insert another row and email every retry.
  try {
    const { data: claims, error: claimError } = await admin.rpc(
      "claim_stripe_account_country_alert",
      { p_studio_id: args.studioId, p_stripe_account_id: args.stripeAccountId,
        p_stripe_livemode: args.livemode },
    );
    const claim = (Array.isArray(claims) ? claims[0] : claims) as {
      out_result: string; out_alert_id: string | null; out_created_at: string | null;
      out_reason: string | null; out_message: string | null;
    } | null;
    if (claimError || !claim || !["created", "existing", "not_mismatched"].includes(claim.out_result)) {
      logInternalStripeError("stripe_account_country_alert_claim_failed", {
        studioId: args.studioId, stripeAccountId: args.stripeAccountId,
        livemode: args.livemode, reason, code: claimError?.code ?? null,
        result: claim?.out_result ?? null,
      });
    } else if (claim.out_result === "created") {
      if (!claim.out_alert_id || !claim.out_created_at || !claim.out_message ||
          !["country_mismatch", "country_conflict"].includes(claim.out_reason ?? "")) {
        logInternalStripeError("stripe_account_country_alert_claim_invalid", {
          studioId: args.studioId, stripeAccountId: args.stripeAccountId,
        });
      } else {
        await notifyCriticalOpsAlert({
          event: "stripe_account_country_mismatch", message: claim.out_message,
          createdAtIso: claim.out_created_at, studioId: args.studioId,
          route: "lib/stripe/account:recordStripeAccountObservation",
        });
      }
    }
  } catch {
    // Alert failures never turn a country refusal into success. The next
    // observation can retry a rolled-back claim; email remains best effort.
    logInternalStripeError("stripe_account_country_alert_claim_threw", {
      studioId: args.studioId, stripeAccountId: args.stripeAccountId,
      livemode: args.livemode, reason,
    });
  }
  return {
    kind: "mismatch",
    accountCountry: row.out_account_country,
    paymentCountry: row.out_payment_country,
    reason,
  };
}

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

  // PAY-CCY-03. The account is created in the studio's VERIFIED payment
  // country (studio_payment_jurisdictions, 0214), never in a deployment-wide
  // default and never inferred from the timezone. An unread jurisdiction stops
  // here, before any provisioning claim exists.
  const jurisdictionRead = await getStudioPaymentJurisdiction(studioId);
  if (!jurisdictionRead.ok) {
    logInternalStripeError("payment_jurisdiction_unread_at_onboarding", {
      studioId,
      reason: jurisdictionRead.reason,
    });
    throw new Error(PAYMENT_COUNTRY_UNVERIFIED_ERROR);
  }
  const paymentCountry = jurisdictionRead.jurisdiction.country;

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
    // PAY-CCY-03. An EXISTING account whose recorded country is not the
    // studio's, or that Stripe has reported in two countries (0214's
    // persisted conflict), fails closed: no onboarding link is minted for it,
    // and it is never swapped for a new one. An unobserved bound account also
    // stays blocked until refresh or account.updated records its country.
    // Binding succeeds before observation, so a retry must not bypass the
    // new-account observation refusal below.
    const { data: bound, error: boundErr } = await admin
      .from("studio_payment_settings")
      .select("stripe_account_country, stripe_account_country_conflict")
      .eq("studio_id", studioId)
      // The claim RPC is mode-scoped (0103) and was called with this mode.
      .eq("stripe_livemode", livemode)
      .eq("stripe_account_id", claim.out_stripe_account_id)
      .maybeSingle();
    if (boundErr) {
      logInternalStripeError("bound_account_country_read_failed", {
        code: boundErr.code,
        studioId,
      });
      throw new Error(PAYMENT_COUNTRY_UNVERIFIED_ERROR);
    }
    const recorded = (bound?.stripe_account_country as string | null) ?? null;
    const conflict =
      (bound?.stripe_account_country_conflict as string | null) ?? null;
    if ((recorded && recorded !== paymentCountry) || conflict) {
      logInternalStripeError("onboarding_refused_account_country_mismatch", {
        studioId,
        recordedAccountCountry: recorded,
        conflictingAccountCountry: conflict,
        paymentCountry,
      });
      throw new Error(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    }
    if (!recorded) {
      throw new Error(PAYMENT_COUNTRY_UNVERIFIED_ERROR);
    }
    return {
      stripeAccountId: claim.out_stripe_account_id,
      livemode: claim.out_stripe_livemode ?? livemode,
      alreadyProvisioned: true,
    };
  }

  // If another worker is mid-claim we wait by returning the existing
  // in-flight account id (if Stripe has already issued one), Stripe's
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

  // PAY-CCY-03 (Codex P1 4244982189). The country the account is created in
  // is the one STAMPED ON THIS CLAIM (0214 §4f), not the read above: that
  // read happened before the claim, and an operator change committed in
  // between would otherwise create the account for the stale country. The
  // stamp is taken under a share lock that serializes with the change
  // command, and an existing claim refuses every later change, so it cannot
  // go stale.
  const { data: claimRow, error: claimRowErr } = await admin
    .from("stripe_account_provisioning_attempts")
    .select("payment_country")
    .eq("id", claim.attempt_id)
    .eq("studio_id", studioId)
    .maybeSingle();
  const claimCountry = (claimRow?.payment_country as string | null) ?? null;
  if (claimRowErr || (claimCountry !== "CA" && claimCountry !== "US")) {
    logInternalStripeError("provisioning_claim_country_unverified", {
      studioId,
      code: claimRowErr?.code ?? null,
      claimCountry,
    });
    throw new Error(PAYMENT_COUNTRY_UNVERIFIED_ERROR);
  }
  if (claimCountry !== paymentCountry) {
    logInternalStripeError("provisioning_claim_country_changed_since_read", {
      studioId,
      readCountry: paymentCountry,
      claimCountry,
    });
  }

  // We own the claim. Call Stripe.accounts.create with the RPC-supplied
  // idempotency key so retries collapse on Stripe's side.
  let account: Stripe.Account;
  try {
    account = await stripe.accounts.create(
      {
        type: "express",
        country: claimCountry,
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

  // PAY-CCY-03. A newly created account must have its country recorded before
  // provisioning succeeds. Keep the binding for reconciliation on failure;
  // do not report onboarding success with an unobserved new account.
  const observation = await recordStripeAccountObservation({
    studioId,
    stripeAccountId: account.id,
    livemode,
    account,
    route: "lib/stripe/account:createOrLoadConnectedAccountForStudio",
  });
  if (observation.kind === "mismatch") {
    // Stripe created the account in a country other than the one requested.
    // It stays bound (it exists on Stripe and must remain traceable) and is
    // NOT replaced; onboarding stops here.
    throw new Error(ACCOUNT_COUNTRY_MISMATCH_ERROR);
  }

  if (observation.kind === "not_recorded") {
    throw new Error(PAYMENT_COUNTRY_UNVERIFIED_ERROR);
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
    // A response must belong to the bound account before any readiness or
    // completion fact is derived or synchronized onto that studio.
    if (account?.id !== params.stripeAccountId) {
      throw new Error("stripe_account_refresh_identity_unverified");
    }
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
  // refreshes: that would forge the "when did onboarding finish"
  // record. We therefore SEND null to the RPC if the stored value
  // is already set; only the first observation of charges_enabled
  // (when the stored timestamp is still null) writes a real value.
  // Mode-scoped (0103): a studio can hold one settings row per Stripe mode;
  // read the CURRENT deployment mode's row only.
  const { data: existingSettings, error: existingSettingsErr } = await admin
    .from("studio_payment_settings")
    .select("stripe_onboarding_completed_at")
    .eq("studio_id", params.studioId)
    .eq("stripe_livemode", livemode)
    .maybeSingle();
  // PAY-READ-01 R-32. A FAILED READ IS NOT "no first completion recorded".
  // PostgREST leaves `data` null on failure, so the `!= null` test below could
  // not tell a timeout from a studio that has never onboarded, and answered
  // both by sending the CURRENT snapshot timestamp into the RPC. Because the
  // RPC coalesces, that OVERWRITES the stored value: the studio's historical
  // first-completion date silently became "now". This is the same collapse
  // #582 closed in the webhook route's equivalent block.
  //
  // We THROW rather than defaulting to null. Sending null would be safe against
  // overwriting, but it is not correct: when the stored value genuinely is null
  // and this refresh is the first observation of charges_enabled, null would
  // SUPPRESS a legitimate first-completion write and lose the fact entirely.
  // Neither branch of the conditional is answerable without a successful read,
  // so the only honest outcome is to refuse and let the caller retry.
  //
  // Nothing has been written at this point - the RPC below is the only writer -
  // so refusing here leaves local state stale, never corrupted.
  //
  // The message is deliberately generic and carries no database text. It is
  // also deliberately absent from SAFE_USER_FACING_MESSAGES in
  // app/(app)/settings/payments/actions.ts, so `sanitizeForUser` collapses it
  // to the existing retryable GENERIC_STRIPE_ERROR copy, exactly as it already
  // does for the two sibling throws in this function.
  if (existingSettingsErr) {
    logInternalStripeError("studio_payment_settings_preserve_read_failed", {
      code: existingSettingsErr.code,
      message: existingSettingsErr.message,
      studioId: params.studioId,
    });
    throw new Error(
      "Stripe status refresh could not verify local onboarding state. Try again.",
    );
  }
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

  // PAY-CCY-03. Every refresh records the account's country. Status is synced
  // first, so the owner's view of Stripe stays accurate either way; a mismatch
  // is then reported to them rather than shown as a healthy account.
  const observation = await recordStripeAccountObservation({
    studioId: params.studioId,
    stripeAccountId: params.stripeAccountId,
    livemode,
    account,
    route: "lib/stripe/account:refreshAccountStatusFromStripe",
  });
  if (observation.kind === "mismatch") {
    throw new Error(ACCOUNT_COUNTRY_MISMATCH_ERROR);
  }
  if (observation.kind === "not_recorded" && observation.reason === "rpc_failed") {
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
