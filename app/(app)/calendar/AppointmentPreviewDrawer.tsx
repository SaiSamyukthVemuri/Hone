"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";
import { formatTimeForStudio, type TimeFormat } from "@/lib/booking/tz";
import { practitionerIntakeReviewHref } from "@/lib/dashboard/today-intake";
import { TodayTreatmentMemory } from "@/app/(app)/dashboard/today-treatment-memory";
import { isAppointmentCancelable } from "@/lib/calendar/appointment-actionability";
import type { AppointmentPreviewDetail } from "@/lib/calendar/appointment-preview-detail";
import { appointmentDisplayStatus } from "./appointment-display-status";
import { timeRangeLabel, weekdayLabel, monthDayLabel } from "./calendar-format";
import { MoveAppointmentButton } from "./MoveAppointmentButton";
import { AppointmentNotesEditor } from "./AppointmentNotesEditor";
import { PractitionerCancelForm } from "./PractitionerCancelForm";
import { loadAppointmentPreviewAction } from "./appointment-preview-actions";
import {
  shouldApplyPreviewResponse,
  shouldApplyPreviewFailure,
  detailRemainsCurrent,
} from "./preview-request";
import { previewAppointmentVersion } from "./preview-appointment-version";

// In-context appointment PREP WORKSPACE, opened from a card on the desktop week
// grid. The question it answers is "what do I need to know about this visit,
// and what do I usually do next" — without leaving the calendar.
//
// It owns NO business logic. Every fact and every action below belongs to an
// authority that already exists, and this file only arranges them:
//
//   last treatment  -> loadLastChartedTreatmentForClient (the shared
//                      newest-charted-treatment rule, via the lazy loader)
//   intake          -> practitionerIntakeReviewHref, the authenticated
//                      practitioner surface; never the client's /intake/<token>
//   notes           -> AppointmentNotesEditor + the governed 0173
//                      set_appointment_notes command
//   reschedule      -> the shared MoveAppointmentButton / dialog, relabelled
//                      through its `label` prop, not forked
//   cancel          -> PractitionerCancelForm -> practitioner_cancel_appointment
//   the cancel/move -> isAppointmentCancelable, the one predicate the detail
//   visibility gate    page uses
//
// PERFORMANCE. The week grid still carries no clinical or prep data, and the
// RSC payload is unchanged. This drawer issues ONE bounded load for the ONE
// appointment that was clicked, when it is clicked. Nothing here scales with
// the number of appointments on screen.
//
// FRESHNESS. The header renders immediately from the row the grid already had,
// then switches to the re-read row the moment it lands — and switches ALL of it
// at once. See ./preview-appointment-version: one selection supplies the
// displayed schedule, the displayed status, the action gate and the move
// dialog's expected-version payload, so the drawer cannot show one appointment
// while acting on another. A week payload can be minutes old; an appointment
// moved or cancelled in another window must not be described from the grid's
// memory of it, nor still offer Cancel.

type Props = {
  appointment: AppointmentWithPractitionerColor | null;
  studioTimezone: string;
  timeFormat: TimeFormat;
  // Preserves the calendar's return-to-this-week behaviour on the deep link.
  returnTo: string;
  onClose: () => void;
};

type LoadState = "idle" | "loading" | "error";

// Weekday + month/day for a studio-local instant (display only).
function dayLabel(iso: string, tz: string): string {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: undefined,
  }).format(new Date(iso)); // YYYY-MM-DD in studio tz
  const dow = new Date(`${local}T12:00:00Z`).getUTCDay();
  return `${weekdayLabel(dow)}, ${monthDayLabel(local)}`;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
      {children}
    </h3>
  );
}

export function AppointmentPreviewDrawer({
  appointment,
  studioTimezone,
  timeFormat,
  returnTo,
  onClose,
}: Props) {
  // The detail is held WITH the generation that produced it. Freshness is a
  // statement about the newest read, not a badge the object keeps: see
  // detailRemainsCurrent in ./preview-request.
  const [detail, setDetail] =
    useState<{ value: AppointmentPreviewDetail; seq: number } | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  // The drawer owns the mutable sequence; the decisions themselves are pure and
  // live in ./preview-request so they can be tested directly. `issuedSeq`
  // mirrors the ref into state so RENDER has a reactive view of it — a ref read
  // during render would not re-run this component when it changes.
  const requestSeq = useRef(0);
  const [issuedSeq, setIssuedSeq] = useState(0);

  const appointmentId = appointment?.id ?? null;

  const load = useCallback((id: string) => {
    const seq = ++requestSeq.current;
    // Issuing the read is itself the event that withdraws currency from
    // whatever is held: from here until this read succeeds, nobody is asserting
    // the row. The held copy stays on screen, but stops authorizing actions.
    setIssuedSeq(seq);
    setLoadState("loading");
    void loadAppointmentPreviewAction(id)
      .then((res) => {
        if (!res.ok) {
          // A superseded failure must not report a stale problem over a newer
          // verified result.
          if (!shouldApplyPreviewFailure({ requestSeq: seq, currentSeq: requestSeq.current })) {
            return;
          }
          // The held detail is deliberately NOT discarded — it is still the best
          // thing to show — but `issuedSeq` has moved past it, so it no longer
          // reads as current and the actions disappear with the error.
          setLoadState("error");
          return;
        }
        // A response for appointment A must never populate appointment B.
        if (
          !shouldApplyPreviewResponse({
            responseAppointmentId: res.detail.appointmentId,
            requestSeq: seq,
            currentSeq: requestSeq.current,
            openAppointmentId: id,
          })
        ) {
          return;
        }
        setDetail({ value: res.detail, seq });
        setLoadState("idle");
      })
      .catch(() => {
        if (!shouldApplyPreviewFailure({ requestSeq: seq, currentSeq: requestSeq.current })) {
          return;
        }
        setLoadState("error");
      });
  }, []);

  useEffect(() => {
    if (!appointmentId) {
      // Closing invalidates any in-flight response.
      const seq = ++requestSeq.current;
      setIssuedSeq(seq);
      setDetail(null);
      setLoadState("idle");
      return;
    }
    // Clicking a different appointment must not show the previous one's prep
    // while the new one loads.
    setDetail(null);
    load(appointmentId);
  }, [appointmentId, load]);

  useEffect(() => {
    if (!appointment) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [appointment, onClose]);

  if (!appointment) return null;

  const a = appointment;

  // ONE version for the whole drawer. Before this, the status line read the
  // re-read row while the time line read the grid, so a booking moved in
  // another window showed its old time beside its new status — and Reschedule
  // opened on a third answer. Display, the action gate and the move payload now
  // all read the same object, so they cannot disagree.
  const version = previewAppointmentVersion({
    grid: {
      startsAt: a.starts_at,
      endsAt: a.ends_at,
      durationMinutes: a.duration_minutes,
      status: a.status,
    },
    detail: detail
      ? {
          startsAt: detail.value.startsAt,
          endsAt: detail.value.endsAt,
          durationMinutes: detail.value.durationMinutes,
          status: detail.value.status,
        }
      : null,
    detailIsCurrent: detailRemainsCurrent({
      detailSeq: detail?.seq ?? null,
      issuedSeq,
    }),
  });

  const start = new Date(version.startsAt);
  const dispStart = formatTimeForStudio(start, studioTimezone, timeFormat);
  const dispEnd = version.endsAt
    ? formatTimeForStudio(new Date(version.endsAt), studioTimezone, timeFormat)
    : null;
  const timeRange = timeRangeLabel(dispStart, dispEnd);
  const clientName = a.client?.name?.trim() || "Client";
  const serviceName = a.service?.name?.trim() || null;
  const modality = a.service?.modality?.trim() || null;

  // Prefer the freshly re-read row once it arrives. The week payload can be
  // minutes old, and a drawer that labels a cancelled appointment "Upcoming"
  // while offering it no actions is the confusing half-truth this avoids.
  const ds = appointmentDisplayStatus(version.status, version.endsAt);
  // Every arm appointmentDisplayStatus can return has a label. It returns
  // "cancelled" as a first-class value, and without an arm for it a booking
  // cancelled in another window fell through to "Upcoming" — the drawer
  // withholding Cancel and Reschedule while still calling the appointment
  // upcoming. "Cancelled" is the term /calendar/[id] already uses; this is not
  // a second status vocabulary.
  const statusLabel =
    ds === "cancelled"
      ? "Cancelled"
      : ds === "done"
        ? "Done"
        : ds === "completed"
          ? "Completed"
          : ds === "no_show"
            ? "No-show"
            : "Upcoming";

  // Gated on the SERVER-READ status, not the week payload's copy, and on the
  // one shared predicate. Cancel and Reschedule share it exactly as they share
  // one `isCancelable` on the detail page.
  // Gated on the SAME version the drawer is displaying, so the actions offered
  // and the facts shown can never describe different rows. `fresh` is required:
  // a grid snapshot is not a verified current state, and offering lifecycle
  // actions on one is how the stale-move refusal happened.
  const canAct =
    version.fresh
    && isAppointmentCancelable({
      status: version.status,
      startsAt: version.startsAt,
      nowMs: Date.now(),
    });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Appointment preview"
      className="fixed inset-0 z-50 flex items-stretch justify-end"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30 backdrop-blur-[1px]"
      />
      <div
        className="relative z-10 flex w-full max-w-md flex-col gap-4 overflow-y-auto bg-white p-6 shadow-xl dark:bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-base font-semibold">{clientName}</h2>
            <p className="text-sm text-neutral-500">
              {dayLabel(version.startsAt, studioTimezone)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 px-2.5 py-1 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Close
          </button>
        </header>

        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500">Time</dt>
            <dd className="text-right font-medium tabular-nums">
              {timeRange} · {version.durationMinutes}m
            </dd>
          </div>
          {serviceName && (
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500">Service</dt>
              <dd className="text-right font-medium">
                {serviceName}
                {modality ? ` · ${modality}` : ""}
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500">Status</dt>
            <dd className="text-right font-medium">{statusLabel}</dd>
          </div>
        </dl>

        {/* Allergies: the one client-safety fact worth carrying here, and it
            comes free with the appointment read. Never summarised or truncated
            into something that could read as reassurance. */}
        {detail?.value.allergies?.trim() && (
          <div
            aria-label="Allergies"
            className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100"
          >
            <span className="font-semibold">Allergies: </span>
            {detail.value.allergies}
          </div>
        )}

        {loadState === "loading" && (
          <p className="text-sm text-neutral-500" role="status">
            Loading appointment details…
          </p>
        )}

        {loadState === "error" && (
          <p
            className="text-sm text-red-700 dark:text-red-400"
            data-testid="preview-load-error"
          >
            Could not load this appointment&apos;s details. Open full details
            below, or close and try again.
          </p>
        )}

        {detail && (
          <>
            {/* 1. PREP FOR THIS CLIENT ------------------------------------ */}
            <section
              className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
              data-testid="preview-prep"
            >
              <SectionHeading>Prep for this client</SectionHeading>
              {/* The SAME component the dashboard's Today row uses: a compact
                  one-line identity of the previous visit, expandable in place
                  to the canonical <AppointmentPrepMemoryCard>. Reused rather
                  than re-rendered here so there is exactly one definition of
                  what "last treatment" looks like, and one truthful handling
                  of the unavailable state. It is imported across feature
                  folders for the same reason the detail page imports
                  practitionerIntakeReviewHref from @/lib/dashboard. */}
              {!detail.value.lastTreatmentUnavailable && !detail.value.prepMemory ? (
                <p className="text-sm text-neutral-500">
                  No previous treatment charted for this client.
                </p>
              ) : (
                detail.value.clientId && (
                  <TodayTreatmentMemory
                    clientId={detail.value.clientId}
                    clientName={clientName}
                    memory={detail.value.prepMemory}
                    unavailable={detail.value.lastTreatmentUnavailable}
                  />
                )
              )}
            </section>

            {/* 2. INTAKE -------------------------------------------------- */}
            <section
              className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
              data-testid="preview-intake"
            >
              <SectionHeading>Intake</SectionHeading>
              {detail.value.intakeUnavailable ? (
                <p className="text-sm text-neutral-500">
                  Intake status could not be loaded.
                </p>
              ) : detail.value.intakeStatus === "submitted" ? (
                <>
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">
                    Awaiting review
                  </p>
                  {detail.value.clientId && (
                    <Link
                      href={practitionerIntakeReviewHref(detail.value.clientId)}
                      data-testid="preview-review-intake"
                      className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
                    >
                      Review intake
                    </Link>
                  )}
                </>
              ) : detail.value.intakeStatus === "reviewed" ? (
                <>
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">
                    Reviewed
                  </p>
                  {detail.value.clientId && (
                    <Link
                      href={practitionerIntakeReviewHref(detail.value.clientId)}
                      data-testid="preview-view-intake"
                      className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                    >
                      View intake
                    </Link>
                  )}
                </>
              ) : detail.value.intakeStatus === "in_progress" ? (
                // Deliberately no action: an unsubmitted form is not reviewable,
                // and offering to review it would be a lie.
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  Started, not yet submitted.
                </p>
              ) : (
                <p className="text-sm text-neutral-500">No intake on file.</p>
              )}
            </section>

            {/* 3. APPOINTMENT NOTES --------------------------------------- */}
            {/* The governed 0173 writer, not a second one. onSaved re-reads
                this drawer's own copy: router.refresh() re-runs the RSC but
                cannot refresh a client-held lazy load. */}
            {/* key: the editor seeds its draft from `notes` on MOUNT. One
                drawer instance serves every appointment in its column, so
                without this, clicking A then B would carry A's unsaved draft
                into B's editor. */}
            <AppointmentNotesEditor
              key={a.id}
              appointmentId={a.id}
              notes={detail.value.notes}
              onSaved={() => load(a.id)}
            />

            {/* 4. ACTIONS ------------------------------------------------- */}
            {canAct && (
              <>
                {/* The RE-READ appointment version, not the week payload's copy.
                    startsAt/endsAt become 0133's p_expected_starts_at/ends_at,
                    so a stale pair does not merely look wrong — it makes a
                    legitimate move impossible for as long as the drawer stays
                    open. durationMinutes is carried as its OWN stored fact,
                    never reconstructed from the span, because 0133 preserves
                    that column and computes the new end from it. All three come
                    from one version; see ./move-dialog-schedule. */}
                <MoveAppointmentButton
                  appointment={{
                    id: a.id,
                    startsAt: version.startsAt,
                    endsAt: version.endsAt,
                    durationMinutes: version.durationMinutes,
                    clientName: a.client?.name ?? null,
                    serviceName: a.service?.name ?? null,
                  }}
                  studioTimezone={studioTimezone}
                  timeFormat={timeFormat}
                  label="Reschedule"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  onMoved={onClose}
                />
                {/* key: same reason as the notes editor — the form holds a
                    `reason` draft that must not follow A into B. */}
                <PractitionerCancelForm
                  key={a.id}
                  appointmentId={a.id}
                  onCancelled={onClose}
                />
              </>
            )}
          </>
        )}

        {/* The full record and every other appointment action live on the
            unchanged detail route, never duplicated here. */}
        <Link
          href={`/calendar/${a.id}${returnTo}`}
          className="mt-1 inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Open full details
        </Link>
      </div>
    </div>
  );
}
