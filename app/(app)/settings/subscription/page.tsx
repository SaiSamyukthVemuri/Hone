import { OwnerOnlyNotice } from "@/components/settings/view-heading";
import { notFound } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import {
  isSelfServeCheckoutEnabled,
  parsePlanKey,
  PLANS,
  teamAllowance,
} from "@/lib/subscriptions/plans";
import { openOwnerBilling } from "./actions";

export default async function SubscriptionPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (!isSelfServeCheckoutEnabled(process.env)) notFound();
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") return <OwnerOnlyNotice>Only studio owners can manage billing.</OwnerOnlyNotice>;
  const { data, error } = await (
    await createClient()
  ).rpc("my_hone_billing_status", { p_studio: studio.id });
  if (error) throw new Error("Could not load subscription.");
  const plan = parsePlanKey(data?.plan);
  if (!plan) notFound();
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Hone subscription</h1>
      <p>
        {PLANS[plan].label} · US${PLANS[plan].unitAmount / 100}/month
      </p>
      <p>{teamAllowance(plan)}. The owner uses one practitioner seat.</p>
      {data.deadline && (
        <p>
          {Date.now() >= Date.parse(data.deadline)
            ? "New bookings and charts are paused."
            : "Payment is overdue. Your grace period ends " +
              new Date(data.deadline).toLocaleString("en-US", {
                timeZone: studio.timezone ?? "UTC",
                timeZoneName: "short",
              }) +
              "."}
        </p>
      )}
      <form action={openOwnerBilling}>
        <button className="rounded border px-4 py-2">
          Manage billing and invoices
        </button>
      </form>
      {(await searchParams).error && (
        <p role="alert">The billing portal is unavailable. Please try again.</p>
      )}
    </section>
  );
}
