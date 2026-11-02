import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  captureServerEvent,
  identifyServerUser,
} from "@/lib/analytics/server";
import { isAnalyticsUuid } from "@/lib/analytics/ids";
import { deskHomeFor, type HomeSupabase } from "@/lib/desk/home";

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
      let dest = next;
      let clearSelection = false;
      try {
        const { data: rec } = await supabase.rpc(
          "reconcile_my_pending_invitation",
        );
        const status =
          rec && typeof rec === "object"
            ? (rec as { status?: string; choose_studio?: boolean })
            : null;
        if (status?.status === "acceptance_required") {
          dest = "/accept-invitation";
        } else if (status?.status === "conflict") {
          dest = "/no-access?reason=invite-conflict";
        } else if (status?.status === "ambiguous") {
          dest = "/no-access?reason=invite-ambiguous";
        } else if (
          (status?.status === "linked" ||
            status?.status === "already_linked") &&
          status?.choose_studio === true
        ) {
          // Newly a multi-studio user: force a truthful chooser (clear any
          // selection; middleware routes 2+ memberships w/o selection there).
          dest = "/dashboard";
          clearSelection = true;
        }
      } catch {
        // Never block sign-in on reconciliation.
      }

      // Receptionist landing (Privacy R3/R4). Only when the ordinary destination is the dashboard
      // and the desk flag is on: a user whose ONLY membership is an active receptionist row lands on
      // /desk. A practitioner membership anywhere always keeps /dashboard, and with the flag off this
      // makes no read at all (lib/desk/home.ts). It must never block sign-in.
      if (dest === "/dashboard") {
        try {
          const home = await deskHomeFor(supabase as unknown as HomeSupabase, data.user.id);
          if (home) dest = home;
        } catch {
          // keep the ordinary landing
        }
      }

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
