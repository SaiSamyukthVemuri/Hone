"use server";
import { redirect } from "next/navigation";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createBillingStripeClient } from "@/lib/subscriptions/billing-client";
import { hostedInvoiceUrl } from "@/lib/subscriptions/hosted-invoice-url";
import { readOwnerBilling } from "@/lib/subscriptions/owner-billing";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";

const billingPath = "/settings/subscription";

async function requireOwnerBilling(expectedStudio: string) {
  if (!isSelfServeCheckoutEnabled(process.env)) redirect("/settings");
  const { studio, practitioner } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner" || studio.id !== expectedStudio) redirect("/settings");
  const { billing, error } = await readOwnerBilling(studio.id);
  if (error || !billing?.customer || !billing.subscription) redirect(billingPath + "?error=billing");
  return billing;
}

async function openPortal(studioId: string, updateCard = false) {
  const billing = await requireOwnerBilling(studioId);
  const config = process.env.HONE_BILLING_PORTAL_CONFIGURATION;
  if (!config) redirect(billingPath + "?error=portal");
  let url: string;
  try {
    url = await createBillingStripeClient(process.env).ownerPortal(
      billing.customer,
      getRequiredAppOrigin() + billingPath,
      config,
      updateCard ? { subscription: billing.subscription } : undefined,
    );
  } catch {
    redirect(billingPath + "?error=portal");
  }
  redirect(url);
}

export async function openOwnerBilling(studioId: string) {
  return openPortal(studioId);
}

export async function updateBillingCard(studioId: string) {
  return openPortal(studioId, true);
}

export async function payOutstandingInvoice(studioId: string) {
  const billing = await requireOwnerBilling(studioId);
  if (!billing.invoice) redirect(billingPath);
  let url: string | null = null;
  let alreadyPaid = false;
  try {
    const invoice = await createBillingStripeClient(process.env).readNoticeInvoice(billing.invoice);
    if (!invoice.live && invoice.id === billing.invoice &&
        invoice.customer === billing.customer && invoice.subscription === billing.subscription) {
      alreadyPaid = invoice.status === "paid" && invoice.amountRemaining === 0;
      if ((invoice.status === "open" || invoice.status === "uncollectible") && invoice.amountRemaining > 0) {
        url = hostedInvoiceUrl(invoice.hostedUrl);
      }
    }
  } catch {
    redirect(billingPath + "?error=invoice");
  }
  if (alreadyPaid) redirect(billingPath + "?notice=settling");
  redirect(url ?? billingPath + "?error=invoice");
}
