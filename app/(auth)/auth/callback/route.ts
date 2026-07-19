import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  captureServerEvent,
  identifyServerUser,
} from "@/lib/analytics/server";
import { isAnalyticsUuid } from "@/lib/analytics/ids";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user) {
      // Post-response, bounded: sign-in must never fail or stall because
      // PostHog is unavailable (P1/P2-ANALYTICS-03). Identify by opaque UUID
      // only; the (app) layout re-identifies with the validated coarse role.
      if (isAnalyticsUuid(data.user.id)) {
        identifyServerUser({ id: data.user.id });
        captureServerEvent({
          actor: { kind: "user", id: data.user.id },
          event: "user_signed_in",
          properties: { provider: "magic_link" },
        });
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
