import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { PlanKey } from "./plans";

export type OwnerBilling = {
  plan: PlanKey;
  status: "active" | "past_due" | "paused";
  deadline: string | null;
  customer: string;
  subscription: string;
  invoice: string | null;
};

// Request-local so the Settings rail, notice and page share one owner-scoped read.
export const readOwnerBilling = cache(async (studioId: string) => {
  const db = await createClient();
  const { data, error } = await db.rpc("my_hone_billing_status", { p_studio: studioId });
  return { billing: data as OwnerBilling | null, error };
});
