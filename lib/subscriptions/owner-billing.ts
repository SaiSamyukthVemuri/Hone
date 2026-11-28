import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import type { PlanKey } from "./plans";

export type OwnerBilling = {
  plan: PlanKey;
  status: "active" | "past_due" | "paused" | "canceled" | "canceling";
  change_id: string | null;
  pending: PlanKey | "cancel" | null;
  canceled_at: string | null;
  deadline: string | null;
  overdue: boolean;
};

// The provider ids never travel in the signed-in status call. The server reads them for the
// verified owner only, to open the portal or list invoices.
export type ProviderIds = { customer: string; subscription: string; invoice: string | null };

// Request-local so the Settings rail, notice and page share one owner-scoped read.
export const readOwnerBilling = cache(async (studioId: string) => {
  const db = await createClient();
  const { data, error } = await db.rpc("my_hone_billing_status", { p_studio: studioId });
  return { billing: data as OwnerBilling | null, error: Boolean(error) };
});

export async function readOwnerProviderIds(studioId: string): Promise<ProviderIds | null> {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return null;
  const { data, error } = await createAdminClient().rpc("read_hone_billing_provider_ids", { p_studio: studioId, p_user: user.id });
  if (error || !data?.customer || !data?.subscription) return null;
  return data as ProviderIds;
}

export type SoloImpact = {
  version: string;
  owner: string;
  can_confirm: boolean;
  members: { name: string; role: "owner" | "practitioner" | "receptionist" }[];
  invitations: string[];
};

export async function readSoloImpact(studioId: string): Promise<SoloImpact | null> {
  const db = await createClient();
  const { data, error } = await db.rpc("my_hone_solo_impact", { p_studio: studioId });
  if (error || !data) return null;
  return data;
}
