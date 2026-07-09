import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAdmin } from "@/lib/admin";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublicRoute =
    pathname === "/" ||
    pathname === "/login" ||
    pathname.startsWith("/auth/") ||
    pathname === "/pricing" ||
    pathname === "/demo" ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    // Metadata image routes (Next file conventions: opengraph-image, icon,
    // apple-icon). Social scrapers and browsers fetch these while logged out;
    // they are generated, public, branded images with no sensitive data, so
    // the middleware must not redirect them to /login (or social/OG cards and
    // the favicon break for anonymous visitors).
    pathname === "/opengraph-image" ||
    pathname === "/icon" ||
    pathname === "/apple-icon" ||
    pathname.startsWith("/book/") ||
    pathname.startsWith("/cancel/") ||
    // Token-authenticated public flows: clients click links from email
    // (intake form completion, reschedule picker) without being logged in.
    // The route handlers verify the signed token themselves.
    pathname.startsWith("/intake/") ||
    // /manage/<token> is the single neutral SMS landing page that
    // surfaces both reschedule and cancel after the studio's
    // policies. It resolves the same column-or-HMAC token as /cancel
    // and must clear the same anonymous-visitor gate; without this
    // entry, every "Manage appointment:" SMS link bounces to /login.
    pathname.startsWith("/manage/") ||
    // Client portal lives in a separate auth realm: email magic
    // links + an httpOnly cookie session (client_portal_sessions,
    // migration 0052). The portal pages handle their own session
    // checks server-side and redirect to /portal/login when no
    // portal session is present; the practitioner Supabase auth
    // guard here must never bounce a portal visitor to /login (the
    // practitioner login).
    //
    // Important: this allowlist is INTENTIONALLY narrow. We list
    // only the three known portal-public routes by exact match (or
    // by /portal/verify/ prefix so the [token] segment is honored)
    // rather than blanket-allowlisting /portal/*. A future /portal
    // route MUST add its own portal-session check (via
    // getCurrentPortalSession from lib/portal/session.ts) AND its
    // own entry here. A typo or a forgotten entry should fall back
    // to the practitioner /login redirect, which is loud and easy
    // to spot, rather than silently exposing a new portal surface
    // to anonymous visitors.
    pathname === "/portal" ||
    pathname === "/portal/login" ||
    pathname.startsWith("/portal/verify/") ||
    pathname.startsWith("/reschedule/") ||
    // Read-only iCal subscription feed at /calendar-feed/<token>.ics.
    // Google Calendar / Apple Calendar fetch the feed server-side and
    // are never logged in. The route handler looks up the practitioner
    // by token via the admin client; any unknown / rotated-out token
    // returns 404 from the handler itself.
    pathname.startsWith("/calendar-feed/") ||
    // Cron endpoints authenticate via the CRON_SECRET Bearer header
    // checked inside each route handler; don't let middleware redirect
    // them to /login.
    pathname.startsWith("/api/cron/") ||
    // Stripe webhook authenticates via Stripe-Signature header verified
    // by stripe.webhooks.constructEvent inside the route handler. Exact
    // path match — do NOT broaden to /api/stripe/* because future Stripe
    // routes (refresh, dashboard link, etc.) should remain owner-only.
    pathname === "/api/stripe/webhook" ||
    // Twilio inbound SMS webhook authenticates via X-Twilio-Signature
    // (HMAC-SHA1 over the full URL plus sorted POST fields, validated
    // inside the route handler before any DB write). Exact path match
    // for the same reason as Stripe: do NOT broaden to /api/twilio/*
    // because any future Twilio endpoint (status callbacks, etc.)
    // should remain explicitly gated.
    pathname === "/api/twilio/inbound-sms";

  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // PR #253 invite-only gate: an AUTHENTICATED user with no active
  // practitioner row (an uninvited sign-in — auth.users exists but the
  // 0081 handle_new_user trigger created no studio/practitioner) is sent
  // to the safe /no-access page BEFORE any (app) layout or page renders.
  // Doing it here (not only in the shell layout) means no-studio users
  // never execute an app loader, so there is no raw error and no studio
  // data is ever loaded. Exempt: public routes, the /no-access gate
  // itself, and its sign-out (a POST to /no-access). The practitioners
  // read is studio-RLS-scoped to the caller; a no-studio user matches no
  // row. The shell layout keeps its own requirePractitionerWithStudio
  // guard as defense in depth.
  if (user && !isPublicRoute && pathname !== "/no-access") {
    // PR #254: platform operators (the ADMIN_EMAILS allowlist, fail-closed in
    // production) may reach the internal /admin surface WITHOUT a studio. The
    // New Studio Wizard must be usable by an operator who is bootstrapping a
    // studio and is not yet a practitioner anywhere; without this carve-out
    // the PR #253 no-studio gate would bounce them to /no-access before the
    // /admin layout's own isAdmin check ever runs. This does NOT weaken
    // invite-only for anyone else: the carve-out is limited to /admin paths
    // AND an isAdmin email, the /admin layout plus every admin server action
    // re-check isAdmin, and a no-studio NON-admin still falls through to
    // /no-access below.
    const isAdminRoute =
      pathname === "/admin" || pathname.startsWith("/admin/");
    if (!(isAdminRoute && isAdmin(user.email))) {
      // Load active memberships explicitly (NOT .maybeSingle(), which errors on
      // 2+ rows). A user may be an active practitioner in more than one studio
      // (unique key is (studio_id, user_id)):
      //   * 0 active   -> /no-access (invite-only gate)
      //   * exactly 1  -> proceed unchanged (the single-studio pilot path)
      //   * 2+ active  -> proceed IF the hone_selected_studio cookie names one
      //                   of the active studios; otherwise send to the chooser
      //                   (/no-access?reason=multiple-studios). The cookie is
      //                   validated against the RLS-scoped membership set here,
      //                   so a stale/forged value never grants access.
      const { data: memberships } = await supabase
        .from("practitioners")
        .select("studio_id")
        .eq("user_id", user.id)
        .eq("active", true);
      const activeStudioIds = (memberships ?? []).map(
        (m) => m.studio_id as string,
      );
      const selectedStudioId = request.cookies.get(
        "hone_selected_studio",
      )?.value;
      const hasValidSelection =
        selectedStudioId != null && activeStudioIds.includes(selectedStudioId);
      const usable =
        activeStudioIds.length === 1 ||
        (activeStudioIds.length > 1 && hasValidSelection);
      if (!usable) {
        const url = request.nextUrl.clone();
        url.pathname = "/no-access";
        if (activeStudioIds.length > 1) {
          url.searchParams.set("reason", "multiple-studios");
        }
        const redirectResponse = NextResponse.redirect(url);
        // Clear a stale/forged selection so it can't linger.
        if (selectedStudioId != null && !hasValidSelection) {
          redirectResponse.cookies.delete("hone_selected_studio");
        }
        return redirectResponse;
      }
    }
  }

  return supabaseResponse;
}
