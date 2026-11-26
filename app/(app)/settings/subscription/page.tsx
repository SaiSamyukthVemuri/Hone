import { notFound } from "next/navigation";
import { OwnerOnlyNotice, SettingsViewHeading } from "@/components/settings/view-heading";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { SubscriptionControls } from "./subscription-controls";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createBillingStripeClient } from "@/lib/subscriptions/billing-client";
import { readOwnerBilling, readSoloImpact } from "@/lib/subscriptions/owner-billing";
import { isSelfServeCheckoutEnabled, PLANS, teamAllowance } from "@/lib/subscriptions/plans";
import { openOwnerBilling, payOutstandingInvoice, updateBillingCard } from "./actions";
import { InvoiceHistory } from "./invoice-history";

const states = {
  canceling: { label: "Cancellation pending", tone: "warning" },
  canceled: { label: "Canceled", tone: "neutral" },
  active: { label: "Active", tone: "success" },
  past_due: { label: "Payment overdue", tone: "warning" },
  paused: { label: "Access paused", tone: "danger" },
} as const;
const split = "flex flex-wrap items-center justify-between gap-x-5 gap-y-3";
const section = "space-y-4 border-t border-line py-6";
const sectionTitle = "text-base font-semibold tracking-tight";
const secondary = "text-sm text-fg-muted";
async function stripeOverview(customer: string, subscription: string) {
  try {
    const stripe = createBillingStripeClient(process.env);
    const config = process.env.HONE_BILLING_PORTAL_CONFIGURATION;
    const [profile, invoices, editTax] = await Promise.all([
      stripe.billingProfile(customer, subscription).catch(() => null),
      stripe.billingInvoices(customer, subscription).catch(() => null),
      config ? stripe.canEditTaxId(config).catch(() => false) : false,
    ]);
    return { profile, invoices, editTax };
  } catch {
    return { profile: null, invoices: null, editTax: false };
  }
}

export default async function SubscriptionPage({ searchParams }: {
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
  const [{ profile, invoices, editTax }, soloImpact] = await Promise.all([
    stripeOverview(billing.customer, billing.subscription), billing.plan === "studio" && billing.status === "active" ? readSoloImpact(studio.id).catch(() => null) : null,
  ]);
  const terminal = billing.status === "canceled" || billing.status === "canceling";
  const controls = { studioId: studio.id, studioName: studio.name, current: billing.plan, version: billing.change_id ?? null,
    soloImpact };
  const plan = PLANS[billing.plan];
  const state = states[billing.status];
  const query = await searchParams;
  const tz = studio.timezone || "UTC";
  const formatDate = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-US", { timeZone: tz, dateStyle: "long" });
  const portal = openOwnerBilling.bind(null, studio.id);
  return <section className="mx-auto w-full max-w-4xl">
    <div>{heading}</div>
    {query.error && <p role="alert" className="my-4 text-sm text-danger-fg">{query.error === "invoice"
      ? "We couldn’t open that invoice for payment. Check your invoice history or try again."
      : query.error === "team_changed" ? "Your team changed. Open Change tier to review who will lose access."
      : query.error === "billing_owner" ? "Only the subscription owner can switch this studio to Solo."
      : query.error === "stale" ? "Your subscription changed. Review the current details before trying again."
      : query.error === "overdue" ? "Pay outstanding invoices before changing tiers."
      : query.error === "change" ? "We couldn’t complete that change. Review your billing details and try again."
      : "We couldn’t open billing. Please try again."}</p>}
    {query.notice === "settling" && billing.invoice && <p role="status" className="my-4 text-sm">Check your invoice history for the latest payment.</p>}
    <section aria-label="Current plan" className="py-6">
      <div className={split}>
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-xl font-semibold text-on-accent" aria-hidden="true">H</span>
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2"><h3 className="text-xl font-semibold tracking-tight">{terminal ? "Former " : ""}{plan.label} plan</h3><StatusPill tone={state.tone}>{state.label}</StatusPill></div>
            <p className="text-sm font-medium">{terminal && "Previous rate · "}US${plan.unitAmount / 100} per month</p>
            {!terminal && profile?.ends ? <p className={secondary}>Scheduled to end {formatDate(profile.ends)}.</p>
              : billing.status === "active" && profile?.renews ? <p className={secondary}>Renews {formatDate(profile.renews)}.</p> : null}
          </div>
        </div>
        {billing.status === "active" && !billing.pending && !profile?.ends && <SubscriptionControls kind="tier" {...controls} />}
      </div>
      {billing.pending && !terminal && <p role="status" className="mt-4 text-sm">Your tier change is processing. Refresh Billing to check its status.</p>}
      {!terminal && <p className="mt-5 text-sm text-fg-muted">{teamAllowance(billing.plan)}. The owner uses one practitioner seat.</p>}
      {(billing.status !== "active" || billing.invoice) && <div className="mt-4 space-y-3 rounded-lg border border-line bg-surface-sunken p-4 text-sm">
        {terminal && <p role="status">{billing.status === "canceled"
          ? "Your subscription is canceled. Studio access is paused. You can still manage billing and download invoices."
          : "Studio access is paused. We’re confirming the cancellation with Stripe."}</p>}
        {billing.status === "past_due" && billing.deadline && <p>Pay before {new Date(billing.deadline).toLocaleString("en-US", {
          timeZone: tz, timeZoneName: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
        })} to keep new bookings and chart entries available.</p>}
        {billing.status === "paused" && <p>You can still view your records. Pay your overdue invoices to resume new bookings and chart entries.</p>}
        {billing.invoice && <form action={payOutstandingInvoice.bind(null, studio.id)}><Button type="submit" variant="primary">Pay outstanding invoice</Button></form>}
      </div>}
    </section>
    <section aria-labelledby="billing-payment" className={section}>
      <h3 id="billing-payment" className={sectionTitle}>Payment method</h3>
      <div className={split}>
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-12 shrink-0 place-items-center rounded-lg border border-line" aria-hidden="true"><span className="h-4 w-6 rounded border border-current bg-[linear-gradient(transparent_25%,currentColor_25%,currentColor_44%,transparent_44%)]" /></span>
          <div>{profile?.card ? <>
            <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium"><span className="capitalize">{profile.card.brand}</span> •••• {profile.card.last4}</span><StatusPill>Default</StatusPill></div>
            <p className={secondary}>Expires {profile.card.expires}</p></> :
            <p className={secondary}>{!profile ? "Card details are temporarily unavailable." : profile.hasMethod ? "Payment method on file with Stripe." : "No payment method on file."}</p>}
          </div>
        </div>
        <form action={updateBillingCard.bind(null, studio.id)}><Button size="sm" type="submit">{profile && !profile.hasMethod ? "Add card" : "Update card"}</Button></form>
      </div>
    </section>
    <section aria-labelledby="billing-tax" className={section}>
      <div className={split}><div className="space-y-1"><h3 id="billing-tax" className={sectionTitle}>Tax ID</h3>
        {profile?.taxIds ? profile.taxIds.length ? profile.taxIds.map((tax, i) => <p key={i} className={secondary}>{tax.type} ending in {tax.last4}</p>) : <p className={secondary}>No tax ID on file.</p>
          : <p className={secondary}>Tax ID details are temporarily unavailable.</p>}</div>
        {editTax && <form action={portal}><Button size="sm" type="submit">{profile?.taxIds?.length === 0 ? "Add tax ID" : "Manage tax IDs"}</Button></form>}
      </div>
    </section>
    <section aria-labelledby="billing-invoices" className={section}>
      <div className={split}><h3 id="billing-invoices" className={sectionTitle}>Invoices</h3>
        <form action={portal}><Button size="sm" variant="quiet" type="submit">View invoices and receipts</Button></form>
      </div>
      {invoices ? <InvoiceHistory key={studio.id + ":" + (invoices.next ?? "")} initial={invoices} studioId={studio.id} timezone={tz}/>
        : <p className={secondary}>Invoice history is temporarily unavailable here. You can still open it in Stripe.</p>}
    </section>
    {!terminal && <section aria-labelledby="billing-cancel" className={section}>
      <div className={split}><div className="space-y-1"><h3 id="billing-cancel" className={sectionTitle}>Cancellation</h3>
        <p className={secondary}>Cancel now to end future renewals and pause studio access immediately.</p></div>
        <SubscriptionControls kind="cancel" {...controls}/></div>
    </section>}
  </section>;
}
