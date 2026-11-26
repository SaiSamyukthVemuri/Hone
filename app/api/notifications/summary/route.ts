import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { IdentityRefusalError } from "@/lib/supabase/identity-refusal";
import { scopeNotificationsToViewer } from "@/lib/notifications/owner-only-events";
import { SUMMARY_MAX_IDS } from "@/lib/notifications/live-poller";

// HON-106: "how many unread notifications do I have, and which are new?" One small answer for NotificationsProvider to poll, so the
// bell is current without a navigation (HON-48's rules, applied to the bell).
//
// WHAT IT RETURNS: `{ unread, ids, viewer }`: the viewer's unread count, the ids of their newest unread rows, and an opaque marker of who they are. Never a title, a body, a
// link, a client name or a timestamp: the wording of a toast is a product decision, and the notification centre shows the same
// viewer exactly what this counted.
//
// WHAT THE COUNT IS: the PERSISTED unread rows only, narrowed by scopeNotificationsToViewer exactly as the layout's badge count is
// (owner-only event types never reach a non-owner; a per-recipient cancellation reaches only its recipient). The computed
// overdue-disinfectant alerts are not rows and are added by the provider from the server render, so a poll can never drop them.
//
// AUTHORIZATION, in this order (the same as /api/calendar/change-fingerprint):
//   1. The session middleware already refuses it before this runs (no user -> 307 /login; no active practitioner, such as a
//      receptionist or an uninvited account -> 307 /no-access). It adds NO middleware exemption.
//   2. getUser -> 401, then the throwing identity read: a controlled refusal -> 403, a thrown infrastructure error -> 503.
//   3. The STUDIO, the role and the viewer id come from the session, never from the request; the route takes no parameters.
//   4. The read uses the caller's own session client (never the admin client), so the studio RLS applies as to the page.
//
// RESPONSES: never cached (no-store), no CORS headers. A transient failure is a plain 500 with no detail; the caller keeps its last
// count and backs off.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private" } as const;

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json(401, { error: "unauthenticated" });

  let identity: Awaited<ReturnType<typeof getCurrentPractitionerWithStudio>>;
  try {
    identity = await getCurrentPractitionerWithStudio();
  } catch (error) {
    // 403 is reserved for a CONTROLLED identity refusal; anything else is infrastructure and retryable.
    if (error instanceof IdentityRefusalError) return json(403, { error: "forbidden" });
    if (typeof (error as { digest?: unknown })?.digest === "string" && (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")) {
      return json(401, { error: "unauthenticated" });
    }
    return json(503, { error: "unavailable" });
  }

  try {
    // One bounded read: the exact count and the newest ids, from the partial unread index (migration 0070).
    const { data, count, error } = await scopeNotificationsToViewer(
      supabase
        .from("practitioner_notifications")
        .select("id", { count: "exact" })
        .eq("studio_id", identity.studio.id)
        .is("read_at", null)
        .order("created_at", { ascending: false })
        .limit(SUMMARY_MAX_IDS),
      identity.practitioner.role === "owner",
      identity.practitioner.id,
    );
    if (error) return json(500, { error: "unavailable" });
    // An OPAQUE marker of who this answer is for, so a browser can tell that the person behind the tab changed (sign out, sign in as
    // someone else) and discard what it remembered about the first person. A one-way digest, never the practitioner id itself.
    const viewer = createHash("sha256").update(`notifications-viewer:${identity.studio.id}:${identity.practitioner.id}`).digest("hex").slice(0, 16);
    return json(200, { unread: count ?? 0, ids: (data ?? []).map((r: { id: string }) => r.id), viewer });
  } catch {
    return json(500, { error: "unavailable" });
  }
}
