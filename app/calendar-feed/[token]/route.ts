import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { buildIcsFeed, type IcsEvent } from "@/lib/booking/ical";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { hashCalendarFeedToken } from "@/lib/calendar-feed/token";

// Private read-only iCal subscription feed.
//
// Endpoint: GET /calendar-feed/<token>.ics
//
// Lookup model: the [token] path segment is a high-entropy random
// string matched by its SHA-256 hash against
// practitioners.calendar_feed_token_hash (migrations 0079/0116; the raw
// token is never stored: hash-only at rest).
// The route resolves the practitioner via the admin client (anon /
// authenticated callers have no row-level access to practitioners by
// token), then loads the practitioner's appointments and renders an
// ICS calendar. No login, no cookies. Anyone with the token can fetch.
//
// Privacy rules baked in (PR #289, privacy-preserving by default).
//   * The feed URL is a BEARER secret. Third-party calendar providers
//     (Google / Apple / Outlook) store the URL AND the event contents.
//     So the default ICS exposes NO client data and NO treatment
//     context: anyone who obtains the URL learns only the
//     practitioner's busy/free times, not who or what.
//   * SUMMARY is always "Hone appointment", generic, no service name
//     (lock-screen safe; shared-calendar safe).
//   * DESCRIPTION is generic ("Appointment scheduled in Hone…") plus a
//     link back to /calendar/<id> in Hone (auth-gated; not a token).
//     It does NOT contain the client name, email, phone, address, the
//     service / modality / body area / treatment context, notes,
//     status, any token, Stripe/payment data, or storage paths.
//   * The route does not even SELECT the client name or service
//     modality: defense in depth, so a row leaked to logs carries no
//     client PII.
//   * No intake responses, allergies, EpiPen flags, private warnings,
//     pricing, payment data, or session notes ever appear in the feed.
//   * Cancelled appointments are excluded entirely (status filter).
//   * Time window: 30 days back + all future.
//   * (Deferred backlog: an explicit per-studio opt-in to include
//     client names in the feed; token rotation/revoke UI; last-used
//     telemetry. NOT in this PR.)
//
// Cache headers: private, no-store so the URL itself stays the only
// secret and providers re-fetch (rotated tokens drop quickly). No CDN
// caching. Referrer-Policy: no-referrer + X-Robots-Tag: noindex are
// applied to /calendar-feed/:token* by next.config.ts.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEED_WINDOW_DAYS = 30;

// Generic, non-sensitive event description for every feed event. No
// client/appointment specifics; the practitioner opens Hone (the
// auth-gated /calendar/<id> link below) for the real details.
const GENERIC_DESCRIPTION =
  "Appointment scheduled in Hone. Open Hone for details.";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token: rawToken } = await params;
  // Path is /calendar-feed/<token>.ics; strip the trailing extension
  // before lookup. Treating .ics as optional keeps "subscribe to URL
  // without extension" cases working too.
  const token = rawToken.replace(/\.ics$/i, "");
  if (!token || token.length < 16) {
    return new NextResponse("Not found", { status: 404 });
  }

  // PR #182 phase 1. Lookup the practitioner via the SHA-256 hash of
  // the URL token instead of the raw token. The hash column was
  // backfilled by migration 0079 so existing in-the-wild feed URLs
  // continue to resolve through the deploy boundary. The route no
  // longer SELECTs the raw column at all -- if a database read leaks
  // a row to logs, the raw bearer token is not in the row shape.
  // The hash itself is never echoed back to the client; the response
  // is only the ICS body or a generic 404.
  const tokenHash = hashCalendarFeedToken(token);
  const admin = createAdminClient();
  const { data: practitioner, error: pErr } = await admin
    .from("practitioners")
    .select("id, studio_id, active")
    .eq("calendar_feed_token_hash", tokenHash)
    .maybeSingle();
  if (pErr) {
    console.error(
      JSON.stringify({
        event: "calendar_feed_practitioner_lookup_error",
        code: pErr.code,
        timestamp: new Date().toISOString(),
      }),
    );
    return new NextResponse("Not found", { status: 404 });
  }
  if (!practitioner || !practitioner.active) {
    return new NextResponse("Not found", { status: 404 });
  }

  const windowStart = new Date(
    Date.now() - FEED_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // PR #289: pull ONLY the time-window columns. We deliberately do NOT
  // select the client name or the service/modality, the default feed
  // exposes neither, and not fetching them means a row leaked to logs
  // carries no client PII or treatment context. The status filter still
  // excludes cancelled appointments; status itself is not projected
  // because the generic description does not surface it.
  const { data: rows, error: aErr } = await admin
    .from("appointments")
    .select("id, starts_at, ends_at")
    .eq("studio_id", practitioner.studio_id)
    .eq("practitioner_id", practitioner.id)
    .in("status", ["confirmed", "completed", "no_show"])
    .gte("starts_at", windowStart)
    .order("starts_at", { ascending: true });
  if (aErr) {
    console.error(
      JSON.stringify({
        event: "calendar_feed_appointments_lookup_error",
        code: aErr.code,
        timestamp: new Date().toISOString(),
      }),
    );
    return new NextResponse("Not found", { status: 404 });
  }

  // Studio address is the same value already displayed on the public
  // booking page, so including it in LOCATION does not leak anything
  // not already publicly visible.
  const { data: studio } = await admin
    .from("studios")
    .select("address")
    .eq("id", practitioner.studio_id)
    .maybeSingle();
  const location = studio?.address?.trim() || undefined;

  type Row = {
    id: string;
    starts_at: string;
    ends_at: string;
  };

  const appOrigin = getRequiredAppOrigin();
  const events: IcsEvent[] = ((rows ?? []) as Row[]).map((row) => {
    // Generic description only: no client / treatment specifics. The
    // /calendar/<id> link is auth-gated (a login is required to see any
    // detail) and carries no token.
    const description = `${GENERIC_DESCRIPTION}\nView in Hone: ${appOrigin}/calendar/${row.id}`;

    return {
      uid: row.id,
      start: new Date(row.starts_at),
      end: new Date(row.ends_at),
      summary: "Hone appointment",
      description,
      location,
    };
  });

  const body = buildIcsFeed(events);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      // Short revalidation window so a rotated token drops out of
      // Google Calendar quickly. The URL itself is the secret; CDN
      // caching would be inappropriate here.
      "cache-control":
        "private, no-store, max-age=0, must-revalidate",
    },
  });
}
