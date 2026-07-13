import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  attachStructuredAreas,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import { getPinnedNotesForClient } from "@/lib/client-pinned-notes/queries";
import { getClientTags } from "@/lib/client-tags/queries";
import { getLatestIntakeForClient } from "@/lib/intake/queries";
import { getTreatmentPlansForClient } from "@/lib/treatment-plans/queries";
import { FITZPATRICK_TYPES } from "@/lib/constants";
import { referralSourceLabel } from "@/lib/booking/referral-source";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  buildLastSessionSummary,
  type ClinicalSummaryBlock,
  type LastSessionSummary,
} from "@/lib/sessions/clinical-summary";
import {
  AreaSummaries,
  FromLastVisitForToday,
} from "@/components/last-session-summary";
import { PinnedNotesReadonly } from "@/components/pinned-notes-readonly";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import { AppointmentLifecycleActions } from "../AppointmentLifecycleActions";
import { AppointmentCheckoutCell } from "@/components/appointment-checkout-cell";
import { getAppointmentPaymentStates } from "@/lib/billing/appointment-payment-state";
import { calendarReturnHref } from "../calendar-return";
import { PractitionerCancelForm } from "../PractitionerCancelForm";
import { PostcareSendButton } from "../PostcareSendButton";
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
  let lastSession: Pick<
    Session,
    "id" | "started_at" | "modality" | "session_notes" | "next_session_note"
  > | null = null;
  // PR #190 (clinical memory): compact clinical summary of the last
  // session's blocks (areas, settings, tolerance, reaction, caution),
  // built by the shared lib/sessions/clinical-summary helper.
  let lastSessionSummary: LastSessionSummary | null = null;
  // PR #156 (migration 0068). The session, if any, that was logged
  // explicitly against THIS appointment via the new appointment_id
  // FK. Distinct from `lastSession` above, which is the most recent
  // session for the client (used as a "what happened last time" hint
  // for context). The linked session is the per-visit treatment
  // record for this appointment; when present, the appointment is
  // already charted and the Chart session affordance becomes a View
  // session link instead.
  let linkedSession: Pick<Session, "id" | "started_at" | "modality"> | null =
    null;

  if (data.client) {
    const clientId = data.client.id;
    const [
      pinnedRes,
      tagsRes,
      intakeRes,
      plansRes,
      lastSessionRes,
      linkedSessionRes,
    ] = await Promise.all([
      getPinnedNotesForClient(studio.id, clientId),
      getClientTags(studio.id, clientId),
      getLatestIntakeForClient(studio.id, clientId),
      getTreatmentPlansForClient(studio.id, clientId),
      // Most recent non-deleted session that began before this
      // appointment. Used as a one-line "what happened last time"
      // hint above the per-visit chart. Narrow column set; no
      // entries, no audit, no notes leakage beyond the existing
      // owner-only view.
      supabase
        .from("sessions")
        .select("id, started_at, modality, session_notes, next_session_note")
        .eq("studio_id", studio.id)
        .eq("client_id", clientId)
        .is("deleted_at", null)
        .lt("started_at", data.starts_at)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
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
    if (lastSessionRes.error) {
      throw new Error(
        `Failed to load last session: ${lastSessionRes.error.message}`,
      );
    }
    lastSession = (lastSessionRes.data ?? null) as
      | Pick<
          Session,
          "id" | "started_at" | "modality" | "session_notes" | "next_session_note"
        >
      | null;
    if (linkedSessionRes.error) {
      throw new Error(
        `Failed to load linked session: ${linkedSessionRes.error.message}`,
      );
    }
    linkedSession = (linkedSessionRes.data ?? null) as
      | Pick<Session, "id" | "started_at" | "modality">
      | null;

    // PR #190 (clinical memory): the last session's blocks feed the
    // compact clinical summary on the card below. One extra narrow
    // read, only when a previous session exists. A block-less session
    // (e.g. laser) yields a summary of nulls, which renders as the
    // pre-#190 card plus the next-session note when present.
    if (lastSession) {
      const { data: lastBlocks } = await supabase
        .from("session_blocks")
        .select(
          "id, sort_order, block_name, primary_area, side, custom_area_detail, mode, apilus_modality, energy_level, minutes_performed, probe_label, tolerance_rating, reaction_type, reaction_notes, caution_for_next_session, caution_note",
        )
        .eq("studio_id", studio.id)
        .eq("session_id", lastSession.id)
        .is("deleted_at", null)
        .order("sort_order", { ascending: true });
      // Migration 0128: attach structured areas so the appointment-card summary
      // shows every treated area + laterality, not only the legacy primary_area.
      const lastBlockRows = (lastBlocks ?? []) as Array<
        ClinicalSummaryBlock & { id: string }
      >;
      await attachStructuredAreas(lastBlockRows, studio.id);
      lastSessionSummary = buildLastSessionSummary({
        blocks: lastBlockRows,
        nextSessionNote: lastSession.next_session_note,
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
      />

      <LastSessionCard
        session={lastSession}
        summary={lastSessionSummary}
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
          is hidden entirely only when the client has no email on
          file. */}
      {data.client?.email && (
        <PostcareSection
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
        <PractitionerCancelForm appointmentId={id} />
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
}: {
  client: ClientBriefing | null;
  tags: ClientTag[];
  intake: ClientIntakeForm | null;
  fitzpatrick: string | null;
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
        <Link
          href={`/clients/${client.id}?tab=treatment`}
          className="rounded-md border border-neutral-300 px-2.5 py-1.5 font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Treatment plans
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
          {client.skin_notes && (
            <p className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
              <span className="text-neutral-500">Skin notes:</span>{" "}
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
// Last session memory at the point of care. PR #190 upgraded this
// from a date+modality pointer to a compact clinical summary: areas,
// settings, probe, tolerance, reaction, caution, and the note the
// practitioner left for this visit. Lines render only when recorded
// (lib/sessions/clinical-summary nulls absent data), so pre-#190
// sessions show the same calm card as before. Session id + client id
// link to the session detail route.
// ---------------------------------------------------------------------------
function LastSessionCard({
  session,
  summary,
  clientId,
}: {
  session: Pick<
    Session,
    "id" | "started_at" | "modality" | "session_notes" | "next_session_note"
  > | null;
  summary: LastSessionSummary | null;
  clientId: string | null;
}) {
  if (!session) {
    return (
      <section className="rounded-lg border border-dashed border-neutral-300 p-5 text-sm text-neutral-500 dark:border-neutral-700">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Last session
        </h2>
        <p className="mt-2">No previous session logged for this client.</p>
      </section>
    );
  }
  const sessionLine = (
    <>
      <span className="font-medium">
        <FormattedDateTime iso={session.started_at} />
      </span>
      <span className="text-neutral-500 capitalize"> · {session.modality}</span>
    </>
  );
  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Last session
      </h2>
      <p className="mt-2 text-sm">
        {clientId ? (
          <Link
            href={`/clients/${clientId}/sessions/${session.id}`}
            className="hover:underline"
          >
            {sessionLine}
          </Link>
        ) : (
          sessionLine
        )}
      </p>
      {/* PR #191: one compact mini-summary PER treatment area, plus
          ONE combined From last visit box (watch + plan). Never a
          first-area-only line, never two competing warning boxes. */}
      {summary && summary.areas.length > 0 && (
        <div className="mt-3">
          <AreaSummaries summary={summary} />
        </div>
      )}
      {summary && (
        <div className="mt-3">
          <FromLastVisitForToday summary={summary} />
        </div>
      )}
      {session.session_notes && (
        <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300">
          {session.session_notes}
        </p>
      )}
      {clientId && (
        <p className="mt-3 text-xs">
          <Link
            href={`/clients/${clientId}/sessions/${session.id}`}
            className="text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            View full session
          </Link>
        </p>
      )}
    </section>
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
function PostcareSection(props: {
  appointmentId: string;
  studioName: string;
  studioEmail: string | null;
  studioTimezone: string;
  aftercareText: string | null;
  warningSignsText: string | null;
  productRecommendationsText: string | null;
  reviewUrl: string | null;
  reviewPromptText: string | null;
  clientName: string;
  serviceName: string | null;
  serviceModality: string | null;
  startsAt: string;
  practitionerName: string | null;
  postcareEmailSentAt: string | null;
  postcareEmailSendAttempts: number;
  // PR #311: postcare send-state correctness.
  postcareEmailClaimedAt: string | null;
  postcareEmailFailedAt: string | null;
  isOwner: boolean;
}) {
  const preview = buildPostcareEmail({
    clientName: props.clientName,
    studioName: props.studioName,
    studioEmail: props.studioEmail,
    practitionerName: props.practitionerName,
    serviceName: props.serviceName,
    startsAt: props.startsAt ? new Date(props.startsAt) : null,
    timezone: props.studioTimezone,
    aftercareText: props.aftercareText,
    warningSignsText: props.warningSignsText,
    productRecommendationsText: props.productRecommendationsText,
    reviewUrl: props.reviewUrl,
    reviewPromptText: props.reviewPromptText,
  });

  const aftercareConfigured =
    !!props.aftercareText && props.aftercareText.trim().length > 0;
  const isConsultation = props.serviceModality === "consultation";

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Postcare email
      </h2>
      {isConsultation && (
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          Consultations sometimes include a short electrolysis test
          treatment. Send postcare only if treatment was performed.
        </p>
      )}
      {aftercareConfigured ? (
        <>
          <p className="text-xs text-neutral-500">
            {isConsultation
              ? "Preview the email before sending. You'll confirm that treatment was performed in the next step."
              : "Send the client your studio's aftercare information. Preview the email before sending."}
          </p>
          <PostcareSendButton
            appointmentId={props.appointmentId}
            alreadySentAt={props.postcareEmailSentAt}
            failedAt={props.postcareEmailFailedAt}
            // PR #311: "sending" = a fresh claim with no outcome yet (server-
            // computed so the client render carries no Date.now → no hydration
            // mismatch). A stale claim (>5 min, sender died) is not "sending".
            sending={
              !!(
                props.postcareEmailClaimedAt &&
                !props.postcareEmailSentAt &&
                !props.postcareEmailFailedAt &&
                Date.now() - new Date(props.postcareEmailClaimedAt).getTime() <
                  5 * 60_000
              )
            }
            sendAttempts={props.postcareEmailSendAttempts}
            previewText={preview.preview}
            requiresConsultationConfirmation={isConsultation}
          />
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            Postcare email is not configured yet.
          </p>
          {props.isOwner ? (
            <a
              href="/settings/intake#postcare"
              className="self-start rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Configure postcare
            </a>
          ) : (
            <p className="text-xs text-neutral-500">
              Ask the studio owner to configure postcare instructions.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
