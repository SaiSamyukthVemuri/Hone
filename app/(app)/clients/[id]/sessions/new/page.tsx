import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getClientById,
  requirePractitionerWithStudio,
} from "@/lib/supabase/queries";
import { localLongDate } from "@/lib/booking/tz";
import {
  buildLastSessionSummary,
  type LastSessionSummary,
} from "@/lib/sessions/clinical-summary";
import { loadLastChartedTreatment } from "@/lib/sessions/last-treatment-loader";
import {
  blocklessTreatmentCopy,
  toClinicalSummaryBlocks,
} from "@/lib/sessions/point-of-care-memory";
import {
  AreaSummaries,
  FromLastVisitForToday,
} from "@/components/last-session-summary";
import { createClient } from "@/lib/supabase/server";
import {
  parseSessionStartRefusal,
  sessionStartRefusalCopy,
} from "@/lib/sessions/session-start-refusal";
import { ModalityPicker } from "./ModalityPicker";
import { SectionLabel } from "@/components/ui/section-label";

// PR #156 (migration 0068). Sanity match for ?appointment_id=. Empty,
// missing, or malformed values fall through to "no appointment in
// scope"; the action layer re-validates the value against the
// authenticated studio and the route's client id.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // PR #156. The Chart session link on the client page (uncharted past
  // appointment) and the appointment detail page forward ?appointment_id
  // here. Both surfaces compute the value server-side; the search-param
  // hop is just the carrier between server-rendered pages.
  searchParams?: Promise<{ appointment_id?: string; refused?: string }>;
}) {
  const { id } = await params;
  const sp = (await searchParams) ?? {};
  const { studio, practitioner } = await requirePractitionerWithStudio();
  const data = await getClientById(studio.id, id);
  if (!data) notFound();

  const appointmentId =
    typeof sp.appointment_id === "string" && UUID_RE.test(sp.appointment_id)
      ? sp.appointment_id
      : null;

  // An expected refusal, either redirected back from startSessionAction or
  // found here BEFORE the picker is offered. A booking assigned to a colleague
  // is refused (PR #156 lineage, re-enforced by start_session), and that
  // refusal is now SAID on this page rather than reaching the generic error
  // boundary. This is presentation only: the action and the command still
  // refuse on their own, so the pre-check cannot widen anything.
  let refusal = appointmentId ? parseSessionStartRefusal(sp.refused) : null;
  let assignedName: string | null = null;
  // Move (owner reassignment) exists only for a confirmed FUTURE appointment,
  // the calendar page's isCancelable gate; the copy must not offer it otherwise.
  let canReassign = false;
  if (appointmentId) {
    const supabase = await createClient();
    // The embed MUST name the assignment FK: since migration 0174 appointments
    // has several practitioner relationships, and an unqualified embed is PGRST201.
    const { data: appt, error: apptErr } = await supabase
      .from("appointments")
      .select(
        "client_id, practitioner_id, status, starts_at, practitioner:practitioners!appointments_practitioner_same_studio_fk(display_name)",
      )
      .eq("id", appointmentId)
      .eq("studio_id", studio.id)
      .maybeSingle();
    if (apptErr) {
      // Fail closed on the PRESENTATION: never offer the picker on an unknown
      // appointment. The action would still refuse on its own.
      console.error(JSON.stringify({ event: "session_new_appointment_precheck_failed", code: apptErr.code ?? null }));
      refusal = refusal ?? "appointment_missing";
    } else if (appt && appt.client_id === id && appt.practitioner_id && appt.practitioner_id !== practitioner.id) {
      refusal = "assigned_elsewhere";
      const joined = appt.practitioner as { display_name?: string | null } | { display_name?: string | null }[] | null;
      assignedName = (Array.isArray(joined) ? joined[0]?.display_name : joined?.display_name) ?? null;
      const startsAtMs = Date.parse(String(appt.starts_at ?? ""));
      // Move REASSIGNS only in a capacity-on studio (loadMoveSlotsAction:
      // owner && studio.practitioner_capacity_enabled === true); elsewhere it
      // keeps the current assignee, so the copy must not promise it.
      canReassign =
        studio.practitioner_capacity_enabled === true &&
        appt.status === "confirmed" &&
        Number.isFinite(startsAtMs) &&
        startsAtMs > Date.now();
    }
  }
  const refusalCopy = refusal ? sessionStartRefusalCopy(refusal, assignedName, { canReassign }) : null;

  // PR #190 (clinical memory). The most recent previous session + its
  // blocks, condensed into the context panel below. This is the
  // five-second read before charting a returning client: last area,
  // settings, tolerance, reaction, caution, and the note left for
  // today. First-visit clients simply see no panel.
  //
  // The candidate used to be the newest session ROW (`order started_at desc
  // limit 1`), which is wrong here more often than anywhere else in the app:
  // tapping a modality on THIS page creates an empty session immediately, so an
  // abandoned attempt, or a newer administrative row, or a laser session for a
  // client mid-transition, permanently won the lookup and rendered a
  // "Previous session context" heading over an empty body while the real
  // treatment sat one row below. It is now the newest CHARTED session
  // (lib/sessions/charted-session.ts), the same definition the live charting
  // screen's point-of-care memory card uses.
  //
  // This also REMOVES two round-trips: the client's sessions and their live
  // entries already arrived with getClientById above, and the prior blocks now
  // carry their structured areas in the same select instead of needing a
  // separate attachStructuredAreas pass.
  const lastTreatment = await loadLastChartedTreatment({
    studioId: studio.id,
    sessions: data.sessions,
  });

  let previousSummary: LastSessionSummary | null = null;
  let previousMeta: { startedAt: string; modality: string; sessionId: string } | null =
    null;
  // Non-null when the selected treatment is genuinely charted but carries NO
  // settings blocks: a LASER visit (which charts into laser_entries) or
  // pre-0019 legacy electrolysis (which charted straight into entries).
  //
  // The selector deliberately accepts both, and it is right to: a laser visit
  // IS the last treatment for a client mid-transition. But every block-shaped
  // summary is empty for them: buildLastSessionSummary still returns a TRUTHY
  // object with `areas: []`, so this panel used to render its heading and date
  // over nothing at all. It now says what the record actually is, using the
  // SAME copy the charting screen's memory card uses.
  let blocklessNote: string | null = null;
  if (lastTreatment) {
    previousSummary = buildLastSessionSummary({
      // Charting unification: the adapter feeds each block's LIVE entries'
      // observation_chips through so the reaction line reads the unified
      // representation.
      blocks: toClinicalSummaryBlocks(lastTreatment.blocks),
      nextSessionNote: lastTreatment.session.next_session_note ?? null,
    });
    previousMeta = {
      startedAt: lastTreatment.session.started_at,
      modality: lastTreatment.session.modality,
      sessionId: lastTreatment.session.id,
    };
    if (lastTreatment.blocks.length === 0) {
      blocklessNote = blocklessTreatmentCopy({
        modality: lastTreatment.session.modality,
        hasLiveElectrolysisEntries: (
          lastTreatment.session.electrolysis_entries ?? []
        ).some((e) => e.deleted_at == null),
      });
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <div>
        <Link
          href={`/clients/${id}?tab=sessions`}
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← {data.client.name}
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          New session
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Choose a modality to start charting.
        </p>
        {appointmentId && !refusalCopy && (
          <p className="mt-2 text-xs text-neutral-500">
            Linking this session to the selected appointment.
          </p>
        )}
      </div>

      {refusalCopy && (
        <section
          role="status"
          data-testid="session-start-refusal"
          data-refusal={refusal ?? undefined}
          className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <h2 className="font-semibold">{refusalCopy.title}</h2>
          <p>{refusalCopy.body}</p>
          <div className="flex flex-wrap gap-4 pt-1">
            {appointmentId && (
              <Link href={`/calendar/${appointmentId}`} className="font-medium hover:underline">
                Open the appointment
              </Link>
            )}
            <Link href={`/clients/${id}`} className="font-medium hover:underline">
              Back to {data.client.name}
            </Link>
          </div>
        </section>
      )}

      {previousSummary && previousMeta && (
        <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-5 text-sm dark:border-neutral-800 dark:bg-neutral-900/50">
          <SectionLabel as="h2">
            Previous session context
          </SectionLabel>
          <p>
            <Link
              href={`/clients/${id}/sessions/${previousMeta.sessionId}`}
              className="font-medium hover:underline"
            >
              {localLongDate(new Date(previousMeta.startedAt), studio.timezone)}
            </Link>
            <span className="text-neutral-500 capitalize">
              {" "}
              · {previousMeta.modality}
            </span>
          </p>
          {/* A charted visit with no settings blocks (laser / legacy
              entry-only) renders the truthful fallback INSTEAD of an empty
              AreaSummaries. The plan still shows below either way. */}
          {blocklessNote ? (
            <div className="flex flex-col gap-2">
              <p
                data-testid="previous-context-blockless"
                className="text-neutral-700 dark:text-neutral-300"
              >
                {blocklessNote}
              </p>
              <Link
                href={`/clients/${id}/sessions/${previousMeta.sessionId}`}
                className="self-start text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
              >
                Open full chart →
              </Link>
            </div>
          ) : (
            /* PR #191: per-treatment-area mini-summaries plus the ONE
               combined From last visit box (watch + plan). */
            <AreaSummaries summary={previousSummary} />
          )}
          <FromLastVisitForToday summary={previousSummary} />
        </section>
      )}

      {/* Never offer the picker for a chart the action would refuse. */}
      {!refusalCopy && <ModalityPicker clientId={id} appointmentId={appointmentId} />}
    </div>
  );
}
