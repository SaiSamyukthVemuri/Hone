import "server-only";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { resolveStripePublishableKey } from "@/lib/stripe/publishable-key";

// Shared read-only payment status presenter (PR A of the app-wide
// smart-payment-status plan). ONE place derives payment state and the copy
// that describes it, so surfaces stop making static payments-are-off /
// coming-later claims that drift from reality.
//
// Design rules:
//   * Pure derivation over data the caller already holds — this module runs
//     NO queries, calls NO Stripe SDK, and never writes. Unit-testable
//     without a database.
//   * Runtime mode comes from the DEPLOYMENT (inferStripeLivemode()), never
//     from a nullable row (a not-yet-connected studio has no row; deriving
//     mode from the row rendered "Test mode" on a live deployment — the
//     row-null bug this PR fixes).
//   * A studio is never called "ready" for charging unless charges_enabled
//     AND payouts_enabled are BOTH true for the current mode. Charges
//     without payouts is a WARNING, not ready.
//   * Per-ROW artifacts (cards, attempts, refunds, receipts) must badge
//     from the row's own stripe_livemode — see modeBadgeForRow — never from
//     the runtime.

// ---------------------------------------------------------------------------
// 1. Runtime mode (deployment-level; env-derived)
// ---------------------------------------------------------------------------
export type RuntimeMode = "test" | "live";

export function currentRuntimeMode(): RuntimeMode {
  return inferStripeLivemode() ? "live" : "test";
}

// ---------------------------------------------------------------------------
// 2. Studio Connect capability (from the CURRENT-mode settings row)
// ---------------------------------------------------------------------------
export type ConnectCapability =
  | "not_connected"
  | "onboarding_started"
  | "charges_disabled"
  | "charges_enabled_payouts_pending"
  | "ready"
  | "unknown";

export type ConnectStatusInput = {
  // The current-mode studio_payment_settings row as surfaced by
  // get_studio_payment_settings_display; null = no row for this mode.
  accountStatus: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
} | null;

export function deriveConnectCapability(
  input: ConnectStatusInput | undefined,
): ConnectCapability {
  if (input === undefined) return "unknown"; // read error — never all-clear
  if (input === null) return "not_connected";
  const status = input.accountStatus;
  if (status === null) return "not_connected";
  if (input.chargesEnabled && input.payoutsEnabled && status === "enabled") {
    return "ready";
  }
  if (input.chargesEnabled && !input.payoutsEnabled) {
    return "charges_enabled_payouts_pending";
  }
  if (status === "rejected") return "charges_disabled";
  if (status === "enabled" && !input.chargesEnabled) return "charges_disabled";
  return "onboarding_started"; // pending / restricted, charges not enabled
}

// Headline + detail for the Settings → Payments status banner. Live-ready
// and test-ready wording per the approved copy list; payouts-pending is a
// warning and NEVER says ready.
export function connectBannerCopy(
  mode: RuntimeMode,
  capability: ConnectCapability,
): { tone: "ready" | "warning" | "info"; headline: string; detail: string } {
  if (capability === "charges_enabled_payouts_pending") {
    return {
      tone: "warning",
      headline: "Payouts are not ready",
      detail:
        "Charges may be enabled, but payouts are not ready. Finish payout setup before charging clients.",
    };
  }
  if (capability === "ready") {
    return mode === "live"
      ? {
          tone: "ready",
          headline: "Live payments are ready.",
          detail:
            "This studio can accept live payments through Hone after a client saves an authorized card on file.",
        }
      : {
          tone: "ready",
          headline: "Test payment setup is ready.",
          detail:
            "You can test payment setup without moving real money. Test mode charges no real cards.",
        };
  }
  if (capability === "unknown") {
    return {
      tone: "info",
      headline: "Payment status could not be loaded",
      detail: "Refresh the page or use Refresh Stripe status below.",
    };
  }
  const stage =
    capability === "not_connected"
      ? "This studio is not connected to Stripe yet."
      : capability === "onboarding_started"
        ? "Stripe onboarding is not finished yet."
        : "Stripe has not enabled charges for this account.";
  return {
    tone: "info",
    headline:
      mode === "live"
        ? "Live payments are not set up yet"
        : "Test mode: payment setup is not finished",
    detail: `${stage} Clients are not charged until setup is complete and a card is authorized.`,
  };
}

// ---------------------------------------------------------------------------
// 3. Portal card-on-file capability (first blocker wins)
// ---------------------------------------------------------------------------
export type PortalCardCapability =
  | "needs_connect"
  | "needs_authorization_template"
  | "needs_publishable_key"
  | "available"
  | "unknown";

export function derivePortalCardCapability(args: {
  connect: ConnectCapability;
  hasActiveAuthorizationTemplate: boolean;
  publishableKeyOk: boolean;
}): PortalCardCapability {
  if (args.connect === "unknown") return "unknown";
  // SetupIntents need an onboarded account (status enabled), not payouts:
  // charges_enabled_payouts_pending and ready both permit card save.
  const connectOk =
    args.connect === "ready" ||
    args.connect === "charges_enabled_payouts_pending";
  if (!connectOk) return "needs_connect";
  if (!args.hasActiveAuthorizationTemplate) {
    return "needs_authorization_template";
  }
  if (!args.publishableKeyOk) return "needs_publishable_key";
  return "available";
}

export function portalCardCopy(capability: PortalCardCapability): string {
  switch (capability) {
    case "available":
      // Available means AVAILABLE — never "when card-on-file becomes
      // available".
      return "Portal card-on-file is available. Clients can sign the card authorization and save a card in the client portal.";
    case "needs_connect":
      return "Portal card-on-file is not available yet: finish Stripe Connect onboarding first.";
    case "needs_authorization_template":
      return "Portal card-on-file is not available yet: activate a card authorization consent template in Settings → Consent forms.";
    case "needs_publishable_key":
      return "Portal card-on-file is not available yet: the Stripe publishable key is not configured for this environment.";
    case "unknown":
      return "Portal card-on-file status could not be determined.";
  }
}

// Convenience for server components that already hold the connect input:
// resolves the publishable-key gate from env (pure env read, no query).
export function publishableKeyOk(): boolean {
  return resolveStripePublishableKey().ok;
}

// ---------------------------------------------------------------------------
// 4. Public booking card collection — OFF today; single source of truth so
//    every surface flips together the day a real setting ships.
// ---------------------------------------------------------------------------
export type BookingCardCollection = "off" | "on";

export function bookingCardCollection(): BookingCardCollection {
  // No setting exists yet; booking-time collection is off product-wide.
  return "off";
}

export function bookingCardCopy(state: BookingCardCollection): string {
  return state === "off"
    ? "Booking-time card collection is off. Clients can still book without entering a card."
    : "Booking-time card collection is on.";
}

// ---------------------------------------------------------------------------
// 5. Manual fee capability — configuration vs charging, made explicit.
// ---------------------------------------------------------------------------
export type ManualFeeCapability = "not_configured" | "configured_but_hold";

export function deriveManualFeeCapability(args: {
  lateCancelFeeCents: number | null;
  noShowFeeCents: number | null;
}): ManualFeeCapability {
  const configured =
    (args.lateCancelFeeCents ?? 0) > 0 || (args.noShowFeeCents ?? 0) > 0;
  return configured ? "configured_but_hold" : "not_configured";
}

export function manualFeeCopy(capability: ManualFeeCapability): string {
  // Fees are never automatic and settings never charge; amounts are
  // configuration only. "Money is not charged here" stays on the fee card.
  return capability === "configured_but_hold"
    ? "Manual fee amounts are configured. Fees are never charged automatically — a practitioner runs each fee explicitly, and only against a saved, authorized card."
    : "Manual fee amounts are not configured. Setting an amount is configuration only; saving it does not charge anyone.";
}

// ---------------------------------------------------------------------------
// 7. Per-row payment record mode — ALWAYS the row's own stripe_livemode.
// ---------------------------------------------------------------------------
export type PaymentRecordBadge = "Live" | "Test" | "Unknown";

export function modeBadgeForRow(
  rowLivemode: boolean | null | undefined,
): PaymentRecordBadge {
  if (rowLivemode === true) return "Live";
  if (rowLivemode === false) return "Test";
  return "Unknown";
}
