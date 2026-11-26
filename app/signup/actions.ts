"use server";

import { createClient } from "@/lib/supabase/server";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import {
  isSelfServeCheckoutEnabled,
  parsePlanKey,
} from "@/lib/subscriptions/plans";
import { invitationDestination } from "@/lib/supabase/invitation-destination";
import { clearSelectedStudioId } from "@/lib/supabase/selected-studio";

type Result = { ok: true; destination?: string } | { ok: false; error: string };
const unavailable = {
  ok: false,
  error: "Sign-in is unavailable. Please try again.",
} as const;

export async function startOwnerSignIn(
  planInput: string,
  emailInput?: string,
): Promise<Result> {
  const plan = parsePlanKey(planInput);
  const returning = planInput === "signin";
  if ((!plan && !returning) || !isSelfServeCheckoutEnabled(process.env))
    return unavailable;
  const next = returning ? "/dashboard" : "/no-access?plan=" + plan;
  try {
    const origin = getRequiredAppOrigin();
    const auth = await createClient();
    if (emailInput === undefined) {
      const callback = new URL("/auth/callback", origin);
      callback.searchParams.set("next", next);
      const { data, error } = await auth.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: callback.href, skipBrowserRedirect: true },
      });
      return error || !data.url
        ? unavailable
        : { ok: true, destination: data.url };
    }
    const email = emailInput.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return { ok: false, error: "Enter a valid email address." };
    const { error } = await auth.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: !returning,
        emailRedirectTo: origin + "/signup",
      },
    });
    return error ? unavailable : { ok: true };
  } catch {
    return unavailable;
  }
}

export async function confirmOwnerCode(
  planInput: string,
  emailInput: string,
  code: string,
): Promise<Result> {
  const plan = parsePlanKey(planInput);
  const returning = planInput === "signin";
  if ((!plan && !returning) || !isSelfServeCheckoutEnabled(process.env))
    return unavailable;
  const next = returning ? "/dashboard" : "/no-access?plan=" + plan;
  const email = emailInput.trim().toLowerCase();
  const invalid = {
    ok: false,
    error: "That code is invalid or expired. Try again or request a new code.",
  } as const;
  if (!/^\d{6,10}$/.test(code) || !email || email.length > 254) return invalid;
  try {
    const db = await createClient();
    const { data, error } = await db.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    if (error || !data.user) return invalid;
    const { dest, clearSelection } = await invitationDestination(db, next);
    if (clearSelection) await clearSelectedStudioId();
    return { ok: true, destination: dest };
  } catch {
    return unavailable;
  }
}
