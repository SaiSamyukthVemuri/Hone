import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  currentRuntimeMode,
  deriveConnectCapability,
  type ConnectCapability,
  type RuntimeMode,
} from "@/lib/payments/payment-status-presenter";

// Admin payment-status reads (PR B). REDACTION-FIRST by construction:
//   * selects capability/status/count columns only — never PaymentIntent
//     ids, card ids, customer ids, fingerprints, tokens, emails, or any
//     client/intake content;
//   * the ONLY identifier that leaves this module is a redacted account-id
//     suffix ("acct_…1a2b") for operator cross-reference — never a full id;
//   * counts are ALWAYS mode-separated (per-row stripe_livemode); a status
//     summary is derived via the shared presenter, so "ready" here means
//     the same thing it means on the practitioner surfaces.
// Callers pass their EXISTING service-role client (both admin pages already
// hold one behind the operator allowlist gate); this module never creates a
// client of its own.

export function redactAccountId(accountId: string | null): string | null {
  if (!accountId) return null;
  return `acct_…${accountId.slice(-4)}`;
}

type SettingsRow = {
  stripe_livemode: boolean | null;
  stripe_account_id: string | null;
  stripe_account_status: string | null;
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
};

function toCapability(row: SettingsRow | undefined): ConnectCapability {
  if (!row || row.stripe_account_id === null) return "not_connected";
  return deriveConnectCapability({
    accountStatus: row.stripe_account_status,
    chargesEnabled: row.stripe_charges_enabled,
    payoutsEnabled: row.stripe_payouts_enabled,
  });
}

// ---------------------------------------------------------------------------
// Platform summary (admin homepage): current-mode capability counts across
// all studios. Counts only — no per-studio identifiers at all.
// ---------------------------------------------------------------------------
export type PlatformPaymentSummary = {
  runtimeMode: RuntimeMode;
  studios: number;
  ready: number;
  payoutsPending: number;
  onboarding: number; // onboarding_started + charges_disabled
  notConnected: number; // no current-mode row (or no account)
  loadError: boolean;
};

export async function loadPlatformPaymentSummary(
  admin: SupabaseClient,
): Promise<PlatformPaymentSummary> {
  const runtimeMode = currentRuntimeMode();
  const livemode = runtimeMode === "live";
  const [{ count: studioCount, error: studiosErr }, { data: rows, error: rowsErr }] =
    await Promise.all([
      admin.from("studios").select("id", { count: "exact", head: true }),
      admin
        .from("studio_payment_settings")
        .select(
          "stripe_livemode, stripe_account_id, stripe_account_status, stripe_charges_enabled, stripe_payouts_enabled",
        )
        .eq("stripe_livemode", livemode),
    ]);
  if (studiosErr || rowsErr) {
    return {
      runtimeMode,
      studios: 0,
      ready: 0,
      payoutsPending: 0,
      onboarding: 0,
      notConnected: 0,
      loadError: true,
    };
  }
  let ready = 0;
  let payoutsPending = 0;
  let onboarding = 0;
  let connected = 0;
  for (const row of (rows ?? []) as SettingsRow[]) {
    const cap = toCapability(row);
    if (cap === "not_connected") continue;
    connected += 1;
    if (cap === "ready") ready += 1;
    else if (cap === "charges_enabled_payouts_pending") payoutsPending += 1;
    else onboarding += 1;
  }
  const studios = studioCount ?? 0;
  return {
    runtimeMode,
    studios,
    ready,
    payoutsPending,
    onboarding,
    notConnected: Math.max(0, studios - connected),
    loadError: false,
  };
}

// ---------------------------------------------------------------------------
// Per-studio status (admin studio detail): both mode rows + current-mode
// capability + mode-separated card/attempt counts. Redacted account suffix
// only.
// ---------------------------------------------------------------------------
export type StudioModeRow = {
  exists: boolean;
  capability: ConnectCapability;
  accountStatus: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  accountIdRedacted: string | null;
  activeCards: number;
  attempts: { succeeded: number; active: number; other: number };
};

export type StudioPaymentStatus = {
  runtimeMode: RuntimeMode;
  live: StudioModeRow;
  test: StudioModeRow;
  loadError: boolean;
};

const EMPTY_MODE_ROW: StudioModeRow = {
  exists: false,
  capability: "not_connected",
  accountStatus: null,
  chargesEnabled: false,
  payoutsEnabled: false,
  accountIdRedacted: null,
  activeCards: 0,
  attempts: { succeeded: 0, active: 0, other: 0 },
};

export async function loadStudioPaymentStatus(
  admin: SupabaseClient,
  studioId: string,
): Promise<StudioPaymentStatus> {
  const runtimeMode = currentRuntimeMode();
  const [settingsRes, cardsRes, attemptsRes] = await Promise.all([
    admin
      .from("studio_payment_settings")
      .select(
        "stripe_livemode, stripe_account_id, stripe_account_status, stripe_charges_enabled, stripe_payouts_enabled",
      )
      .eq("studio_id", studioId),
    admin
      .from("client_payment_methods")
      .select("stripe_livemode")
      .eq("studio_id", studioId)
      .eq("status", "active"),
    admin
      .from("payment_charge_attempts")
      .select("stripe_livemode, status")
      .eq("studio_id", studioId),
  ]);
  if (settingsRes.error || cardsRes.error || attemptsRes.error) {
    return {
      runtimeMode,
      live: EMPTY_MODE_ROW,
      test: EMPTY_MODE_ROW,
      loadError: true,
    };
  }

  const buildModeRow = (livemode: boolean): StudioModeRow => {
    const row = ((settingsRes.data ?? []) as SettingsRow[]).find(
      (r) => r.stripe_livemode === livemode,
    );
    const cards = (cardsRes.data ?? []).filter(
      (c) => c.stripe_livemode === livemode,
    ).length;
    const attempts = (attemptsRes.data ?? []).filter(
      (a) => a.stripe_livemode === livemode,
    );
    const succeeded = attempts.filter((a) => a.status === "succeeded").length;
    const active = attempts.filter(
      (a) => a.status === "ready" || a.status === "pending_stripe",
    ).length;
    return {
      exists: row != null,
      capability: toCapability(row),
      accountStatus: row?.stripe_account_status ?? null,
      chargesEnabled: row?.stripe_charges_enabled === true,
      payoutsEnabled: row?.stripe_payouts_enabled === true,
      accountIdRedacted: redactAccountId(row?.stripe_account_id ?? null),
      activeCards: cards,
      attempts: {
        succeeded,
        active,
        other: attempts.length - succeeded - active,
      },
    };
  };

  return {
    runtimeMode,
    live: buildModeRow(true),
    test: buildModeRow(false),
    loadError: false,
  };
}
