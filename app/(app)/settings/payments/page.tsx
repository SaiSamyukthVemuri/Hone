import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { PaymentsSettings, type StripeStatusView } from "./PaymentsSettings";

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
  // RPC via is_studio_owner().
  const supabase = await createClient();
  const { data: rows, error } = await supabase.rpc(
    "get_studio_payment_settings_display",
    { p_studio_id: studio.id },
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

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-medium">Payments</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Connect this studio to Stripe so it can accept payments later.
          Public booking does not collect cards from clients yet.
        </p>
      </div>
      <PaymentsSettings
        status={status}
        paidServiceCount={paidServiceCount}
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
