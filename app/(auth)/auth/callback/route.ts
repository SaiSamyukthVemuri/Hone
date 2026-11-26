import { invitationDestination } from "@/lib/supabase/invitation-destination";
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

      // Existing-account invitation reconciliation. handle_new_user() only
      // provisions the membership when a NEW auth.users row is inserted, so an
      // email that already has a Hone account, invited to a new studio, would
      // otherwise sign in with the invite left 'pending' and land on /no-access.
      // The self-scoped RPC links the membership (copying valid current-version
      // acceptance evidence) or routes to explicit acceptance. It must NEVER
      // block sign-in, so any failure falls through to the default destination.
      const { dest, clearSelection } = await invitationDestination(supabase, next);

      // Treat the caller's destination as a path, never an origin suffix.
      // URL parsing also normalizes backslashes/control characters; compare
      // origins after that normalization before emitting a redirect.
      let destination = new URL("/dashboard", origin);
      if (dest.startsWith("/")) {
        try {
          const candidate = new URL(dest, origin);
          if (candidate.origin === origin) destination = candidate;
        } catch {
          // Malformed destinations keep the ordinary signed-in landing page.
        }
      }
      const response = NextResponse.redirect(destination);
      if (clearSelection) {
        response.cookies.delete("hone_selected_studio");
      }
      return response;
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
