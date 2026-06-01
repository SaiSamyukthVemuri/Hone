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
    pathname === "/api/stripe/webhook";

  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
