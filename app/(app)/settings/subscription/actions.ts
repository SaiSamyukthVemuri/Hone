"use server";
import { redirect } from "next/navigation";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { createBillingStripeClient } from "@/lib/subscriptions/billing-client";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";

export async function openOwnerBilling() {
  if (!isSelfServeCheckoutEnabled(process.env)) redirect("/settings");
  const { studio, practitioner } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") redirect("/settings");
  const db = await createClient();
  const { data, error } = await db.rpc("my_hone_billing_status", {
    p_studio: studio.id,
  });
  const config = process.env.HONE_BILLING_PORTAL_CONFIGURATION;
  if (error || !data?.customer || !config)
    redirect("/settings/subscription?error=portal");
  let url: string;
  try {
    url = await createBillingStripeClient(process.env).ownerPortal(
      data.customer,
      getRequiredAppOrigin() + "/settings/subscription",
      config,
    );
  } catch {
    redirect("/settings/subscription?error=portal");
  }
  redirect(url);
}
