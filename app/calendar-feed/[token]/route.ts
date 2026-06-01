import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { buildIcsFeed, type IcsEvent } from "@/lib/booking/ical";

// Private read-only iCal subscription feed.
//
// Endpoint: GET /calendar-feed/<token>.ics
//
// Lookup model: the [token] path segment is a high-entropy random
// string stored on practitioners.calendar_feed_token (migration 0046).
// The route resolves the practitioner via the admin client (anon /
// authenticated callers have no row-level access to practitioners by
// token), then loads the practitioner's appointments and renders an
// ICS calendar. No login, no cookies. Anyone with the token can fetch.
//
// Privacy rules baked in:
//   * SUMMARY is always "Hone appointment" — no service name in the
//     event title (lock-screen safe; shared-calendar safe).
//   * DESCRIPTION contains client name + service modality (NOT the
//     specific service name; modality is "electrolysis" / "laser" /
//     "consultation", general enough not to leak treatment area) +
//     a link back to /calendar/<id> in Hone (which is auth-gated).
//   * No intake responses, allergies, EpiPen flags, private warnings,
//     pricing, payment data, or session notes ever appear in the feed.
//   * Cancelled appointments are excluded entirely.
//   * Time window: 30 days back + all future. Past window keeps the
//     calendar useful for "what did I do last Wednesday" without
//     leaking long-tail historical data into a subscribed surface.
//
// Cache headers: short max-age + must-revalidate so Google's poller
// re-fetches frequently enough that rotated tokens drop quickly. No
// CDN caching; the URL itself is the secret.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEED_WINDOW_DAYS = 30;
const APP_ORIGIN =
  process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";

// Map a service modality string to a generic, treatment-area-free
// label. Anything unknown collapses to "Appointment".
function modalityLabel(m: string | null | undefined): string {
  if (m === "electrolysis") return "Electrolysis";
  if (m === "laser") return "Laser";
  if (m === "consultation") return "Consultation";
  return "Appointment";
}

function statusDescriptor(status: string): string | null {
  if (status === "completed") return "completed";
  if (status === "no_show") return "no-show";
  return null;
}

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

  const admin = createAdminClient();
  const { data: practitioner, error: pErr } = await admin
    .from("practitioners")
    .select("id, studio_id, active, calendar_feed_token")
    .eq("calendar_feed_token", token)
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

  // Pull just enough columns to render the conservative feed. NO
  // appointment.notes, NO client.allergies / pinned notes, NO
  // session entries, NO pricing.
  const { data: rows, error: aErr } = await admin
    .from("appointments")
    .select(
      `id, starts_at, ends_at, status,
       service:services(modality),
       client:clients(name)`,
    )
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
    status: string;
    service: { modality: string | null } | { modality: string | null }[] | null;
    client: { name: string } | { name: string }[] | null;
  };

  const events: IcsEvent[] = ((rows ?? []) as Row[]).map((row) => {
    const service = Array.isArray(row.service) ? row.service[0] : row.service;
    const client = Array.isArray(row.client) ? row.client[0] : row.client;
    const lines: string[] = [];
    if (client?.name) {
      lines.push(`Client: ${client.name}`);
    }
    lines.push(`Type: ${modalityLabel(service?.modality ?? null)}`);
    const descriptor = statusDescriptor(row.status);
    if (descriptor) {
      lines.push(`Status: ${descriptor}`);
    }
    lines.push(`View in Hone: ${APP_ORIGIN}/calendar/${row.id}`);

    return {
      uid: row.id,
      start: new Date(row.starts_at),
      end: new Date(row.ends_at),
      summary: "Hone appointment",
      description: lines.join("\n"),
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
