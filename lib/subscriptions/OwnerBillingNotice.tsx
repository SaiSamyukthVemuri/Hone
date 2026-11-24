import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isSelfServeCheckoutEnabled } from "./plans";

export async function OwnerBillingNotice({ studioId }: { studioId: string }) {
  if (!isSelfServeCheckoutEnabled(process.env)) return null;
  const { data } = await (
    await createClient()
  ).rpc("my_hone_billing_status", { p_studio: studioId });
  if (!data) return null;
  return (
    <aside className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2 text-sm">
      {data.deadline && (
        <span role="status">
          {Date.now() >= Date.parse(data.deadline)
            ? "New bookings and charts are paused until payment is received."
            : "Your Hone renewal payment failed. Update your payment method during the seven-day grace period."}
        </span>
      )}
      <Link href="/settings/subscription" className="underline">
        Hone subscription
      </Link>
    </aside>
  );
}
