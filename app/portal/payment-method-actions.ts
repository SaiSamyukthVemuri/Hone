"use server";

import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { getCurrentPortalSession } from "@/lib/portal/session";
import {
  createCardOnFileSetupIntent,
  getOrCreateStripeCustomerForCardOnFile,
} from "@/lib/stripe/setup-intent";
import { getCardAuthorizationStatus } from "@/lib/consent/current-card-authorization";

// PR #135. Portal-side server action that produces a Stripe
// SetupIntent client_secret for the Add card form. The action
// returns the client_secret to the browser; the Stripe Elements
// PaymentElement consumes it and submits the card details directly
// to Stripe. The card details NEVER touch Hone's servers; the only
// thing that comes back to Hone via webhook is the brand / last4 /
// exp.
//
// Critical security invariants:
//   * Requires a valid getCurrentPortalSession().
//   * Re-checks the client row active + non-archived.
//   * Re-checks an active card_authorization template exists for the
//     studio.
//   * Re-checks the client has at least one signature for that
//     template.
//   * Resolves the studio's connected Stripe account (charges_enabled
//     not required for SetupIntent, but the account must be
//     'enabled' in our local payment-settings posture so we know we
//     have a usable connected account id + livemode).
//   * Reuses the 0032 customer-provisioning RPCs via the shared
//     getOrCreateStripeCustomerForCardOnFile helper so concurrent
//     clicks do not mint duplicate Stripe Customers.
//   * Creates the SetupIntent on the connected account with
//     usage='off_session' and metadata that the webhook arm
//     validates before inserting client_payment_methods.
//   * Never logs the client_secret. Never logs the SetupIntent id
//     except as an opaque audit field.

export type CreateCardSetupIntentResult =
  | {
      ok: true;
      clientSecret: string;
      // The publishable key the portal page already knows about, so
      // the browser can mount Elements with the correct connected-
      // account context.
      stripeAccountId: string;
    }
  | { ok: false; error: string };

// Friendly visitor-facing copy for each early-exit branch. Internal
// detail is sanitized-logged separately.
const ERR_SESSION_EXPIRED =
  "Your portal session has expired. Please sign in again.";
const ERR_CLIENT_ARCHIVED = "This account is no longer available.";
const ERR_NO_AUTHORIZATION_TEMPLATE =
  "Card-on-file authorization is not configured yet. Please contact the studio.";
const ERR_UNSIGNED_AUTHORIZATION =
  "Please review and sign the card-on-file authorization before adding a card.";
// PR #170. New error branch for the current-version signature gate:
// the client signed an older version of the card_authorization
// template (likely against the historical placeholder body) and
// must re-sign the updated wording before any new card can be
// saved. The portal renders a dedicated "re-sign updated card
// authorization" state for this branch (see PR #158's deep-link
// pattern); the action's role is to refuse the SetupIntent with a
// clear visitor-facing message.
const ERR_AUTHORIZATION_OUT_OF_DATE =
  "The card-on-file authorization was updated. Please review and sign the new version before adding a card.";
const ERR_STUDIO_NOT_READY =
  "The studio has not finished setting up payments yet. Please contact the studio.";
const ERR_TRY_AGAIN = "Couldn't start the card setup. Please try again.";

export async function createCardSetupIntentAction(): Promise<CreateCardSetupIntentResult> {
  const session = await getCurrentPortalSession();
  if (!session) return { ok: false, error: ERR_SESSION_EXPIRED };

  const admin = createAdminClient();

  // 1. Client row active + non-archived. A still-live cookie on an
  //    archived client cannot start a SetupIntent.
  const { data: client, error: clientErr } = await admin
    .from("clients")
    .select("id, name, archived_at")
    .eq("id", session.clientId)
    .eq("studio_id", session.studioId)
    .maybeSingle();
  if (clientErr) {
    console.error(
      JSON.stringify({
        event: "card_setup_client_lookup_failed",
        code: clientErr.code,
        message: clientErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: ERR_TRY_AGAIN };
  }
  if (!client || client.archived_at != null) {
    return { ok: false, error: ERR_CLIENT_ARCHIVED };
  }

  // 2 + 3. Card authorization status via the shared helper
  // (PR #170). The helper resolves the live card_authorization
  // template (PR #167 is_live=true AND status='active' AND
  // form_type='card_authorization') and the client's latest
  // signature, and returns one of four discriminated kinds:
  //
  //   no_live_template      -- studio has not authored a live
  //                            template; portal Add Card surface
  //                            already hides itself via the
  //                            existing PR #158 placeholder.
  //   unsigned              -- live template exists but the
  //                            client has never signed it.
  //   signed_out_of_date    -- client signed an older version of
  //                            the live template. PR #170 gates
  //                            SetupIntent on this branch so old
  //                            signatures against the historical
  //                            placeholder body do NOT satisfy
  //                            authorization once an owner has
  //                            updated the template via Settings.
  //   signed_current        -- the only happy path. signature
  //                            template_version equals current
  //                            template version, so the visitor
  //                            agreed to the current wording.
  //
  // The helper centralises the gate so the manual fee eligibility
  // check (lib/billing/manual-fee-eligibility.ts) and the portal
  // / practitioner UIs all read the same source of truth.
  const cardAuth = await getCardAuthorizationStatus({
    studioId: session.studioId,
    clientId: session.clientId,
  });
  if (cardAuth.kind === "no_live_template") {
    return { ok: false, error: ERR_NO_AUTHORIZATION_TEMPLATE };
  }
  if (cardAuth.kind === "unsigned") {
    return { ok: false, error: ERR_UNSIGNED_AUTHORIZATION };
  }
  if (cardAuth.kind === "signed_out_of_date") {
    return { ok: false, error: ERR_AUTHORIZATION_OUT_OF_DATE };
  }
  // Past this point cardAuth.kind === "signed_current", so the
  // rest of the function reads templateId and signatureId directly
  // from the helper's return shape. PR #170 removed the
  // intermediate `template` / `signature` aliases that older code
  // carried; the helper is the single source of truth.

  // 4. Studio payment settings: the connected account id + livemode
  //    are mandatory; account status must be 'enabled' so we know
  //    onboarding has finished. We do NOT require charges_enabled
  //    here because SetupIntent does not move money; a card can be
  //    saved while a fresh account is still awaiting payouts setup.
  //    Mode-scoped (0103): a studio can hold one settings row per Stripe
  //    mode; the SetupIntent must be created on the CURRENT deployment
  //    mode's connected account only.
  const { data: settings, error: settingsErr } = await admin
    .from("studio_payment_settings")
    .select(
      "stripe_account_id, stripe_account_status, stripe_livemode, stripe_charges_enabled",
    )
    .eq("studio_id", session.studioId)
    .eq("stripe_livemode", inferStripeLivemode())
    .maybeSingle();
  if (settingsErr) {
    console.error(
      JSON.stringify({
        event: "card_setup_settings_lookup_failed",
        code: settingsErr.code,
        message: settingsErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: ERR_TRY_AGAIN };
  }
  if (
    !settings ||
    !settings.stripe_account_id ||
    settings.stripe_account_status !== "enabled" ||
    settings.stripe_livemode == null
  ) {
    return { ok: false, error: ERR_STUDIO_NOT_READY };
  }

  // 5. Stripe Customer get-or-create (reuses the 0032 RPCs +
  //    client_stripe_customers). Concurrent clicks land on the same
  //    Customer; in-flight provisioning returns the retryable
  //    error.
  const customer = await getOrCreateStripeCustomerForCardOnFile({
    admin,
    studioId: session.studioId,
    clientId: session.clientId,
    stripeAccountId: settings.stripe_account_id as string,
    stripeLivemode: settings.stripe_livemode as boolean,
    clientName: (client.name as string) ?? "Client",
  });
  if (!customer.ok) {
    console.error(
      JSON.stringify({
        event: "card_setup_customer_failed",
        reason: customer.error,
        detail: customer.detail,
        studioId: session.studioId,
        clientId: session.clientId,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: ERR_TRY_AGAIN };
  }

  // 6. SetupIntent on the connected account.
  const setup = await createCardOnFileSetupIntent({
    studioId: session.studioId,
    clientId: session.clientId,
    stripeAccountId: settings.stripe_account_id as string,
    stripeCustomerId: customer.stripeCustomerId,
    cardAuthorizationSignatureId: cardAuth.signatureId,
  });
  if (!setup.ok) {
    console.error(
      JSON.stringify({
        event: "card_setup_intent_create_failed",
        error: setup.error,
        studioId: session.studioId,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: ERR_TRY_AGAIN };
  }

  return {
    ok: true,
    clientSecret: setup.clientSecret,
    stripeAccountId: settings.stripe_account_id as string,
  };
}
