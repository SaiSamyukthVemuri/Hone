"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { createBillingStripeClient } from "@/lib/subscriptions/billing-client";
import {
  createSubscriptionCheckout,
  CHECKOUT_SESSION_TTL_SECONDS,
} from "@/lib/subscriptions/checkout-session";
import {
  parsePlanKey,
  isSelfServeCheckoutEnabled,
} from "@/lib/subscriptions/plans";

type Attempt = {
  id: string;
  state: string;
  email: string;
  plan: string;
  created: number;
  session: string | null;
  url: string | null;
};

export async function beginStudioCheckout(form: FormData) {
  if (!isSelfServeCheckoutEnabled(process.env)) redirect("/no-access");
  const plan = parsePlanKey(form.get("plan"));
  const studio = String(form.get("studio") ?? "").trim();
  const owner = String(form.get("owner") ?? "").trim();
  if (!plan || !studio || studio.length > 100 || !owner || owner.length > 100)
    redirect("/no-access?reason=checkout-input" + (plan ? "&plan=" + plan : ""));
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user?.email_confirmed_at || !user.email) redirect("/login");

  let destination = "/no-access?reason=checkout-unavailable";
  try {
    const client = createBillingStripeClient(process.env);
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("claim_hone_signup", {
      p_user: user.id,
      p_plan: plan,
      p_studio: studio,
      p_owner: owner,
    });
    if (error || !data) throw new Error("claim_failed");
    const a = data as Attempt;
    if (a.state !== "open") {
      destination = "/dashboard";
    } else if (a.created + CHECKOUT_SESSION_TTL_SECONDS <= Date.now() / 1000) {
      const previous = await client.findAttemptSession(a);
      if (previous?.status === "complete") {
        destination = "/no-access?reason=confirming-payment";
      } else if (previous?.status === "open" && previous.url && (previous.expires_at ?? 0) > Date.now() / 1000 + 60) {
        destination = previous.url;
      } else if (!previous || previous.status === "expired") {
        const release = await admin.rpc("expire_hone_checkout", {
          p_attempt: a.id,
          p_user: user.id,
          p_session: previous?.id ?? null,
        });
        if (release.error) throw new Error("release_failed");
        destination = "/no-access?reason=checkout-expired";
      }
    } else if (a.plan !== plan) {
      destination = "/no-access?reason=checkout-open";
    } else if (a.url) {
      destination = a.url;
    } else {
      // A crash can leave a session at Stripe that was never bound. Reuse it rather than open a second one.
      const prior = await client.findAttemptSession(a).catch(() => null);
      if (prior?.status === "complete") {
        destination = "/no-access?reason=confirming-payment";
      } else {
        // Expiry is measured from THIS request, never from the claim: Stripe refuses a session that
        // expires in under 30 minutes, and a retry a minute after the claim would otherwise fall below it.
        const requestSeconds = Math.floor(Date.now() / 1000);
        const reusable = prior?.status === "open" && prior.url && (prior.expires_at ?? 0) > requestSeconds + 60;
        const result = reusable
          ? { ok: true as const, sessionId: prior!.id, url: prior!.url as string }
          : await createSubscriptionCheckout({
              client,
              plan,
              env: process.env,
              origin: getRequiredAppOrigin(),
              user: { id: user.id, email: a.email },
              attemptId: a.id,
              nowSeconds: requestSeconds,
            });
        if (result.ok) {
          const bound = await admin.rpc("bind_hone_checkout", {
            p_attempt: a.id,
            p_user: user.id,
            p_session: result.sessionId,
            p_url: result.url,
          });
          if (bound.error) throw new Error("bind_failed");
          destination = bound.data
            ? result.url
            : "/no-access?reason=confirming-payment";
        }
      }
    }
  } catch {
    // The original claim and Stripe idempotency key survive a lost response.
  }
  if (plan && destination.startsWith("/no-access?reason=checkout-")) destination += "&plan=" + plan;
  redirect(destination);
}
