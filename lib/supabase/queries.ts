import { redirect } from "next/navigation";
import { createClient } from "./server";
import { readSelectedStudioId } from "./selected-studio";
import type {
  ApilusModality,
  Appointment,
  Client,
  ClientPricing,
  ElectrolysisEntry,
  ElectrolysisMode,
  LaserEntry,
  MachineFrequency,
  Modality,
  Practitioner,
  ProbeLot,
  ProbeType,
  Session,
  SessionBlock,
  Studio,
} from "@/lib/types/database";

export type PractitionerWithStudio = {
  practitioner: Practitioner;
  studio: Studio;
};

type ServerSupabase = Awaited<ReturnType<typeof createClient>>;

// Resolution of a signed-in user's ACTIVE practitioner memberships.
//
// Hone lets a user be an active practitioner in more than one studio: the
// practitioners unique key is (studio_id, user_id) — NOT user_id — so 0, 1, or
// 2+ active rows are all reachable states. (The old resolvers used
// `.maybeSingle()`, which ERRORS on 2+ rows.)
//
// For 2+ memberships the user must CHOOSE a studio; the choice is persisted in
// the httpOnly `hone_selected_studio` cookie (see lib/supabase/selected-studio).
// The cookie is NEVER trusted on its own: this resolver honors it only if it
// matches one of the user's ACTIVE memberships (the rows below are already
// user-scoped + RLS-scoped). A missing/stale/forged value resolves to "choose"
// (the chooser), never to another studio's data, and a studio is NEVER
// auto-picked for a multi-membership user.
export type StudioMembershipOption = {
  studioId: string;
  studioName: string;
  role: string;
};

export type PractitionerMembership =
  | { kind: "none" }
  | { kind: "one"; value: PractitionerWithStudio }
  | { kind: "selected"; value: PractitionerWithStudio }
  | { kind: "choose"; options: StudioMembershipOption[] };

function toValue(
  row: Practitioner & { studio: Studio },
): PractitionerWithStudio {
  const { studio, ...practitioner } = row;
  return { practitioner: practitioner as Practitioner, studio };
}

async function loadActiveMembershipRows(
  supabase: ServerSupabase,
  userId: string,
): Promise<Array<Practitioner & { studio: Studio }>> {
  const { data, error } = await supabase
    .from("practitioners")
    .select("*, studio:studios(*)")
    .eq("user_id", userId)
    .eq("active", true);
  if (error) {
    throw new Error(`Failed to load practitioner: ${error.message}`);
  }
  return (data ?? []) as Array<Practitioner & { studio: Studio }>;
}

async function resolveActivePractitionerMembership(
  supabase: ServerSupabase,
  userId: string,
  selectedStudioId: string | null,
): Promise<PractitionerMembership> {
  const rows = await loadActiveMembershipRows(supabase, userId);
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) return { kind: "one", value: toValue(rows[0]) };

  // 2+ active memberships: honor a valid selection, otherwise send to chooser.
  if (selectedStudioId) {
    const match = rows.find((r) => r.studio_id === selectedStudioId);
    if (match) return { kind: "selected", value: toValue(match) };
    // else: stale/forged selection — fall through to the chooser (never trust it).
  }
  return {
    kind: "choose",
    options: rows.map((r) => ({
      studioId: r.studio_id,
      studioName: r.studio.name,
      role: r.role,
    })),
  };
}

// The user's active studio memberships (for the chooser + the "Switch studio"
// affordance). RLS-scoped + user-scoped; safe to expose studio name + role.
export async function listActiveStudioMemberships(): Promise<
  StudioMembershipOption[]
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const rows = await loadActiveMembershipRows(supabase, user.id);
  return rows.map((r) => ({
    studioId: r.studio_id,
    studioName: r.studio.name,
    role: r.role,
  }));
}

// Returns the signed-in user's active practitioner row + studio.
// Redirects to /login if no auth user, or throws if the user has no practitioner row.
export async function getCurrentPractitionerWithStudio(): Promise<PractitionerWithStudio> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const selectedStudioId = await readSelectedStudioId();
  const membership = await resolveActivePractitionerMembership(
    supabase,
    user.id,
    selectedStudioId,
  );
  if (membership.kind === "none") {
    throw new Error("No active practitioner found for the signed-in user.");
  }
  if (membership.kind === "choose") {
    // Controlled (not raw-DB) error, and never an auto-picked studio. Reached
    // only as a server-action backstop: the middleware + shell layout redirect
    // multi-membership users with no valid selection to the chooser before any
    // page loader runs, and server actions run inside try/catch that returns a
    // generic denial — so no raw 500 reaches the user because of multiple rows.
    throw new Error(
      `Multiple active studio memberships (${membership.options.length}) with no valid studio selection; choose a studio first.`,
    );
  }
  return membership.value;
}

// Route-guard variant of getCurrentPractitionerWithStudio for the
// authenticated app SHELL (app/(app)/layout.tsx). Hone is invite-only
// (PR #189 / migration 0081 / PR #253): a signed-in user with no active
// practitioner row — e.g. an uninvited Google sign-in, which creates an
// auth.users row but NO studio/practitioner — must not reach the app.
// Instead of throwing a raw 500 (what getCurrentPractitionerWithStudio
// does), this redirects:
//   * no auth user                 -> /login
//   * authed, but no studio        -> /no-access  (the safe invite-only gate)
//   * authed, 2+ studios, no valid selection -> /no-access?reason=multiple-studios (chooser)
// The throwing variant stays the backstop for direct server-action POSTs
// (those run inside try/catch and safely return a generic denial), so
// this redirecting guard is used ONLY where a clean redirect is wanted
// and not swallowed by a surrounding catch (the shell layout).
export async function requirePractitionerWithStudio(): Promise<PractitionerWithStudio> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const selectedStudioId = await readSelectedStudioId();
  const membership = await resolveActivePractitionerMembership(
    supabase,
    user.id,
    selectedStudioId,
  );
  if (membership.kind === "none") {
    // Authenticated but no studio membership: invite-only gate.
    redirect("/no-access");
  }
  if (membership.kind === "choose") {
    // Authenticated with 2+ active studios but no valid selection: send to the
    // chooser (never an auto-picked studio). /no-access renders the chooser
    // when the active count is > 1.
    redirect("/no-access?reason=multiple-studios");
  }

  return membership.value;
}

export async function getPractitionersForStudio(
  studioId: string,
): Promise<Practitioner[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("practitioners")
    .select("*")
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("display_name", { ascending: true });
  if (error) throw new Error(`Failed to load practitioners: ${error.message}`);
  return (data ?? []) as Practitioner[];
}

export async function getClientsForStudio(studioId: string): Promise<Client[]> {
  // PR Willow launch fixes (migration 0050): filter archived clients
  // out of the active list. Archived rows still exist (their
  // appointments, sessions, intake, treatment plans, and audit
  // history all keep working), but the active client list, the
  // calendar quick-book picker, and the dashboard birthday surface
  // should not show the test/duplicate rows the practitioner
  // archived. The detail page (/clients/[id]) intentionally does not
  // filter so the practitioner can navigate to a known archived
  // client to un-archive or to view their history.
  //
  // The dedicated archived view in /clients?view=archived uses the
  // sibling helper getArchivedClientsForStudio below.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("studio_id", studioId)
    .is("archived_at", null)
    .order("name", { ascending: true });

  if (error) throw new Error(`Failed to load clients: ${error.message}`);
  return (data ?? []) as Client[];
}

// Archived clients for the studio's "Archived clients" view. Mirrors
// getClientsForStudio but with the filter inverted: returns rows
// where archived_at is non-null, ordered by most-recently-archived
// first so a practitioner who just archived a row by mistake finds
// it at the top of the list without scrolling. This is the only
// surface that intentionally shows archived clients in a list; the
// calendar quick-book picker, dashboard birthday surface, and active
// client list continue to hide them.
export async function getArchivedClientsForStudio(
  studioId: string,
): Promise<Client[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("studio_id", studioId)
    .not("archived_at", "is", null)
    .order("archived_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load archived clients: ${error.message}`);
  }
  return (data ?? []) as Client[];
}

export type SessionWithEntries = Session & {
  electrolysis_entries: ElectrolysisEntry[];
  laser_entries: LaserEntry[];
};

export type ClientCheatSheet = {
  client: Client;
  pricing: ClientPricing[];
  sessions: SessionWithEntries[];
  practitioners: Practitioner[];
};

// Resolves the human-readable name of who performed a session,
// preferring performed_by_practitioner_id but falling back to the creator.
export function sessionPerformerName(
  session: Pick<Session, "performed_by_practitioner_id" | "practitioner_id">,
  practitioners: Practitioner[],
): string | null {
  const id = session.performed_by_practitioner_id ?? session.practitioner_id;
  if (!id) return null;
  const match = practitioners.find((p) => p.id === id);
  if (!match) return null;
  return match.display_name?.trim() ? match.display_name : match.email;
}

// Migration 0114: a voided pass (deleted_at set) stays in the DB but must never
// appear in an active view. Every loader that embeds entries strips soft-deleted
// rows through this helper so downstream consumers (charting, Last Visit,
// Treatment Intelligence, before-today, exports) only ever see active passes.
function stripDeletedEntries(session: SessionWithEntries): SessionWithEntries {
  return {
    ...session,
    electrolysis_entries: (session.electrolysis_entries ?? []).filter(
      (e) => !e.deleted_at,
    ),
    laser_entries: (session.laser_entries ?? []).filter((e) => !e.deleted_at),
  };
}

export async function getClientById(
  studioId: string,
  clientId: string,
): Promise<ClientCheatSheet | null> {
  const supabase = await createClient();

  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("*")
    .eq("studio_id", studioId)
    .eq("id", clientId)
    .maybeSingle();

  if (clientErr) throw new Error(`Failed to load client: ${clientErr.message}`);
  if (!client) return null;

  const [pricingRes, sessionsRes, practitioners] = await Promise.all([
    supabase
      .from("client_pricing")
      .select("*")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .order("effective_from", { ascending: false }),
    supabase
      .from("sessions")
      .select("*, electrolysis_entries(*), laser_entries(*)")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .is("deleted_at", null)
      .order("started_at", { ascending: false }),
    getPractitionersForStudio(studioId),
  ]);

  if (pricingRes.error)
    throw new Error(`Failed to load pricing: ${pricingRes.error.message}`);
  if (sessionsRes.error)
    throw new Error(`Failed to load sessions: ${sessionsRes.error.message}`);

  return {
    client: client as Client,
    pricing: (pricingRes.data ?? []) as ClientPricing[],
    sessions: ((sessionsRes.data ?? []) as SessionWithEntries[]).map(
      stripDeletedEntries,
    ),
    practitioners,
  };
}

// Past confirmed appointments for the client's Sessions tab. Returns
// rows where starts_at < now AND status = 'confirmed' (i.e. the
// appointment happened or was supposed to happen and was not
// cancelled). The page interleaves these with charted sessions to
// surface visits the practitioner has not yet charted.
//
// Dedup, in order of preference (PR #156, migration 0068):
//
//   1. EXPLICIT LINK. If any session for this client has
//      `appointment_id = a.id`, the appointment is charted and is
//      excluded. This is exact, robust to same-day visits and
//      reschedules, and replaces guessing.
//
//   2. HEURISTIC FALLBACK. For appointments NOT covered by the
//      explicit link, fall back to the +/-2 hour starts_at proximity
//      window against sessions where `appointment_id IS NULL`. These
//      are legacy sessions (pre-0068) and client-scoped sessions
//      that did not run through the appointment-context create
//      flow. The fallback intentionally consults only the unlinked
//      sessions so a linked session does not get counted twice (once
//      explicitly + once via proximity to its own appointment).
//
//   3. The +/-2 hour window is generous because a practitioner who
//      logs the session after the appointment typically does so
//      within minutes; only pathological cases would land outside
//      the window. False negatives (an uncharted visit gets hidden
//      because there happened to be an unrelated unlinked session
//      nearby) are accepted as the lesser harm versus duplicate
//      rows.
//
// no_show appointments are intentionally NOT included: those have
// their own lifecycle handled by no-show-check cron + follow-up.
//
// The function takes the session list as a parameter because the
// caller (the client profile page) already loads the same sessions
// for the timeline render; passing them in avoids a redundant DB
// roundtrip. Each entry carries started_at AND appointment_id so the
// helper can split the explicit set from the heuristic set.
export type KnownSessionForPastAppointmentDedup = {
  started_at: string;
  appointment_id: string | null;
};
export async function getPastConfirmedAppointmentsForClient(
  studioId: string,
  clientId: string,
  knownSessions: ReadonlyArray<KnownSessionForPastAppointmentDedup>,
): Promise<Appointment[]> {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("status", "confirmed")
    .lt("starts_at", nowIso)
    .order("starts_at", { ascending: false })
    .limit(50);
  if (error) {
    throw new Error(
      `Failed to load past appointments: ${error.message}`,
    );
  }
  const rows = (data ?? []) as Appointment[];
  if (rows.length === 0) return rows;

  // Split the session list into two buckets so we can prefer the
  // explicit FK lookup and only fall through to the proximity window
  // for legacy / client-scoped rows.
  const linkedAppointmentIds = new Set<string>();
  const unlinkedSessionStartMs: number[] = [];
  for (const s of knownSessions) {
    if (s.appointment_id) {
      linkedAppointmentIds.add(s.appointment_id);
    } else {
      const ms = new Date(s.started_at).getTime();
      if (Number.isFinite(ms)) unlinkedSessionStartMs.push(ms);
    }
  }

  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  return rows.filter((a) => {
    // 1. Explicit link. The appointment has a session pointing at it
    //    via the new appointment_id FK; the practitioner has already
    //    charted this visit.
    if (linkedAppointmentIds.has(a.id)) return false;
    // 2. Heuristic fallback over UNLINKED sessions only. A session
    //    that already has an explicit appointment_id is not consulted
    //    here, so the same visit cannot be counted twice (once via
    //    the explicit set + once via its own +/- 2h window).
    const aMs = new Date(a.starts_at).getTime();
    return !unlinkedSessionStartMs.some(
      (sMs) => Math.abs(sMs - aMs) <= TWO_HOURS_MS,
    );
  });
}

// PR #157. Single appointment timeline read for the client profile.
// Returns the client's appointments across all statuses (confirmed,
// completed, cancelled, no_show) joined with the linked session via
// the PR #156 appointment_id FK. The page groups the result into
// Upcoming / Needs charting / Charted / Cancelled / No-show buckets;
// the query stays a single helper so the page can render the timeline
// from one read.
//
// Linked-session row: at most one per appointment is returned (the
// most recent non-deleted linked session for that appointment id).
// The PR #156 data model does NOT enforce one-to-one and a future
// flow may produce multiple linked sessions per appointment; until
// that ships, surfacing the latest is the correct v1 simplification.
// The client profile's separate session-timeline section below the
// appointments timeline continues to show every session row
// regardless of linkage, so no row is lost to this collapse.
//
// Studio + client scope are enforced at the query layer; the
// underlying tables also carry the studio-membership RLS policies
// from migrations 0001 (sessions) and 0010 (appointments). No
// service-role.
export type ClientAppointmentTimelineRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: "confirmed" | "cancelled" | "completed" | "no_show";
  service_id: string | null;
  service_name: string | null;
  service_modality: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  // Postcare send visibility (read-only, existing columns from migration
  // 0043). `postcare_email_sent_at` is the timestamp of the last successful
  // send (never a delivery/receipt confirmation); attempts counts recorded
  // send attempts. Surfaced so a practitioner can see postcare was sent.
  postcare_email_sent_at: string | null;
  postcare_email_send_attempts: number;
  linked_session: {
    id: string;
    started_at: string;
    modality: Modality;
  } | null;
};

// Bound the timeline at 100 rows ordered newest-first. A studio that
// books 2-3 appointments per client per month hits this only after
// roughly 3 years of relationship; older rows can be surfaced via a
// future "Show older" expansion if the operator asks for it.
const CLIENT_APPOINTMENT_TIMELINE_LIMIT = 100;

export async function getAppointmentsForClientProfile(
  studioId: string,
  clientId: string,
): Promise<ClientAppointmentTimelineRow[]> {
  const supabase = await createClient();
  const { data: rawAppts, error: apptErr } = await supabase
    .from("appointments")
    .select(
      "id, starts_at, ends_at, status, service_id, cancelled_at, cancellation_reason, postcare_email_sent_at, postcare_email_send_attempts, service:services(name, modality)",
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .order("starts_at", { ascending: false })
    .limit(CLIENT_APPOINTMENT_TIMELINE_LIMIT);
  if (apptErr) {
    throw new Error(
      `Failed to load client appointments: ${apptErr.message}`,
    );
  }
  const appts = (rawAppts ?? []) as Array<{
    id: string;
    starts_at: string;
    ends_at: string;
    status: "confirmed" | "cancelled" | "completed" | "no_show";
    service_id: string | null;
    cancelled_at: string | null;
    cancellation_reason: string | null;
    postcare_email_sent_at: string | null;
    postcare_email_send_attempts: number | null;
    service:
      | { name: string; modality: string | null }
      | Array<{ name: string; modality: string | null }>
      | null;
  }>;
  if (appts.length === 0) return [];

  // Second roundtrip for linked sessions. We could do a single Postgres
  // LEFT JOIN via PostgREST but the resource-name embed would not let
  // us LIMIT the linked session per appointment, and a session can
  // appear in multiple appointment-context flows (rare today, but
  // possible). Two queries + an in-memory map keeps the dedup
  // deterministic: latest session wins per appointment id.
  const apptIds = appts.map((a) => a.id);
  const { data: rawSessions, error: sessErr } = await supabase
    .from("sessions")
    .select("id, started_at, modality, appointment_id")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .in("appointment_id", apptIds)
    .is("deleted_at", null)
    .order("started_at", { ascending: false });
  if (sessErr) {
    throw new Error(
      `Failed to load linked sessions: ${sessErr.message}`,
    );
  }
  const sessions = (rawSessions ?? []) as Array<{
    id: string;
    started_at: string;
    modality: Modality;
    appointment_id: string | null;
  }>;
  const latestByAppointment = new Map<
    string,
    { id: string; started_at: string; modality: Modality }
  >();
  for (const s of sessions) {
    if (!s.appointment_id) continue;
    if (latestByAppointment.has(s.appointment_id)) continue; // newest wins (order DESC)
    latestByAppointment.set(s.appointment_id, {
      id: s.id,
      started_at: s.started_at,
      modality: s.modality,
    });
  }

  return appts.map((a) => {
    const svc = Array.isArray(a.service) ? (a.service[0] ?? null) : a.service;
    return {
      id: a.id,
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      status: a.status,
      service_id: a.service_id,
      service_name: svc?.name ?? null,
      service_modality: svc?.modality ?? null,
      cancelled_at: a.cancelled_at,
      cancellation_reason: a.cancellation_reason,
      postcare_email_sent_at: a.postcare_email_sent_at,
      postcare_email_send_attempts: a.postcare_email_send_attempts ?? 0,
      linked_session: latestByAppointment.get(a.id) ?? null,
    };
  });
}

export async function getSessionForClient(
  studioId: string,
  clientId: string,
  sessionId: string,
): Promise<SessionWithEntries | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select("*, electrolysis_entries(*), laser_entries(*)")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("id", sessionId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new Error(`Failed to load session: ${error.message}`);
  return data ? stripDeletedEntries(data as SessionWithEntries) : null;
}

export async function getRecentEntryForClient(
  studioId: string,
  clientId: string,
  modality: Modality,
): Promise<ElectrolysisEntry | LaserEntry | null> {
  const supabase = await createClient();
  const entryTable =
    modality === "electrolysis" ? "electrolysis_entries" : "laser_entries";

  // Find the most recent session for this client/modality and pull its latest entry.
  const { data: sessionRows, error: sessErr } = await supabase
    .from("sessions")
    .select(`id, ${entryTable}(*)`)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("modality", modality)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(10);

  if (sessErr) throw new Error(`Failed to load recent session: ${sessErr.message}`);

  for (const row of sessionRows ?? []) {
    // Migration 0114: never suggest defaults from a voided pass.
    const entries = (
      (row as unknown as { [k: string]: (ElectrolysisEntry | LaserEntry)[] })[
        entryTable
      ] ?? []
    ).filter((e) => !e.deleted_at);
    if (entries.length > 0) {
      // Sessions return entries in insertion order; take the latest.
      const sorted = [...entries].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      return sorted[0];
    }
  }
  return null;
}

// Counts past laser entries for this client grouped by zone, across all sessions
// (including any in-progress one). Used to auto-suggest the next "Treatment #".
export async function getLaserTreatmentCountsForClient(
  studioId: string,
  clientId: string,
): Promise<Record<string, number>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select("id, laser_entries(zone, deleted_at)")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("modality", "laser")
    .is("deleted_at", null);

  if (error)
    throw new Error(`Failed to load laser treatment counts: ${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const entries = (
      row as unknown as {
        laser_entries: { zone: string; deleted_at: string | null }[];
      }
    ).laser_entries;
    for (const e of entries ?? []) {
      // Migration 0114: a voided pass does not count toward "Treatment #".
      if (e.deleted_at) continue;
      counts[e.zone] = (counts[e.zone] ?? 0) + 1;
    }
  }
  return counts;
}

// Read-only: count of the client's non-deleted LASER sessions that
// started before `beforeIso` (the current session's start). Used only to
// add modality context to the electrolysis session heading
// ("· N laser sessions previously"). Does not touch treatment-time
// calculations — it's a plain session count, separate from TTT.
export async function getPriorLaserSessionCount(
  studioId: string,
  clientId: string,
  beforeIso: string,
): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("modality", "laser")
    .is("deleted_at", null)
    .lt("started_at", beforeIso);
  if (error) {
    throw new Error(`Failed to count prior laser sessions: ${error.message}`);
  }
  return count ?? 0;
}

export async function getSessionAudit(
  sessionId: string,
): Promise<import("@/lib/types/database").SessionAudit[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_audit")
    .select("*")
    .eq("session_id", sessionId)
    .order("edited_at", { ascending: true });
  if (error) throw new Error(`Failed to load session audit: ${error.message}`);
  return (data ?? []) as import("@/lib/types/database").SessionAudit[];
}

export async function getActiveProbeLots(studioId: string): Promise<ProbeLot[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("probe_lots")
    .select("*")
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("probe_size", { ascending: true });

  if (error) throw new Error(`Failed to load probe lots: ${error.message}`);
  return (data ?? []) as ProbeLot[];
}

// Returns clients with a session that started today (in the studio's timezone, naive: server time).
export async function getTodayRosterForStudio(studioId: string): Promise<
  Array<{ client: Client; sessions: Session[] }>
> {
  const supabase = await createClient();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const { data, error } = await supabase
    .from("sessions")
    .select("*, client:clients(*)")
    .eq("studio_id", studioId)
    .is("deleted_at", null)
    .gte("started_at", start.toISOString())
    .lte("started_at", end.toISOString())
    .order("started_at", { ascending: true });

  if (error) throw new Error(`Failed to load today's roster: ${error.message}`);

  const grouped = new Map<string, { client: Client; sessions: Session[] }>();
  for (const row of data ?? []) {
    const { client, ...session } = row as Session & { client: Client };
    if (!client) continue;
    const existing = grouped.get(client.id);
    if (existing) {
      existing.sessions.push(session as Session);
    } else {
      grouped.set(client.id, { client, sessions: [session as Session] });
    }
  }
  return Array.from(grouped.values());
}

// Migration 0019: session block helpers.
// 17.5b.2 will use these to render blocks in the UI. They exist now so the
// query layer is complete and the new shape is reviewable in isolation.

export type SessionBlockWithEntries = SessionBlock & {
  electrolysis_entries: ElectrolysisEntry[];
};

export type SessionWithBlocks = {
  session: Session;
  blocks: SessionBlockWithEntries[];
  // Entries that somehow don't have a block_id, returned separately so the
  // UI can flag them. Expected to be empty after 0020 backfills and new
  // inserts go through ensureEntryHasBlock().
  orphan_entries: ElectrolysisEntry[];
};

// Returns all non-deleted blocks for a session, ordered by sort_order.
export async function getSessionBlocks(
  sessionId: string,
): Promise<SessionBlock[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_blocks")
    .select("*")
    .eq("session_id", sessionId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`Failed to load session blocks: ${error.message}`);
  return (data ?? []) as SessionBlock[];
}

export async function getSessionBlockById(
  blockId: string,
): Promise<SessionBlock | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_blocks")
    .select("*")
    .eq("id", blockId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`Failed to load block: ${error.message}`);
  return (data ?? null) as SessionBlock | null;
}

// Fetches a session plus all its non-deleted blocks and the electrolysis
// entries grouped under each block. Laser entries are out of scope for the
// blocks restructure (blocks model electrolysis treatment-level params).
export async function getSessionWithBlocks(
  sessionId: string,
): Promise<SessionWithBlocks | null> {
  const supabase = await createClient();

  const [sessionRes, blocksRes, entriesRes] = await Promise.all([
    supabase
      .from("sessions")
      .select("*")
      .eq("id", sessionId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("session_blocks")
      .select("*")
      .eq("session_id", sessionId)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true }),
    supabase
      .from("electrolysis_entries")
      .select("*")
      .eq("session_id", sessionId)
      .is("deleted_at", null) // Migration 0114: exclude voided passes.
      .order("created_at", { ascending: true }),
  ]);

  if (sessionRes.error)
    throw new Error(`Failed to load session: ${sessionRes.error.message}`);
  if (blocksRes.error)
    throw new Error(`Failed to load blocks: ${blocksRes.error.message}`);
  if (entriesRes.error)
    throw new Error(`Failed to load entries: ${entriesRes.error.message}`);
  if (!sessionRes.data) return null;

  const session = sessionRes.data as Session;
  const blocks = (blocksRes.data ?? []) as SessionBlock[];
  const entries = (entriesRes.data ?? []) as ElectrolysisEntry[];

  const byBlock = new Map<string, ElectrolysisEntry[]>();
  const orphan: ElectrolysisEntry[] = [];
  for (const e of entries) {
    if (e.block_id) {
      const bucket = byBlock.get(e.block_id) ?? [];
      bucket.push(e);
      byBlock.set(e.block_id, bucket);
    } else {
      orphan.push(e);
    }
  }

  const blocksWithEntries: SessionBlockWithEntries[] = blocks.map((b) => ({
    ...b,
    electrolysis_entries: byBlock.get(b.id) ?? [],
  }));

  return { session, blocks: blocksWithEntries, orphan_entries: orphan };
}

// Block params are the working template (current grouping and defaults for
// new entries in this block). Entry params are the historical snapshot
// (what was actually done at the moment of treatment). They are not
// duplicates pending cleanup; they capture different things.
//
// When rendering a block-grouped view, prefer block params for the GROUPED
// display (block header treatment params line) and entry params for the
// per-entry detail. The "Override" badge fires when entry.mode and
// block.mode differ.
//
// The resolver below is for "best available" rendering when the caller
// hasn't been passed the block context separately. Prefer the explicit
// prop pattern where the parent computes resolved params once and passes
// them down (see session-blocks-view.tsx).
export type TreatmentParams = {
  mode: ElectrolysisMode | null;
  apilus_modality: ApilusModality | null;
  energy_level: number | null;
  minutes_performed: number | null;
  probe_type: ProbeType | null;
  probe_size: string | null;
  machine_frequency: MachineFrequency | null;
};

export function resolveTreatmentParams(
  entry: ElectrolysisEntry,
  block: SessionBlock | null,
): TreatmentParams {
  return {
    mode: block?.mode ?? entry.mode,
    apilus_modality: block?.apilus_modality ?? entry.apilus_modality,
    energy_level: block?.energy_level ?? entry.energy_level,
    minutes_performed: block?.minutes_performed ?? entry.minutes_performed,
    probe_type: block?.probe_type ?? entry.probe_type,
    probe_size: block?.probe_size ?? entry.probe_size,
    machine_frequency: block?.machine_frequency ?? entry.machine_frequency,
  };
}
