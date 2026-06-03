import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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

  return supabaseResponse;
}
