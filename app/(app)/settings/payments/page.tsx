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

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-medium">Payments</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Connect this studio to Stripe so it can accept payments later.
          Public booking does not collect cards from clients yet.
        </p>
      </div>
      <PaymentsSettings status={status} />
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
