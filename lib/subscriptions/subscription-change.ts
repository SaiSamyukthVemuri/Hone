import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { createBillingStripeClient } from "./billing-client";
import type { PlanKey } from "./plans";

export type SubscriptionChange = {
  id: string; target: PlanKey | "cancel"; plan: PlanKey; user: string;
  attempt: string; subscription: string; customer: string;
};

// Persisted owner intent makes an interrupted or repeated request recoverable.
export async function processSubscriptionChange(id: string | null) {
  const db = createAdminClient();
  const claim = await db.rpc("claim_hone_subscription_change", { p_id: id });
  if (claim.error) throw new Error("Billing change unavailable");
  if (!claim.data) return "idle";
  const change: SubscriptionChange = claim.data;
  const outcome = await createBillingStripeClient(process.env).applyOwnerChange(change);
  const final = outcome === "canceled"
    ? await db.rpc("record_hone_subscription_canceled", {
        p_subscription: change.subscription, p_customer: change.customer,
        p_attempt: change.attempt, p_user: change.user,
      })
    : await db.rpc("finish_hone_subscription_change", { p_id: change.id, p_applied: outcome === "applied" });
  if (final.error) throw new Error("Billing change awaiting reconciliation");
  return final.data ? outcome : "idle";
}
