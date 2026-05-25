// Stripe webhook endpoint (Phase 1).
//
// Allowed mutations: account-status sync only.
//   - account.updated, capability.updated -> sync_studio_account_status
//
// Forbidden mutations in Phase 1 (these events are claimed for
// idempotency and marked processed with a payload_summary, but they
// do NOT trigger any business-logic state change):
//   - payment_intent.*
//   - charge.*
//   - refund.*
//   - charge.dispute.*
//   - customer.*
//   - setup_intent.*
//
// Webhook discipline:
//   * Raw body via await req.text(). NEVER req.json() before
//     constructEvent — Stripe's signature verification requires the
//     exact byte string sent.
//   * 400 with generic "Invalid signature" on any verification
//     failure. Stripe error message is logged internally, not
//     surfaced.
//   * Idempotent claim via public.claim_stripe_event(...). Concurrent
//     deliveries land on the same partial unique
//     (account_id, livemode, event_id); the loser sees
//     already_processed=true or currently_processing_elsewhere=true.
//   * No full webhook payload is logged. Only event id, event type,
//     and a small structured payload_summary (account id +
//     charges_enabled, etc.) is persisted on the stripe_events row.
//   * No raw bank/account/PII details are logged.

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe/server";
import { accountToStatusSnapshot } from "@/lib/stripe/account";
import { createAdminClient } from "@/lib/supabase/admin-server";

// Force Node runtime — Stripe SDK + raw body buffering need Node, not
// the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENERIC_BAD_SIGNATURE = "Invalid signature.";

function logInternal(event: string, detail: unknown) {
  try {
    console.error(
      JSON.stringify({ event, detail, timestamp: new Date().toISOString() }),
    );
  } catch {
    console.error(event, detail);
  }
}

function getWebhookSecretOrFail(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  }
  return secret;
}

export async function POST(req: Request): Promise<Response> {
  // 1. Raw body. MUST be the exact bytes Stripe sent so the HMAC
  //    signature check succeeds.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    logInternal("stripe_webhook_body_read_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: GENERIC_BAD_SIGNATURE }, { status: 400 });
  }

  // 2. Signature header. Stripe-Signature is the canonical header
  //    name; Next normalizes to lower-case so we use that.
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    logInternal("stripe_webhook_missing_signature_header", {});
    return NextResponse.json({ error: GENERIC_BAD_SIGNATURE }, { status: 400 });
  }

  // 3. constructEvent. Stripe's library verifies the HMAC, the
  //    timestamp tolerance, and parses the JSON. Failure throws.
  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    const webhookSecret = getWebhookSecretOrFail();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    logInternal("stripe_webhook_signature_verification_failed", {
      // Do NOT serialize the raw err.message (Stripe sometimes
      // includes parts of the body). Just record the error class.
      type:
        typeof err === "object" && err !== null && "type" in err
          ? (err as Record<string, unknown>).type
          : "unknown",
    });
    return NextResponse.json({ error: GENERIC_BAD_SIGNATURE }, { status: 400 });
  }

  // 4. Resolve account context. Stripe Connect webhooks include the
  //    connected `account` field on the event envelope. Some events
  //    arrive at the platform level with no account set — we still
  //    claim those but cannot sync per-studio status.
  const stripeAccountId = event.account ?? null;
  const livemode = event.livemode === true;

  // Look up the studio that owns this connected account, if any.
  let studioId: string | null = null;
  if (stripeAccountId) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("studio_payment_settings")
      .select("studio_id")
      .eq("stripe_account_id", stripeAccountId)
      .eq("stripe_livemode", livemode)
      .maybeSingle();
    studioId = data?.studio_id ?? null;
  }

  // 5. Claim the event idempotently. The RPC enforces a partial
  //    unique on (account_id, livemode, event_id). A concurrent
  //    duplicate delivery sees `already_processed=true` and we ack
  //    with 200 to stop Stripe retrying.
  const admin = createAdminClient();
  const { data: claimRows, error: claimErr } = await admin.rpc(
    "claim_stripe_event",
    {
      p_event_id: event.id,
      p_event_type: event.type,
      p_stripe_account_id: stripeAccountId ?? "",
      p_stripe_livemode: livemode,
      p_studio_id: studioId,
    },
  );
  if (claimErr) {
    logInternal("stripe_webhook_claim_failed", {
      eventId: event.id,
      eventType: event.type,
      code: claimErr.code,
      message: claimErr.message,
    });
    // Return 500 so Stripe retries. The event is not yet recorded;
    // the next delivery will re-attempt.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
  if (!claim) {
    logInternal("stripe_webhook_claim_empty", { eventId: event.id });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  if (claim.already_processed) {
    return NextResponse.json({ ok: true, alreadyProcessed: true });
  }
  if (claim.currently_processing_elsewhere) {
    // Another worker is mid-process. Tell Stripe we're alive but not
    // done — they'll re-deliver shortly.
    return NextResponse.json({ ok: false, retry: true }, { status: 409 });
  }
  if (!claim.claimed_by_this_request || !claim.claim_token) {
    logInternal("stripe_webhook_claim_unexpected_shape", {
      eventId: event.id,
      claim,
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  const claimToken = claim.claim_token as string;

  // 6. Dispatch by event type. Phase 1 mutation surface is strictly
  //    account.updated and capability.updated; everything else is
  //    recorded for the audit trail without side effects.
  try {
    const payloadSummary = await handleStripeEvent(event, {
      studioId,
      stripeAccountId,
      livemode,
    });

    const { error: markErr } = await admin.rpc("mark_stripe_event_processed", {
      p_event_id: event.id,
      p_claim_token: claimToken,
      p_payload_summary: payloadSummary,
    });
    if (markErr) {
      logInternal("stripe_webhook_mark_processed_failed", {
        eventId: event.id,
        code: markErr.code,
        message: markErr.message,
      });
      return NextResponse.json({ ok: false }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logInternal("stripe_webhook_handler_failed", {
      eventId: event.id,
      eventType: event.type,
      err: err instanceof Error ? err.message : String(err),
    });
    try {
      const { error: releaseErr } = await admin.rpc(
        "release_stripe_event_claim_with_error",
        {
          p_event_id: event.id,
          p_claim_token: claimToken,
          p_error: err instanceof Error ? err.message : "handler_failed",
        },
      );
      if (releaseErr) {
        logInternal("stripe_webhook_release_claim_failed", { releaseErr });
      }
    } catch (releaseErr) {
      logInternal("stripe_webhook_release_claim_threw", { releaseErr });
    }
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// handleStripeEvent
// ---------------------------------------------------------------------------
// Returns a small JSON summary that's safe to persist on
// stripe_events.payload_summary. NO PII, NO secrets, NO raw payload.
// ---------------------------------------------------------------------------
async function handleStripeEvent(
  event: Stripe.Event,
  ctx: { studioId: string | null; stripeAccountId: string | null; livemode: boolean },
): Promise<Record<string, unknown>> {
  switch (event.type) {
    case "account.updated":
    case "capability.updated": {
      // Allowed Phase 1 mutation: sync the connected-account status
      // onto studio_payment_settings.
      if (!ctx.studioId || !ctx.stripeAccountId) {
        // No local binding — record but don't sync.
        return {
          eventType: event.type,
          unboundAccount: true,
        };
      }
      const accountObject = await resolveAccountFromEvent(event, ctx.stripeAccountId);
      if (!accountObject) {
        return { eventType: event.type, accountResolutionFailed: true };
      }
      const snapshot = accountToStatusSnapshot(accountObject);

      const admin = createAdminClient();
      // Preserve-first-completion semantics (see equivalent block in
      // lib/stripe/account.ts#refreshAccountStatusFromStripe). The
      // sync_studio_account_status RPC uses
      //   coalesce(p_onboarding_completed_at, sps.stripe_onboarding_completed_at)
      // so a non-null value overwrites. Sending null on subsequent
      // webhooks preserves the original first-completion timestamp.
      const { data: existingSettings } = await admin
        .from("studio_payment_settings")
        .select("stripe_onboarding_completed_at")
        .eq("studio_id", ctx.studioId)
        .maybeSingle();
      const onboardingCompletedAtForRpc =
        existingSettings?.stripe_onboarding_completed_at != null
          ? null
          : snapshot.onboardingCompletedAt;

      const { error: syncErr } = await admin.rpc("sync_studio_account_status", {
        p_studio_id: ctx.studioId,
        p_stripe_account_id: ctx.stripeAccountId,
        p_stripe_livemode: ctx.livemode,
        p_status: snapshot.status,
        p_charges_enabled: snapshot.chargesEnabled,
        p_payouts_enabled: snapshot.payoutsEnabled,
        p_onboarding_completed_at: onboardingCompletedAtForRpc,
      });
      if (syncErr) {
        throw new Error(
          `sync_studio_account_status failed: ${syncErr.message}`,
        );
      }

      return {
        eventType: event.type,
        status: snapshot.status,
        chargesEnabled: snapshot.chargesEnabled,
        payoutsEnabled: snapshot.payoutsEnabled,
        requirementsCurrentlyDueCount: snapshot.requirementsCurrentlyDue.length,
        requirementsEventuallyDueCount: snapshot.requirementsEventuallyDue.length,
      };
    }

    // Phase 1: every other event class is recorded without side effects.
    // No appointment state changes, no payment intent / charge / refund
    // / dispute / customer / setup_intent handling. The summary records
    // the type so the audit trail is complete; no body is logged.
    default:
      return {
        eventType: event.type,
        ignoredInPhase1: true,
      };
  }
}

async function resolveAccountFromEvent(
  event: Stripe.Event,
  stripeAccountId: string,
): Promise<Stripe.Account | null> {
  // For account.updated the event.data.object IS the Account. For
  // capability.updated it's a Capability whose `.account` field
  // names the parent account id; we retrieve the full Account.
  const obj = event.data.object as Stripe.Account | Stripe.Capability;
  if (event.type === "account.updated") {
    return obj as Stripe.Account;
  }
  // capability.updated: refresh via accounts.retrieve.
  try {
    const stripe = getStripe();
    return await stripe.accounts.retrieve(stripeAccountId);
  } catch (err) {
    logInternal("capability_updated_account_retrieve_failed", {
      stripeAccountId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
