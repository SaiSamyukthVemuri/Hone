import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPostHogClient } from "@/lib/posthog-server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user) {
      const posthog = getPostHogClient();
      // Identify by the opaque auth user id only. Do NOT attach email (or any
      // other PII) to the PostHog person profile — clinical-data posture. The
      // (app)-layout PostHogIdentify separately attaches the non-PII `role`.
      posthog.identify({
        distinctId: data.user.id,
      });
      posthog.capture({
        distinctId: data.user.id,
        event: "user_signed_in",
        properties: { provider: "magic_link" },
      });
      await posthog.flush();
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
