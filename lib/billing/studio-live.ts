import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The app's copy of the database's `studio_has_gone_live` (0394): the ONE definition of a LIVE studio. A studio is live when it has a Stripe Connect settings row in LIVE mode
 * with an account id (it connected live Stripe: no payment needed, so cash or a transfer can be its first real money), OR a succeeded live card attempt.
 * Derived from rows only, never from a caller. `studio_payment_settings` has no owner policy and is written only by the service-role provisioning functions, so it is read
 * with the service role. A failed read is `null`: the caller fails closed (never guesses "not live").
 */
export async function readStudioLive(admin: SupabaseClient, studioId: string): Promise<boolean | null> {
  const [settings, attempts] = await Promise.all([
    admin.from("studio_payment_settings").select("studio_id").eq("studio_id", studioId).eq("stripe_livemode", true).not("stripe_account_id", "is", null).limit(1),
    admin.from("payment_charge_attempts").select("id").eq("studio_id", studioId).eq("stripe_livemode", true).eq("status", "succeeded").limit(1),
  ]);
  if (settings.error || attempts.error) return null;
  return (settings.data?.length ?? 0) > 0 || (attempts.data?.length ?? 0) > 0;
}
