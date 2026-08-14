"use server";

// Stripe Connect onboarding server actions (Phase 1).
//
// Browser-supplied identity is NEVER trusted. The studio + practitioner
// are resolved server-side via getCurrentPractitionerWithStudio() and
// the studio.id is what flows into the Stripe library.
//
// Error sanitization rule: the only error messages exposed to the
// owner UI are explicit, hand-vetted safe strings. Any other error
// (Stripe API exceptions, Postgres errors, unexpected nulls) is logged
// in structured form server-side and surfaced as GENERIC_STRIPE_ERROR.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  createOrLoadConnectedAccountForStudio,
  createConnectOnboardingLink,
  createExpressDashboardLoginLink,
  refreshAccountStatusFromStripe,
  type AccountStatusSnapshot,
} from "@/lib/stripe/account";
import { getAppOrigin, inferStripeLivemode } from "@/lib/stripe/server";
import { createAdminClient } from "@/lib/supabase/admin-server";

const GENERIC_STRIPE_ERROR =
  "Stripe could not complete that action. Please try again.";

// Whitelist of error messages that are safe to surface verbatim to the
// owner UI. Every entry is a hand-written, sanitized string thrown by
// this module or by lib/stripe/account.ts. Any error whose message is
// NOT in this set is collapsed to GENERIC_STRIPE_ERROR.
const SAFE_USER_FACING_MESSAGES: ReadonlySet<string> = new Set([
  // owner-authority gates
  "Only the studio owner can connect Stripe.",
  "Only the studio owner can refresh Stripe status.",
  "Only the studio owner can open the Stripe dashboard.",
  // missing-account gates
  "No Stripe account yet. Start onboarding first.",
  "No Stripe account yet. Complete onboarding first.",
  // dashboard-not-ready gate
  "Stripe dashboard is available after onboarding is complete.",
  // race-with-another-tab gate
  "Stripe onboarding is already starting in another window. Refresh in a few seconds.",
]);

function logInternal(event: string, detail: unknown) {
  try {
    console.error(
      JSON.stringify({ event, detail, timestamp: new Date().toISOString() }),
    );
  } catch {
    console.error(event, detail);
  }
}

function sanitizeForUser(err: unknown): string {
  if (err instanceof Error && SAFE_USER_FACING_MESSAGES.has(err.message)) {
    return err.message;
  }
  return GENERIC_STRIPE_ERROR;
}

function isNextRedirect(err: unknown): boolean {
  // Next.js throws a synthetic error with `digest` starting with
  // "NEXT_REDIRECT" inside server actions to trigger a redirect.
  // We must rethrow that and never wrap or log it as an internal
  // failure.
  if (typeof err !== "object" || err === null) return false;
  const digest = (err as Record<string, unknown>).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

// ---------------------------------------------------------------------------
// startStripeConnectOnboardingAction
// ---------------------------------------------------------------------------
// Owner-only. Resolves the studio server-side, creates or loads the
// connected account, then creates a one-shot AccountLink and REDIRECTs
// the practitioner to the Stripe-hosted onboarding flow.
//
// Stripe's return_url lands at /settings/payments/return.
// Stripe's refresh_url lands at /settings/payments/refresh, which
// re-runs this action to mint a fresh link.
// ---------------------------------------------------------------------------
export async function startStripeConnectOnboardingAction(): Promise<void> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only the studio owner can connect Stripe.");
  }

  let stripeAccountId: string;
  try {
    const result = await createOrLoadConnectedAccountForStudio(studio.id);
    stripeAccountId = result.stripeAccountId;
  } catch (err) {
    if (isNextRedirect(err)) throw err;
    logInternal("start_onboarding_create_or_load_failed", {
      studioId: studio.id,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new Error(sanitizeForUser(err));
  }

  let url: string;
  try {
    url = await createConnectOnboardingLink({
      stripeAccountId,
      appOrigin: getAppOrigin(),
    });
  } catch (err) {
    if (isNextRedirect(err)) throw err;
    logInternal("start_onboarding_link_failed", {
      studioId: studio.id,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new Error(sanitizeForUser(err));
  }

  redirect(url);
}

// ---------------------------------------------------------------------------
// refreshStripeStatusAction
// ---------------------------------------------------------------------------
// Owner-only. Pulls the current account state from Stripe and writes
// it to the studio's payment settings row via sync_studio_account_status.
// Returns the snapshot for the caller (UI updates from revalidatePath
// after this).
// ---------------------------------------------------------------------------
export type RefreshStatusResult =
  | { ok: true; status: AccountStatusSnapshot }
  | { ok: false; error: string };

export async function refreshStripeStatusAction(): Promise<RefreshStatusResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return {
      ok: false,
      error: "Only the studio owner can refresh Stripe status.",
    };
  }

  const admin = createAdminClient();
  // Mode-scoped (0103): a studio can hold one settings row per Stripe mode;
  // refresh must load the CURRENT deployment mode's account only, never the
  // other mode's acct_ id (Stripe rejects a test account under a live key).
  const { data: settings, error: settingsErr } = await admin
    .from("studio_payment_settings")
    .select("stripe_account_id")
    .eq("studio_id", studio.id)
    .eq("stripe_livemode", inferStripeLivemode())
    .maybeSingle();
  if (settingsErr) {
    logInternal("refresh_status_settings_lookup_failed", {
      code: settingsErr.code,
      message: settingsErr.message,
      studioId: studio.id,
    });
    return { ok: false, error: GENERIC_STRIPE_ERROR };
  }
  if (!settings?.stripe_account_id) {
    return {
      ok: false,
      error: "No Stripe account yet. Start onboarding first.",
    };
  }

  try {
    const snapshot = await refreshAccountStatusFromStripe({
      studioId: studio.id,
      stripeAccountId: settings.stripe_account_id,
    });
    revalidatePath("/settings/payments");
    return { ok: true, status: snapshot };
  } catch (err) {
    logInternal("refresh_status_call_failed", {
      studioId: studio.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: sanitizeForUser(err) };
  }
}

// ---------------------------------------------------------------------------
// openStripeDashboardAction
// ---------------------------------------------------------------------------
// Owner-only. Mints a one-shot Stripe-hosted Express dashboard login
// link and REDIRECTs to it. Only valid for already-onboarded accounts;
// Stripe rejects login link requests for accounts that haven't
// completed onboarding.
// ---------------------------------------------------------------------------
export async function openStripeDashboardAction(): Promise<void> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only the studio owner can open the Stripe dashboard.");
  }

  const admin = createAdminClient();
  // Mode-scoped (0103): the Express dashboard login link must be minted for
  // the CURRENT deployment mode's account only (accounts.createLoginLink on
  // the other mode's acct_ id fails with account_invalid).
  const { data: settings } = await admin
    .from("studio_payment_settings")
    .select("stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled")
    .eq("studio_id", studio.id)
    .eq("stripe_livemode", inferStripeLivemode())
    .maybeSingle();
  if (!settings?.stripe_account_id) {
    throw new Error("No Stripe account yet. Complete onboarding first.");
  }
  if (!settings.stripe_charges_enabled && !settings.stripe_payouts_enabled) {
    throw new Error(
      "Stripe dashboard is available after onboarding is complete.",
    );
  }

  let url: string;
  try {
    url = await createExpressDashboardLoginLink(settings.stripe_account_id);
  } catch (err) {
    if (isNextRedirect(err)) throw err;
    logInternal("open_dashboard_failed", {
      studioId: studio.id,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new Error(sanitizeForUser(err));
  }

  redirect(url);
}
