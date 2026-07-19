import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  captureServerEvent,
  identifyServerUser,
} from "@/lib/analytics/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user) {
      // Post-response, bounded: sign-in must never fail or stall because
      // PostHog is unavailable (P1/P2-ANALYTICS-03). Identify carries the
      // opaque auth user id ONLY — the wrapper does not accept person
      // properties (clinical-data posture); the (app)-layout PostHogIdentify
      // separately attaches the non-PII `role` client-side.
      identifyServerUser({ distinctId: data.user.id });
      captureServerEvent({
        distinctId: data.user.id,
        event: "user_signed_in",
        properties: { provider: "magic_link" },
      });
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
