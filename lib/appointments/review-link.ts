import { createClient } from "@/lib/supabase/server";
import { classifyForCheck, type OpenAppointment, type PractitionerLite } from "@/lib/appointments/check-practitioner";

// Whether the owner sees the "Review practitioner assignments" link (Sam, 2 Nov). It is HIDDEN when the owner is the studio's only
// ACTIVE practitioner (pending invitations and receptionists do not count: they are not practitioner rows) and nothing is left to
// review, SHOWN once a second practitioner is active, and SHOWN in a solo studio that still has rows the review page would list.
// The page itself stays reachable to owners by URL and is a 404 for everyone else; this only decides whether the link appears.
// Fails toward SHOWING: an unreadable studio or an incomplete read never hides a link that might be needed.
// Reads with the owner's own session client (the same rows the page reads); no new data is exposed, only a boolean is returned.

type Db = Awaited<ReturnType<typeof createClient>>;
// A solo studio can only have something to review in three ways: a confirmed appointment with no practitioner, or one whose
// charted performer differs from its (former) practitioner. Both are found with a count and two bounded candidate reads instead of
// paging every confirmed appointment; the exact page classifier then runs on the candidates only. A full candidate page fails toward SHOWING.
const CANDIDATE_LIMIT = 100;
const SELECT_FULL = "id, starts_at, practitioner_id, created_by_practitioner_id, sessions(performed_by_practitioner_id, started_at, deleted_at)";

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
  const active = practitioners.filter((p) => p.active);
  if (active.length > 1) return true;
  const soleId = active[0]?.id ?? null;

  // Solo owner: show the link only while the review page would still list something.
  const none = await supabase
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("status", "confirmed")
    .is("practitioner_id", null);
  if (none.error || (none.count ?? 0) > 0) return true;

  const candidates = () =>
    supabase
      .from("appointments")
      .select("id, sessions!inner(performed_by_practitioner_id)")
      .eq("studio_id", studioId)
      .eq("status", "confirmed")
      .not("practitioner_id", "is", null)
      .is("sessions.deleted_at", null)
      .not("sessions.performed_by_practitioner_id", "is", null)
      .limit(CANDIDATE_LIMIT);
  // Charted by anyone but the sole active practitioner, or charted by them on an appointment that belongs to someone else.
  const reads = soleId
    ? [candidates().neq("sessions.performed_by_practitioner_id", soleId), candidates().neq("practitioner_id", soleId).eq("sessions.performed_by_practitioner_id", soleId)]
    : [candidates()];
  const results = await Promise.all(reads);
  const ids = new Set<string>();
  for (const r of results) {
    if (r.error) return true;
    const rows = (r.data ?? []) as unknown as { id: string }[];
    if (rows.length >= CANDIDATE_LIMIT) return true; // could not read every candidate: do not hide
    for (const row of rows) ids.add(row.id);
  }
  if (ids.size === 0) return false;

  const res = await supabase.from("appointments").select(SELECT_FULL).eq("studio_id", studioId).eq("status", "confirmed").in("id", [...ids]);
  if (res.error) return true;
  const rows = (res.data ?? []) as unknown as {
    id: string;
    starts_at: string;
    practitioner_id: string | null;
    created_by_practitioner_id: string | null;
    sessions: { performed_by_practitioner_id: string | null; started_at: string | null; deleted_at: string | null }[] | null;
  }[];
  const open: OpenAppointment[] = rows.map((r) => {
    const live = (r.sessions ?? []).filter((x) => x.deleted_at === null || x.deleted_at === undefined);
    const starts = live.map((x) => x.started_at).filter((x): x is string => !!x).sort();
    return {
      id: r.id,
      startsAt: r.starts_at,
      practitionerId: r.practitioner_id,
      createdByPractitionerId: r.created_by_practitioner_id,
      performedBy: live.map((x) => x.performed_by_practitioner_id).filter((x): x is string => !!x),
      linkedSessionCount: live.length,
      treatmentStartedAt: starts[0] ?? null,
    };
  });
  return classifyForCheck(open, practitioners, new Date()).length > 0;
}
