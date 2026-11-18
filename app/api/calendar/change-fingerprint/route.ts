import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { isCalendarAnchor, isCalendarView } from "@/lib/calendar/calendar-load-range";
import { readCalendarFingerprint } from "@/lib/calendar/change-probe-read";

// HON-48 (option B): "has what this calendar screen shows changed?" One small answer for CalendarAutoRefresh to poll,
// instead of every screen re-rendering on a timer.
//
// WHAT IT RETURNS: `{ fingerprint }`, a 32-hex hash. Never a row, a name, a note, a count or a timestamp. It tells a
// signed-in member of the studio that "something on this screen changed", which a reload would show them anyway.
//
// AUTHORIZATION, in this order:
//   1. The session middleware already refuses it before this runs (no user -> 307 /login; no active practitioner, such
//      as a receptionist or an uninvited account -> 307 /no-access). It adds NO middleware exemption.
//   2. getUser -> 401, then the throwing identity read -> 403, repeated here as defence in depth.
//   3. The STUDIO comes from the session, never from the request. The request carries only the view and its anchor
//      date, so there is no parameter that could name another studio.
//   4. The reads use the caller's own session client (never the admin client), so the same studio and role RLS applies
//      as to the page. A member of studio B gets studio B's fingerprint, whatever the anchor.
//
// RESPONSES: never cached (no-store), no CORS headers (a cross-site page can send the GET but never read the answer).
// A transient failure is a plain 500 with no detail; the caller backs off and the 60 s refresh remains the backstop.
//
// COST per probe, counted so the poll interval is chosen with it in view: the session middleware's auth check, this
// route's getUser, the membership read, and four narrow selects (the appointment select repeats only past 1000 rows).

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private" } as const;

function json(status: number, body: Record<string, string>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest) {
  const view = request.nextUrl.searchParams.get("view");
  const anchor = request.nextUrl.searchParams.get("anchor");
  if (!isCalendarView(view) || !isCalendarAnchor(anchor)) {
    return json(400, { error: "bad_request" });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json(401, { error: "unauthenticated" });

  let studio: { id: string; timezone: string };
  try {
    ({ studio } = await getCurrentPractitionerWithStudio());
  } catch {
    return json(403, { error: "forbidden" });
  }

  try {
    const fingerprint = await readCalendarFingerprint({
      studioId: studio.id,
      timezone: studio.timezone,
      view,
      anchor,
    });
    return json(200, { fingerprint });
  } catch {
    return json(500, { error: "unavailable" });
  }
}
