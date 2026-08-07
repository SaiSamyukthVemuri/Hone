import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getPinnedNotesForClient } from "@/lib/client-pinned-notes/queries";
import { getClientTags } from "@/lib/client-tags/queries";
import { getLatestIntakeForClient } from "@/lib/intake/queries";
import { getTreatmentPlansForClient } from "@/lib/treatment-plans/queries";
import { FITZPATRICK_TYPES } from "@/lib/constants";
import { referralSourceLabel } from "@/lib/booking/referral-source";
import { resolveTimeFormat } from "@/lib/booking/tz";
import { MoveAppointmentButton } from "../MoveAppointmentButton";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { loadLastChartedTreatmentForClient } from "@/lib/sessions/last-treatment-loader";
import {
  buildAppointmentPrepMemory,
  type AppointmentPrepMemory,
} from "@/lib/sessions/appointment-prep-memory";
import type { AppointmentPrepLoad } from "@/lib/sessions/last-treatment-loader";
import { AppointmentPrepMemoryCard } from "@/components/appointment-prep-memory-card";
import { PinnedNotesReadonly } from "@/components/pinned-notes-readonly";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import { AppointmentLifecycleActions } from "../AppointmentLifecycleActions";
import { AppointmentCheckoutCell } from "@/components/appointment-checkout-cell";
import { getAppointmentPaymentStates } from "@/lib/billing/appointment-payment-state";
import { calendarReturnHref } from "../calendar-return";
import { PractitionerCancelForm } from "../PractitionerCancelForm";
import { PostcareSendButton } from "../PostcareSendButton";
import { PostcareSection } from "@/components/appointment/postcare-section";
import { buildPostcareEmail } from "@/lib/email/templates/postcare";
import { ManualFeeChargeCard } from "./ManualFeeChargeCard";
import { getManualFeeChargeEligibility } from "@/lib/billing/manual-fee-eligibility";
import {
  appointmentDisplayStatus,
  type AppointmentDisplayStatus,
} from "../appointment-display-status";
import type {
  Appointment,
  Client,
  ClientIntakeForm,
  ClientTag,
  Practitioner,
  Service,
  Session,
  TreatmentPlan,
} from "@/lib/types/database";

type ClientBriefing = Pick<
  Client,
  | "id"
  | "name"
  | "email"
  | "phone"
  | "pronouns"
  | "allergies"
  | "fitzpatrick_type"
  | "skin_notes"
>;

type Joined = Appointment & {
  client: ClientBriefing | null;
  service: Pick<
    Service,
    "id" | "name" | "default_duration_minutes" | "modality"
  > | null;
  practitioner: Pick<Practitioner, "id" | "display_name" | "color"> | null;
};

function fitzpatrickLabel(value: number | null): string | null {
  if (value == null) return null;
  const match = FITZPATRICK_TYPES.find((f) => f.value === value);
  return match ? match.label : `Type ${value}`;
}

export default async function AppointmentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    view?: string | string[];
    week?: string | string[];
    month?: string | string[];
  }>;
}) {
  const { id } = await params;
  // Safe, internal-only back link: returns to the view/date the practitioner
  // came from (falls back to /calendar). Never an external URL.
  const backHref = calendarReturnHref(await searchParams);
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const isOwner = practitioner.role === "owner";
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("appointments")
    .select(
      "*, client:clients(id, name, email, phone, pronouns, allergies, fitzpatrick_type, skin_notes), service:services(id, name, default_duration_minutes, modality), practitioner:practitioners(id, display_name, color)",
    )
    .eq("id", id)
    .eq("studio_id", studio.id)
    .maybeSingle<Joined>();
  if (error) throw new Error(error.message);
  if (!data) notFound();

  const isCancelled = data.status === "cancelled";

  // PR #144. When the appointment is cancelled, load the latest
  // `cancelled` audit row so we can surface the structured insight
  // the public token path now captures (reason machine value, label
  // snapshot, optional note, follow-up permission). Studio members
  // can read appointment_audit via RLS (migration 0010); no service
  // role needed. The shape is jsonb so we narrow at use sites.
  // Practitioner-initiated cancellations produce a different details
  // shape (no reason_label / note / follow_up_allowed) and the UI
  // below falls through to the existing column-based rendering for
  // those rows.
  type CancellationAuditDetails = {
    source?: string;
    reason?: string;
    reason_label?: string;
    note?: string;
    follow_up_allowed?: boolean;
  };
  let cancellationInsight: CancellationAuditDetails | null = null;
  if (isCancelled) {
    const { data: auditRow } = await supabase
      .from("appointment_audit")
      .select("details")
      .eq("appointment_id", id)
      .eq("action", "cancelled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ details: CancellationAuditDetails | null }>();
    cancellationInsight = auditRow?.details ?? null;
  }

  // Compute "cancelled quickly" from the row's own timestamps. The
  // window is 15 minutes between created_at and cancelled_at; if the
  // row was created and cancelled within that window the practitioner
  // sees a small "Cancelled quickly" hint with the elapsed minutes.
  // No new column, no migration; just arithmetic on what the row
  // already stores. Returns null when the appointment is not
  // cancelled or when either timestamp is missing or malformed.
  let cancelledQuicklyMinutes: number | null = null;
  if (isCancelled && data.cancelled_at && data.created_at) {
    const createdMs = new Date(data.created_at).getTime();
    const cancelledMs = new Date(data.cancelled_at).getTime();
    if (Number.isFinite(createdMs) && Number.isFinite(cancelledMs)) {
      const deltaMin = Math.round((cancelledMs - createdMs) / 60000);
      if (deltaMin >= 0 && deltaMin <= 15) {
        cancelledQuicklyMinutes = deltaMin;
      }
    }
  }

  // PR #145. Manual cancellation/no-show fee preview. Both eligibility
  // snapshots are computed when the appointment is cancelled or
  // no_show; the card UI toggles between them locally without a
  // round-trip. The helper itself is read-only and runs through
  // service-role; no Stripe call, no row write. The future Stripe-
  // charge PR will reuse the same helper before any PaymentIntent.
  const showManualFeeCard =
    data.status === "cancelled" || data.status === "no_show";
  const manualFeeLateCancel = showManualFeeCard
    ? await getManualFeeChargeEligibility({
        studioId: studio.id,
        appointmentId: id,
        chargeType: "late_cancel",
      })
    : null;
  const manualFeeNoShow = showManualFeeCard
    ? await getManualFeeChargeEligibility({
        studioId: studio.id,
        appointmentId: id,
        chargeType: "no_show",
      })
    : null;

  // P0-1 + P0-3: typed alias so the lifecycle component sees an exhaustive
  // status union and not the raw `string` from the database row type.
  const typedStatus = data.status as
    | "confirmed"
    | "completed"
    | "cancelled"
    | "no_show";

  // Quick checkout: the appointment's coarse payment state, so the Payment
  // section shows Paid/Processing/Refunded or the Checkout entry — the SAME
  // bounded loader + cell the dashboard uses (one flow, not two).
  const checkoutPaymentState =
    typedStatus === "completed"
      ? (await getAppointmentPaymentStates(studio.id, [id])).get(id) ??
        "no_session"
      : "no_session";

  // Workflow fix 3 (preserved): cancel surface only for confirmed +
  // future. Past/in-progress confirmed appointments expose Mark
  // complete / Mark no-show only.
  const startsAtMs = new Date(data.starts_at).getTime();
  const isCancelable =
    typedStatus === "confirmed"
    && Number.isFinite(startsAtMs)
    && startsAtMs > Date.now();

  // Display-derived status (DB row unchanged). A past confirmed appointment
  // reads as "Done"; the stored status stays confirmed so Mark no-show stays
  // available. Computed at render time; no timer.
  const displayStatus = appointmentDisplayStatus(data.status, data.ends_at);

  // Briefing reads — every additional fetch below is read-only,
  // scoped to the authenticated practitioner's studio via RLS, and
  // already used elsewhere in the app. No new RPCs, no mutations.
  let pinnedNotes: Awaited<ReturnType<typeof getPinnedNotesForClient>> = [];
  let tags: ClientTag[] = [];
  let intake: ClientIntakeForm | null = null;
  let treatmentPlans: Awaited<
    ReturnType<typeof getTreatmentPlansForClient>
  > = [];
  // Appointment preparation uses the same newest-charted-treatment authority as
  // the active charting and new-session surfaces
  // (lib/sessions/charted-session.ts, reached through
  // loadLastChartedTreatmentForClient). There is ONE definition of "the last
  // treatment" in the product and this page no longer carries a second one.
  //
  // What it replaces: a `sessions … order started_at desc limit 1` read whose
  // chosen row was then inspected for blocks. That query has no way to ask
  // whether a session CONTAINS anything, so an abandoned empty session — one is
  // created the instant a practitioner taps a modality on /sessions/new — or a
  // newer administrative row, or a void row, or this appointment's own
  // in-progress session, permanently won the lookup and rendered an empty "Last
  // session" over the real treatment sitting one row below.
  let prepMemory: AppointmentPrepMemory | null = null;
  // True only when a read itself failed — never for a first-visit client, and
  // never merely because nothing is charted.
  let prepUnavailable = false;
  // Practitioner narrative recovered from the candidate window. Survives BOTH
  // "nothing charted" and "the block read failed", because a plan can be
  // written on a visit that never got charted and because those rows were
  // already fetched successfully. Rendered only when no treatment card owns it.
  let prepNarrative: AppointmentPrepLoad["narrative"] = {
    plan: null,
    legacySessionNotes: null,
  };
  // PR #156 (migration 0068). The session, if any, that was logged
  // explicitly against THIS appointment via the new appointment_id
  // FK. Distinct from `prepMemory` above, which is the newest charted
  // treatment BEFORE this appointment. The linked session is the
  // per-visit treatment record for this appointment; when present, the
  // appointment is already charted and the Chart session affordance
  // becomes a View session link instead. The two can never be the same
  // row: the prep loader excludes every session carrying this
  // appointment id.
  let linkedSession: Pick<Session, "id" | "started_at" | "modality"> | null =
    null;

  if (data.client) {
    const clientId = data.client.id;
    const [
      pinnedRes,
      tagsRes,
      intakeRes,
      plansRes,
      lastTreatment,
      linkedSessionRes,
    ] = await Promise.all([
      getPinnedNotesForClient(studio.id, clientId),
      getClientTags(studio.id, clientId),
      getLatestIntakeForClient(studio.id, clientId),
      getTreatmentPlansForClient(studio.id, clientId),
      // THE newest charted treatment before this appointment. Same selector,
      // same batched block read and same fail-soft contract as the charting
      // screen and /sessions/new — this page just has to fetch its own bounded
      // candidate window, because it is appointment-scoped and (deliberately)
      // never loads the client profile.
      //
      // Two round-trips, independent of how long the client's history is, how
      // many areas each block treats and how many passes each area carries. It
      // replaces three: newest row → that row's blocks → structured areas.
      loadLastChartedTreatmentForClient({
        studioId: studio.id,
        clientId,
        // Strictly before this appointment. Not now(), which would let a
        // session charted after the appointment began win; not omitted, which
        // would let a future booking's session win.
        before: data.starts_at,
        // This appointment's own visit record is never its own history.
        excludeAppointmentId: id,
      }),
      // PR #156 (migration 0068). Explicitly linked session, if one
      // was logged against this appointment id. ON DELETE SET NULL
      // means the row is queryable even if the parent appointment
      // is later removed; we still filter to the current appointment
      // id so a freshly-nulled row does not surface here. The query
      // returns the most recent linked session in case future flows
      // ever produce more than one (today the action treats the FK
      // as effectively one-to-one per coalesce window).
      supabase
        .from("sessions")
        .select("id, started_at, modality")
        .eq("studio_id", studio.id)
        .eq("client_id", clientId)
        .eq("appointment_id", id)
        .is("deleted_at", null)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    pinnedNotes = pinnedRes;
    tags = tagsRes;
    intake = intakeRes;
    treatmentPlans = plansRes;
    if (linkedSessionRes.error) {
      throw new Error(
        `Failed to load linked session: ${linkedSessionRes.error.message}`,
      );
    }
    linkedSession = (linkedSessionRes.data ?? null) as
      | Pick<Session, "id" | "started_at" | "modality">
      | null;

    // The complete pre-visit view model: every treated area with laterality,
    // the complete per-area setup, the outcomes kept separate from that setup,
    // and the WHOLE practitioner narrative — at full length, with line breaks
    // preserved and nothing clamped. Assembled by a pure builder; this page
    // decides nothing about which notes exist or how they group.
    //
    // Structured areas arrive inside the same block select the loader already
    // performs, so the old attachStructuredAreas round-trip is gone.
    prepUnavailable = lastTreatment.unavailable;
    prepNarrative = lastTreatment.narrative;
    if (lastTreatment.treatment) {
      const selected = lastTreatment.treatment;
      prepMemory = buildAppointmentPrepMemory({
        session: {
          id: selected.session.id,
          started_at: selected.session.started_at,
          modality: selected.session.modality,
          // Legacy, and the only render of this column anywhere in the product:
          // sessions.session_notes has no surviving writer, so the text on
          // existing rows can never be recreated once a surface stops showing
          // it.
          session_notes: selected.session.session_notes ?? null,
          next_session_note: selected.session.next_session_note ?? null,
        },
        blocks: selected.blocks,
        laserEntries: selected.session.laser_entries ?? null,
        // Pre-0019 electrolysis charted straight into entries with no block, so
        // this is the ONLY channel that narrative has. Passes that do belong to
        // a block arrive through that block instead and are skipped there.
        electrolysisEntries: selected.session.electrolysis_entries ?? null,
        supersededByEmptySession: selected.supersededByEmptySession,
        // The plan source is deliberately decoupled from the treatment source:
        // the instruction most likely to change today is the most RECENT one,
        // and it can live on a session that never got charted.
        planSource: prepNarrative.plan,
        hasLiveElectrolysisEntries: (
          selected.session.electrolysis_entries ?? []
        ).some((e) => e.deleted_at == null),
      });
    }
  }

  const activePlans = treatmentPlans.filter((p) => p.status === "active");
  const fitzpatrick = fitzpatrickLabel(data.client?.fitzpatrick_type ?? null);

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={backHref}
        className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        ← Calendar
      </Link>

      <StatusHeader
        serviceName={data.service?.name ?? "Appointment"}
        startsAt={data.starts_at}
        durationMinutes={data.duration_minutes}
        practitioner={data.practitioner}
        displayStatus={displayStatus}
      />

      <PinnedNotesReadonly notes={pinnedNotes} />

      {data.client?.allergies && (
        <section
          className="rounded-lg border-l-4 border-rose-400 bg-rose-50 px-5 py-4 dark:border-rose-500 dark:bg-rose-950/30"
          aria-label="Allergies"
        >
          <h2 className="text-xs font-semibold uppercase tracking-wider text-rose-900 dark:text-rose-200">
            Allergies
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-rose-950 dark:text-rose-100">
            {data.client.allergies}
          </p>
        </section>
      )}

      <ClientBriefingCard
        client={data.client}
        tags={tags}
        intake={intake}
        fitzpatrick={fitzpatrick}
        appointmentId={id}
      />

      <LastTreatmentSection
        memory={prepMemory}
        unavailable={prepUnavailable}
        narrative={prepNarrative}
        clientId={data.client?.id ?? null}
      />

      {/* PR #156 (migration 0068). Chart-this-appointment affordance.
          Skipped on cancelled appointments (nothing to chart) but
          shown for confirmed / done / completed / no_show so the
          practitioner can record what happened or look at what they
          already charted. When a linked session exists, the card
          becomes a "View session" link. When no linked session
          exists, it forwards to /clients/[id]/sessions/new with
          ?appointment_id so the action stamps the FK. This is the
          single appointment-context write-forward surface in this PR;
          there is intentionally no appointment picker on the
          client-scoped flow. */}
      {/* PR #181. ChartSessionCard is hidden for completed appointments
          because the NextStepCard (rendered further down) is the
          primary CTA surface for that state and shows the same
          linked-session info in a billing-aware form. Cancelled
          appointments hide ChartSessionCard as before; no_show /
          confirmed still see it. */}
      {!isCancelled && typedStatus !== "completed" && (
        <ChartSessionCard
          appointmentId={id}
          clientId={data.client?.id ?? null}
          linkedSession={linkedSession}
        />
      )}

      <TreatmentPlanCard
        plans={activePlans}
        clientId={data.client?.id ?? null}
      />

      {typedStatus === "confirmed" && (
        <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Outcome
          </h2>
          <p className="text-xs text-neutral-500">
            {displayStatus === "done"
              ? "This appointment's time has passed, so it shows as Done. Its status stays confirmed, so mark no-show if the client did not arrive."
              : "Mark no-show only if the client did not arrive (available after the end time)."}
          </p>
          <AppointmentLifecycleActions
            appointmentId={id}
            status={typedStatus}
            endsAt={data.ends_at}
          />
        </section>
      )}

      {/* Quick checkout (Chloe): take payment for a completed appointment right
          here, without navigating into charting. The modal reuses the existing
          session-payment card + actions; charting is independent. */}
      {typedStatus === "completed" && (
        <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Payment
          </h2>
          <p className="text-xs text-neutral-500">
            Take payment for this appointment. Charting is separate — you can
            finish charting later.
          </p>
          <AppointmentCheckoutCell
            appointmentId={id}
            status={typedStatus}
            paymentState={checkoutPaymentState}
          />
        </section>
      )}

      {/* Postcare email. Manual, practitioner-driven, NOT a completion
          event. The previous version hard-hid this section for
          consultations; per Chloe's clarification (consultations
          sometimes include a short electrolysis test treatment), the
          section now renders for consultations too, gated by an
          explicit "treatment was performed" confirmation on send.
          Status is NOT a gate. Empty postcare aftercare text is
          surfaced as inline guidance, not a silent block. The section
          renders a clear "Postcare unavailable — no client email"
          state instead of vanishing when the client has no EMAIL. (A deleted
          client row is a different case and still renders nothing.) */}
      {data.client && (
        <PostcareSection
          clientEmail={data.client?.email ?? null}
          appointmentId={id}
          studioName={studio.name}
          // Match the priority used by sendPostcareToClient
          // (postcareContactEmail helper): postcare_contact_email
          // overrides owner_email; the template omits the line when
          // both are blank.
          studioEmail={
            (studio.postcare_contact_email?.trim() || studio.owner_email) ??
            null
          }
          studioTimezone={studio.timezone}
          aftercareText={studio.postcare_aftercare_text}
          warningSignsText={studio.postcare_warning_signs_text}
          productRecommendationsText={
            studio.postcare_product_recommendations_text
          }
          reviewUrl={studio.postcare_review_url}
          reviewPromptText={studio.postcare_review_prompt_text}
          clientName={data.client.name}
          serviceName={data.service?.name ?? null}
          serviceModality={data.service?.modality ?? null}
          startsAt={data.starts_at}
          practitionerName={data.practitioner?.display_name ?? null}
          postcareEmailSentAt={data.postcare_email_sent_at}
          postcareEmailSendAttempts={data.postcare_email_send_attempts}
          postcareEmailClaimedAt={data.postcare_email_claimed_at}
          postcareEmailFailedAt={data.postcare_email_failed_at}
          isOwner={isOwner}
        />
      )}

      {typedStatus === "completed" && (
        <NextStepCard
          clientId={data.client?.id ?? null}
          appointmentId={id}
          linkedSession={linkedSession}
        />
      )}

      {typedStatus === "no_show" && (
        <section className="rounded-lg border border-neutral-200 bg-neutral-50 p-5 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          No-show
        </section>
      )}

      {isCancelled ? (
        <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-5 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">Cancelled</span>
            {data.cancelled_by && (
              <span className="text-neutral-600 dark:text-neutral-400">
                by {data.cancelled_by}
              </span>
            )}
            {data.cancelled_at && (
              <span className="text-neutral-600 dark:text-neutral-400">
                · <FormattedDateTime iso={data.cancelled_at} />
              </span>
            )}
            {/* PR #144. "Cancelled quickly" hint: rendered only when
                the cancellation happened within 15 minutes of the
                booking row being created. Shown to the practitioner
                only; never to the client. Computed above from the
                row's own timestamps so no schema change was needed. */}
            {cancelledQuicklyMinutes !== null && (
              <span
                className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                title="Cancelled within 15 minutes of booking"
              >
                {cancelledQuicklyMinutes === 0
                  ? "Cancelled within a minute of booking"
                  : `Cancelled ${cancelledQuicklyMinutes} minute${cancelledQuicklyMinutes === 1 ? "" : "s"} after booking`}
              </span>
            )}
            {/* PR #144. Follow-up permission. Surfaced as a small
                positive badge only when the client opted in.
                Absence is silent (no "no follow-up" badge in the
                main UI). */}
            {cancellationInsight?.follow_up_allowed === true && (
              <span className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                Follow-up okay
              </span>
            )}
          </div>

          {/* PR #144. Reason label snapshot + note. Both are
              optional; we only render the labelled rows when the
              client supplied them. The label snapshot lives in the
              audit row (cancellationInsight.reason_label), and
              appointments.cancellation_reason carries the same
              string for back-compat with older surfaces. Prefer the
              snapshot when present. */}
          {(cancellationInsight?.reason_label ||
            data.cancellation_reason) && (
            <div className="text-neutral-700 dark:text-neutral-300">
              <span className="font-medium">Cancellation reason: </span>
              {cancellationInsight?.reason_label ||
                data.cancellation_reason}
            </div>
          )}
          {cancellationInsight?.note && (
            <div className="text-neutral-700 dark:text-neutral-300">
              <span className="font-medium">Client note: </span>
              {cancellationInsight.note}
            </div>
          )}

          {/* PR #144. Suggested follow-up copy. Shown only when the
              client opted into follow-up. The practitioner can copy
              this into an email manually; we do not auto-send
              anything. */}
          {cancellationInsight?.follow_up_allowed === true && (
            <details className="mt-1 text-neutral-700 dark:text-neutral-300">
              <summary className="cursor-pointer text-xs font-medium uppercase tracking-wider text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300">
                Suggested follow-up message
              </summary>
              <p className="mt-2 whitespace-pre-line text-sm">
                No worries at all about the cancellation. If another
                time would work better or if anything was confusing
                during booking, feel free to let me know.
              </p>
            </details>
          )}
        </section>
      ) : isCancelable ? (
        // Workflow fix 3 (preserved): Cancel surface is shown ONLY when
        // the appointment is `confirmed` AND `starts_at > now()`. For
        // started/past confirmed appointments the lifecycle outcome
        // section above (Mark complete / Mark no-show) is the only
        // legitimate path.
        //
        // Move appointment shares that exact gate (confirmed + future). It is
        // the ONE shared responsive workflow — the same MoveAppointmentButton /
        // dialog / server actions used by the desktop preview drawer. A move
        // UPDATES this same appointment row (same id, same client/service/
        // payment/clinical links); it never cancels + rebooks.
        <>
          <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
            <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Reschedule
            </h2>
            <p className="text-xs text-neutral-500">
              Move this appointment to a new time. Same appointment and details —
              only the time changes, and the client is notified.
            </p>
            <MoveAppointmentButton
              appointment={{
                id,
                startsAt: data.starts_at,
                endsAt: data.ends_at,
                durationMinutes: data.duration_minutes,
                clientName: data.client?.name ?? null,
                serviceName: data.service?.name ?? null,
                practitionerName: data.practitioner?.display_name ?? null,
              }}
              studioTimezone={studio.timezone}
              timeFormat={resolveTimeFormat(studio)}
            />
          </section>
          <PractitionerCancelForm appointmentId={id} />
        </>
      ) : null}

      {/* PR #145. Manual cancellation/no-show fee preview. Rendered
          only when the appointment is cancelled or no_show. Both
          eligibility branches are pre-loaded server-side so the
          card's local type toggle is instant; the prepare action
          re-validates eligibility before any DB write. No Stripe
          call lives in this card. */}
      {showManualFeeCard && manualFeeLateCancel && manualFeeNoShow && (
        <ManualFeeChargeCard
          appointmentId={id}
          lateCancel={manualFeeLateCancel}
          noShow={manualFeeNoShow}
        />
      )}

      {data.notes && (
        <section className="rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Appointment notes
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
            {data.notes}
          </p>
        </section>
      )}

      {/* PR #163 (migration 0069). Practitioner-facing attribution
          row. The "How did you hear about us?" answer the client
          picked at booking time. Hidden when null so a brand-new
          client without an answer does not show an empty box. The
          label resolver lives in lib/booking/referral-source.ts so
          every surface reads the same display string. This is
          intentionally practitioner-only; it is NOT rendered in
          the client confirmation email, the portal, or the public
          booking confirmation page. */}
      {data.referral_source && (
        <section className="rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            How they heard about us
          </h2>
          <p className="mt-2 text-neutral-700 dark:text-neutral-300">
            {referralSourceLabel(data.referral_source) ??
              data.referral_source}
          </p>
        </section>
      )}

      <details className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wider text-neutral-500">
          Email activity
        </summary>
        <div className="mt-3 flex flex-col gap-1.5">
          <EmailRow
            label="Confirmation"
            iso={data.confirmation_sent_at}
            attempts={data.confirmation_send_attempts}
          />
          <EmailRow
            label="24-hour reminder"
            iso={data.reminder_24h_sent_at}
            attempts={data.reminder_24h_send_attempts}
          />
          <EmailRow
            label="2-hour reminder"
            iso={data.reminder_2h_sent_at}
            attempts={data.reminder_2h_send_attempts}
          />
          {data.no_show_email_sent_at && (
            <EmailRow
              label="No-show follow-up"
              iso={data.no_show_email_sent_at}
              attempts={data.no_show_email_send_attempts}
            />
          )}
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status header — pulls the status pill out of the body copy so it's the
// first thing a practitioner reads.
// ---------------------------------------------------------------------------
function StatusHeader({
  serviceName,
  startsAt,
  durationMinutes,
  practitioner,
  displayStatus,
}: {
  serviceName: string;
  startsAt: string;
  durationMinutes: number;
  practitioner: Pick<Practitioner, "id" | "display_name" | "color"> | null;
  displayStatus: AppointmentDisplayStatus;
}) {
  return (
    <header className="flex flex-col gap-2">
      <StatusPill status={displayStatus} />
      <h1 className="text-3xl font-semibold tracking-tight">{serviceName}</h1>
      <p className="text-sm text-neutral-500">
        <FormattedDateTime iso={startsAt} /> · {durationMinutes} min
      </p>
      <PractitionerLine practitioner={practitioner} />
    </header>
  );
}

function StatusPill({ status }: { status: AppointmentDisplayStatus }) {
  const variant: Record<
    AppointmentDisplayStatus,
    { label: string; classes: string }
  > = {
    upcoming: {
      label: "Confirmed",
      classes:
        "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
    },
    // Display-derived: a past confirmed appointment. Distinct from DB
    // "Completed" (neutral) so the two never read as the same thing.
    done: {
      label: "Done",
      classes:
        "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
    },
    completed: {
      label: "Completed",
      classes:
        "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    },
    cancelled: {
      label: "Cancelled",
      classes:
        "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    },
    no_show: {
      label: "No-show",
      classes:
        "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    },
  };
  const v = variant[status];
  return (
    <span
      className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${v.classes}`}
    >
      {v.label}
    </span>
  );
}

function PractitionerLine({
  practitioner,
}: {
  practitioner: Pick<Practitioner, "id" | "display_name" | "color"> | null;
}) {
  const name = practitioner?.display_name?.trim();
  if (!practitioner || !name) {
    return (
      <p className="text-sm text-neutral-400 dark:text-neutral-500">
        Unassigned
      </p>
    );
  }
  const color = resolvePractitionerColor(practitioner.color);
  return (
    <p className="flex items-center gap-2 text-sm">
      <span
        aria-hidden
        className={`inline-block h-2.5 w-2.5 rounded-full ${color.bg}`}
      />
      <span className="font-medium text-neutral-800 dark:text-neutral-200">
        {name}
      </span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Client briefing — name + contact + pronouns + tags + skin + intake status
// in one calm card.
// ---------------------------------------------------------------------------
function ClientBriefingCard({
  client,
  tags,
  intake,
  fitzpatrick,
  appointmentId,
}: {
  client: ClientBriefing | null;
  tags: ClientTag[];
  intake: ClientIntakeForm | null;
  fitzpatrick: string | null;
  appointmentId: string;
}) {
  if (!client) {
    return (
      <section className="rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Client
        </h2>
        <p className="mt-2 text-neutral-500">Client deleted.</p>
      </section>
    );
  }
  const contact = [client.email, client.phone].filter(Boolean).join(" · ");
  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Client
      </h2>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link
          href={`/clients/${client.id}`}
          className="text-base font-medium hover:underline"
        >
          {client.name}
        </Link>
        {client.pronouns && (
          <span className="text-sm text-neutral-500">{client.pronouns}</span>
        )}
      </div>
      {/* Quick navigation row to the parts of the client record the
          practitioner asked to be reachable directly from the
          appointment view ("workable links"). Only links to routes
          that exist today; no invented routes. Treatment plans
          land on the Treatment Plans tab where the inline editor
          lives; there is no standalone /clients/[id]/treatment-plans
          route, so a separate "Create" / "Edit" link is intentionally
          NOT added in this PR (would point to a non-existent route).
          Targets are min-h-[44px] friendly for mobile tap. */}
      <nav
        aria-label="Client navigation"
        className="mt-3 flex flex-wrap gap-2 text-xs"
      >
        <Link
          href={`/clients/${client.id}`}
          className="rounded-md border border-neutral-300 px-2.5 py-1.5 font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          View profile
        </Link>
        <Link
          href={`/clients/${client.id}/edit`}
          className="rounded-md border border-neutral-300 px-2.5 py-1.5 font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Edit client
        </Link>
        <Link
          href={`/clients/${client.id}?tab=health`}
          className="rounded-md border border-neutral-300 px-2.5 py-1.5 font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Health &amp; Forms
        </Link>
        {/* Primary CTA: open the client's Treatment Plans tab AND auto-open the
            existing create form (create_plan=1), with a validated back link to
            THIS appointment. Uses the appointment's own authorized client id;
            nothing is created until the practitioner presses Save. */}
        <Link
          href={`/clients/${client.id}?tab=treatment&create_plan=1&returnTo=${encodeURIComponent(
            `/calendar/${appointmentId}`,
          )}`}
          className="rounded-md border border-neutral-900 bg-neutral-900 px-2.5 py-1.5 font-medium text-white hover:bg-neutral-800 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
        >
          Create treatment plan
        </Link>
        <Link
          href={`/clients/${client.id}?tab=treatment`}
          className="rounded-md border border-neutral-300 px-2.5 py-1.5 font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          View treatment plans
        </Link>
      </nav>
      {contact && (
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {contact}
        </p>
      )}
      {tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              {t.label}
            </span>
          ))}
        </div>
      )}
      {(fitzpatrick || client.skin_notes) && (
        <div className="mt-3 flex flex-col gap-1 text-sm">
          {fitzpatrick && (
            <p className="text-neutral-700 dark:text-neutral-300">
              <span className="text-neutral-500">Fitzpatrick:</span>{" "}
              {fitzpatrick}
            </p>
          )}
          {/* LEGACY label (Chloe Session 1A). This is the retired, in-place
              overwriteable clients.skin_notes column, not the append-only
              skin/hair-analysis clinical record. Labelling it prevents this
              appointment-prep surface from presenting unattributed historical
              profile text as the authoritative current analysis. */}
          {client.skin_notes && (
            <p className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
              <span className="text-neutral-500">Legacy skin notes:</span>{" "}
              {client.skin_notes}
            </p>
          )}
        </div>
      )}
      <IntakeStatusLine intake={intake} clientId={client.id} />
    </section>
  );
}

function IntakeStatusLine({
  intake,
  clientId,
}: {
  intake: ClientIntakeForm | null;
  clientId: string;
}) {
  // Intake color convention (see app/(app)/dashboard/page.tsx):
  //   reviewed → green/calm (good state)
  //   everything else (no form, in progress, awaiting review) → amber,
  //   because each is a "needs attention before this appointment" state
  //   Chloe said was too easy to miss when rendered as quiet grey.
  if (!intake) {
    return (
      <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-400">
        Intake: no form on file.
      </p>
    );
  }
  if (intake.status === "reviewed") {
    return (
      <p className="mt-3 text-xs">
        <span className="text-neutral-500">Intake:</span>{" "}
        <span className="font-medium text-emerald-700 dark:text-emerald-400">
          Reviewed
        </span>{" "}
        ·{" "}
        <Link
          href={`/clients/${clientId}/intake`}
          className="text-neutral-700 hover:underline dark:text-neutral-300"
        >
          View
        </Link>
      </p>
    );
  }
  if (intake.status === "submitted") {
    return (
      <p className="mt-3 text-xs">
        <span className="text-neutral-500">Intake:</span>{" "}
        <span className="font-medium text-amber-700 dark:text-amber-400">
          Awaiting review
        </span>{" "}
        ·{" "}
        <Link
          href={`/clients/${clientId}/intake`}
          className="text-neutral-700 hover:underline dark:text-neutral-300"
        >
          Review
        </Link>
      </p>
    );
  }
  if (intake.status === "in_progress") {
    return (
      <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-400">
        Intake: started, not yet submitted.
      </p>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Appointment preparation memory. PR #190 turned this from a date+modality
// pointer into a compact per-area summary; Session 1D turns it into the COMPLETE
// pre-visit read — every treated area, the complete setup, the outcomes kept
// distinct from that setup, and the whole practitioner narrative at full length.
//
// Appointment preparation uses the same newest-charted-treatment authority as
// the active charting and new-session surfaces. This function is presentation
// only: it chooses between "there is a prior charted treatment" and "there is
// not", and delegates everything else to the shared card.
// ---------------------------------------------------------------------------
function LastTreatmentSection({
  memory,
  unavailable,
  narrative,
  clientId,
}: {
  memory: AppointmentPrepMemory | null;
  unavailable: boolean;
  narrative: AppointmentPrepLoad["narrative"];
  clientId: string | null;
}) {
  // Narrative is rendered here ONLY when no treatment card exists. When a
  // treatment was selected the card already owns the plan (planSource) and the
  // selected visit's session_notes, so rendering it again would print the same
  // practitioner text twice on one screen.
  const hasNarrative =
    narrative.plan != null || narrative.legacySessionNotes != null;
  // Null covers three genuinely different situations, and all three are
  // truthfully described by the same sentence: a first-visit client, a client
  // whose only other sessions carry no charting at all, and a failed read (the
  // loader fails soft — a memory panel must never take the appointment page
  // down). It is deliberately NOT an empty card with headings over nothing.
  // A FAILED read is not the same clinical statement as "no history". Saying
  // "no previous treatment" because a query timed out would have the
  // practitioner prep a forty-visit client as a first visit.
  if (unavailable && !memory) {
    // A FAILED read is not the same clinical statement as "no history". Any
    // narrative that WAS loaded is still shown: the candidate rows succeeded, so
    // discarding a safety instruction we already hold would compound the
    // failure rather than report it.
    return (
      <section
        data-testid="appointment-prep-unavailable"
        className="flex flex-col gap-3 rounded-lg border border-dashed border-amber-300 p-5 text-sm text-amber-900 dark:border-amber-800 dark:text-amber-200"
      >
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
            Last treatment
          </h2>
          <p className="mt-2">
            Previous treatment could not be loaded. Open the client&rsquo;s
            chart to review it before treating.
          </p>
        </div>
        <PriorNarrative narrative={narrative} />
      </section>
    );
  }
  if (!memory || !clientId) {
    // No charted treatment. That statement stays — a note-only visit is NOT a
    // treatment and must never be promoted to one — but the practitioner
    // narrative attached to those visits is still shown, because "nothing was
    // charted" and "there is nothing to know" are different things.
    return (
      <section
        data-testid="appointment-prep-empty"
        className="flex flex-col gap-3 rounded-lg border border-dashed border-neutral-300 p-5 text-sm text-neutral-500 dark:border-neutral-700"
      >
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Last treatment
          </h2>
          <p className="mt-2">No previous treatment charted for this client.</p>
        </div>
        {hasNarrative && <PriorNarrative narrative={narrative} />}
      </section>
    );
  }
  return <AppointmentPrepMemoryCard clientId={clientId} memory={memory} />;
}

// Practitioner narrative from prior visits that produced no charted treatment
// (or whose treatment detail could not be loaded). READ-ONLY, and deliberately
// never labelled as a treatment: it reuses the same section vocabulary the
// treatment card uses — "For next visit", "Legacy session notes" — so the two
// surfaces read identically without either claiming the other's meaning.
//
// Full text, whole: whitespace-pre-wrap keeps the practitioner's line breaks
// and break-words keeps a long unbroken run from scrolling the page sideways.
function PriorNarrative({
  narrative,
}: {
  narrative: AppointmentPrepLoad["narrative"];
}) {
  if (!narrative.plan && !narrative.legacySessionNotes) return null;
  return (
    <div data-testid="prep-prior-narrative" className="flex flex-col gap-3">
      {narrative.plan && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/40">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-800 dark:text-blue-300">
            For next visit
          </p>
          <p
            data-testid="prep-prior-plan"
            className="mt-0.5 whitespace-pre-wrap break-words text-sm text-blue-950 dark:text-blue-100"
          >
            {narrative.plan.text}
          </p>
          <p className="mt-1 text-xs text-blue-800 dark:text-blue-300">
            Written <FormattedDateTime iso={narrative.plan.startedAt} format="date" />
          </p>
        </div>
      )}
      {narrative.legacySessionNotes && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            Legacy session notes
          </p>
          <p
            data-testid="prep-prior-legacy-notes"
            className="mt-0.5 whitespace-pre-wrap break-words text-sm text-neutral-700 dark:text-neutral-300"
          >
            {narrative.legacySessionNotes.text}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #156 (migration 0068). Chart-this-appointment affordance. Two states:
//   * a session is already linked to this appointment id  → View session
//   * no linked session                                    → + Chart session
// Both states route to existing pages: the View link points at the
// session detail page where the practitioner edits entries / notes /
// blocks; the Chart link points at the new-session page with
// ?appointment_id, which the action validates against (studio_id,
// client_id) before stamping the FK. The card stays hidden on a
// cancelled appointment (LastSessionCard above already conveys what
// the practitioner needs in that case). No appointment status
// mutation happens here.
// ---------------------------------------------------------------------------
function ChartSessionCard({
  appointmentId,
  clientId,
  linkedSession,
}: {
  appointmentId: string;
  clientId: string | null;
  linkedSession: Pick<Session, "id" | "started_at" | "modality"> | null;
}) {
  if (!clientId) {
    return null;
  }
  if (linkedSession) {
    return (
      <section className="rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Session for this appointment
        </h2>
        <p className="mt-2">
          <Link
            href={`/clients/${clientId}/sessions/${linkedSession.id}`}
            className="font-medium hover:underline"
          >
            <FormattedDateTime iso={linkedSession.started_at} />
          </Link>
          <span className="text-neutral-500"> · {linkedSession.modality}</span>
        </p>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-dashed border-neutral-300 p-5 text-sm dark:border-neutral-700">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Session for this appointment
      </h2>
      <p className="text-neutral-500">
        Not charted yet. Logging from here links the session to this
        appointment.
      </p>
      <Link
        href={`/clients/${clientId}/sessions/new?appointment_id=${encodeURIComponent(appointmentId)}`}
        className="self-start rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 dark:border-white dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        + Chart session
      </Link>
    </section>
  );
}

// ---------------------------------------------------------------------------
// PR #181. NextStepCard. Replaces the bare "Completed" placeholder
// section that previously rendered for typedStatus === 'completed'.
// The card makes the next practitioner action obvious so the
// appointment-to-billing handoff Chloe found weak after PR #180
// becomes a guided one-click path.
//
// Three sub-states, each with a single primary CTA:
//   1. No linked session exists yet           -> "Start session"
//        forwards to /clients/<id>/sessions/new?appointment_id=<id>
//        which is the same destination ChartSessionCard used; the
//        session-start action stamps the appointment_id FK and (per
//        PR #180) auto-marks the appointment completed. Because the
//       appointment is ALREADY completed here, the auto-mark is a
//       no-op; the link path stays unchanged so a future regression
//       is structurally caught.
//   2. Linked session exists, not started      -> "Open session"
//        (this case is rare today because sessions.started_at NOT
//       NULL DEFAULT now() means every inserted row has it; the
//       branch exists for defensive structural reasons.)
//   3. Linked session exists, started_at set   -> "Go to billing"
//       deep-links to the session page with #session-payment so
//       the practitioner lands on the payment card.
//
// No payment-eligibility logic lives here. The session page's
// SessionPaymentPrepareCard remains the single owner of "is billing
// ready", "card on file", "card authorization", and all per-status
// rendering. NextStepCard's only job is to make the next click
// obvious from the calendar surface.
// ---------------------------------------------------------------------------
function NextStepCard({
  clientId,
  appointmentId,
  linkedSession,
}: {
  clientId: string | null;
  appointmentId: string;
  linkedSession: Pick<Session, "id" | "started_at" | "modality"> | null;
}) {
  if (!clientId) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-neutral-50 p-5 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Appointment completed
        </p>
      </section>
    );
  }

  const sessionStarted = linkedSession?.started_at != null;
  const sessionId = linkedSession?.id ?? null;

  let ctaHref: string;
  let ctaLabel: string;
  if (!linkedSession) {
    ctaHref = `/clients/${clientId}/sessions/new?appointment_id=${encodeURIComponent(appointmentId)}`;
    ctaLabel = "Start session";
  } else if (!sessionStarted) {
    ctaHref = `/clients/${clientId}/sessions/${sessionId}`;
    ctaLabel = "Open session";
  } else {
    ctaHref = `/clients/${clientId}/sessions/${sessionId}#session-payment`;
    ctaLabel = "Go to billing";
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-5 text-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Appointment completed
        </p>
        <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
          Next step: chart the session and bill the client.
        </p>
      </div>
      <Link
        href={ctaHref}
        className="self-start rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {ctaLabel}
      </Link>
      {linkedSession && (
        <p className="text-xs text-neutral-500">
          Linked session: {linkedSession.modality}
          {linkedSession.started_at && (
            <>
              {" · started "}
              <FormattedDateTime iso={linkedSession.started_at} />
            </>
          )}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Treatment plan — active plans only on the briefing surface. Closed plans
// stay on the client profile.
// ---------------------------------------------------------------------------
function TreatmentPlanCard({
  plans,
  clientId,
}: {
  plans: ReadonlyArray<TreatmentPlan & { attached_count: number }>;
  // When set, plan names link to the Treatment Plans tab where the
  // inline editor lives. There is no standalone per-plan edit route
  // today; linking to the tab is the closest existing target.
  clientId: string | null;
}) {
  if (plans.length === 0) {
    return (
      <section className="rounded-lg border border-dashed border-neutral-300 p-5 text-sm text-neutral-500 dark:border-neutral-700">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Treatment plan
        </h2>
        <p className="mt-2">No active treatment plan yet.</p>
        {clientId && (
          <p className="mt-2 text-xs">
            <Link
              href={`/clients/${clientId}?tab=treatment`}
              className="text-neutral-700 hover:underline dark:text-neutral-300"
            >
              Open Treatment Plans →
            </Link>
          </p>
        )}
      </section>
    );
  }
  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Treatment plan
      </h2>
      <ul className="mt-2 flex flex-col gap-2 text-sm">
        {plans.map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-baseline justify-between gap-3"
          >
            {clientId ? (
              <Link
                href={`/clients/${clientId}?tab=treatment`}
                className="font-medium hover:underline"
              >
                {p.name}
              </Link>
            ) : (
              <span className="font-medium">{p.name}</span>
            )}
            <span className="text-xs text-neutral-500">
              {p.attached_count}{" "}
              {p.attached_count === 1 ? "session" : "sessions"}
              {p.suggested_visit_count > 0 && ` of ~${p.suggested_visit_count}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Three-state row:
//   * sent_at set         → "Sent <time>"
//   * sent_at null, attempts > 0 → "Failed after N attempt(s)"
//   * sent_at null, attempts = 0 → "Not sent"
// Pure read-only from the appointment row. Attempt counts come from the
// existing reminder_*_send_attempts / confirmation_send_attempts /
// no_show_email_send_attempts columns the row already loaded. No retry
// implied — this is just an honest status display.
function EmailRow({
  label,
  iso,
  attempts,
}: {
  label: string;
  iso: string | null;
  attempts: number;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
      <span className="text-neutral-500">{label}</span>
      {iso ? (
        <span className="text-neutral-700 dark:text-neutral-300">
          Sent <FormattedDateTime iso={iso} />
        </span>
      ) : attempts > 0 ? (
        <span className="text-amber-700 dark:text-amber-400">
          Failed after {attempts} attempt{attempts === 1 ? "" : "s"}
        </span>
      ) : (
        <span className="text-neutral-400">Not sent</span>
      )}
    </div>
  );
}


// Postcare section (manual practitioner-triggered email).
//
// Server-renders the preview text once via buildPostcareEmail and
// passes it to the client-side PostcareSendButton, so the modal
// opens instantly with the exact text the client will receive. No
// new fetch at button-click time; no auto-send; no completion-event
// coupling.
//
// Consultation branch: when the appointment's service modality is
// "consultation", the section adds explanatory copy ("consultations
// sometimes include a short electrolysis test treatment") AND wires
// the send modal to require an explicit "I performed electrolysis /
// test treatment" checkbox. The server action verifies the same flag
// independently; the checkbox is UX, not the security boundary.
//
// Missing-setup branch: when postcare_aftercare_text is empty, the
// section renders a "Postcare email is not configured yet" notice
// and a Configure postcare CTA (owner-only). Non-owners see "Ask the
// studio owner to configure postcare instructions." instead. The
// send button is not rendered in this state; the action would
// reject anyway, and the missing-setup case is what the practitioner
// actually needs to act on.
