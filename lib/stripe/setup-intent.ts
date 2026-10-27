import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe, inferStripeLivemode } from "@/lib/stripe/server";
import { dbErrorCode, stripeErrorFields, thrownErrorClass } from "@/lib/logging/error-class";

// PR #135. Card-on-file Phase 1 helpers. Two server-only utilities:
//   1. getOrCreateStripeCustomerForCardOnFile - serialises the
//      Stripe Customer create against the existing 0032 customer
//      provisioning RPCs so concurrent portal Add card clicks
//      cannot mint duplicate Stripe Customer rows for the same
//      (studio, client, account, mode) tuple.
//   2. createCardOnFileSetupIntent - thin wrapper that calls
//      stripe.setupIntents.create on the connected account with the
//      correct metadata. Returns the {client_secret, setupIntentId}
//      to the caller; the caller is responsible for passing the
//      client_secret to the portal Stripe Elements form.
//
// Neither helper writes to client_payment_methods. That insert
// happens in the setup_intent.succeeded webhook arm so the row is
// only created from server-side Stripe-verified data.

export type StripeCustomerResolution =
  | {
      ok: true;
      stripeCustomerId: string;
    }
  | {
      ok: false;
      // The portal action surfaces a generic "Please try again."
      // string; this enum is for the sanitized server log.
      error:
        | "missing_email"
        | "provisioning_in_flight"
        | "provisioning_rpc_failed"
        | "stripe_customer_create_failed"
        | "complete_rpc_failed";
      // CLOSED: a SQLSTATE / PostgREST code, or a thrown-error class with the
      // Stripe SDK's documented type and code. Never a message: a Postgres or
      // Stripe message can quote the value it rejected, and the portal action
      // logs this field whole.
      detail?: string;
    };

function stripeFailureDetail(err: unknown): string {
  const { stripeType, stripeCode } = stripeErrorFields(err);
  return [thrownErrorClass(err), stripeType, stripeCode].filter(Boolean).join(":");
}

// Idempotent get-or-create. Reuses the existing 0032 RPCs:
//
//   create_or_claim_stripe_customer_provisioning -> idempotent claim
//   complete_stripe_customer_provisioning        -> commit after Stripe ok
//
// Mirrors the pattern in lib/stripe/account.ts (account provisioning)
// without duplicating its logic. The Stripe SDK call is keyed on the
// RPC's returned idempotency key so a re-run produces the same
// Customer id rather than a duplicate.
//
// Concurrency contract: callers MUST be prepared for
// 'provisioning_in_flight' (another worker / browser tab is
// currently provisioning the same tuple). The portal action treats
// that as a retryable error and surfaces "Please try again." to
// the visitor without crashing.
// Payload version of the customers.create request, appended to the RPC's
// idempotency key. Stripe rejects a reused key whose parameters differ, and
// the stale-claim path replays the attempt's ORIGINAL key. An attempt that
// reached Stripe before G-09 shipped sent the client name, so replaying its
// bare key with the opaque-id payload would fail and block that client's card
// setup. A new version gives the new payload its own key space: a pre-G-09
// attempt that already created a customer leaves that customer unmapped on
// the connected account instead of blocking. Bump it whenever the
// customers.create parameters change.
export const CUSTOMER_CREATE_PAYLOAD_VERSION = "opaque_ids_v2";

export function customerCreateIdempotencyKey(attemptKey: string): string {
  return `${attemptKey}:${CUSTOMER_CREATE_PAYLOAD_VERSION}`;
}

export async function getOrCreateStripeCustomerForCardOnFile(params: {
  admin: SupabaseClient;
  studioId: string;
  clientId: string;
  stripeAccountId: string;
  stripeLivemode: boolean;
  // No client name, email or phone goes to Stripe (HIPAA-READY-01 G-09,
  // #828). The connected-account customer is identified by opaque Hone ids
  // only; reconciliation resolves the client through Hone's own rows.
}): Promise<StripeCustomerResolution> {
  const { admin, studioId, clientId, stripeAccountId, stripeLivemode } = params;

  // Step 1: claim. RPC enforces normalized_email present on the
  // clients row; an empty / missing email surfaces as the
  // 'P0002' SQLSTATE we recognise here.
  const { data: claimRows, error: claimErr } = await admin.rpc(
    "create_or_claim_stripe_customer_provisioning",
    {
      p_client_id: clientId,
      p_studio_id: studioId,
      p_stripe_account_id: stripeAccountId,
      p_stripe_livemode: stripeLivemode,
    },
  );
  if (claimErr) {
    if (claimErr.code === "P0002") {
      return { ok: false, error: "missing_email", detail: dbErrorCode(claimErr) };
    }
    return {
      ok: false,
      error: "provisioning_rpc_failed",
      detail: dbErrorCode(claimErr),
    };
  }
  const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
  if (!claim) {
    return { ok: false, error: "provisioning_rpc_failed", detail: "empty_rows" };
  }

  // Fast path 1: customer already provisioned. Reuse the existing
  // stripe_customer_id without any Stripe call.
  if (claim.already_provisioned === true && claim.out_stripe_customer_id) {
    return { ok: true, stripeCustomerId: claim.out_stripe_customer_id as string };
  }

  // Fast path 2: another in-flight provisioning. The RPC returns
  // should_execute_stripe_call=false when an earlier 'succeeded' or
  // 'processing' attempt is still active. We surface as a retryable
  // error so the visitor can re-click rather than racing with the
  // other worker.
  if (
    claim.should_execute_stripe_call !== true ||
    typeof claim.out_idempotency_key !== "string" ||
    !claim.out_idempotency_key ||
    typeof claim.attempt_id !== "string" ||
    !claim.attempt_id ||
    typeof claim.out_processing_claim_token !== "string"
  ) {
    return { ok: false, error: "provisioning_in_flight" };
  }

  // Step 2: Stripe Customer create on the connected account, keyed
  // by the RPC's idempotency key. Description / metadata carry opaque
  // ids only, enough to triage the connected-account dashboard against
  // Hone. No card-touching information and no client name are sent.
  const stripe = getStripe();
  let stripeCustomerId: string;
  try {
    const customer = await stripe.customers.create(
      {
        description: `Hone studio ${studioId} / client ${clientId}`,
        metadata: {
          hone_studio_id: studioId,
          hone_client_id: clientId,
          hone_source: "portal_card_on_file",
        },
      },
      {
        stripeAccount: stripeAccountId,
        idempotencyKey: customerCreateIdempotencyKey(
          claim.out_idempotency_key as string,
        ),
      },
    );
    stripeCustomerId = customer.id;
  } catch (err) {
    return {
      ok: false,
      error: "stripe_customer_create_failed",
      detail: stripeFailureDetail(err),
    };
  }

  // Step 3: commit. complete_stripe_customer_provisioning writes
  // the client_stripe_customers mapping row + flips the attempt to
  // 'succeeded' atomically. A second attempt with the same
  // idempotency key would return an existing customer from Stripe;
  // calling complete on the same claim token would raise.
  const { error: completeErr } = await admin.rpc(
    "complete_stripe_customer_provisioning",
    {
      p_attempt_id: claim.attempt_id as string,
      p_claim_token: claim.out_processing_claim_token as string,
      p_stripe_customer_id: stripeCustomerId,
    },
  );
  if (completeErr) {
    return {
      ok: false,
      error: "complete_rpc_failed",
      detail: dbErrorCode(completeErr),
    };
  }

  return { ok: true, stripeCustomerId };
}

export type SetupIntentResult =
  | {
      ok: true;
      clientSecret: string;
      setupIntentId: string;
      stripeLivemode: boolean;
    }
  | { ok: false; error: string };

// Wrapper around stripe.setupIntents.create scoped to the studio's
// connected account. Metadata records the Hone identity tuple so
// the setup_intent.succeeded webhook arm can validate every dimension
// before writing client_payment_methods. The client_secret returned
// here flows back to the browser; it MUST NOT be logged.
export async function createCardOnFileSetupIntent(params: {
  studioId: string;
  clientId: string;
  stripeAccountId: string;
  stripeCustomerId: string;
  cardAuthorizationSignatureId: string;
}): Promise<SetupIntentResult> {
  const stripe = getStripe();
  const livemode = inferStripeLivemode();
  try {
    const setupIntent = await stripe.setupIntents.create(
      {
        customer: params.stripeCustomerId,
        payment_method_types: ["card"],
        usage: "off_session",
        metadata: {
          hone_studio_id: params.studioId,
          hone_client_id: params.clientId,
          hone_card_authorization_signature_id:
            params.cardAuthorizationSignatureId,
          hone_source: "portal_card_on_file",
        },
      },
      {
        stripeAccount: params.stripeAccountId,
        // Per-Hone-Phase 1 idempotency: the Hone identity tuple is
        // the stable component. Adding a coarse time bucket keeps
        // the key fresh enough that an old SetupIntent doesn't
        // poison a brand-new Add card click after a long pause.
        idempotencyKey:
          `card_on_file:${params.studioId}:${params.clientId}:${params.cardAuthorizationSignatureId}:${Math.floor(Date.now() / 60_000)}`,
      },
    );
    const clientSecret = setupIntent.client_secret;
    if (!clientSecret) {
      return { ok: false, error: "setup_intent_client_secret_missing" };
    }
    return {
      ok: true,
      clientSecret,
      setupIntentId: setupIntent.id,
      stripeLivemode: livemode,
    };
  } catch (err) {
    // The SDK's message can quote the request or the customer, and the portal
    // action logs this field whole: a thrown-error class and Stripe's documented
    // type and code only.
    return { ok: false, error: `setup_intent_create_failed:${stripeFailureDetail(err)}` };
  }
}
