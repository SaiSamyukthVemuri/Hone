import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import {
  bookingCardCollection,
  bookingCardCopy,
  connectBannerCopy,
  currentRuntimeMode,
  deriveConnectCapability,
  derivePortalCardCapability,
  portalCardCopy,
  publishableKeyOk,
} from "@/lib/payments/payment-status-presenter";
import { PaymentsSettings, type StripeStatusView } from "./PaymentsSettings";
import { FeeAmountsCard } from "./FeeAmountsCard";

export const dynamic = "force-dynamic";

export default async function PaymentsSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-medium">Payments</h2>
        <p className="text-sm text-neutral-500">
          Only the studio owner can manage payments.
        </p>
      </section>
    );
  }

  // get_studio_payment_settings_display is the display-safe read RPC
  // (display columns only, no Stripe IDs). RLS is enforced inside the
  // RPC via is_studio_owner(). Mode-scoped (migration 0103): only the
  // CURRENT deployment mode's row is returned: in live mode a studio with
  // only a test binding gets zero rows, which renders the not-connected /
  // Connect-with-Stripe state instead of the other mode's stale status.
  const supabase = await createClient();
  const { data: rows, error } = await supabase.rpc(
    "get_studio_payment_settings_display",
    { p_studio_id: studio.id, p_stripe_livemode: inferStripeLivemode() },
  );
  if (error) {
    console.error(
      JSON.stringify({
        event: "get_studio_payment_settings_display_failed",
        code: error.code,
        message: error.message,
        studioId: studio.id,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  const row = Array.isArray(rows) ? rows[0] : rows;

  const status: StripeStatusView = {
    accountStatus: mapAccountStatus(row?.account_status ?? null),
    chargesEnabled: row?.charges_enabled === true,
    payoutsEnabled: row?.payouts_enabled === true,
    onboardingCompletedAt: row?.onboarding_completed_at ?? null,
    livemode: typeof row?.livemode === "boolean" ? row.livemode : null,
  };

  // Paid-service count for the card-on-file readiness checklist
  // (C1 read-only display only; not used to gate booking, not used
  // to gate card collection, not exported as a reusable helper).
  // Counts active services with a positive price_cents; free
  // consultations (price_cents = 0 or null, or modality =
  // 'consultation') do not count toward this number.
  const { count: paidServiceCountRaw } = await supabase
    .from("services")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studio.id)
    .eq("active", true)
    .gt("price_cents", 0);
  const paidServiceCount = paidServiceCountRaw ?? 0;

  // C2a-core: readiness checklist flips the policy row green only
  // when BOTH cancellation and no-show policy texts are non-empty.
  // The values themselves are never sent to the client; only the
  // boolean readiness signal is.
  const hasCancellationPolicy =
    (studio.cancellation_policy_text ?? "").trim().length > 0;
  const hasNoShowPolicy =
    (studio.no_show_policy_text ?? "").trim().length > 0;

  // Shared payment-status presenter (PR A): ALL status copy on this page is
  // derived server-side and passed down as plain strings: the client
  // component makes no claims of its own. Runtime mode comes from the
  // deployment (inferStripeLivemode()), never from the nullable row.
  const runtimeMode = currentRuntimeMode();
  const connect = deriveConnectCapability(
    row
      ? {
          accountStatus: row.account_status ?? null,
          chargesEnabled: row.charges_enabled === true,
          payoutsEnabled: row.payouts_enabled === true,
        }
      : error
        ? undefined // read error → "unknown", never an all-clear
        : null,
  );
  // Active card-authorization template presence (read-only; same table the
  // portal gate reads). Errors degrade to "unknown" rather than a claim.
  const { data: authTemplate, error: authTemplateErr } = await supabase
    .from("consent_form_templates")
    .select("id")
    .eq("studio_id", studio.id)
    .eq("form_type", "card_authorization")
    .eq("status", "active")
    .eq("is_live", true)
    .limit(1)
    .maybeSingle();
  const portalCard = authTemplateErr
    ? "unknown"
    : derivePortalCardCapability({
        connect,
        hasActiveAuthorizationTemplate: authTemplate != null,
        publishableKeyOk: publishableKeyOk(),
      });
  const banner = connectBannerCopy(runtimeMode, connect);

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-medium">Payments</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Connect this studio to Stripe to accept payments.{" "}
          {bookingCardCopy(bookingCardCollection())}
        </p>
      </div>
      <PaymentsSettings
        status={status}
        runtimeMode={runtimeMode}
        banner={banner}
        portalCardMessage={portalCardCopy(portalCard)}
        bookingCardMessage={bookingCardCopy(bookingCardCollection())}
        paidServiceCount={paidServiceCount}
        hasCancellationPolicy={hasCancellationPolicy}
        hasNoShowPolicy={hasNoShowPolicy}
      />
      {/* PR #145. Owner-only fee amount settings. Money is not
          charged here; this only persists the dollar amount that
          the manual-fee preview will reuse. */}
      <FeeAmountsCard
        initialLateCancelCents={studio.late_cancel_fee_cents}
        initialNoShowCents={studio.no_show_fee_cents}
      />
    </section>
  );
}

function mapAccountStatus(
  raw: string | null,
): StripeStatusView["accountStatus"] {
  if (raw === "pending") return "pending";
  if (raw === "restricted") return "restricted";
  if (raw === "enabled") return "enabled";
  if (raw === "rejected") return "rejected";
  return "not_connected";
}
