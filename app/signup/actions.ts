"use server";

import { createClient } from "@/lib/supabase/server";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";

// HON-70 account step (PROPOSED). Creating an ACCOUNT is free and grants no
// studio access: handle_new_user() has no no-invite studio fallback (0081), so
// a new auth user lands on /no-access until a paid plan is confirmed by a
// verified webhook (a later milestone). Nothing here touches Stripe or billing.
//
// Email verification IS the sign-in: the account only exists once the person
// follows the one-time link sent to the address. The response is identical for
// every well-formed address so this form is not an account-enumeration oracle.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SignupResult = { ok: true } | { ok: false; error: string };

export async function requestSignupLinkAction(
  email: string,
): Promise<SignupResult> {
  // Flag off: behave as if the feature does not exist.
  if (!isSelfServeCheckoutEnabled(process.env)) {
    return { ok: false, error: "Not available." };
  }
  const normalized = (email ?? "").trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_RE.test(normalized)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  // After verification the person lands on the ordinary signed-in destination;
  // with no studio the middleware sends them to /no-access. The paid "Start your
  // studio" step is a later milestone and is deliberately not linked from here.
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: normalized,
    options: {
      emailRedirectTo: `${getRequiredAppOrigin()}/auth/callback`,
      shouldCreateUser: true,
    },
  });
  if (error) {
    // No Supabase error text leaves this function (it can quote the address).
    return { ok: false, error: "Could not send the link. Try again in a moment." };
  }
  return { ok: true };
}
