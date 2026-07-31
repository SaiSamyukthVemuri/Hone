import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { AppointmentCheckoutCell } from "@/components/appointment-checkout-cell";
import {
  getAppointmentPaymentStates,
  type AppointmentPaymentState,
} from "@/lib/billing/appointment-payment-state";
import {
  getCurrentPractitionerWithStudio,
  getPractitionersForStudio,
} from "@/lib/supabase/queries";
import {
  getActiveServices,
  getAvailabilityDefaults,
} from "@/lib/booking/queries";
import { computeBookingReadiness } from "@/lib/booking/readiness";
import { BookingSetupCard } from "./BookingSetupCard";
import { getLatestPinnedNoteByClient } from "@/lib/client-pinned-notes/queries";
import { getClientBirthdaysForMonth } from "@/lib/clients/birthday-queries";
import { resolveBirthdayColor } from "@/lib/birthday-colors";
import type { BirthdayReminderColor } from "@/lib/types/database";
import {
  addDays,
  formatTimeForStudio,
  localTimeString12h,
  resolveTimeFormat,
  todayInTz,
  utcInstantFromLocal,
  type TimeFormat,
} from "@/lib/booking/tz";
import { FormattedToday } from "@/components/formatted-date-time";
import { PracticeSnapshot } from "./practice-snapshot";
import {
  getPracticeDashboardMetrics,
  isDashboardPeriod,
  type DashboardPeriod,
} from "@/lib/dashboard/practice-metrics";
import {
  resolveNextAction,
} from "@/lib/dashboard/next-action";
import {
  getBeforeTodayPreviews,
  type BeforeTodayPreview,
} from "@/lib/dashboard/before-today-previews";
import { getClientsNeedingAttention } from "@/lib/dashboard/clients-needing-attention";
import {
  buildTodayWorkflow,
  todayWorkflowByAppointment,
  type TodayCharting,
  type TodayIntake,
  type TodayWorkflowInput,
  type TodayWorkflowItem,
} from "@/lib/dashboard/today-workflow";
import { PilotFeedbackPrompt } from "./pilot-feedback-prompt";
import { getMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";
import { getExpiringSterileItems } from "@/lib/record-keeping/queries";
import { FollowUpAssistantCard } from "./follow-up-assistant";
import { SuppliesExpiringCard } from "./supplies-expiring";
import { PilotLearningCard } from "./pilot-learning";
import {
  buildGettingStarted,
  getGettingStartedSignals,
} from "@/lib/onboarding/getting-started";
import { buildOnboardingModel } from "@/lib/onboarding/steps";
import { getOnboardingSignals } from "@/lib/onboarding/signals";
import { getOnboardingRow, toPersisted } from "@/lib/onboarding/state";
import { OnboardingSurface } from "./onboarding/OnboardingSurface";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import type {
  Appointment,
  AppointmentStatus,
  Client,
  ClientIntakeForm,
  Service,
} from "@/lib/types/database";
import { DashboardGreeting } from "./DashboardGreeting";
import { getRequiredAppOrigin } from "@/lib/app-origin";

// ---------------------------------------------------------------------------
// Color convention (Chloe P0 feedback). Kept here as the canonical note
// because the dashboard is where the hierarchy is most visible; the
// appointment briefing and client profile follow the same rules.
//
//   Allergies / cautions ........ RED   (rose-*)   — never amber
//   Pinned notes ................. AMBER (amber-*)  — distinct from allergies
//   Intake incomplete / awaiting . AMBER (amber-*)  — easy-to-miss → visible
//   Intake reviewed / complete ... GREEN (emerald-*) / neutral — calm/good
//   Needs attention (urgent) ..... AMBER accent (amber-* left border + tint)
//   Needs attention (soft/info) .. NEUTRAL (no Phase-1-blocking urgency)
//   Birthdays .................... WARM  (rose-* tint)
//   Empty / good states .......... GREEN / NEUTRAL
//
// This is a local convention, not a design-system refactor.
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

type TodayAppointment = Pick<
  Appointment,
  | "id"
  | "starts_at"
  | "ends_at"
  | "duration_minutes"
  | "status"
  | "client_id"
> & {
  client: Pick<Client, "id" | "name" | "allergies" | "pronouns"> | null;
  service: Pick<Service, "id" | "name" | "modality"> | null;
  practitioner: { id: string; display_name: string | null; color: string } | null;
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const sp = await searchParams;
  // PR #208: practice-snapshot period filter. Default: this week.
  const period: DashboardPeriod = isDashboardPeriod(sp.period)
    ? sp.period
    : "week";
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const isOwner = practitioner.role === "owner";
  const supabase = await createClient();

  // Studio-local "today" range, converted to UTC for the appointments
  // query. The calendar week view uses the same pattern; we just window
  // it to a single local day here.
  const todayLocal = todayInTz(studio.timezone);
  const tomorrowLocal = addDays(todayLocal, 1);
  const startUtc = utcInstantFromLocal(todayLocal, "00:00", studio.timezone);
  const endUtc = utcInstantFromLocal(tomorrowLocal, "00:00", studio.timezone);

  // Today's appointments. Use a narrow inline SELECT so the dashboard
  // gets practitioner color + service modality + client allergies in
  // one trip without N+1 lookups.
  const { data: apptRows, error: apptErr } = await supabase
    .from("appointments")
    .select(
      "id, starts_at, ends_at, duration_minutes, status, client_id, client:clients(id, name, allergies, pronouns), service:services(id, name, modality), practitioner:practitioners(id, display_name, color)",
    )
    .eq("studio_id", studio.id)
    .gte("starts_at", startUtc.toISOString())
    .lt("starts_at", endUtc.toISOString())
    .order("starts_at", { ascending: true });
  if (apptErr) {
    throw new Error(`Failed to load today's appointments: ${apptErr.message}`);
  }

  // Supabase types joined relations as either a single row or an array.
  // Normalize so the renderer can do `a.practitioner?.color` without
  // branching, same idiom as getAppointmentsForRange.
  type RawAppt = {
    id: string;
    starts_at: string;
    ends_at: string;
    duration_minutes: number;
    status: AppointmentStatus;
    client_id: string;
    client:
      | Pick<Client, "id" | "name" | "allergies" | "pronouns">
      | Pick<Client, "id" | "name" | "allergies" | "pronouns">[]
      | null;
    service:
      | Pick<Service, "id" | "name" | "modality">
      | Pick<Service, "id" | "name" | "modality">[]
      | null;
    practitioner:
      | { id: string; display_name: string | null; color: string }
      | { id: string; display_name: string | null; color: string }[]
      | null;
  };
  const todayAppointments: TodayAppointment[] = (
    (apptRows ?? []) as RawAppt[]
  ).map((r) => ({
    id: r.id,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    duration_minutes: r.duration_minutes,
    status: r.status,
    client_id: r.client_id,
    client: Array.isArray(r.client) ? r.client[0] ?? null : r.client,
    service: Array.isArray(r.service) ? r.service[0] ?? null : r.service,
    practitioner: Array.isArray(r.practitioner)
      ? r.practitioner[0] ?? null
      : r.practitioner,
  }));

  // The visible roster excludes cancelled appointments — they shouldn't
  // crowd a "what's today" briefing. Cancellation records remain on the
  // calendar week view, where context is appropriate.
  const visibleAppointments = todayAppointments.filter(
    (a) => a.status !== "cancelled",
  );

  const todayClientIds = Array.from(
    new Set(visibleAppointments.map((a) => a.client_id)),
  );

  // Bulk lookups for the visible client set. Each query is read-only,
  // RLS-scoped, and bounded by today's client list.
  const [practitioners, pinnedByClient, intakeByClient] = await Promise.all([
    getPractitionersForStudio(studio.id),
    getLatestPinnedNoteByClient(studio.id, todayClientIds),
    loadIntakeStatusByClient(supabase, studio.id, todayClientIds),
  ]);
  void practitioners; // currently unused on the appointments roster;
  // kept fetched in parallel because future per-practitioner annotations
  // may surface here without paying an extra round-trip.

  // "Needs attention" sources. Each is independently safe to fail; if a
  // single signal can't be fetched we render the rest. All checks here
  // are bounded SELECTs on tables we already have RLS on.
  const [
    intakesAwaitingReviewCount,
    activeServicesCount,
    paymentStatus,
    birthdaysThisMonth,
    availabilityDefaults,
  ] = await Promise.all([
    countIntakesAwaitingReview(supabase, studio.id),
    countActiveServices(studio.id),
    isOwner ? loadPaymentStatus(supabase, studio.id) : Promise.resolve(null),
    // Birthday reminders — month-of-year only, derived from
    // clients.date_of_birth. Practitioner-facing only. Never sent as
    // email/SMS or exposed to client/public surfaces.
    getClientBirthdaysForMonth(studio.id, parseInt(todayLocal.slice(5, 7), 10)),
    // Booking setup readiness (owner-only card). Loaded for everyone since
    // the studio_availability_default table is RLS-scoped to the studio
    // and the read is cheap (≤7 rows). The readiness compute + render is
    // gated on isOwner below.
    isOwner
      ? getAvailabilityDefaults(studio.id)
      : Promise.resolve(
          [] as Awaited<ReturnType<typeof getAvailabilityDefaults>>,
        ),
  ]);

  // Booking readiness for the owner card. Derived only; no schema flag.
  // The card itself is owner-only (rendered below). Public booking is
  // soft-gated independently in app/book/[slug]/page.tsx.
  const openAvailabilityDaysCount = isOwner
    ? availabilityDefaults.filter(
        (d) =>
          d.is_open === true &&
          typeof d.open_time === "string" &&
          typeof d.close_time === "string",
      ).length
    : 0;
  const bookingReadiness = isOwner
    ? computeBookingReadiness({
        studio,
        activeServicesCount,
        openAvailabilityDaysCount,
        appOrigin: getRequiredAppOrigin(),
      })
    : null;

  // PR #208: read-only practice metrics for the selected period.
  const practiceMetrics = await getPracticeDashboardMetrics(
    studio.id,
    studio.timezone,
    period,
  );

  // PR #212: compact Before-today previews for the Today roster.
  // THREE batched reads for all of today's clients (never per-row);
  // exactly the PR #211 briefing pipeline, compacted.
  // PR #236: linked-session facts for the Today next actions. Two
  // batched reads (same shape as the charted-24h loader); no N+1.
  const apptIds = todayAppointments.map((a) => a.id);
  const sessionByAppointment = new Map<
    string,
    { sessionId: string; hasChartedArea: boolean }
  >();
  if (apptIds.length > 0) {
    const { data: linkedSessions } = await supabase
      .from("sessions")
      .select("id, appointment_id")
      .eq("studio_id", studio.id)
      .in("appointment_id", apptIds)
      .is("deleted_at", null);
    const sessions = (linkedSessions ?? []) as Array<{
      id: string;
      appointment_id: string;
    }>;
    if (sessions.length > 0) {
      const { data: blockRows } = await supabase
        .from("session_blocks")
        .select("session_id")
        .eq("studio_id", studio.id)
        .in("session_id", sessions.map((s) => s.id))
        .is("deleted_at", null);
      const sessionsWithAreas = new Set(
        ((blockRows ?? []) as Array<{ session_id: string }>).map(
          (b) => b.session_id,
        ),
      );
      for (const s of sessions) {
        sessionByAppointment.set(s.appointment_id, {
          sessionId: s.id,
          hasChartedArea: sessionsWithAreas.has(s.id),
        });
      }
    }
  }

  // Quick checkout (Chloe): one bounded, tenant-scoped batch loader for the
  // visible appointments' payment state — no per-row query, no full history.
  const paymentStates = await getAppointmentPaymentStates(studio.id, apptIds);

  const beforeTodayPreviews = await getBeforeTodayPreviews(
    studio.id,
    visibleAppointments.map((a) => a.client_id),
  );

  // ONE combined Today workflow (Chloe: "Today and the Daily Prep Brief are
  // redundant"). A pure helper turns facts already loaded above — visible
  // appointments, the Before Today previews, the linked-session charting state,
  // intake status — into exactly one card per appointment, keyed by APPOINTMENT
  // id and in the query's chronological order. No new query; nothing sorted.
  const todayWorkflowInputs: TodayWorkflowInput[] = visibleAppointments.map(
    (appt) => {
      const preview = beforeTodayPreviews.get(appt.client_id) ?? null;
      const linked = sessionByAppointment.get(appt.id) ?? null;
      const charting: TodayCharting = linked
        ? linked.hasChartedArea
          ? "charted"
          : "started"
        : appt.status === "completed"
          ? "needs"
          : "none";
      const intakeStatus = intakeByClient.get(appt.client_id) ?? null;
      const intake: TodayIntake = intakeStatus ?? "none";
      return {
        appointmentId: appt.id,
        clientId: appt.client_id,
        clientName: appt.client?.name ?? "Client",
        timeLabel: localTimeString12h(new Date(appt.starts_at), studio.timezone),
        status: appt.status,
        serviceName: appt.service?.name ?? null,
        hasHistory: preview?.hasHistory ?? false,
        nextVisitNote: preview?.nextVisitNote ?? null,
        cautionNote: preview?.cautionNote ?? null,
        setupLine: preview?.setupLine ?? null,
        reminders: preview?.reminders ?? [],
        intake,
        charting,
      };
    },
  );
  const todayWorkflow = buildTodayWorkflow(todayWorkflowInputs);
  const workflowByAppointment = todayWorkflowByAppointment(todayWorkflow);

  // PR #214: recorded-history attention list (two batched reads over
  // the 200 most recent sessions; unique clients counted once).
  const clientsNeedingAttention = await getClientsNeedingAttention(studio.id);

  // PR #249: Missing Records / Follow-up Assistant V1. Rules-based only
  // (no AI, no model, no provider, no action): bounded, studio-scoped,
  // RLS-backed reads over recent sessions and completed appointments turn
  // recorded workflow gaps (charting, aftercare, probe lot, intake,
  // for-next-visit follow-ups) into a deterministic, link-only list. The
  // window is computed once here so the helper stays clock-free.
  const followUpAssistant = await getMissingRecordsAssistant(
    studio.id,
    new Date().toISOString(),
  );

  // PR #316: sterile items / probe lots expired or expiring within 30 days,
  // studio-scoped, for the on-dashboard "Supplies expiring" attention card.
  const expiringSupplies = await getExpiringSterileItems(studio.id, todayLocal);

  // PR #215: Getting Started progress for the dashboard card.
  const gettingStarted = buildGettingStarted(
    await getGettingStartedSignals(
      { id: studio.id, name: studio.name, slug: studio.slug },
      practitioner.display_name?.trim() || practitioner.email,
    ),
  );

  // PR #238 (Chloe pilot): the dashboard reads as a daily worklist.
  // Today moved to the top (it sat below the snapshot, attention,
  // booking, and birthday cards); once every auto-detected setup
  // step is done, the Getting started card collapses to a one-line
  // footer link so finished setup stops occupying the prime spot.
  const setupComplete =
    gettingStarted.autoTotal > 0 &&
    gettingStarted.autoDone === gettingStarted.autoTotal;

  // Onboarding v2 (guided welcome wizard + pinned setup-progress card). Strictly
  // opt-in per studio and owner-only: when the flag is off, NONE of this runs
  // and the dashboard renders exactly as today (the getting-started link card /
  // footer below). Read as `=== true` so an undefined flag is off.
  const onboardingV2On = isOwner && studio.onboarding_v2_enabled === true;
  const onboarding = onboardingV2On
    ? await (async () => {
        const [signals, row] = await Promise.all([
          getOnboardingSignals(studio),
          getOnboardingRow(studio.id),
        ]);
        const model = buildOnboardingModel(signals, toPersisted(row));
        // Auto-open on load until the owner dismisses it or finishes; the pinned
        // card re-opens it thereafter.
        const initialOpen = !model.dismissed && !model.isComplete;
        return { model, initialOpen };
      })()
    : null;

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-1">
        <DashboardGreeting displayName={practitioner.display_name} />
        <p className="text-xs uppercase tracking-wider text-neutral-500">
          <FormattedToday format="weekday-date" />
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
      </section>

      {/* Onboarding v2: pinned setup-progress card + auto-opening guided wizard,
          above the fold. Opt-in per studio + owner-only; supersedes the legacy
          getting-started link/footer below (which is gated off when v2 is on). */}
      {onboarding && (
        <OnboardingSurface
          model={onboarding.model}
          initialOpen={onboarding.initialOpen}
        />
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">Today</h2>
            <DaySummary
              appointmentCount={visibleAppointments.length}
              clientCount={todayClientIds.length}
            />
          </div>
          {/* The primary action in the appointments area is booking, not
              adding a client (Chloe: she'd never add a client here). Links
              to the calendar, where the quick-book flow lives. */}
          <Link
            href="/calendar"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Book appointment
          </Link>
        </div>

        {visibleAppointments.length === 0 ? (
          <EmptyDayState />
        ) : (
          <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {visibleAppointments.map((appt) => (
              <li key={appt.id}>
                <AppointmentRow
                  appt={appt}
                  workflow={workflowByAppointment.get(appt.id) ?? null}
                  pinnedNoteText={
                    pinnedByClient.get(appt.client_id)?.text ?? null
                  }
                  intakeStatus={intakeByClient.get(appt.client_id) ?? null}
                  linkedSession={sessionByAppointment.get(appt.id) ?? null}
                  paymentState={paymentStates.get(appt.id) ?? "no_session"}
                  tz={studio.timezone}
                  timeFormat={resolveTimeFormat(studio)}
                />
              </li>
            ))}
          </ul>
        )}
        {/* The pilot feedback prompt used to live at the foot of the Daily Prep
            Brief card. That card is gone, so it moves here — ONCE, at the foot
            of the combined section, never once per appointment. Same
            surface="daily_prep" contract, so pilot feedback stays comparable
            across the change. */}
        {visibleAppointments.length > 0 && (
          <PilotFeedbackPrompt surface="daily_prep" />
        )}
      </section>


      {/* PR #215: setup/readiness checklist entry point. A normal
          link card, never a blocking modal. PR #238: shown here, under
          Today, only while auto-detected steps remain; the full
          checklist always lives on /getting-started. */}
      {!onboardingV2On && !setupComplete && (
        <Link
          href="/getting-started"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 px-4 py-3 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
        >
          <span className="text-sm font-medium">Getting started</span>
          <span className="text-xs text-neutral-500">
            {gettingStarted.autoDone} of {gettingStarted.autoTotal} steps
            complete →
          </span>
        </Link>
      )}

      {/* PR #208: practice snapshot (period filter + appointment
          counts + service value + test-mode payment posture + action
          cards). Read-only; never labeled revenue while live payments
          are disabled. */}
      <PracticeSnapshot metrics={practiceMetrics} attention={clientsNeedingAttention} livemode={inferStripeLivemode()} />

      {/* PR #249: Follow-up assistant — recorded record gaps and
          follow-ups from recent appointments. Rules-based, read-only,
          links only. Sits under the snapshot so Today stays on top. */}
      <FollowUpAssistantCard assistant={followUpAssistant} />
      <SuppliesExpiringCard items={expiringSupplies} today={todayLocal} />

      <NeedsAttention
        isOwner={isOwner}
        intakesAwaitingReviewCount={intakesAwaitingReviewCount}
        activeServicesCount={activeServicesCount}
        paymentStatus={paymentStatus}
      />

      {isOwner && bookingReadiness && (
        <BookingSetupCard
          readiness={bookingReadiness}
          studioSlug={studio.slug}
          appOrigin={getRequiredAppOrigin()}
        />
      )}

      <BirthdaysThisMonth
        birthdays={birthdaysThisMonth}
        today={todayLocal}
        accentColor={studio.birthday_reminder_color}
      />

      {/* PR #250 Pilot Love Loop V1: a quiet, optional "Pilot learning"
          card near the bottom (well below Today). Manual mailto only —
          no automated send, no contacts, no referral links, no provider. */}
      <PilotLearningCard />

      {/* PR #238: completed setup collapses to a quiet footer link;
          the /getting-started route stays reachable (also in the
          account/mobile menus). */}
      {!onboardingV2On && setupComplete && (
        <p className="text-xs text-neutral-500">
          Setup complete.{" "}
          <Link
            href="/getting-started"
            className="underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900 hover:decoration-neutral-700 dark:hover:text-neutral-100"
          >
            Getting started checklist →
          </Link>
        </p>
      )}
    </div>
  );
}

function DaySummary({
  appointmentCount,
  clientCount,
}: {
  appointmentCount: number;
  clientCount: number;
}) {
  // ONE empty-day message. EmptyDayState is the single source of truth for the
  // empty day; this summary used to print "No appointments today." as well, so
  // the sentence appeared twice — once under the heading and once in the card
  // below it. The counts below are the only thing this component adds, and on
  // an empty day there are no counts worth stating.
  if (appointmentCount === 0) return null;
  const appt = `${appointmentCount} ${appointmentCount === 1 ? "appointment" : "appointments"}`;
  const client = `${clientCount} ${clientCount === 1 ? "client" : "clients"}`;
  return (
    <p className="mt-1 text-sm text-neutral-500">
      {appt} · {client}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Appointment row
// ---------------------------------------------------------------------------
function AppointmentRow({
  appt,
  workflow,
  pinnedNoteText,
  intakeStatus,
  linkedSession,
  paymentState,
  tz,
  timeFormat,
}: {
  appt: TodayAppointment;
  // The ONE derived preparation model for THIS appointment (keyed by
  // appointment id, so two same-client appointments never share a card).
  workflow: TodayWorkflowItem | null;
  pinnedNoteText: string | null;
  intakeStatus: ClientIntakeForm["status"] | null;
  linkedSession: { sessionId: string; hasChartedArea: boolean } | null;
  paymentState: AppointmentPaymentState;
  tz: string;
  timeFormat: TimeFormat;
}) {
  // PR #236: ONE obvious primary action per row, resolved from
  // existing facts (pure helper; existing routes only).
  const nextAction = resolveNextAction({
    status: appt.status,
    clientId: appt.client_id,
    appointmentId: appt.id,
    hasHistory: workflow?.hasHistory ?? false,
    sessionId: linkedSession?.sessionId ?? null,
    hasChartedArea: linkedSession?.hasChartedArea ?? false,
  });
  const time = formatTimeForStudio(new Date(appt.starts_at), tz, timeFormat);
  const performerName = appt.practitioner?.display_name?.trim();
  const performerColor = resolvePractitionerColor(appt.practitioner?.color);
  const modality = appt.service?.modality
    ? appt.service.modality
    : null;
  const serviceName = appt.service?.name ?? null;
  const showAllergyFlag = !!appt.client?.allergies;

  return (
    // PR #236: the row body still opens the appointment (calendar
    // detail), and a separate primary-action button sits beside it,
    // wrapping below the content on phones. No nested anchors.
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 hover:bg-neutral-50 dark:hover:bg-neutral-900">
      <Link
        href={`/calendar/${appt.id}`}
        className="flex min-w-0 flex-1 basis-64 gap-4"
      >
        <div className="w-14 flex-none text-sm font-medium tabular-nums text-neutral-700 dark:text-neutral-300">
          {time}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate font-medium">
              {appt.client?.name ?? "Client deleted"}
            </span>
            <AppointmentStatusPill status={appt.status} />
            {nextAction.chip && (
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                  nextAction.chip === "Charting needed"
                    ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                    : "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200"
                }`}
              >
                {nextAction.chip}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-neutral-500">
            {serviceName && <span>{serviceName}</span>}
            {modality && <span>{serviceName ? " · " : ""}{modality}</span>}
            <span>
              {(serviceName || modality) ? " · " : ""}
              {appt.duration_minutes} min
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {performerName ? (
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`inline-block h-2 w-2 rounded-full ${performerColor.bg}`}
                />
                <span className="text-neutral-600 dark:text-neutral-400">
                  {performerName}
                </span>
              </span>
            ) : (
              <span className="text-neutral-400 dark:text-neutral-500">
                Unassigned
              </span>
            )}
            {showAllergyFlag && (
              <span className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 font-medium text-rose-900 dark:bg-rose-900/40 dark:text-rose-200">
                Allergies
              </span>
            )}
            <IntakePill status={intakeStatus} />
          </div>
          {pinnedNoteText && (
            <div
              className="mt-1 truncate text-xs text-amber-800 dark:text-amber-300"
              title={pinnedNoteText}
            >
              <span className="font-semibold uppercase tracking-wider text-[10px]">
                Pinned
              </span>{" "}
              {truncate(pinnedNoteText, 50)}
            </div>
          )}
          {/* PREPARATION — the facts that used to be split across the Today
              row and the Daily Prep Brief, now resolved ONCE by
              buildTodayWorkflow and rendered once here. Nothing below repeats a
              status already shown by a pill or chip above. */}
          {workflow && (
            <div className="mt-1.5 flex flex-col gap-0.5 text-xs">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                Before today
              </span>
              {!workflow.hasHistory ? (
                // ONE relationship line, not "New client" here and "No prior
                // treatment history yet" somewhere else.
                <span className="text-neutral-500">
                  New client · No charted history yet
                </span>
              ) : (
                <>
                  {/* Remember = the PLAN note (next_session_note). It is no
                      longer taken from `rememberLine`, which collapsed the
                      caution and the plan into one string, so the caution used
                      to print twice under two different labels. */}
                  {workflow.remember && (
                    <span
                      className="whitespace-pre-wrap break-words text-blue-900 dark:text-blue-200"
                      title={workflow.remember}
                    >
                      Remember: {workflow.remember}
                    </span>
                  )}
                  {/* Caution = the watch line, kept visually distinct in the
                      established rose convention and never folded into
                      Remember. */}
                  {workflow.caution && (
                    <span
                      className="whitespace-pre-wrap break-words text-rose-900 dark:text-rose-200"
                      title={workflow.caution}
                    >
                      Caution: {workflow.caution}
                    </span>
                  )}
                  {!workflow.remember && !workflow.caution && (
                    <span className="text-neutral-500">No watch/plan note.</span>
                  )}
                  {/* Latest setup, once. The brief's duplicate "Last recorded:"
                      line is gone. */}
                  <span className="whitespace-pre-wrap break-words text-neutral-600 dark:text-neutral-400">
                    Latest setup: {workflow.setup ?? "Not recorded"}
                  </span>
                </>
              )}
              {/* Specific missing-record reminders, once each. The generic
                  "Records: N reminders" count is gone: it said nothing these
                  chips do not say precisely. */}
              {workflow.missingRecords.length > 0 && (
                <span className="mt-0.5 flex flex-wrap gap-1">
                  {workflow.missingRecords.map((r) => (
                    <span
                      key={r}
                      data-testid="missing-record-chip"
                      className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                    >
                      {r}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
        </div>
      </Link>
      <div className="flex flex-col items-end gap-2 self-center">
        {/* Quick checkout (Chloe): take payment from the roster without opening
            charting. Paid/Processing/Refunded show a status badge instead. */}
        <AppointmentCheckoutCell
          appointmentId={appt.id}
          status={appt.status}
          paymentState={paymentState}
        />
        <Link
          href={nextAction.href}
          className="rounded-md border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-700 hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-100 dark:hover:bg-neutral-900"
        >
          {nextAction.label}
        </Link>
      </div>
    </div>
  );
}

function AppointmentStatusPill({ status }: { status: AppointmentStatus }) {
  if (status === "confirmed") return null;
  const variant: Record<
    "completed" | "no_show" | "cancelled",
    { label: string; classes: string }
  > = {
    completed: {
      label: "Completed",
      classes:
        "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    },
    no_show: {
      label: "No-show",
      classes:
        "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    },
    cancelled: {
      label: "Cancelled",
      classes:
        "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    },
  };
  const v = variant[status as "completed" | "no_show" | "cancelled"];
  if (!v) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${v.classes}`}
    >
      {v.label}
    </span>
  );
}

function IntakePill({
  status,
}: {
  status: ClientIntakeForm["status"] | null;
}) {
  // Intake color convention (see top of file): reviewed → green/calm;
  // every not-ready state (none on file, in progress, awaiting review) →
  // amber so it's visible rather than easy to miss in quiet grey.
  if (!status) {
    return (
      <span className="font-medium text-amber-700 dark:text-amber-400">
        No intake on file
      </span>
    );
  }
  if (status === "reviewed") {
    return (
      <span className="text-emerald-700 dark:text-emerald-400">
        Intake reviewed
      </span>
    );
  }
  if (status === "submitted") {
    return (
      <span className="font-medium text-amber-700 dark:text-amber-400">
        Intake awaiting review
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="font-medium text-amber-700 dark:text-amber-400">
        Intake in progress
      </span>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------
type PaymentStatusForDashboard = {
  hasAccount: boolean;
  livemode: boolean | null;
  onboardingCompleted: boolean;
  payoutsEnabled: boolean;
};

function NeedsAttention({
  isOwner,
  intakesAwaitingReviewCount,
  activeServicesCount,
  paymentStatus,
}: {
  isOwner: boolean;
  intakesAwaitingReviewCount: number;
  activeServicesCount: number;
  paymentStatus: PaymentStatusForDashboard | null;
}) {
  // tone drives the color accent. "urgent" items block or interrupt the
  // daily workflow (unreviewed intakes, no bookable services) → amber.
  // "soft" items are optional Phase-1 nudges (Stripe) → calm neutral.
  const items: Array<{
    key: string;
    title: string;
    body: string;
    tone: "urgent" | "soft";
    href?: string;
    cta?: string;
  }> = [];

  if (intakesAwaitingReviewCount > 0) {
    items.push({
      key: "intake-review",
      title: `${intakesAwaitingReviewCount} ${
        intakesAwaitingReviewCount === 1 ? "intake" : "intakes"
      } awaiting review`,
      body: "Open the client to read the submitted answers and mark reviewed.",
      tone: "urgent",
      href: "/clients",
      cta: "Open clients",
    });
  }

  if (isOwner && activeServicesCount === 0) {
    items.push({
      key: "no-services",
      title: "No services yet",
      body: "Clients can't book until at least one active service exists.",
      tone: "urgent",
      href: "/settings/services",
      cta: "Add a service",
    });
  }

  if (isOwner && paymentStatus) {
    if (!paymentStatus.hasAccount) {
      // Soft nudge only; not flagged red. Phase 1 booking does not
      // require Stripe.
      items.push({
        key: "stripe-not-connected",
        title: "Stripe not connected yet",
        body: "Public booking still works without it. Connect when you're ready to accept payments.",
        tone: "soft",
        href: "/settings/payments",
        cta: "Open Payments",
      });
    } else if (!paymentStatus.onboardingCompleted) {
      items.push({
        key: "stripe-incomplete",
        title: "Stripe setup not finished",
        body: "A few details are still needed. Continue setup when you have a minute.",
        tone: "soft",
        href: "/settings/payments",
        cta: "Continue setup",
      });
    } else if (!paymentStatus.payoutsEnabled) {
      items.push({
        key: "stripe-payouts",
        title: "Payout setup needs attention",
        body: "Stripe is connected, but payouts aren't ready yet.",
        tone: "soft",
        href: "/settings/payments",
        cta: "Open Payments",
      });
    }
  }

  if (items.length === 0) return null;

  const hasUrgent = items.some((i) => i.tone === "urgent");

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-medium">Needs attention</h2>
        {hasUrgent && (
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-amber-500"
          />
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((item) => {
          const urgent = item.tone === "urgent";
          return (
            <li
              key={item.key}
              className={
                urgent
                  ? "flex flex-wrap items-start justify-between gap-3 rounded-lg border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:border-l-amber-500 dark:bg-amber-950/30"
                  : "flex flex-wrap items-start justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/50"
              }
            >
              <div className="min-w-0 flex-1">
                <p
                  className={
                    urgent
                      ? "text-sm font-medium text-amber-900 dark:text-amber-200"
                      : "text-sm font-medium"
                  }
                >
                  {item.title}
                </p>
                <p
                  className={
                    urgent
                      ? "mt-0.5 text-xs text-amber-800 dark:text-amber-300/80"
                      : "mt-0.5 text-xs text-neutral-600 dark:text-neutral-400"
                  }
                >
                  {item.body}
                </p>
              </div>
              {item.href && item.cta && (
                <Link
                  href={item.href}
                  className={
                    urgent
                      ? "rounded-md border border-amber-400 bg-white/70 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-white dark:border-amber-700 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-950/50"
                      : "rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-900"
                  }
                >
                  {item.cta}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
function EmptyDayState() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-10 dark:border-neutral-700 dark:bg-neutral-900">
      <p className="text-lg font-medium">No appointments today.</p>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Use the quiet time to review the week or book an appointment.
      </p>
      {/* Single CTA: the "Book appointment" primary action already lives in
          the Appointments section header, so the empty state only offers the
          calendar view to avoid a duplicate Book appointment button. */}
      <div className="flex flex-wrap gap-2">
        <Link
          href="/calendar"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          View calendar
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only data helpers — kept inline because each is a narrow single-call-
// site SELECT/RPC against tables we already use elsewhere. Promoting them
// to lib/ would scatter the dashboard's "needs attention" wiring without
// reuse.
// ---------------------------------------------------------------------------
async function loadIntakeStatusByClient(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
  clientIds: ReadonlyArray<string>,
): Promise<Map<string, ClientIntakeForm["status"]>> {
  const out = new Map<string, ClientIntakeForm["status"]>();
  if (clientIds.length === 0) return out;
  const { data, error } = await supabase
    .from("client_intake_forms")
    .select("client_id, status, created_at")
    .eq("studio_id", studioId)
    .in("client_id", clientIds as string[])
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to load intake status: ${error.message}`);
  }
  // First row per client_id wins (created_at desc), so each client maps
  // to the status of their most recent non-deleted intake.
  for (const row of (data ?? []) as {
    client_id: string;
    status: ClientIntakeForm["status"];
  }[]) {
    if (!out.has(row.client_id)) out.set(row.client_id, row.status);
  }
  return out;
}

async function countIntakesAwaitingReview(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("client_intake_forms")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("status", "submitted")
    .is("deleted_at", null);
  if (error) {
    throw new Error(
      `Failed to count intakes awaiting review: ${error.message}`,
    );
  }
  return count ?? 0;
}

async function countActiveServices(studioId: string): Promise<number> {
  // Use the existing helper; cheap, already cached at the page level.
  const services = await getActiveServices(studioId);
  return services.length;
}

async function loadPaymentStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
): Promise<PaymentStatusForDashboard | null> {
  // Uses the same display-safe RPC the Payments settings page reads from.
  // No Stripe SDK calls, no secrets, no Stripe IDs returned. Mode-scoped
  // (migration 0103): reads the CURRENT deployment mode's row only, so the
  // dashboard never reflects the other mode's stale status.
  const { data, error } = await supabase.rpc(
    "get_studio_payment_settings_display",
    { p_studio_id: studioId, p_stripe_livemode: inferStripeLivemode() },
  );
  if (error) {
    // Surface for the page renderer's "Needs attention" branch only;
    // log the structured event but don't break the dashboard.
    console.error(
      JSON.stringify({
        event: "dashboard_payment_status_failed",
        code: error.code,
        message: error.message,
        studioId,
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      hasAccount: false,
      livemode: null,
      onboardingCompleted: false,
      payoutsEnabled: false,
    };
  }
  return {
    hasAccount: row.account_status != null && row.account_status !== "not_connected",
    livemode: typeof row.livemode === "boolean" ? row.livemode : null,
    onboardingCompleted: row.onboarding_completed_at != null,
    payoutsEnabled: row.payouts_enabled === true,
  };
}

// Birthdays this month — practitioner-facing only. Renders nothing when
// the studio has no clients with a birthday in the current month so the
// dashboard stays quiet. Each row links to the client profile so the
// practitioner can pull up context before wishing them a happy birth
// month.
//
// Never sent as email/SMS. Never exposed to client/public surfaces.
function BirthdaysThisMonth({
  birthdays,
  today,
  accentColor,
}: {
  birthdays: ReadonlyArray<{ id: string; name: string; month: number; day: number }>;
  // Studio-local YYYY-MM-DD for the "today" highlight.
  today: string;
  // Studio-chosen accent (migration 0040). Never red/rose — that's
  // reserved for allergies/cautions. Falls back to purple if unset.
  accentColor: BirthdayReminderColor;
}) {
  if (birthdays.length === 0) return null;

  const todayDay = parseInt(today.slice(8, 10), 10);
  const accent = resolveBirthdayColor(accentColor);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Birthdays this month</h2>
      <ul className="flex flex-col gap-2">
        {birthdays.map((b) => {
          const isToday = b.day === todayDay;
          return (
            <li
              key={b.id}
              className={`flex flex-wrap items-baseline justify-between gap-3 rounded-lg border px-4 py-3 ${accent.card}`}
            >
              <div className="flex items-baseline gap-2">
                <Link
                  href={`/clients/${b.id}?tab=personal`}
                  className="text-sm font-medium hover:underline"
                >
                  {b.name}
                </Link>
                <span className={`text-xs tabular-nums ${accent.mutedText}`}>
                  {formatMonthDay(b.month, b.day)}
                </span>
                {isToday && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${accent.badge}`}
                  >
                    Today
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const MONTH_NAMES: ReadonlyArray<string> = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function formatMonthDay(month: number, day: number): string {
  const name = MONTH_NAMES[month - 1] ?? "";
  return `${name} ${day}`;
}
