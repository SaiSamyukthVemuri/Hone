import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getClientById,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import { localLongDate } from "@/lib/booking/tz";
import {
  buildLastSessionSummary,
  type LastSessionSummary,
} from "@/lib/sessions/clinical-summary";
import { loadVisitPreparation } from "@/lib/sessions/history/prepare-visit";
import {
  blocklessTreatmentCopy,
  toClinicalSummaryBlocks,
} from "@/lib/sessions/point-of-care-memory";
import {
  AreaSummaries,
  FromLastVisitForToday,
} from "@/components/last-session-summary";
import { startSessionAction } from "./actions";

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
  searchParams?: Promise<{ appointment_id?: string }>;
}) {
  const { id } = await params;
  const sp = (await searchParams) ?? {};
  const { studio } = await getCurrentPractitionerWithStudio();
  const data = await getClientById(studio.id, id);
  if (!data) notFound();

  const appointmentId =
    typeof sp.appointment_id === "string" && UUID_RE.test(sp.appointment_id)
      ? sp.appointment_id
      : null;

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
  // THROUGH THE HISTORICAL AUTHORITY.
  //
  // This page used to hand the loader `data.sessions` — a bare array the page
  // already had in memory. That is the shape that lets a caller decide "which
  // of these is the newest charted one?" for itself, and it inherited that
  // read's weaknesses: `getClientById`'s sessions select declares no `.limit()`
  // (so a silent cap at PostgREST's max_rows) and orders `started_at DESC` with
  // no tie-break, which is not a total order.
  //
  // `before: null` is correct and is NOT a clock read: /sessions/new has no
  // appointment to be relative to, so it asks "what did we last do for this
  // client" with no horizon rather than inventing one from now().
  const prep = await loadVisitPreparation({
    studioId: studio.id,
    clientId: id,
    before: null,
  });
  const selectedVisit = prep.preparation.treatment;

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
  if (selectedVisit.kind === "visit" && prep.session && prep.detail) {
    previousSummary = buildLastSessionSummary({
      // Charting unification: each block carries its LIVE entries so the
      // reaction line reads the unified representation. They arrive attached to
      // the block by the canonical record rather than being re-joined here.
      blocks: toClinicalSummaryBlocks(prep.detail.blocks),
      nextSessionNote: prep.session.next_session_note ?? null,
    });
    previousMeta = {
      startedAt: prep.session.started_at,
      modality: prep.session.modality ?? "",
      sessionId: prep.session.id,
    };
    // FROM THE VARIANT, not from `blocks.length === 0`.
    //
    // A count of zero is ambiguous: it is a laser visit, a legacy entry-only
    // visit, or a read that lost the blocks. The authority has already
    // distinguished them, and reading `hasLiveElectrolysisEntries` off embedded
    // rows — as this did — is exactly the inference a row cap can falsify.
    if (selectedVisit.treatment.kind !== "charted-areas") {
      blocklessNote = blocklessTreatmentCopy({
        modality: prep.session.modality ?? "",
        hasLiveElectrolysisEntries:
          selectedVisit.treatment.kind === "legacy-entry-only",
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
        {appointmentId && (
          <p className="mt-2 text-xs text-neutral-500">
            Linking this session to the selected appointment.
          </p>
        )}
      </div>

      {previousSummary && previousMeta && (
        <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-5 text-sm dark:border-neutral-800 dark:bg-neutral-900/50">
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Previous session context
          </h2>
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

      <div className="grid gap-4 md:grid-cols-2">
        <ModalityCard
          clientId={id}
          modality="electrolysis"
          title="Electrolysis"
          description="Area, probe, mode, intensity, duration."
          appointmentId={appointmentId}
        />
        <ModalityCard
          clientId={id}
          modality="laser"
          title="Laser"
          description="Zone, fluence, pulse width, spot size."
          appointmentId={appointmentId}
        />
      </div>
    </div>
  );
}

function ModalityCard({
  clientId,
  modality,
  title,
  description,
  appointmentId,
}: {
  clientId: string;
  modality: "electrolysis" | "laser";
  title: string;
  description: string;
  appointmentId: string | null;
}) {
  return (
    <form action={startSessionAction}>
      <input type="hidden" name="client_id" value={clientId} />
      <input type="hidden" name="modality" value={modality} />
      {appointmentId && (
        <input type="hidden" name="appointment_id" value={appointmentId} />
      )}
      <button
        type="submit"
        className="flex w-full flex-col items-start gap-2 rounded-lg border border-neutral-200 bg-white px-5 py-6 text-left transition hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-100 dark:hover:bg-neutral-900"
      >
        <span className="text-lg font-medium">{title}</span>
        <span className="text-sm text-neutral-500">{description}</span>
      </button>
    </form>
  );
}
