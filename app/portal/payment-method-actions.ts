"use server";

import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPortalSession } from "@/lib/portal/session";
import {
  createCardOnFileSetupIntent,
  getOrCreateStripeCustomerForCardOnFile,
} from "@/lib/stripe/setup-intent";

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

  // 2. Active card_authorization template. The owner creates this
  //    in Settings -> Consent forms; we do NOT auto-create one.
  //    PR #167 added the is_live clause; before that the SetupIntent
  //    flow would treat a draft / not-live card_authorization
  //    template as usable, which is exactly the test-template-in-
  //    front-of-real-clients risk Chloe reported. With this clause
  //    the practitioner must explicitly Make Live the template
  //    before any client can use it to authorize card on file.
  const { data: template, error: tmplErr } = await admin
    .from("consent_form_templates")
    .select("id")
    .eq("studio_id", session.studioId)
    .eq("is_live", true)
    .eq("status", "active")
    .eq("form_type", "card_authorization")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (tmplErr) {
    console.error(
      JSON.stringify({
        event: "card_setup_template_lookup_failed",
        code: tmplErr.code,
        message: tmplErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: ERR_TRY_AGAIN };
  }
  if (!template) {
    return { ok: false, error: ERR_NO_AUTHORIZATION_TEMPLATE };
  }

  // 3. Latest signature row for that template by this client. We
  //    accept ANY prior version of the template for v1 (the spec is
  //    explicit on this). A future PR can opt into "require latest
  //    version" once the UX of re-sign-on-edit is settled.
  const { data: signature, error: sigErr } = await admin
    .from("client_consent_signatures")
    .select("id")
    .eq("studio_id", session.studioId)
    .eq("client_id", session.clientId)
    .eq("template_id", template.id)
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sigErr) {
    console.error(
      JSON.stringify({
        event: "card_setup_signature_lookup_failed",
        code: sigErr.code,
        message: sigErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: ERR_TRY_AGAIN };
  }
  if (!signature) {
    return { ok: false, error: ERR_UNSIGNED_AUTHORIZATION };
  }

  // 4. Studio payment settings: the connected account id + livemode
  //    are mandatory; account status must be 'enabled' so we know
  //    onboarding has finished. We do NOT require charges_enabled
  //    here because SetupIntent does not move money; a card can be
  //    saved while a fresh account is still awaiting payouts setup.
  const { data: settings, error: settingsErr } = await admin
    .from("studio_payment_settings")
    .select(
      "stripe_account_id, stripe_account_status, stripe_livemode, stripe_charges_enabled",
    )
    .eq("studio_id", session.studioId)
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
    cardAuthorizationSignatureId: signature.id as string,
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
