import Link from "next/link";
import { readOwnerBilling } from "./owner-billing";
import { isSelfServeCheckoutEnabled } from "./plans";

export async function OwnerBillingNotice({ studioId }: { studioId: string }) {
  if (!isSelfServeCheckoutEnabled(process.env)) return null;
  const { billing } = await readOwnerBilling(studioId);
  if (!billing) return null;
  return (
    <aside className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2 text-sm">
      {(billing.status === "canceling" || billing.status === "canceled") && <span>Studio access is paused.</span>}
      {billing.deadline && (billing.status === "past_due" || billing.status === "paused") && (
        <span role="status">
          {billing.status === "paused"
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
