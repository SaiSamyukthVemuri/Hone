import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";

// PR #135. Server-only reads for client_payment_methods. Every
// function is scoped by explicit (studioId, clientId) that callers
// must resolve from getCurrentPractitionerWithStudio() (practitioner
// side) or getCurrentPortalSession() (portal side).
//
// We DELIBERATELY do not select Stripe id columns
// (stripe_customer_id, stripe_payment_method_id, stripe_setup_intent_id,
// stripe_account_id) into the UI surface; those are operational
// fields the audit query can read via the service-role admin client
// when needed but should not flow into rendered HTML.

export type ActiveCardSummary = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  addedAt: string;
  cardAuthorizationSignatureId: string | null;
};

export async function getActiveCardForStudioClient(
  studioId: string,
  clientId: string,
): Promise<ActiveCardSummary | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_payment_methods")
    .select(
      "id, brand, last4, exp_month, exp_year, added_at, card_authorization_signature_id",
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("status", "active")
    .order("added_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(
      JSON.stringify({
        event: "active_card_lookup_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }
  if (!data) return null;
  return {
    id: data.id as string,
    brand: data.brand as string,
    last4: data.last4 as string,
    expMonth: data.exp_month as number,
    expYear: data.exp_year as number,
    addedAt: data.added_at as string,
    cardAuthorizationSignatureId:
      (data.card_authorization_signature_id as string | null) ?? null,
  };
}
