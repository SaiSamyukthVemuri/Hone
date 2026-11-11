"use server";

import { createClient } from "@/lib/supabase/server";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";

// HON-70 account step (PROPOSED). Creating an ACCOUNT is free and grants no
// studio access: handle_new_user() has no no-invite studio fallback (0081), so
// a new auth user lands on /no-access until a paid plan is confirmed by a
// verified webhook (a later milestone). Nothing here touches Stripe or billing.
//
// The person confirms their address by following the one-time link. Whether
// Supabase creates the auth row at request time or at link time is NOT verified
// here (Privacy 1e5bc9a4 (b)), so neither this comment nor the copy claims
// either. The response is identical for every well-formed address so this form
// is not an account-enumeration oracle.
//
// DELIBERATE REVERSAL of PR #189: the login action allowed user creation only
// for an invited address; this sets shouldCreateUser true for ANY well-formed
// address. Flag-gated; a Sam decision, named in the PR body.

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
  // The chosen plan is NOT carried through the link: it is re-chosen after
  // verification (Insurance U-6). A missing origin env is a generic failure, not
  // an unhandled 500.
  let redirectTo: string;
  try {
    redirectTo = `${getRequiredAppOrigin()}/auth/callback`;
  } catch {
    // One bounded server-side signal for a misconfigured deployment: a fixed
    // code only, never the address or the error text (Insurance G-5).
    console.error("signup_origin_unavailable");
    return { ok: false, error: "Could not send the link. Try again in a moment." };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: normalized,
    options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
  });
  if (error) {
    // No Supabase error text leaves this function (it can quote the address).
    return { ok: false, error: "Could not send the link. Try again in a moment." };
  }
  return { ok: true };
}
