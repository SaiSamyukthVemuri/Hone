import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getClientById,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { localLongDate } from "@/lib/booking/tz";
import {
  buildLastSessionSummary,
  type ClinicalSummaryBlock,
  type LastSessionSummary,
} from "@/lib/sessions/clinical-summary";
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
  const supabase = await createClient();
  const { data: prevSession } = await supabase
    .from("sessions")
    .select("id, started_at, modality, next_session_note")
    .eq("studio_id", studio.id)
    .eq("client_id", id)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let previousSummary: LastSessionSummary | null = null;
  let previousMeta: { startedAt: string; modality: string; sessionId: string } | null =
    null;
  if (prevSession) {
    const { data: prevBlocks } = await supabase
      .from("session_blocks")
      .select(
        "sort_order, block_name, primary_area, side, custom_area_detail, mode, apilus_modality, energy_level, minutes_performed, probe_label, tolerance_rating, reaction_type, reaction_notes, caution_for_next_session, caution_note",
      )
      .eq("studio_id", studio.id)
      .eq("session_id", prevSession.id)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true });
    previousSummary = buildLastSessionSummary({
      blocks: (prevBlocks ?? []) as ClinicalSummaryBlock[],
      nextSessionNote: prevSession.next_session_note,
    });
    previousMeta = {
      startedAt: prevSession.started_at,
      modality: prevSession.modality,
      sessionId: prevSession.id,
    };
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
          {/* PR #191: per-treatment-area mini-summaries plus the ONE
              combined From last visit box (watch + plan). */}
          <AreaSummaries summary={previousSummary} />
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
