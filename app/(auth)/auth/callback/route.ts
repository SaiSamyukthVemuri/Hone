import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  captureServerEvent,
  identifyServerUser,
} from "@/lib/analytics/server";
import { isAnalyticsUuid } from "@/lib/analytics/ids";
import { ADMIN_RETURN_COOKIE, safeInternalPath } from "@/lib/auth/return-path";
import { adminReturnTargetFor } from "@/lib/auth/admin-return";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user) {
      // Where to go after sign-in. Every candidate is VALIDATED as a
      // same-origin relative path (an unvalidated `next` such as
      // `@evil.example` would leave this origin): the /admin target the
      // middleware remembered for an operator's link (Codex P2 4248920454),
      // honoured only for an allowlisted operator, then a `next` parameter,
      // then the dashboard.
      const adminTarget = adminReturnTargetFor(
        request.cookies.get(ADMIN_RETURN_COOKIE)?.value,
        data.user.email,
      );
      const next =
        adminTarget ?? safeInternalPath(searchParams.get("next")) ?? "/dashboard";

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
      // A REQUIRED step comes first (accepting the invitation, choosing a
      // studio), and the operator's target is CARRIED through it, to be used
      // when it completes (Codex P2 4263663458; lib/auth/admin-return.ts). A
      // refusal (conflict, ambiguity) or a sign-in with no step forgets it.
      let carryAdminTarget = false;
      try {
        const { data: rec } = await supabase.rpc(
          "reconcile_my_pending_invitation",
        );
        const status =
          rec && typeof rec === "object"
            ? (rec as { status?: string; choose_studio?: boolean; role?: string })
            : null;
        if (status?.status === "acceptance_required") {
          dest = "/accept-invitation";
          carryAdminTarget = adminTarget !== null;
        } else if (status?.status === "conflict") {
          dest = "/no-access?reason=invite-conflict";
        } else if (status?.status === "ambiguous") {
          dest = "/no-access?reason=invite-ambiguous";
        } else if (
          (status?.status === "linked" || status?.status === "already_linked") &&
          status?.role === "receptionist"
        ) {
          // A front-desk membership lands on the front desk (STUDIO-READY-02b).
          dest = status.choose_studio === true ? "/front-desk/select" : "/front-desk";
          clearSelection = status.choose_studio === true;
        } else if (
          (status?.status === "linked" ||
            status?.status === "already_linked") &&
          status?.choose_studio === true
        ) {
          // Newly a multi-studio user: force a truthful chooser (clear any
          // selection; middleware routes 2+ memberships w/o selection there).
          dest = "/dashboard";
          clearSelection = true;
          carryAdminTarget = adminTarget !== null;
        }
      } catch {
        // Never block sign-in on reconciliation.
      }

      const response = NextResponse.redirect(`${origin}${dest}`);
      if (clearSelection) {
        response.cookies.delete("hone_selected_studio");
      }
      // One sign-in, one use: the remembered target outlives it only to be
      // used at the end of a required step (and its own 15-minute life).
      if (!carryAdminTarget) {
        response.cookies.delete(ADMIN_RETURN_COOKIE);
      }
      return response;
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
