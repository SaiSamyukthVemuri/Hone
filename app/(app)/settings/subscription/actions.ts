"use server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { createSubscriptionCheckout, CHECKOUT_SESSION_TTL_SECONDS } from "@/lib/subscriptions/checkout-session";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { processSubscriptionChange } from "@/lib/subscriptions/subscription-change";
import { redirect } from "next/navigation";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createBillingStripeClient } from "@/lib/subscriptions/billing-client";
import { hostedInvoiceUrl } from "@/lib/subscriptions/hosted-invoice-url";
import { readOwnerBilling } from "@/lib/subscriptions/owner-billing";
import { isSelfServeCheckoutEnabled, parsePlanKey } from "@/lib/subscriptions/plans";

const billingPath = "/settings/subscription";

async function requireOwnerBilling(expectedStudio: string) {
  if (!isSelfServeCheckoutEnabled(process.env)) redirect("/settings");
  const { studio, practitioner } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner" || studio.id !== expectedStudio) redirect("/settings");
  const { billing, error } = await readOwnerBilling(studio.id);
  if (error || !billing?.customer || !billing.subscription) redirect(billingPath + "?error=billing");
  return billing;
}

async function openPortal(billing: Awaited<ReturnType<typeof requireOwnerBilling>>, updateCard = false) {
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
  const billing = await requireOwnerBilling(studioId);
  return openPortal(billing);
}

export async function updateBillingCard(studioId: string) {
  const billing = await requireOwnerBilling(studioId);
  return openPortal(billing, true);
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

export async function loadOlderInvoices(studioId: string, cursor: string) {
  const billing = await requireOwnerBilling(studioId);
  if (!/^in_[A-Za-z0-9_]{1,120}$/.test(cursor)) return null;
  try {
    return await createBillingStripeClient(process.env).billingInvoices(billing.customer, billing.subscription, cursor);
  } catch {
    return null;
  }
}

export async function changeSubscription(studioId: string, version: string | null, form: FormData) {
  await requireOwnerBilling(studioId);
  const target = form.get("target");
  if ((target !== "cancel" && !parsePlanKey(target)) ||
      (target === "cancel" && form.get("confirm") !== "cancel-now")) redirect(billingPath + "?error=change");
  const db = await createClient();
  const { data, error } = await db.rpc("request_hone_subscription_change", {
    p_studio: studioId, p_target: target, p_version: version, p_team_version: form.get("teamVersion"),
  });
  if (error || !data) redirect(billingPath + "?error=change");
  const { result, id } = data;
  if (["billing_owner", "team_changed", "stale", "overdue"].includes(result)) redirect(billingPath + "?error=" + result);
  let outcome = result;
  if (result === "pending") {
    // The database already paused a confirmed cancellation, even if Stripe is temporarily offline.
    try { outcome = await processSubscriptionChange(id); } catch { outcome = "pending"; }
  }
  revalidatePath("/", "layout");
  redirect(billingPath + (outcome === "refused" ? "?error=change" : "?notice=change"));
}

export async function restartSubscription(studioId: string) {
  await requireOwnerBilling(studioId);
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect("/login");
  type Claim = { id: string; created: number; attempt: string; customer: string; plan: string };
  const admin = createAdminClient();
  async function claim(expired: string | null): Promise<Claim> {
    const { data, error } = await admin.rpc("claim_hone_restart", {
      p_studio: studioId, p_user: user!.id, p_expired: expired,
    });
    if (error || !data) throw new Error("restart_unavailable");
    return data;
  }
  let destination = billingPath + "?error=restart";
  try {
    let intent = await claim(null);
    const client = createBillingStripeClient(process.env);
    if (intent.created + CHECKOUT_SESSION_TTL_SECONDS <= Date.now()/1000) {
      const session = await client.findAttemptSession({ ...intent, session: null });
      if (!session || session.status === "expired") intent = await claim(intent.id);
      else if (session.status === "complete") destination = billingPath + "?notice=restarting";
      else if (session.url) destination = session.url;
    }
    if (intent.created + CHECKOUT_SESSION_TTL_SECONDS > Date.now()/1000) {
      const result = await createSubscriptionCheckout({
        env: process.env, client, origin: getRequiredAppOrigin(), user,
        plan: intent.plan, attemptId: intent.attempt, nowSeconds: intent.created,
        restart: { id: intent.id, customer: intent.customer },
      });
      if (result.ok) destination = result.url;
    }
  } catch { /* The same intent can be retried after an interrupted request. */ }
  redirect(destination);
}
