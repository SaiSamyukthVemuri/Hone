import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { PaymentsSettings, type StripeStatusView } from "./PaymentsSettings";

export const dynamic = "force-dynamic";

export default async function PaymentsSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <main className="flex flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <p className="text-sm text-neutral-500">
          Only the studio owner can manage payments.
        </p>
      </main>
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
    <main className="flex flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <p className="text-sm text-neutral-500">
          Studio: <span className="font-medium">{studio.name}</span>
        </p>
      </header>
      <PaymentsSettings status={status} />
    </main>
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
