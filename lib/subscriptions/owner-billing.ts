import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { isSelfServeCheckoutEnabled, type PlanKey } from "./plans";

export type OwnerBilling = {
  plan: PlanKey;
  status: "active" | "past_due" | "paused" | "canceled" | "canceling";
  change_id: string | null;
  pending: PlanKey | "cancel" | null;
  canceled_at: string | null;
  deadline: string | null;
  customer: string;
  subscription: string;
  invoice: string | null;
};

// Request-local so the Settings rail, notice and page share one owner-scoped read.
export const readOwnerBilling = cache(async (studioId: string) => {
  const db = await createClient();
  const { data, error } = await db.rpc("my_hone_billing_status", { p_studio: studioId });
  return { billing: data as OwnerBilling | null, error: Boolean(error) };
});

export async function ownerWorkspacePaused(studioId: string) {
  if (!isSelfServeCheckoutEnabled(process.env)) return false;
  const { billing } = await readOwnerBilling(studioId);
  return billing?.status === "canceled" || billing?.status === "canceling";
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
