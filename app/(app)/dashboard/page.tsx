import { StaffWelcome } from "@/components/onboarding/staff-welcome";
import { Suspense } from "react";
import { SummaryStrip } from "./summary-strip";
import { dashboardRebookCalendarHref } from "@/lib/calendar/dashboard-rebook";
import { getNextVisitsForRoster, type NextRosterVisit } from "@/lib/dashboard/next-visit-for-roster";
import { computeTimeInsights, formatInsightHours, insightPeriod } from "@/lib/calendar/time-insights";
import { getBoundaryCrossingAppointments } from "@/lib/calendar/boundary-appointments";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import {
  PendingContainerLink,
  PendingLink,
} from "@/components/pending-link";
import { createClient } from "@/lib/supabase/server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { AppointmentCheckoutCell } from "@/components/appointment-checkout-cell";
import {
  getAppointmentPaymentStates,
  type AppointmentPaymentState,
} from "@/lib/billing/appointment-payment-state";
import { timed } from "@/lib/observability/perf-timing";
import {
  requirePractitionerWithStudio,
  getPractitionersForStudio,
} from "@/lib/supabase/queries";
import {
  getActiveServices,
} from "@/lib/booking/queries";
import { getPinnedNotesByClient } from "@/lib/client-pinned-notes/queries";
import {
  canNavigateNext,
  canNavigatePrevious,
  calendarHrefForDashboardDay,
  dashboardDayHref,
  dayHeading,
  daySubLabel,
  emptyDayMessage,
  isViewingToday as isViewingTodayFn,
  nextDay,
  previousDay,
  resolveSelectedDay,
} from "@/lib/dashboard/day-navigation";
import { resolveDayNextAction } from "@/lib/dashboard/day-next-action";
import { getClientBirthdaysForMonth } from "@/lib/clients/birthday-queries";
import { clientDisplayName } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";
import {
  addDays,
  formatTimeForStudio,
  localTimeString12h,
  localLongDate,
  resolveTimeFormat,
  todayInTz,
  utcInstantFromLocal,
  type TimeFormat,
} from "@/lib/booking/tz";
import { FormattedToday } from "@/components/formatted-date-time";
import {
  getNewClientReadiness,
  type NewClientReadiness,
} from "@/lib/booking/new-client-readiness";
import {
  SecondaryStack,
  NeedsAttentionSection,
  DashboardBirthdays,
  NeedsAttentionHeadingCount,
  NeedsAttentionSkeleton,
  SecondaryStackSkeleton,
} from "./secondary-stack";
import {
  getPracticeDashboardMetrics,
  getProcedureActionMetrics,
} from "@/lib/dashboard/practice-metrics";
import { withDisplayNamesOnDetailGaps } from "@/lib/dashboard/client-display-names";
import { getPersonalChartedWithin24h } from "@/lib/dashboard/personal-charting";
import { getClientIdsWithUpcomingVisits } from "@/lib/dashboard/upcoming-visit-clients";
import { CHECK_UNAVAILABLE } from "@/lib/dashboard/needs-attention-model";
import { getIntakesAwaitingReview } from "@/lib/dashboard/intakes-awaiting-review";
import {
  loadStaffManagedClinicChecked,
  STAFF_MANAGED_UNKNOWN,
} from "@/lib/dashboard/staff-managed";
import {
  isReportingPeriod,
  type ReportingPeriod,
} from "@/lib/booking/reporting-period";
import {
} from "@/lib/dashboard/next-action";
import {
  getBeforeTodayPreviews,
  type BeforeTodayPreview,
} from "@/lib/dashboard/before-today-previews";
import { getClientsNeedingAttention } from "@/lib/dashboard/clients-needing-attention";
import {
  loadLastChartedTreatmentsForClients,
  type AppointmentPrepLoad,
} from "@/lib/sessions/last-treatment-loader";
import {
  buildAppointmentPrepMemory,
  prepMemoryInputFromTreatment,
  type AppointmentPrepMemory,
} from "@/lib/sessions/appointment-prep-memory";
import { DashboardTreatmentMemory } from "./dashboard-treatment-memory";
import {
  toDashboardPrepSummary,
  toDisclosureSummary,
  type DashboardPrepSummary,
} from "@/lib/dashboard/dashboard-prep-summary";
import {
  buildTodayWorkflow,
  todayWorkflowByAppointment,
  type TodayCharting,
  type TodayIntake,
  type TodayWorkflowInput,
  type TodayWorkflowItem,
} from "@/lib/dashboard/today-workflow";
import { memorySourceLabels } from "@/lib/dashboard/memory-source-labels";
import {
  resolveTodayIntakeAction,
  selectCurrentIntakeByClient,
  type TodayIntakeRow,
} from "@/lib/dashboard/today-intake";
import { UnfinishedVisitsNote } from "./unfinished-visits-note";
import { getMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";
import { currentAppointmentIds } from "@/lib/dashboard/current-appointment";
import {
  loadCardOnFileForStudio,
  resolveCardOnFileStatus,
  shouldOfferPortalLink,
  type CardOnFileStatus,
} from "@/lib/payment-methods/card-on-file";
import { CardOnFilePill, CurrentPill } from "./today-status-pills";
import { DashboardQuickPin } from "./dashboard-quick-pin";
import { immediateVisitPlans } from "@/lib/dashboard/immediate-visit-plans";
import { RowSafetyLines } from "./row-safety-lines";
import { TodayPortalLinkButton } from "./TodayPortalLinkButton";
import { clientSelfServicePolicyFromStudio } from "@/lib/booking/client-self-service-policy";
import { getExpiringSterileItems } from "@/lib/record-keeping/queries";
import { getGettingStartedSignals } from "@/lib/onboarding/getting-started";
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
  ClientPinnedNote,
  Service,
} from "@/lib/types/database";
import { DashboardGreeting } from "./DashboardGreeting";
import { dbErrorCode } from "@/lib/logging/error-class";

// ---------------------------------------------------------------------------
// Color convention (Chloe P0 feedback). Kept here as the canonical note
// because the dashboard is where the hierarchy is most visible; the
// appointment briefing and client profile follow the same rules.
//
//   Allergies / cautions ........ RED   (rose-*)  , never amber
//   Pinned notes ................. AMBER (amber-*) , distinct from allergies
//   Intake incomplete / awaiting . AMBER (amber-*) , easy-to-miss → visible
//   Intake reviewed / complete ... GREEN (emerald-*) / neutral: calm/good
//   Needs attention (urgent) ..... AMBER accent (amber-* left border + tint)
//   Needs attention (soft/info) .. NEUTRAL (no Phase-1-blocking urgency)
//   Birthdays .................... WARM  (rose-* tint)
//   Current appointment .......... BLUE  (blue-*)  , "in the room now": not an
//                                                    alarm and not a task, so
//                                                    never red and never amber
//   Card on file ................. GREEN (emerald-*)
//   No card on file .............. AMBER (amber-*) , actionable, easy to miss
//   Card status unavailable ...... NEUTRAL         , a failed read is NOT a
//                                                    client state
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
  // `email` is here ONLY so the row can tell whether a portal link CAN be
  // sent. It widens the existing narrow projection by one column rather than
  // adding a second client query, and it is never rendered.
  client: Pick<Client, "id" | "name" | "allergies" | "pronouns" | "email"> | null;
  service: Pick<Service, "id" | "name" | "modality"> | null;
  practitioner: { id: string; display_name: string | null; color: string } | null;
};

// One class for the three day-navigation controls, so the disabled variant
// cannot drift away from the live one. 44px minimum: this row is used on a
// phone between clients.
// ONE segmented day control, not three free-standing buttons.
//
// The segments share a single rounded boundary, so the group reads as one
// object and takes far less visual weight on a phone. The middle segment is
// ALWAYS rendered — as a non-link "you are here" marker on today — because
// conditionally inserting it changed the group's width by ~66px and moved
// "Next →" out from under a thumb that was tapping it repeatedly: a two-tap
// "forward, forward" landed the second tap on "Today" and threw the
// practitioner back. That is the same reasoning already applied to the
// disabled horizon controls, which stay in place rather than disappearing.
const DAY_NAV_GROUP =
  "inline-flex items-stretch overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700";
const DAY_NAV_SEGMENT =
  "inline-flex min-h-[44px] items-center px-3 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900";
const DAY_NAV_SEGMENT_DISABLED =
  "inline-flex min-h-[44px] cursor-default items-center px-3 text-sm text-neutral-400 dark:text-neutral-600";
/**
 * UX-01 QW1 · the segment you are ON.
 *
 * It used to reuse `DAY_NAV_SEGMENT_DISABLED`, which inverted the affordance on
 * the most-visited surface in the product: the day you are VIEWING was painted
 * in the disabled vocabulary — `text-neutral-400`, measured at ≈2.5:1 on white
 * against the AA floor of 4.5:1 — while the days you can travel to were painted
 * as ordinary live text. The current item looked the least available thing in
 * its own row, and the one segment that is not disabled was the only one
 * failing contrast. (The genuinely disabled arrows keep that token and are
 * exempt, which is exactly why overloading it here was wrong.)
 *
 * IT IS MARKED BY GROUND, NOT BY WEIGHT, and that is a constraint rather than a
 * preference. This control carries a promise stated a few lines below — the two
 * arrows must not move under the thumb between days — and `font-medium` changes
 * the text's advance width, so a weight change would shift both arrows every
 * time the practitioner stepped a day. The box metrics here are byte-identical
 * to the other segments (`min-h-[44px] px-3 text-sm`, no weight); only the fill
 * and the ink change, so nothing reflows.
 *
 * `text-neutral-900` on `bg-neutral-100` measures ≈16.4:1. The group is
 * `overflow-hidden`, so the fill clips to its radius without a second corner.
 */
const DAY_NAV_SEGMENT_CURRENT =
  "inline-flex min-h-[44px] cursor-default items-center px-3 text-sm bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100";
/** Divider between segments; the first segment carries no left border. */
const DAY_NAV_DIVIDE = " border-l border-neutral-300 dark:border-neutral-700";

export default async function DashboardPage({
  searchParams,
}: {
  // `day` is browser-controlled and Next hands repeated params through as an
  // array, so the type says so rather than lying about it.
  searchParams: Promise<{ period?: string; day?: string | string[]; unpaid?: string; setup?: string }>;
}) {
  const sp = await searchParams;
  // PR #208: practice-snapshot period filter. Default: this week.
  const period: ReportingPeriod = isReportingPeriod(sp.period)
    ? sp.period
    : "week";
  const { practitioner, studio } = await timed("dashboard.identity", () => requirePractitionerWithStudio());
  const isOwner = practitioner.role === "owner";
  const supabase = await createClient();

  // ONE clock read for the whole render. Every "is this happening now?"
  // question below answers against THIS instant, so the Today roster cannot
  // disagree with itself and no row calls the clock for itself. V1 is
  // deliberately render-time only: no polling, no minute timer.
  const renderNow = new Date();

  // Studio-local "today" range, converted to UTC for the appointments
  // query. The calendar week view uses the same pattern; we just window
  // it to a single local day here.
  // ACTUAL today. Deliberately NOT renamed and NOT repurposed: birthdays, the
  // sterile-supply expiry horizon, the To-do supply labels and the birthday
  // "Today" badge all read this, and every one of them is a claim about the day
  // the practitioner is IN, not about the day she is browsing.
  const todayLocal = todayInTz(studio.timezone);

  // The day the APPOINTMENT BRIEFING describes. Falls back to actual today for
  // anything absent, malformed, impossible or beyond the ±365 horizon; the
  // resolver never throws, so a hand-typed `?day=2026-8-2` cannot 500 the page.
  //
  // Compared against `todayLocal` — the single studio-local today above — and
  // never against a fresh clock read, so the roster window and the history gate
  // cannot disagree across local midnight.
  const selectedDayLocal = resolveSelectedDay(sp.day, todayLocal);
  const viewingToday = isViewingTodayFn(selectedDayLocal, todayLocal);
  const canGoBack = canNavigatePrevious(selectedDayLocal, todayLocal);
  const canGoForward = canNavigateNext(selectedDayLocal, todayLocal);

  // ONE local day, built as TWO separate local-midnight instants. Never
  // `start + 24h`: across a DST transition a Toronto day is 23 or 25 hours, and
  // the short one would silently drop a late-evening appointment.
  const selectedDayEndLocal = addDays(selectedDayLocal, 1);
  // PERF-01B. THE ROSTER MUST NOT WAIT FOR THE BUSINESS.
  //
  // Everything started here depends on the STUDIO and the CLOCK and nothing
  // else — not on the appointment query below, and not on each other. Every one
  // was previously an `await` placed AFTER the roster, so the practitioner's
  // day sat behind six serial round-trip waves that had no bearing on it:
  // the attention sources, practice metrics, the attention list, the
  // missing-records assistant, expiring supplies, and getting-started.
  //
  // They are STARTED here and AWAITED where their value is first read. Nothing
  // about what they return, or who may read them, changes.
  //
  // `settleLater` is not decoration. A promise that rejects while nothing is
  // awaiting it is an unhandled rejection in Node, and the window between
  // starting these and awaiting them spans the roster query. A no-op catch
  // marks the rejection handled for that window WITHOUT consuming it — the
  // real `await` below still throws, and still reaches the route's error
  // boundary exactly as it did when these were inline awaits.
  const settleLater = <T,>(promise: Promise<T>): Promise<T> => {
    promise.catch(() => undefined);
    return promise;
  };
  const birthdays = getClientBirthdaysForMonth(studio.id, Number(todayLocal.slice(5, 7)));
  const todayBirthdayIds = viewingToday ? birthdays.then(
    rows => new Set(rows.filter(row => row.day === Number(todayLocal.slice(8))).map(row => row.id)),
    () => new Set<string>(),
  ) : null;
  const attentionSourcesPromise = settleLater(
    Promise.all([
      // Insurance B2: a failure here is "unavailable" for THIS count only. It
      // must not reject the bundle and hide every other Needs attention item.
      getIntakesAwaitingReview(supabase, studio.id).catch(() => CHECK_UNAVAILABLE),
      countActiveServices(studio.id),
      isOwner ? loadPaymentStatus(supabase, studio.id) : Promise.resolve(null),
      // Birthday reminders: month-of-year only, derived from
      // clients.date_of_birth. Practitioner-facing only. Never sent as
      // email/SMS or exposed to client/public surfaces.
      birthdays,
    ] as const),
  );
  // BOOKING READINESS IS ITS OWN DEFERRED READ, not a member of the bundle
  // above, and the distinction is correctness rather than tidiness.
  //
  // ONB-03 moved the dashboard onto the canonical authority, which performs its
  // own reads; the raw `getAvailabilityDefaults` member that fed the old compute
  // became vestigial in the same change. Left in the tuple it was worse than
  // dead: `SecondaryStack` awaits the whole bundle before calling the authority,
  // so a rejection in a read NOTHING consumed would throw before readiness ran --
  // and the `unknown` card, which exists precisely to say "an authority could not
  // be read", could not render. Sibling promises cannot do that to each other:
  // they settle independently.
  //
  // It also removes a serial wave. The bundle no longer gates the authority's
  // three parallel reads on the owner's primary surface.
  //
  // OWNER-ONLY, null otherwise, so a non-owner pays for no read at all. The
  // previous arrangement read availability for everyone and discarded it.
  const bookingReadinessPromise = settleLater(
    isOwner
      ? getNewClientReadiness(studio)
      : Promise.resolve(null as NewClientReadiness | null),
  );
  // The read distinguishes "unknown" from "standard"; consumers that only need
  // the copy posture get the same default as before, and the stack states the
  // unknown case to the owner.
  const staffManagedReadPromise = settleLater(
    loadStaffManagedClinicChecked(supabase, studio.id),
  );
  const staffManagedPromise = settleLater(
    staffManagedReadPromise.then((v) => (v === STAFF_MANAGED_UNKNOWN ? false : v)),
  );
  // WS-DB: the practice metrics loader runs for the OWNER only. A practitioner
  // never starts it (it reads studio-wide activity and, for the owner, money).
  const practiceMetricsPromise = settleLater(
    isOwner
      ? getPracticeDashboardMetrics(studio.id, studio.timezone, period, {
          viewerIsOwner: true,
        })
      : Promise.resolve(null),
  );
  // The "records missing details" roll-up every role sees. The owner already
  // reads it inside the metrics; anyone else gets just that one read.
  // Privacy C1: the detail-gap entries carry the DISPLAY name (preferred, else
  // stored), not the record's stored name. The procedure record is untouched.
  const procedureActionsPromise = settleLater(
    (isOwner
      ? practiceMetricsPromise.then((m) => m!.actions)
      : getProcedureActionMetrics(studio.id)
    ).then((actions) => withDisplayNamesOnDetailGaps(supabase, studio.id, actions)),
  );
  // Orders intake gaps (preparation tier). A failed read degrades to the safe
  // order and never fails the section: it changes ORDER only, never membership.
  const upcomingVisitClientsPromise = settleLater(
    getClientIdsWithUpcomingVisits(supabase, studio.id, renderNow.toISOString()).catch(
      () => CHECK_UNAVAILABLE,
    ),
  );
  // A practitioner's OWN charting timeliness, for them alone. The owner sees the
  // studio figure in the Practice Snapshot instead, so nothing is read here.
  const personalChartingPromise = settleLater(
    isOwner
      ? Promise.resolve(null)
      : getPersonalChartedWithin24h(studio.id, practitioner.id, renderNow.toISOString()).catch(
          () => CHECK_UNAVAILABLE,
        ),
  );
  const clientsNeedingAttentionPromise = settleLater(
    getClientsNeedingAttention(studio.id),
  );
  const followUpAssistantPromise = settleLater(
    getMissingRecordsAssistant(studio.id, renderNow.toISOString()),
  );
  const expiringSuppliesPromise = settleLater(
    getExpiringSterileItems(studio.id, todayLocal),
  );
  const gettingStartedSignalsPromise = settleLater(
    getGettingStartedSignals(
      { id: studio.id, name: studio.name, slug: studio.slug },
      practitioner.display_name?.trim() || practitioner.email,
      { viewerIsOwner: isOwner },
    ),
  );

  const startUtc = utcInstantFromLocal(selectedDayLocal, "00:00", studio.timezone);
  const endUtc = utcInstantFromLocal(selectedDayEndLocal, "00:00", studio.timezone);

  // Today's appointments. Use a narrow inline SELECT so the dashboard
  // gets practitioner color + service modality + client allergies in
  // one trip without N+1 lookups.
  // HON-58: preferred name where one exists; fails soft to the stored name on a
  // database without the column (before 0258).
  const { data: apptRows, error: apptErr } = await readWithPreferredName((includePreferred) =>
    supabase
      .from("appointments")
      .select(
        `id, starts_at, ends_at, duration_minutes, status, client_id, client:clients(id, name, ${preferredNameColumn(includePreferred)}allergies, pronouns, email), service:services(id, name, modality), practitioner:practitioners!appointments_practitioner_same_studio_fk(id, display_name, color)`,
      )
      .eq("studio_id", studio.id)
      .gte("starts_at", startUtc.toISOString())
      .lt("starts_at", endUtc.toISOString())
      .order("starts_at", { ascending: true }),
  );
  if (apptErr) {
    // DAT-002 N2: a fixed message; PostgREST text can echo the statement.
    throw new Error("Failed to load today's appointments");
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
      | (Pick<Client, "id" | "name" | "allergies" | "pronouns" | "email"> & { preferred_name?: string | null })
      | (Pick<Client, "id" | "name" | "allergies" | "pronouns" | "email"> & { preferred_name?: string | null })[]
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
  const dayAppointments: TodayAppointment[] = (
    (apptRows ?? []) as unknown as RawAppt[]
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

  // The visible roster excludes cancelled appointments: they shouldn't
  // crowd a "what's today" briefing. Cancellation records remain on the
  // calendar week view, where context is appropriate.
  const visibleAppointments = dayAppointments.filter(
    (a) => a.status !== "cancelled",
  );

  // Booked time only: appointments that began before this day and run into it (a midnight-crossing
  // visit) are not in the start-in-day query above. Same function and studio scope as the calendar's
  // time insights; they never join the roster, the appointment count or the client count. A failed
  // read makes the figure "Unavailable", never an undercount.
  const boundaryCrossers = await getBoundaryCrossingAppointments(studio.id, startUtc).catch(
    () => null,
  );

  const selectedDayClientIds = Array.from(
    new Set(visibleAppointments.map((a) => a.client_id)),
  );

  // Chloe: "dashboard should highlight current client". PURE, ZERO queries: the
  // rule reads facts already loaded (starts_at / ends_at / status) against the
  // single `renderNow` above. A SET, so two genuinely overlapping appointments
  // (two practitioners, two rooms) both read Current instead of one silently
  // winning.
  // "Current" is a claim about the real present moment, so it is only asked on
  // the real present day. On any other day the set is empty BY CONSTRUCTION —
  // relying on "nothing contains now" would silently break the first time the
  // predicate grew a fallback such as "next up".
  const currentAppointmentIdSet = !viewingToday
    ? new Set<string>()
    : currentAppointmentIds(visibleAppointments, renderNow.getTime());

  // Bulk lookups for the visible client set. Each query is read-only,
  // RLS-scoped, and bounded by today's client list.
  const [practitioners, pinnedByClient, intakeByClient, cardOnFileLoad, nextVisits] =
    await Promise.all([
      getPractitionersForStudio(studio.id),
      getPinnedNotesByClient(studio.id, selectedDayClientIds),
      loadIntakeStatusByClient(supabase, studio.id, selectedDayClientIds),
      // Chloe: card-on-file status beside each name. Capability is asked
      // FIRST: a studio with no card-on-file route gets `null` and pays ZERO
      // card-status queries, because "no card" is not a truthful thing to say
      // about a client who was never able to add one. When it does apply, this
      // is ONE bounded read for today's UNIQUE client ids, so a client with two
      // appointments costs one lookup and the cost does not grow with the
      // schedule, and a failed read stays UNAVAILABLE — never "No card".
      // PRIVACY F1: card-on-file is a client payment-readiness signal, so it is
      // OWNER-ONLY (Sam decision 12; payment state already works this way). A
      // non-owner never triggers the read, so `cardOnFileLoad` is null, the
      // status resolves to null, and the row renders no pill and no portal-link
      // nudge (which keys off the same status).
      isOwner
        ? loadCardOnFileForStudio(studio.id, selectedDayClientIds)
        : Promise.resolve(null),
      getNextVisitsForRoster(supabase, studio.id, visibleAppointments, renderNow.toISOString()).catch(
        () => null,
      ),
    ]);
  void practitioners; // currently unused on the appointments roster;
  // kept fetched in parallel because future per-practitioner annotations
  // may surface here without paying an extra round-trip.



  // PR #212: compact Before-today previews for the Today roster.
  // THREE batched reads for all of today's clients (never per-row);
  // exactly the PR #211 briefing pipeline, compacted.
  // PR #236: linked-session facts for the Today next actions. Two
  // batched reads (same shape as the charted-24h loader); no N+1.
  const apptIds = dayAppointments.map((a) => a.id);

  // PERF-01B. These three need the ROSTER and nothing else — not each other,
  // and not the linked-session chain immediately below. They used to be three
  // separate awaits placed after that chain, so the card's own preparation
  // facts arrived four waves deep.
  // HON-44 (Sam decision 12): payment state and checkout are owner-only. A
  // non-owner never queries payment_charge_attempts or client_pricing here (the
  // read is not issued), and the row below renders no checkout control for them.
  const paymentStatesPromise = settleLater(
    isOwner
      ? getAppointmentPaymentStates(studio.id, apptIds, studio.timezone, isOwner)
      : Promise.resolve(new Map<string, AppointmentPaymentState>()),
  );
  const beforeTodayPreviewsPromise = settleLater(
    viewingToday
      ? getBeforeTodayPreviews(
          studio.id,
          visibleAppointments.map((a) => a.client_id),
          visibleAppointments.map((a) => ({
            clientId: a.client_id,
            appointmentId: a.id,
            startsAt: a.starts_at,
          })),
        )
      : Promise.resolve(new Map<string, BeforeTodayPreview>()),
  );
  const prepLoadsPromise = settleLater(
    loadLastChartedTreatmentsForClients({
      studioId: studio.id,
      requests: visibleAppointments.map((a) => ({
        // The APPOINTMENT is the unit of identity, not the client. A client with
        // two bookings in a day gets two requests with two different boundaries
        // and must get back two different answers.
        requestKey: a.id,
        clientId: a.client_id,
        before: a.starts_at,
        excludeAppointmentId: a.id,
      })),
    }),
  );
  const sessionByAppointment = new Map<
    string,
    { sessionId: string; hasChartedArea: boolean }
  >();
  if (apptIds.length > 0) {
    const { data: linkedSessions, error: linkedError } = await supabase
      .from("sessions")
      .select("id, appointment_id")
      .eq("studio_id", studio.id)
      .in("appointment_id", apptIds)
      .is("deleted_at", null);
    // DAT-002 (the #981 pattern): a failed read refuses the page through the
    // route error boundary. Read as "no linked session" or "no charted area",
    // it would tell the practitioner a charted visit still needs charting.
    if (linkedError) throw new Error("Failed to load charting status");
    const sessions = (linkedSessions ?? []) as Array<{
      id: string;
      appointment_id: string;
    }>;
    if (sessions.length > 0) {
      const { data: blockRows, error: blocksError } = await supabase
        .from("session_blocks")
        .select("session_id")
        .eq("studio_id", studio.id)
        .in("session_id", sessions.map((s) => s.id))
        .is("deleted_at", null);
      if (blocksError) throw new Error("Failed to load charting status");
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
  // visible appointments' payment state, no per-row query, no full history.
  const paymentStates = await paymentStatesPromise;

  // THE LOAD-BEARING RULE OF THIS CHANGE.
  //
  // These two loaders are the only ones on the roster path that make a
  // HISTORICAL claim about a client. Everything else here — pinned note, intake
  // state, card on file, payment state, the linked session — describes the
  // client or the appointment NOW, and is true on any day.
  //
  // Off Today, V1 does not ask the history question AT ALL. It is not asked and
  // answered "no": it is not asked. So the loads are SKIPPED rather than
  // rendered-but-hidden, and the row states nothing about history in either
  // direction — no "New client", no "Returning client", no caution, plan or
  // setup, and no "unavailable" either, because there was no question.
  //
  // Skipping is also strictly cheaper: it removes six batched reads, the
  // largest read on the page.
  const beforeTodayPreviews = await beforeTodayPreviewsPromise;

  // Dashboard V2 Part 2A: the FULL previous treatment for every returning
  // client of the day, from the SAME #517 authority the appointment page uses.
  //
  // ONE batched call for the whole day: two round-trips total, independent of
  // how many appointments there are. Calling the per-client loader inside the
  // map below would be an N+1 that grows with the studio's schedule, which is
  // why the batched companion exists.
  //
  // Each request carries its OWN appointment boundary: `before` is that
  // appointment's starts_at, and `excludeAppointmentId` keeps a session already
  // linked to today's visit from being presented as its own previous treatment.
  // Runs for the SELECTED day, not just today.
  //
  // This is the one historical surface that is safe off Today, and the reason
  // is structural rather than a judgement call: this loader has no clock in it.
  // Every date it uses is the caller-supplied `before` — that appointment's own
  // `starts_at` — and its result is a THREE-state contract, so a failed or
  // truncated read comes back `unavailable` instead of being flattened into
  // "this client has nothing". The retired Before-Today model could not do
  // either: its only output channel is a boolean, so every unknown was forced
  // to render as an affirmative "New client".
  //
  // One batch is ONE DAY. The shared row budget is spent between the loosest
  // and tightest `before` in the batch, so widening a batch across several days
  // would let one day's rows evict another's and reappear as a false absence.
  const prepLoads = await prepLoadsPromise;

  // Pure fold into the shared model, no I/O. `prepLoads` is ALREADY keyed by
  // appointment id (the requestKey passed above), so this reads its own key and
  // never re-derives one from the client. An earlier version looked the load up
  // by `appt.client_id`, which handed both of a client's appointments whichever
  // answer was written last.
  // PROJECTED ON THE SERVER, and the full model never leaves it.
  //
  // `buildAppointmentPrepMemory` still runs here — it is the shared authority
  // and must not be forked — but its output is immediately reduced to the
  // handful of values the collapsed row actually paints. The complete record
  // (areas, machine settings, probe lot, tolerance, reactions, narrative) is
  // resolved again, for ONE appointment, only when the practitioner opens the
  // disclosure and the server has re-checked that the appointment is hers.
  const plansForVisit = await immediateVisitPlans(supabase, studio.id, visibleAppointments, prepLoads).catch(() => new Map<string, string>());
  const prepSummaryByAppointment = new Map<string, DashboardPrepSummary>();
  for (const appt of visibleAppointments) {
    const load = prepLoads.get(appt.id);
    if (!load) {
      prepSummaryByAppointment.set(
        appt.id,
        toDashboardPrepSummary({ memory: null, unavailable: false, planNote: null, timeZone: studio.timezone }),
      );
      continue;
    }
    prepSummaryByAppointment.set(
      appt.id,
      toDashboardPrepSummary({
        memory: load.treatment
          ? buildAppointmentPrepMemory(prepMemoryInputFromTreatment(load.treatment))
          : null,
        unavailable: load.unavailable,
        planNote: plansForVisit.get(appt.id) ?? null,
        timeZone: studio.timezone,
      }),
    );
  }

  // ONE combined Today workflow (Chloe: "Today and the Daily Prep Brief are
  // redundant"). A pure helper turns facts already loaded above: visible
  // appointments, the Before Today previews, the linked-session charting state,
  // intake status: into exactly one card per appointment, keyed by APPOINTMENT
  // id and in the query's chronological order. No new query; nothing sorted.
  //
  // Built ONLY for actual today. Off Today there is no history answer to put
  // in `hasHistory`, and inventing `false` is the exact untruth this change
  // exists to avoid. An empty input list means every non-Today row gets
  // `workflow === null`, and the preparation block and treatment memory —
  // both already guarded on it in production — go quiet on their own.
  const nowIsoForLabels = renderNow.toISOString();
  const todayWorkflowInputs: TodayWorkflowInput[] = (
    viewingToday ? visibleAppointments : []
  ).map(
    (appt) => {
      const preview = beforeTodayPreviews.get(appt.id) ?? null;
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
        clientName: appt.client ? clientDisplayName(appt.client) : "Client",
        timeLabel: localTimeString12h(new Date(appt.starts_at), studio.timezone),
        status: appt.status,
        serviceName: appt.service?.name ?? null,
        // CLIN-BEFORE-TODAY-F2. The Before-today reads report their own
        // outcome now, and the row derivation is where that outcome has to
        // land: `hasHistory` is false both for a client with nothing charted
        // and for a client whose history could not be read.
        unavailable: preview?.unavailable ?? false,
        hasHistory: preview?.hasHistory ?? false,
        nextVisitNote: preview?.nextVisitNote ?? null,
        cautionNote: preview?.cautionNote ?? null,
        setupLine: preview?.setupLine ?? null,
        // Where the notes and the setup came from, in the STUDIO's calendar (never the server's locale).
        ...(() => {
          const l = memorySourceLabels(preview?.sources, nowIsoForLabels, studio.timezone);
          return { notesSourceLabel: l.notes, setupSourceLabel: l.setup };
        })(),
        reminders: preview?.reminders ?? [],
        intake,
        charting,
      };
    },
  );
  const todayWorkflow = buildTodayWorkflow(todayWorkflowInputs);
  const workflowByAppointment = todayWorkflowByAppointment(todayWorkflow);




  // Onboarding v2 (guided welcome wizard + pinned setup-progress card). Strictly
  // opt-in per studio and owner-only: when the flag is off, NONE of this runs
  // and the dashboard renders exactly as today (the getting-started link card /
  // footer below). Read as `=== true` so an undefined flag is off.
  // Links for the Needs attention "All outstanding" toggle: they keep the day and period the page is showing.
  const unpaidHrefs = (() => {
    const base = new URLSearchParams();
    base.set("period", period);
    if (selectedDayLocal !== todayLocal) base.set("day", selectedDayLocal);
    const recent = base.toString();
    base.set("unpaid", "all");
    return { all: `?${base.toString()}`, recent: recent === "" ? "?" : `?${recent}` };
  })();
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
        const initialOpen = !model.isComplete && (!model.dismissed || sp.setup === "resume");
        return { model, initialOpen };
      })()
    : null;

  return (
    <div className="flex flex-col gap-10">
      {/* Keep the operational sections first on phones. On wider screens the
          birthday strip spans the grid above the schedule and attention list. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)] lg:items-start">
      <header className="flex flex-wrap items-center justify-between gap-3 [--color-accent:#4d405b] [--color-accent-hover:#41354e] [--color-accent-active:#372d43] lg:order-first lg:col-span-2">
        <div className="flex min-w-0 flex-col gap-1">
          <SectionLabel as="p">
            <FormattedToday format="weekday-date" />
          </SectionLabel>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Dashboard</h1>
          <DashboardGreeting displayName={practitioner.display_name} />
        </div>
        <Link
          href={calendarHrefForDashboardDay({
            selectedDay: selectedDayLocal,
            todayLocal,
          })}
          className={buttonClasses({ variant: "primary" })}
        >
          Book appointment
        </Link>
      </header>

      {practitioner.role === "practitioner" && <StaffWelcome role="practitioner" membershipId={practitioner.id} />}

      {/* Onboarding v2: pinned setup-progress card + auto-opening guided wizard,
          above the fold. Opt-in per studio + owner-only; supersedes the legacy
          getting-started link/footer below (which is gated off when v2 is on). */}
      {onboarding && (
        <div className="min-w-0 lg:col-span-2">
          <OnboardingSurface
            model={onboarding.model}
            initialOpen={onboarding.initialOpen}
          />
        </div>
      )}

      {/* WS-DB layout: appointments beside Needs Attention on desktop, stacked on
          mobile. `min-w-0` on both columns lets long names wrap instead of
          widening the grid. The appointments column does not wait for Needs
          Attention: that column streams behind its own boundary. */}
      <section aria-label="Appointments" className="flex min-w-0 flex-col rounded-xl border border-neutral-200 dark:border-neutral-800">
        {/* `flex-wrap` matters: this header was the one multi-control row on
            the page without it, and it now carries day navigation beside the
            primary action. Without wrapping, 390px overflows horizontally. */}
        <div className="flex min-h-[44px] flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            {/* The heading names the day being shown. It says "Today" on the
                real present day, so the ordinary case reads exactly as before;
                it must not keep saying "Today" over another day's roster. */}
            <h2 className="text-lg font-semibold tracking-tight">
              {dayHeading(selectedDayLocal, todayLocal)}
            </h2>
            {/* ONE node per fact. The sub-line exists only to say WHICH day
                "Today"/"Tomorrow"/"Yesterday" is; from two days out the heading
                already IS the date, so `daySubLabel` returns null rather than
                printing the identical string twice — which is what shipped and
                is what the practitioner reported as "wonky". */}
            {daySubLabel(selectedDayLocal, todayLocal) && (
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {daySubLabel(selectedDayLocal, todayLocal)}
              </p>
            )}
          </div>
          {/* Day navigation: server-rendered links, so the URL is shareable,
              browser Back works, and no client-side date state exists — this
              page deliberately holds ONE clock read and no timers.

              UI-01: PendingLink, not Link. This navigation changes only
              `?day=`, so the segment never changes, React reuses the tree, and
              a route-level loading boundary cannot render for it at all —
              the page sits here complete and stale while the server re-runs
              the whole briefing. Before this, tapping Next changed nothing on
              screen until the new day landed.

              PendingLink paints on the segment the thumb is on. It reports
              Next's navigation state and nothing more: it starts no
              navigation, and says nothing about which day is arriving. The
              mark is absolutely positioned and the label only fades, so the
              two arrows still do not move under the thumb between days —
              which is the same promise the inert "Today" span above makes. */}
          <nav aria-label="Change day" className={DAY_NAV_GROUP}>
            {canGoBack ? (
              <PendingLink
                href={dashboardDayHref({
                  day: previousDay(selectedDayLocal),
                  todayLocal,
                  period,
                })}
                aria-label="Previous day"
                data-testid="dashboard-prev-day"
                pendingLabel="Loading day…"
                className={DAY_NAV_SEGMENT}
              >
                ← Previous
              </PendingLink>
            ) : (
              <span
                aria-label="Previous day"
                aria-disabled="true"
                data-testid="dashboard-prev-day"
                data-disabled="true"
                className={DAY_NAV_SEGMENT_DISABLED}
              >
                ← Previous
              </span>
            )}
            {viewingToday ? (
              /* Present but inert: it marks where you are, and keeps the two
                 arrows from moving under the thumb between days. */
              <span
                aria-current="page"
                data-testid="dashboard-today"
                className={DAY_NAV_SEGMENT_CURRENT + DAY_NAV_DIVIDE}
              >
                Today
              </span>
            ) : (
              <PendingLink
                href={dashboardDayHref({ day: todayLocal, todayLocal, period })}
                data-testid="dashboard-today"
                pendingLabel="Loading day…"
                className={DAY_NAV_SEGMENT + DAY_NAV_DIVIDE}
              >
                Today
              </PendingLink>
            )}
            {canGoForward ? (
              <PendingLink
                href={dashboardDayHref({
                  day: nextDay(selectedDayLocal),
                  todayLocal,
                  period,
                })}
                aria-label="Next day"
                data-testid="dashboard-next-day"
                pendingLabel="Loading day…"
                className={DAY_NAV_SEGMENT + DAY_NAV_DIVIDE}
              >
                Next →
              </PendingLink>
            ) : (
              <span
                aria-label="Next day"
                aria-disabled="true"
                data-testid="dashboard-next-day"
                data-disabled="true"
                className={DAY_NAV_SEGMENT_DISABLED + DAY_NAV_DIVIDE}
              >
                Next →
              </span>
            )}
          </nav>

        </div>

        <SummaryStrip
          appointmentCount={visibleAppointments.length}
          clientCount={selectedDayClientIds.length}
          bookedTime={
            boundaryCrossers === null
              ? "Unavailable"
              : formatInsightHours(
                  computeTimeInsights({
                    appointments: [...visibleAppointments, ...boundaryCrossers].map((a) => ({
                      id: a.id,
                      status: a.status,
                      starts_at: a.starts_at,
                      ends_at: a.ends_at,
                      practitioner_id: null,
                    })),
                    period: insightPeriod(startUtc, endUtc),
                    selection: { mode: "all", ids: new Set() },
                  }).minutes,
                )
          }
        />

        {visibleAppointments.length === 0 ? (
          <EmptyDayState selectedDay={selectedDayLocal} todayLocal={todayLocal} />
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {visibleAppointments.map((appt) => (
              <li key={appt.id}>
                <AppointmentRow
                  appt={appt}
                  rebookHref={dashboardRebookCalendarHref(appt.id, selectedDayLocal, period)}
                  todayBirthdayIds={todayBirthdayIds}
                  viewerId={practitioner.id}
                  nextVisit={nextVisits === null ? "unavailable" : nextVisits.get(appt.id) ?? null}
                  workflow={workflowByAppointment.get(appt.id) ?? null}
                  pinnedNotes={pinnedByClient.get(appt.client_id) ?? null}
                  intakeStatus={intakeByClient.get(appt.client_id) ?? null}
                  linkedSession={sessionByAppointment.get(appt.id) ?? null}
                  paymentState={paymentStates.get(appt.id) ?? "unavailable"}
                  isOwner={isOwner}
                  portalEnabled={clientSelfServicePolicyFromStudio(studio).portal}
                  historyAsked={viewingToday}
                  isCurrent={currentAppointmentIdSet.has(appt.id)}
                  hasEnded={new Date(appt.ends_at).getTime() <= renderNow.getTime()}
                  cardOnFile={resolveCardOnFileStatus(
                    cardOnFileLoad,
                    appt.client_id,
                  )}
                  prepSummary={
                    prepSummaryByAppointment.get(appt.id) ??
                    toDashboardPrepSummary({
                      memory: null,
                      unavailable: false,
                      planNote: null,
                    })
                  }
                  tz={studio.timezone}
                  timeFormat={resolveTimeFormat(studio)}
                />
              </li>
            ))}
          </ul>
        )}
        {/* DASH-TRUTH-04: the quiet pilot feedback footer is gone from Today.
            The daily workspace should not ask a practitioner to email the
            founder; that was pilot tooling, not product. */}
      </section>
      <section aria-labelledby="needs-attention-heading" className="flex min-w-0 flex-col gap-3 rounded-xl border border-neutral-200 p-3 sm:p-4 dark:border-neutral-800">
        {/* Header row on the same top edge and minimum height as the appointments header. */}
        <div className="flex min-h-[44px] items-center justify-between gap-3">
          <h2 id="needs-attention-heading" className="text-lg font-semibold tracking-tight">
            Needs attention
          </h2>
          <NeedsAttentionHeadingCount
            key={`needs-count:${selectedDayLocal}:${period}`}
            studioId={studio.id}
            studioTimezone={studio.timezone}
            unpaidAll={sp.unpaid === "all"}
            unpaidHrefs={unpaidHrefs}
            attentionSources={attentionSourcesPromise}
            staffManaged={staffManagedPromise}
            procedureActions={procedureActionsPromise}
            upcomingVisitClients={upcomingVisitClientsPromise}
            clientsNeedingAttention={clientsNeedingAttentionPromise}
            followUpAssistant={followUpAssistantPromise}
            expiringSupplies={expiringSuppliesPromise}
            isOwner={isOwner}
            todayLocal={todayLocal}
          />
        </div>
        {/* KEYED like the secondary stack below, for the same reason. */}
        <Suspense
          key={`needs:${selectedDayLocal}:${period}`}
          fallback={<NeedsAttentionSkeleton />}
        >
          <UnfinishedVisitsNote studioId={studio.id} nowIso={renderNow.toISOString()} />
          <NeedsAttentionSection
            studioId={studio.id}
            studioTimezone={studio.timezone}
            unpaidAll={sp.unpaid === "all"}
            unpaidHrefs={unpaidHrefs}
            attentionSources={attentionSourcesPromise}
            staffManaged={staffManagedPromise}
            procedureActions={procedureActionsPromise}
            upcomingVisitClients={upcomingVisitClientsPromise}
            clientsNeedingAttention={clientsNeedingAttentionPromise}
            followUpAssistant={followUpAssistantPromise}
            expiringSupplies={expiringSuppliesPromise}
            isOwner={isOwner}
            todayLocal={todayLocal}
          />
        </Suspense>
      </section>
      {/* Compact Birthdays: its own boundary, keyed like the others; reads the bundle the page already
          started. Rendered unconditionally (relationship context is not role-gated). */}
      <DashboardBirthdays
        key={`birthdays:${selectedDayLocal}:${period}`}
        attentionSources={attentionSourcesPromise}
        today={todayLocal}
        accentColor={studio.birthday_reminder_color}
      />
      </div>
      {/* PERF-01C: the secondary stack streams; the roster above does not
          wait for it.

          Everything below Today — To do, Birthdays, the practice snapshot and
          the setup cards — reads studio paperwork the day's roster never
          consumes. Before this boundary the page awaited all six of those
          reads before emitting a single byte, so a practitioner waited on
          expiring-supply counts and a setup fraction to find out who was
          coming in.

          The promises are STARTED ABOVE, before the roster query, and are
          passed in here. That direction matters: creating them inside the
          child would delay them until this component rendered, which is worse
          than the serial code PERF-01B replaced. This boundary changes WHEN
          the result is awaited, never when the read begins.

          The fallback is wordless by contract. Every card in this stack states
          something about the studio — a To-do list, appointment counts,
          service value, a setup fraction — and none of it is known yet. See
          SecondaryStackSkeleton. */}
      {/* KEYED, and the key is load-bearing.

          Day and period navigation are QUERY-ONLY: the segment does not change,
          so Next drives them as a React transition. When a transition renders a
          tree that suspends, React deliberately keeps the CURRENT screen up
          rather than showing a fallback — which, with an unkeyed boundary here,
          held the whole navigation until the studio paperwork resolved and put
          the roster back behind exactly the reads this boundary removed it
          from. e2e/perceived-speed.spec.ts caught it: the day never arrived.

          Keying the boundary on the values that change what it renders makes
          React treat each day/period as a NEW boundary, so it shows the
          fallback and commits the roster immediately. */}
      <Suspense
        key={`${selectedDayLocal}:${period}`}
        fallback={<SecondaryStackSkeleton />}
      >
        <SecondaryStack
          attentionSources={attentionSourcesPromise}
          staffManaged={staffManagedPromise}
          staffManagedRead={staffManagedReadPromise}
          personalCharting={personalChartingPromise}
          bookingReadiness={bookingReadinessPromise}
          practiceMetrics={practiceMetricsPromise}
          gettingStartedSignals={gettingStartedSignalsPromise}
          studio={studio}
          isOwner={isOwner}
          onboardingV2On={onboardingV2On}
          todayLocal={todayLocal}
          selectedDayLocal={selectedDayLocal}
        />
      </Suspense>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appointment row
// ---------------------------------------------------------------------------
async function BirthdayTodayBadge({ clientId, ids }: { clientId: string; ids: Promise<Set<string>> }) {
  if (!(await ids).has(clientId)) return null;
  return <span className="rounded-full bg-rose-50 px-2 py-1 font-medium text-rose-900 dark:bg-rose-950/50 dark:text-rose-200">Birthday today</span>;
}

function AppointmentRow({
  appt,
  todayBirthdayIds,
  viewerId,
  rebookHref,
  nextVisit,
  workflow,
  pinnedNotes,
  intakeStatus,
  linkedSession,
  paymentState,
  isOwner,
  portalEnabled,
  prepSummary,
  historyAsked,
  isCurrent,
  hasEnded,
  cardOnFile,
  tz,
  timeFormat,
}: {
  appt: TodayAppointment;
  viewerId: string;
  todayBirthdayIds: Promise<Set<string>> | null;
  rebookHref: string;
  nextVisit: NextRosterVisit | "unavailable" | null;
  // The ONE derived preparation model for THIS appointment (keyed by
  // appointment id, so two same-client appointments never share a card).
  workflow: TodayWorkflowItem | null;
  pinnedNotes: ReadonlyArray<Pick<ClientPinnedNote, "id" | "text" | "created_by_practitioner_id">> | null;
  intakeStatus: ClientIntakeForm["status"] | null;
  linkedSession: { sessionId: string; hasChartedArea: boolean } | null;
  paymentState: AppointmentPaymentState;
  // The viewer is the studio owner. Checkout is owner-only (HON-44).
  isOwner: boolean;
  // Dashboard V2 Part 2A: the #517 previous-treatment model for THIS
  // appointment, already built by the page from one batched read. Keyed by
  // APPOINTMENT id upstream, so two same-client appointments each get their own
  // boundary and one client can never receive another's memory.
  /**
   * The compact projection of the previous visit — exactly what the collapsed
   * row paints, and nothing else. The full `AppointmentPrepMemory` stays
   * server-side until the practitioner explicitly opens the disclosure.
   */
  prepSummary: DashboardPrepSummary;
  // Whether the page ASKED the history question for this row at all. Only
  // actual today does. Passed explicitly rather than inferred from
  // `workflow === null`, so "we did not ask" stays a stated fact rather than a
  // side effect of another decision.
  historyAsked: boolean;
  // Resolved ONCE for the whole page against one instant (see `renderNow`), not
  // re-derived per row from its own clock read.
  isCurrent: boolean;
  // HON-45: the appointment's end has passed, judged against the same single `renderNow` as `isCurrent`.
  hasEnded: boolean;
  // Three states, never two. `unavailable` means the card read failed, which is
  // NOT the same claim as "this client has no card".
  // `null` = this studio has no card-on-file route, so the row asks no card
  // question at all: no pill, no nudge. Distinct from `unavailable`, which
  // means the question applies but the read failed.
  cardOnFile: CardOnFileStatus | null;
  portalEnabled: boolean;
  tz: string;
  timeFormat: TimeFormat;
}) {
  // PR #236: ONE obvious primary action per row, resolved from
  // existing facts (pure helper; existing routes only).
  // On TODAY this delegates verbatim to `resolveNextAction`, so the action is
  // bit-for-bit what production renders. On any other day the history question
  // was never posed, and the wrapper returns the neutral action rather than
  // being handed a fabricated `hasHistory: false` — which would quietly claim
  // that a ten-year client is new.
  const nextAction = resolveDayNextAction({
    status: appt.status,
    clientId: appt.client_id,
    appointmentId: appt.id,
    // THE TODAY MATRIX. Two authorities, and the action must not contradict
    // either of them:
    //
    //   workflow true                      -> history present (Review)
    //   workflow false + prep treatment    -> history present (Review) — the
    //                                         prep loader PROVED it, so the
    //                                         new-client affordance would be
    //                                         a false claim
    //   workflow false + prep unavailable  -> NOT ASKED, neutral action; an
    //                                         unanswered read is not evidence
    //                                         of a new client
    //   workflow false + prep proved none  -> history absent (Open client)
    //
    // Off Today the question is never posed at all, which is the `asked:false`
    // branch the wrapper already owns.
    history: !historyAsked
      ? { asked: false }
      : prepSummary.unavailable && !(workflow?.hasHistory ?? false)
        ? { asked: false }
        : {
            asked: true,
            hasHistory:
              (workflow?.hasHistory ?? false) || prepSummary.hasTreatment,
          },
    sessionId: linkedSession?.sessionId ?? null,
    hasChartedArea: linkedSession?.hasChartedArea ?? false,
    hasEnded,
  });
  // Review intake: the direct route from Today into the canonical
  // practitioner intake-review surface, replacing the
  // Today -> client profile -> Health & Forms -> intake detour. Resolved from
  // `intakeStatus`, which is ALREADY loaded, no extra query, no wider read.
  // Null for in-progress and no-intake states, where the IntakePill below is
  // the truthful statement and there is nothing to review.
  const intakeAction = resolveTodayIntakeAction({
    status: intakeStatus,
    clientId: appt.client_id,
  });
  const time = formatTimeForStudio(new Date(appt.starts_at), tz, timeFormat);
  const endTime = formatTimeForStudio(new Date(appt.ends_at), tz, timeFormat);
  const performerName = appt.practitioner?.display_name?.trim();
  const performerColor = resolvePractitionerColor(appt.practitioner?.color);
  const modality = appt.service?.modality
    ? appt.service.modality
    : null;
  const serviceName = appt.service?.name ?? null;
  const showAllergyFlag = !!appt.client?.allergies;
  const chartHref = linkedSession
    ? `/clients/${appt.client_id}/sessions/${linkedSession.sessionId}`
    : appt.status === "confirmed" || appt.status === "completed"
      ? `/clients/${appt.client_id}/sessions/new?appointment_id=${encodeURIComponent(appt.id)}`
      : null;
  // Chloe: "a button for consultation notes so i can start them immediately
  // from dashboard". The label is derived from the SERVICE MODALITY ALREADY
  // LOADED for this row (zero queries), so "Start consultation notes" is only
  // claimed on the visit where a consultation note is actually about to be
  // written.
  const isConsultationVisit = appt.service?.modality === "consultation";
  // Only when the card status is a TRUSTED "no card": never for a client who
  // already has one, and never off an `unavailable` read.
  const offerPortalLink = shouldOfferPortalLink(cardOnFile);

  const clientLabel = appt.client ? clientDisplayName(appt.client) : "Client deleted";
  return (
    // PR #236: the row body still opens the appointment (calendar
    // detail), and a separate primary-action button sits beside it,
    // wrapping below the content on phones. No nested anchors.
    // CURRENT CLIENT (Chloe): a calm but unmissable accent — left rule + tint
    // + the solid "Current" pill below — so the person in the room is the
    // dominant row without shouting. The border replaces 4px of the left
    // padding (pl-3 + border-4 = the pl-4 the other rows use), so the time
    // column stays on the same vertical line and nothing shifts.
    <div
      id={`appointment-${appt.id}`}
      tabIndex={-1}
      data-testid={isCurrent ? "today-current-row" : undefined}
      data-current={isCurrent ? "true" : undefined}
      className={`group/visit scroll-mt-20 min-w-0 max-w-full flex flex-wrap items-start gap-x-3 gap-y-1 py-3 pr-4 ${
        isCurrent
          ? "border-l-4 border-l-blue-500 bg-blue-50 pl-3 hover:bg-blue-100/70 dark:border-l-blue-400 dark:bg-blue-950/40 dark:hover:bg-blue-950/60"
          : "pl-4 hover:bg-neutral-50 dark:hover:bg-neutral-900"
      }`}
    >
      {/* CHLOE D1, the row body is a link, so NOTHING interactive may live
          inside it.
          ----------------------------------------------------------------
          The Treatment Memory disclosure used to be rendered as the last child
          of the "Before today" block, which is inside this <Link>. Two things
          went wrong at once, and both look identical to the practitioner:

            1. the toggle's click bubbled to the ancestor <Link>, so pressing
               "View full last treatment" set the open state AND pushed
               /calendar/<id>, the region expanded and was then thrown away by
               a navigation she never asked for;
            2. once open, the embedded card rendered an <a> INSIDE an <a>,
               which is invalid HTML with undefined activation behaviour.

          stopPropagation() would only paper over (1), a nested anchor and a
          nested <button> are still invalid content for <a>, and native anchor
          activation is not a React synthetic event. So the disclosure is
          HOISTED OUT of the link instead, and sits directly beneath it in the
          same text column (pl-24 = the w-20 time cell + the gap-4), which
          is where it already appeared. The row body still opens the
          appointment; the disclosure is simply no longer part of it. */}
      {/* The row body owns the full width so long notes can wrap naturally.
          Visit details and checkout are independent controls in the footer. */}
        {/* UI-01C: PendingContainerLink, not Link. This is the LAST navigation
            on the Dashboard with no acknowledgement, and it was deliberately
            left out of UI-01A/B because the shipped PendingLink could not
            serve it: the row body is itself the flex container below, and
            PendingLink wraps children in one span, which would collapse the
            time cell and the text column into a single track.

            The container form adds nothing in flow — the scrim and the live
            region are both absolutely positioned, and an absolutely positioned
            child of a flex container is not a flex item — so these two
            children are laid out exactly as they were. `relative` comes from
            the component, not from here. */}
        <PendingContainerLink
          href={`/calendar/${appt.id}`}
          data-testid="today-row-body"
          pendingLabel="Opening appointment…"
          className="flex min-w-0 basis-full gap-3"
        >
          <div className="w-20 flex-none text-sm font-medium tabular-nums text-neutral-700 dark:text-neutral-300">
            <span>{time}</span>
            <span className="block text-xs font-normal text-neutral-500" data-testid="today-row-end-time">
              {endTime}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 text-xs leading-4">
              {/* An unbroken long name ellipsizes inside the row (min-w-0 / max-w-full all the way up
                  from here) and is never wider than the phone; the title carries the full name. */}
              <span
                className="min-w-0 max-w-full truncate text-sm font-medium leading-5"
                data-testid="today-row-client-name"
                title={clientLabel}
              >
                {clientLabel}
              </span>
              {todayBirthdayIds && (
                <Suspense fallback={null}>
                  <BirthdayTodayBadge clientId={appt.client_id} ids={todayBirthdayIds} />
                </Suspense>
              )}
              {isCurrent && <CurrentPill />}
              <AppointmentStatusPill status={appt.status} />
              {/* Beside the NAME, exactly where Chloe asked for it, and ahead
                  of the intake line in the reading order. A non-interactive
                  span, so it is safe inside the row-body link. */}
              {isOwner && <CardOnFilePill status={cardOnFile} />}
              {nextAction.chip && (
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] leading-3 font-medium uppercase tracking-wider ${
                    nextAction.chip === "Charting needed" || nextAction.chip === "Not finished"
                      ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                      : "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200"
                  }`}
                >
                  {nextAction.chip}
                </span>
              )}
              {/* Closed-state row (Insurance D-1): the intake status stays on the collapsed row, inline on
                  the name line where it fits (it wraps below the name when it does not). */}
              <IntakePill status={intakeStatus} />
            </div>
            {/* COMPACT ROW: service · modality · duration · practitioner on ONE line; allergy flag stays
                visible; everything else about the visit is in the details below the row. */}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              {/* A flex item: min-w-0 + overflow-wrap:anywhere let an unbroken service name wrap inside the card
                  (break-words alone does not lower a flex item's min-content width). */}
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                {serviceName && <span>{serviceName}</span>}
                {modality && <span>{serviceName ? " · " : ""}{modality}</span>}
                <span>
                  {(serviceName || modality) ? " · " : ""}
                  {appt.duration_minutes} min
                </span>
              </span>
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
            </div>
            {/* The lines that must stay visible on the CLOSED row (Insurance D-1/E-1): every pinned note in
                full, the failed-read marker, and the caution/watch line. They add only their own height. */}
            <RowSafetyLines
              pinnedNotes={appt.client ? null : pinnedNotes}
              unavailable={workflow ? workflow.unavailable : prepSummary.unavailable}
              caution={workflow && !workflow.unavailable && workflow.hasHistory ? workflow.caution : null}
              cautionSource={workflow && !workflow.unavailable && workflow.hasHistory ? workflow.notesSourceLabel : null}
              lastTreatment={prepSummary.hasTreatment ? prepSummary.compactSummary : null}
            />
          </div>
        </PendingContainerLink>
        {appt.client && (
          <div className="order-1 ml-[5.75rem] min-w-0 basis-full">
            <DashboardQuickPin
              clientId={appt.client_id}
              clientName={clientLabel}
              pinnedNotes={(pinnedNotes ?? []).map(({ id, text, created_by_practitioner_id }) => ({ id, text, created_by_practitioner_id }))}
              viewer={{ isOwner, practitionerId: viewerId }}
            />
          </div>
        )}
        <div data-testid="today-row-actions" className="order-1 ml-[5.75rem] flex min-w-0 basis-full flex-wrap items-center gap-2">
          {/* Quick checkout (owner): take payment from the roster without opening
              charting. Paid/Processing/Refunded show a status badge instead. */}
          {isOwner && (
            <AppointmentCheckoutCell
              appointmentId={appt.id}
              status={appt.status}
              paymentState={paymentState}
              dashboardStartsAt={appt.starts_at}
              dashboardVisitLabel={[clientLabel, serviceName, time].filter(Boolean).join(" · ")}
              dashboardCardOnFile={cardOnFile}
            />
          )}
          <PendingLink
            href={rebookHref}
            data-testid="today-rebook"
            pendingLabel="Opening calendar…"
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            Rebook
          </PendingLink>
          {chartHref && (
            <PendingLink
              href={chartHref}
              data-testid="today-chart"
              prefetch={false}
              pendingLabel="Opening chart…"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Chart
            </PendingLink>
          )}
          {(nextAction.href !== chartHref || nextAction.label === "Finish visit") && (
            <PendingLink
              href={nextAction.href}
              data-testid="today-next-action"
              pendingLabel="Opening…"
              className="inline-flex min-h-[44px] items-center px-2 text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
            >
              {nextAction.label}
            </PendingLink>
          )}
        </div>
        <div className="order-1 ml-[5.75rem] basis-full text-xs text-neutral-600 dark:text-neutral-400">
          <span className="font-medium">Upcoming session</span>{" · "}
          {nextVisit === "unavailable" ? "Couldn’t load upcoming sessions" : nextVisit ? (
            <PendingLink href={`/calendar/${nextVisit.id}`} pendingLabel="Opening appointment…" className="underline underline-offset-2">
              {localLongDate(new Date(nextVisit.starts_at), tz)} · {formatTimeForStudio(new Date(nextVisit.starts_at), tz, timeFormat)}
              <span className="block text-fg-muted">
                {[nextVisit.service?.name, `${nextVisit.duration_minutes} min`, nextVisit.practitioner?.display_name].filter(Boolean).join(" · ")}
              </span>
            </PendingLink>
          ) : "No upcoming session booked"}
        </div>
        <div data-testid="today-row-details" className="order-2 min-w-0 basis-full pl-1 sm:pl-[5.75rem]">
          {prepSummary.remember && (
            <p data-testid="dashboard-prep-remember" title={prepSummary.remember} className="whitespace-pre-wrap break-words text-xs leading-5 text-fg-muted">
              <span className="font-semibold">For this visit</span>{" · "}{prepSummary.remember}
            </p>
          )}
          {workflow && !workflow.unavailable && !workflow.hasHistory && !prepSummary.hasTreatment && !prepSummary.unavailable && (
            <p className="text-xs text-neutral-500">New client · No charted history yet</p>
          )}
          <div className="text-xs">
            {(prepSummary.hasTreatment || prepSummary.unavailable) && (
              <DashboardTreatmentMemory
                appointmentId={appt.id}
                clientId={appt.client_id}
                clientName={appt.client ? clientDisplayName(appt.client) : "this client"}
                timeZone={tz}
                summary={toDisclosureSummary(prepSummary)}
              />
            )}
          </div>
          {workflow && workflow.missingRecords.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {workflow.missingRecords.map(r => (
                <span key={r} data-testid="missing-record-chip" className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">{r}</span>
              ))}
            </div>
          )}
          {/* Secondary appointment tools stay reachable with the prior treatment closed. */}
          <div className="flex flex-wrap items-center justify-start gap-x-3 gap-y-1">
            {/* A practitioner: consultation notes in ONE TAP from the Dashboard. It
                NAVIGATES to the canonical practitioner writer
                (/clients/<id>?tab=treatment, client_clinical_notes) exactly as
                the appointment-side ConsultationNotesCard does. The
                consultation writer lives in the Treatment tab since #1300
                (the legacy ?tab=consultation link still redirects there). No modal, no
                drawer, no second textarea, no second note action, no second
                clinical-note loader — a second writer is precisely what this
                contract exists to prevent. */}
            <PendingLink
              href={`/clients/${appt.client_id}?tab=treatment`}
              data-testid="today-consultation-notes"
              pendingLabel="Opening client…"
              className="inline-flex min-h-[44px] items-center rounded-md px-0 py-1.5 text-xs font-medium text-neutral-600 sm:px-3 underline-offset-2 hover:text-neutral-900 hover:underline dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              {isConsultationVisit
                ? "Start consultation notes"
                : "Consultation notes"}
            </PendingLink>
            {intakeAction && (
              <PendingLink
                href={intakeAction.href}
                data-testid="today-review-intake"
                pendingLabel="Opening intake…"
                className="inline-flex min-h-[44px] items-center rounded-md px-0 py-1.5 text-xs font-medium text-neutral-600 sm:px-3 underline-offset-2 hover:text-neutral-900 hover:underline dark:text-neutral-400 dark:hover:text-neutral-100"
              >
                {intakeAction.label}
              </PendingLink>
            )}
            {/* Only for a TRUSTED "no card". Reuses the existing practitioner
                portal-link authority whole; sends nothing until she clicks. */}
            {offerPortalLink && (
              <TodayPortalLinkButton
                clientId={appt.client_id}
                clientHasEmail={!!appt.client?.email?.trim()}
                portalEnabled={portalEnabled}
              />
            )}
          </div>
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
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] leading-3 font-medium uppercase tracking-wider ${v.classes}`}
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
// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
function EmptyDayState({
  selectedDay,
  todayLocal,
}: {
  selectedDay: string;
  todayLocal: string;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-10 dark:border-neutral-700 dark:bg-neutral-900">
      {/* The TODAY branch returns the exact pre-existing literal, unchanged.
          The other branches exist because "No appointments today." is simply
          false when the briefing is showing another day. */}
      <p className="text-lg font-medium">
        {emptyDayMessage(selectedDay, todayLocal)}
      </p>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Use the quiet time to review the week or book an appointment.
      </p>
      {/* Single CTA: the "Book appointment" primary action already lives in
          the Appointments section header, so the empty state only offers the
          calendar view to avoid a duplicate Book appointment button. Same
          day-preserving href as that button — an empty day is exactly when a
          practitioner reaches for the calendar, and landing on the wrong week
          would be worst here. */}
      <div className="flex flex-wrap gap-2">
        <Link
          href={calendarHrefForDashboardDay({ selectedDay, todayLocal })}
          className="inline-flex min-h-[44px] items-center rounded-md border border-neutral-300 px-3 text-sm hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          View calendar
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only data helpers: kept inline because each is a narrow single-call-
// site SELECT/RPC against tables we already use elsewhere. Promoting them
// to lib/ would scatter the dashboard's "needs attention" wiring without
// reuse.
// ---------------------------------------------------------------------------
async function loadIntakeStatusByClient(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
  clientIds: ReadonlyArray<string>,
): Promise<Map<string, ClientIntakeForm["status"]>> {
  if (clientIds.length === 0) {
    return new Map<string, ClientIntakeForm["status"]>();
  }
  // ONE bounded, studio-scoped, RLS-backed read for EVERY client on the day,
  // never one query per appointment. The projection is deliberately narrow:
  // `responses` (the medical answers, the #518 acknowledgement, consent text)
  // is NEVER loaded here. Today only needs to know which row is current and
  // what state it is in; the answers belong on the review page.
  const { data, error } = await supabase
    .from("client_intake_forms")
    .select("client_id, status, created_at")
    .eq("studio_id", studioId)
    .in("client_id", clientIds as string[])
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    // DAT-002 N2: a fixed message; PostgREST text can echo the statement.
    throw new Error("Failed to load intake status");
  }
  // Hone's canonical current-intake rule (newest non-deleted row by
  // created_at), applied in memory across the batch by the shared pure helper
  // so Today can never disagree with the page its link opens.
  return selectCurrentIntakeByClient((data ?? []) as TodayIntakeRow[]);
}

async function countActiveServices(studioId: string): Promise<number> {
  // Use the existing helper; cheap, already cached at the page level.
  const services = await getActiveServices(studioId);
  return services.length;
}

// Display-safe payment posture for the To-do model's `payment_setup` item.
// Declared here, beside its loader: it is a DATA shape, and it outlived the
// inline "Needs attention" component that Part 2B replaced.
type PaymentStatusForDashboard = {
  hasAccount: boolean;
  livemode: boolean | null;
  onboardingCompleted: boolean;
  payoutsEnabled: boolean;
};

async function loadPaymentStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
): Promise<PaymentStatusForDashboard | typeof CHECK_UNAVAILABLE> {
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
        code: dbErrorCode(error),
        studioId,
        timestamp: new Date().toISOString(),
      }),
    );
    // WS-DB: a failed read is "unavailable", never "no payment item". The panel
    // says so instead of showing a clean list.
    return CHECK_UNAVAILABLE;
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
