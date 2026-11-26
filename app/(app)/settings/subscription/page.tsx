import { notFound } from "next/navigation";
import { OwnerOnlyNotice, SettingsViewHeading } from "@/components/settings/view-heading";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { readOwnerBilling } from "@/lib/subscriptions/owner-billing";
import { isSelfServeCheckoutEnabled, PLANS, teamAllowance } from "@/lib/subscriptions/plans";
import { openOwnerBilling, payOutstandingInvoice, updateBillingCard } from "./actions";

const states = {
  active: { label: "Active", tone: "success" },
  past_due: { label: "Payment overdue", tone: "warning" },
  paused: { label: "Access paused", tone: "danger" },
} as const;

export default async function SubscriptionPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  if (!isSelfServeCheckoutEnabled(process.env)) notFound();
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") return <OwnerOnlyNotice>Only studio owners can manage billing.</OwnerOnlyNotice>;
  const { billing, error } = await readOwnerBilling(studio.id);
  if (!error && !billing) notFound();
  const heading = <SettingsViewHeading title="Billing">Your Hone subscription for {studio.name}.</SettingsViewHeading>;
  if (error || !billing || !states[billing.status] || !PLANS[billing.plan]) {
    return <section className="space-y-4">{heading}<p role="alert">We couldn’t load your subscription. Refresh this page to try again.</p></section>;
  }
  const plan = PLANS[billing.plan];
  const state = states[billing.status];
  const query = await searchParams;
  return (
    <section className="space-y-4">
      {heading}
      <Card as="section" aria-label="Current plan" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-medium">{plan.label} plan</h3>
          <StatusPill tone={state.tone}>{state.label}</StatusPill>
        </div>
        <p className="text-sm">US${plan.unitAmount / 100} per month</p>
        <p className="text-sm text-fg-muted">{teamAllowance(billing.plan)}. The owner uses one practitioner seat.</p>
        {billing.status === "past_due" && billing.deadline && (
          <p>Pay before {new Date(billing.deadline).toLocaleString("en-US", {
            timeZone: studio.timezone || "UTC", timeZoneName: "short",
            month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
          })} to keep new bookings and chart entries available.</p>
        )}
        {billing.status === "paused" && (
          <p>You can still view your records. Pay your overdue invoices to resume new bookings and chart entries.</p>
        )}
        {billing.invoice && (
          <form action={payOutstandingInvoice.bind(null, studio.id)}>
            <Button type="submit" variant="primary">Pay outstanding invoice</Button>
          </form>
        )}
      </Card>
      <Card as="section" aria-label="Payment method and invoices" className="space-y-3">
        <h3 className="font-medium">Payment method and invoices</h3>
        <div className="flex flex-wrap gap-2">
          <form action={updateBillingCard.bind(null, studio.id)}>
            <Button type="submit">Update card</Button>
          </form>
          <form action={openOwnerBilling.bind(null, studio.id)}>
            <Button type="submit">View invoices and receipts</Button>
          </form>
        </div>
      </Card>
      {query.error && <p role="alert">{query.error === "invoice"
        ? "We couldn’t open that invoice for payment. Check your invoice history or try again."
        : "We couldn’t open billing. Please try again."}</p>}
      {query.notice === "settling" && billing.invoice && (
        <p role="status">Check your invoice history for the latest payment. Refresh this page to see your updated access.</p>
      )}
    </section>
  );
}
