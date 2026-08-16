import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getLatestIntakeForClient } from "@/lib/intake/queries";
import { loadLastChartedTreatmentForClient } from "@/lib/sessions/last-treatment-loader";
import {
  buildAppointmentPrepMemory,
  prepMemoryInputFromTreatment,
  type AppointmentPrepMemory,
} from "@/lib/sessions/appointment-prep-memory";
import type { IntakeStatus } from "@/lib/types/database";

// ONE bounded prep load for ONE appointment, run only when the calendar's
// preview drawer opens.
//
// Why this exists at all: the week grid deliberately carries no clinical or
// prep data. Putting last-treatment, intake and notes into the week RSC payload
// would mean loading them for every appointment in the week to serve the one
// the practitioner actually clicks — the N+1 this module exists to avoid. So
// the grid stays cheap and this runs lazily, once, for the clicked row.
//
// Cost is CONSTANT in the size of the week: one appointment read, then a
// parallel wave of the intake read and the shared last-treatment authority
// (itself a bounded candidate window plus one batched block read). Nothing here
// scales with how many appointments are on screen.
//
// Boundaries:
//   * user-scoped createClient() — RLS applies; no service-role client;
//   * studioId is derived from the session by the CALLER and passed in; the
//     appointment id is a pointer, never authority. A foreign-studio id is
//     indistinguishable from a missing one;
//   * read-only. No writes, no emails, no lifecycle transitions;
//   * no raw DB text crosses to the browser.
//
// It deliberately does NOT re-derive "last treatment", intake currency, or the
// cancel gate. Each of those has exactly one owner elsewhere and is called.

// Bounded operational marker: stage + SQLSTATE only. Never raw DB/PostgREST
// text, row data, client identity or clinical content.
function logPreviewDbError(stage: string, code: string | undefined): void {
  console.error(`appointment_preview_db_error:${stage}:${code ?? "unknown"}`);
}

export type AppointmentPreviewDetail = {
  // Echoed so the client can prove a response describes the appointment it has
  // open. See app/(app)/calendar/preview-request.ts.
  appointmentId: string;
  clientId: string | null;
  // Re-read from the row rather than trusted from the week payload, which may
  // be minutes old: an appointment cancelled or completed in another tab must
  // not still offer Cancel here.
  status: string;
  startsAt: string;
  endsAt: string;
  // The STORED duration, carried as its own fact and never reconstructed from
  // endsAt - startsAt. Nothing in the schema ties the two together (0010 gives
  // duration_minutes only a 5..480 range check), and the move command preserves
  // THIS column while computing a new end from it, so a surface that derives it
  // from the span can state a number the command will not honour.
  durationMinutes: number;
  notes: string | null;
  allergies: string | null;

  // Three-state, never two. A failed read must not render as "no intake on
  // file" — that is an affirmative clinical denial the data does not support.
  intakeStatus: IntakeStatus | null;
  intakeUnavailable: boolean;

  // The canonical prep memory for the ONE clicked appointment, built by the
  // shared builder. Not a local projection of it: the drawer renders it with
  // the same <TodayTreatmentMemory> / <AppointmentPrepMemoryCard> pair the
  // dashboard uses, so there is no second definition of what "last treatment"
  // looks like. Bounded to a single visit — this is one session's memory, not
  // the client's history.
  prepMemory: AppointmentPrepMemory | null;
  // A read FAILED or was truncated. Distinct from `prepMemory === null`, which
  // means the client genuinely has nothing charted.
  lastTreatmentUnavailable: boolean;
};

export type AppointmentPreviewDetailResult =
  | { ok: true; detail: AppointmentPreviewDetail }
  | { ok: false; reason: string };

const NOT_FOUND = "This appointment could not be found in this studio.";
const LOAD_FAILED = "Could not load this appointment. Please try again.";

type ApptRow = {
  id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  notes: string | null;
  client_id: string | null;
  client: { id: string; name: string | null; allergies: string | null } | null;
};

export async function loadAppointmentPreviewDetail(args: {
  studioId: string;
  appointmentId: string;
}): Promise<AppointmentPreviewDetailResult> {
  const appointmentId = (args.appointmentId ?? "").trim();
  if (!appointmentId) return { ok: false, reason: NOT_FOUND };

  const supabase = await createClient();

  // Studio-scoped by explicit predicate ON TOP OF RLS. Both `.eq`s are
  // load-bearing: the studio predicate is what makes another studio's
  // appointment id resolve to "not found" rather than to a row.
  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, status, starts_at, ends_at, duration_minutes, notes, client_id, client:clients(id, name, allergies)",
    )
    .eq("studio_id", args.studioId)
    .eq("id", appointmentId)
    .maybeSingle();

  if (error) {
    logPreviewDbError("appointment", error.code);
    return { ok: false, reason: LOAD_FAILED };
  }
  if (!data) return { ok: false, reason: NOT_FOUND };

  // PostgREST returns an embedded to-one relation as an object, but the
  // generated types widen it to an array. Normalize the same way
  // lib/booking/queries.ts does.
  const raw = data as unknown as Omit<ApptRow, "client"> & {
    client: ApptRow["client"] | ApptRow["client"][] | null;
  };
  const client = Array.isArray(raw.client) ? (raw.client[0] ?? null) : raw.client;
  const clientId = raw.client_id ?? client?.id ?? null;

  const base = {
    appointmentId: raw.id,
    clientId,
    status: raw.status,
    startsAt: raw.starts_at,
    endsAt: raw.ends_at,
    durationMinutes: raw.duration_minutes,
    notes: raw.notes ?? null,
    allergies: client?.allergies ?? null,
  };

  // A deleted client leaves the appointment readable but has no prep to load.
  if (!clientId) {
    return {
      ok: true,
      detail: {
        ...base,
        intakeStatus: null,
        intakeUnavailable: false,
        prepMemory: null,
        lastTreatmentUnavailable: false,
      },
    };
  }

  // Both reads are client-scoped and independent, so they overlap. Neither is
  // allowed to fail the whole drawer: a missing prep section is recoverable,
  // an empty drawer is not.
  const [intakeRes, prepRes] = await Promise.all([
    getLatestIntakeForClient(args.studioId, clientId).then(
      (row) => ({ ok: true as const, status: row?.status ?? null }),
      (err: unknown) => {
        logPreviewDbError(
          "intake",
          typeof (err as { code?: unknown } | null)?.code === "string"
            ? (err as { code: string }).code
            : undefined,
        );
        return { ok: false as const, status: null };
      },
    ),
    // THE canonical newest-charted-treatment authority. The three boundary
    // rules — strictly before this appointment's starts_at, excluding every
    // session linked to THIS appointment, and never letting an empty or
    // abandoned session outrank a real charted one — live in it and are not
    // restated here.
    loadLastChartedTreatmentForClient({
      studioId: args.studioId,
      clientId,
      before: raw.starts_at,
      excludeAppointmentId: raw.id,
    }).then(
      (r) => ({ ok: true as const, load: r }),
      () => {
        logPreviewDbError("last_treatment", undefined);
        return { ok: false as const, load: null };
      },
    ),
  ]);

  // The SAME two pure builders the appointment detail page uses, in the same
  // order. Selection already happened inside the loader; this only shapes it.
  let prepMemory: AppointmentPrepMemory | null = null;
  if (prepRes.ok && prepRes.load?.treatment) {
    prepMemory = buildAppointmentPrepMemory(
      prepMemoryInputFromTreatment(prepRes.load.treatment),
    );
  }

  return {
    ok: true,
    detail: {
      ...base,
      intakeStatus: intakeRes.status,
      intakeUnavailable: !intakeRes.ok,
      prepMemory,
      // A read that FAILED is not a client with no history. Either the loader
      // reported unavailable, or the call itself threw.
      lastTreatmentUnavailable: !prepRes.ok || prepRes.load.unavailable,
    },
  };
}
