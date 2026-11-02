import { createClient } from "@/lib/supabase/server";
import { classifyForCheck, type OpenAppointment, type PractitionerLite } from "@/lib/appointments/check-practitioner";

// Whether the owner sees the "Review practitioner assignments" link (Sam, 2 Nov). It is HIDDEN when the owner is the studio's only
// ACTIVE practitioner (pending invitations and receptionists do not count: they are not practitioner rows) and nothing is left to
// review, SHOWN once a second practitioner is active, and SHOWN in a solo studio that still has rows the review page would list.
// The page itself stays reachable to owners by URL and is a 404 for everyone else; this only decides whether the link appears.
// Fails toward SHOWING: an unreadable studio or an incomplete read never hides a link that might be needed.
// Reads with the owner's own session client (the same rows the page reads); no new data is exposed, only a boolean is returned.

type Db = Awaited<ReturnType<typeof createClient>>;
const PAGE = 500;
const MAX_PAGES = 4;

export async function shouldShowReviewLink(studioId: string, client?: Db): Promise<boolean> {
  const supabase = client ?? (await createClient());
  const pracRes = await supabase.from("practitioners").select("id, role, active, display_name, email").eq("studio_id", studioId);
  if (pracRes.error) return true;
  const practitioners: PractitionerLite[] = (pracRes.data ?? []).map((p) => ({
    id: p.id as string,
    role: p.role as string,
    active: p.active === true,
    displayName: (p.display_name as string) ?? "",
    email: (p.email as string | null) ?? null,
  }));
  if (practitioners.filter((p) => p.active).length > 1) return true;

  // Solo owner: show the link only while the review page would still list something.
  let complete = false;
  const open: OpenAppointment[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await supabase
      .from("appointments")
      .select("id, starts_at, practitioner_id, created_by_practitioner_id, sessions(performed_by_practitioner_id, started_at, deleted_at)")
      .eq("studio_id", studioId)
      .eq("status", "confirmed")
      .order("starts_at")
      .order("id")
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (res.error) return true;
    const rows = (res.data ?? []) as unknown as {
      id: string;
      starts_at: string;
      practitioner_id: string | null;
      created_by_practitioner_id: string | null;
      sessions: { performed_by_practitioner_id: string | null; started_at: string | null; deleted_at: string | null }[] | null;
    }[];
    for (const r of rows) {
      const live = (r.sessions ?? []).filter((s) => s.deleted_at === null || s.deleted_at === undefined);
      const starts = live.map((s) => s.started_at).filter((x): x is string => !!x).sort();
      open.push({
        id: r.id,
        startsAt: r.starts_at,
        practitionerId: r.practitioner_id,
        createdByPractitionerId: r.created_by_practitioner_id,
        performedBy: live.map((s) => s.performed_by_practitioner_id).filter((x): x is string => !!x),
        linkedSessionCount: live.length,
        treatmentStartedAt: starts[0] ?? null,
      });
    }
    if (rows.length < PAGE) {
      complete = true;
      break;
    }
  }
  if (classifyForCheck(open, practitioners, new Date()).length > 0) return true;
  return !complete; // could not read everything: do not hide
}
