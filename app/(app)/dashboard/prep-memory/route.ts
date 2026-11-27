import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { IdentityRefusalError } from "@/lib/supabase/identity-refusal";
import { readAppointmentPrepMemory } from "../prep-memory-read";

// GET /dashboard/prep-memory?appointment_id=<uuid>: the last visit's details for ONE dashboard appointment.
//
// WHY A ROUTE. The dashboard card shows these details on page view (practitioner feedback, 26 Nov 2026). As a server
// action the read held Next's one-at-a-time action queue, so a pinned-note save made while it was loading was not sent
// until it finished. A GET does not use that queue. See prep-memory-read.ts for the rule and docs/03 for the record.
//
// WHAT IT RETURNS: the SAME shape the server action returned: { status: "loaded", memory } or { status: "none" }.
// The browser sends ONLY the appointment id. The practitioner and the STUDIO come from the session, never from the
// request, and the client id and the history cutoff are read from the appointment row (prep-memory-read.ts).
//
// AUTHORIZATION, in this order:
//   1. The session middleware already refuses it before this runs (no user -> 307 /login; no active practitioner -> 307
//      /no-access). It adds NO middleware exemption.
//   2. getUser -> 401, then the throwing identity read: a controlled refusal -> 403, a redirect raised mid-request -> 401,
//      anything else -> 503 (retryable).
//   3. The appointment is fenced to that studio inside the read: a missing or another studio's appointment is the same
//      404, so the route cannot be used to probe whether an id exists.
//   4. The read uses the caller's own session client (never the admin client), so the same studio and role RLS applies
//      as to the page.
//
// RESPONSES: never cached (no-store, private), no CORS headers (a cross-site page can send the GET but never read the
// answer), no detail in any error body.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest) {
  const appointmentId = request.nextUrl.searchParams.get("appointment_id");
  if (!appointmentId || !UUID.test(appointmentId)) {
    return json(400, { error: "bad_request" });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json(401, { error: "unauthenticated" });

  let studioId: string;
  try {
    const { studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
  } catch (error) {
    if (error instanceof IdentityRefusalError) return json(403, { error: "forbidden" });
    if (typeof (error as { digest?: unknown })?.digest === "string" && (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")) {
      return json(401, { error: "unauthenticated" });
    }
    return json(503, { error: "unavailable" });
  }

  const outcome = await readAppointmentPrepMemory(appointmentId, studioId);
  if (outcome.status === "not_found") return json(404, { error: "not_found" });
  if (outcome.status === "unavailable") return json(503, { status: "unavailable" });
  return json(200, outcome);
}
