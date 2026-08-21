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
import { resolveBirthdayColor } from "@/lib/birthday-colors";
import type { BirthdayReminderColor } from "@/lib/types/database";
import {
  addDays,
  formatTimeForStudio,
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
} from "@/lib/dashboard/next-action";
import {
  buildPreVisitPrep,
} from "@/lib/dashboard/prep/build-pre-visit-prep";
import {
  hasObservedPrepFact,
  type PreVisitPrep,
} from "@/lib/dashboard/prep/pre-visit-prep";
import { PreVisitPrepBlock } from "@/app/(app)/dashboard/pre-visit-prep-block";
import { getClientsNeedingAttention } from "@/lib/dashboard/clients-needing-attention";
import {
  loadLastChartedTreatmentsForClients,
} from "@/lib/sessions/last-treatment-loader";
import {
  buildAppointmentPrepMemory,
  prepMemoryInputFromTreatment,
} from "@/lib/sessions/appointment-prep-memory";
import { DashboardTreatmentMemory } from "./dashboard-treatment-memory";
import {
  toDashboardPrepSummary,
  toDisclosureSummary,
  type DashboardPrepSummary,
} from "@/lib/dashboard/dashboard-prep-summary";
// `lib/dashboard/today-workflow` is no longer imported here.
//
// On this page it only ever carried PREPARATION facts — hasHistory, remember,
// caution, setup, missingRecords — and nothing else: the row already receives
// its intake and charting state directly, and its priority/label fields were
// computed and never read. Those facts now come from the appointment-bounded
// projection above, so the module is off this path entirely.
//
// It is left on disk with its unit tests rather than deleted. Deleting it has a
// contract-test blast radius that belongs in its own change, exactly as with
// lib/dashboard/before-today-previews.ts.
import {
  resolveTodayIntakeAction,
  selectCurrentIntakeByClient,
  type TodayIntakeRow,
} from "@/lib/dashboard/today-intake";
import { getMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";
import { currentAppointmentIds } from "@/lib/dashboard/current-appointment";
import {
  loadCardOnFileForStudio,
  resolveCardOnFileStatus,
  shouldOfferPortalLink,
  type CardOnFileStatus,
} from "@/lib/payment-methods/card-on-file";
import { CardOnFilePill, CurrentPill } from "./today-status-pills";
import { TodayPortalLinkButton } from "./TodayPortalLinkButton";
import { getExpiringSterileItems } from "@/lib/record-keeping/queries";
import { DashboardTodoList } from "./todo-list";
import { buildDashboardTodo } from "@/lib/dashboard/todo-model";
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

/**
 * The appointment's OWN client row, as embedded on the roster select.
 *
 * A MANY-TO-ONE relation: one appointment has exactly one client, so this is
 * never a capped collection. Either the row came back — in which case its
 * scalars are authoritative and may license a missing-record chip — or it did
 * not, in which case NOTHING is claimed about the client's record.
 */
type PrepClientEmbed = Pick<
  Client,
  "id" | "name" | "allergies" | "pronouns" | "email" | "date_of_birth" | "phone" | "address"
>;

/**
 * The prep a row gets when the page holds no entry for it at all.
 *
 * Deliberately EMPTY rather than a "no history" shape: an absent map entry is a
 * page-level bug, not evidence about the client, and it renders nothing.
 */
const EMPTY_PREP: PreVisitPrep = { directRecordReminders: [] };

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
  //
  // `date_of_birth`, `phone` and `address` are here for the SAME reason and are
  // likewise never rendered: they are read on the server to decide whether a
  // record-completeness chip is licensed, and only the chip text crosses to the
  // browser. Widening this MANY-TO-ONE embed is what let the Dashboard delete a
  // separate `clients` query whose error was discarded — a query whose single
  // missing row turned into three false "missing from record" accusations
  // against a complete client record.
  client: PrepClientEmbed | null;
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
/** Divider between segments; the first segment carries no left border. */
const DAY_NAV_DIVIDE = " border-l border-neutral-300 dark:border-neutral-700";

export default async function DashboardPage({
  searchParams,
}: {
  // `day` is browser-controlled and Next hands repeated params through as an
  // array, so the type says so rather than lying about it.
  searchParams: Promise<{ period?: string; day?: string | string[] }>;
}) {
  const sp = await searchParams;
  // PR #208: practice-snapshot period filter. Default: this week.
  const period: DashboardPeriod = isDashboardPeriod(sp.period)
    ? sp.period
    : "week";
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
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
  const startUtc = utcInstantFromLocal(selectedDayLocal, "00:00", studio.timezone);
  const endUtc = utcInstantFromLocal(selectedDayEndLocal, "00:00", studio.timezone);

  // Today's appointments. Use a narrow inline SELECT so the dashboard
  // gets practitioner color + service modality + client allergies in
  // one trip without N+1 lookups.
  const { data: apptRows, error: apptErr } = await supabase
    .from("appointments")
    .select(
      "id, starts_at, ends_at, duration_minutes, status, client_id, client:clients(id, name, allergies, pronouns, email, date_of_birth, phone, address), service:services(id, name, modality), practitioner:practitioners!appointments_practitioner_same_studio_fk(id, display_name, color)",
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
    client: PrepClientEmbed | PrepClientEmbed[] | null;
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

  // The visible roster excludes cancelled appointments: they shouldn't
  // crowd a "what's today" briefing. Cancellation records remain on the
  // calendar week view, where context is appropriate.
  const visibleAppointments = dayAppointments.filter(
    (a) => a.status !== "cancelled",
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
  const [practitioners, pinnedByClient, intakeByClient, cardOnFileLoad] =
    await Promise.all([
      getPractitionersForStudio(studio.id),
      getLatestPinnedNoteByClient(studio.id, selectedDayClientIds),
      loadIntakeStatusByClient(supabase, studio.id, selectedDayClientIds),
      // Chloe: card-on-file status beside each name. Capability is asked
      // FIRST: a studio with no card-on-file route gets `null` and pays ZERO
      // card-status queries, because "no card" is not a truthful thing to say
      // about a client who was never able to add one. When it does apply, this
      // is ONE bounded read for today's UNIQUE client ids, so a client with two
      // appointments costs one lookup and the cost does not grow with the
      // schedule, and a failed read stays UNAVAILABLE — never "No card".
      loadCardOnFileForStudio(studio.id, selectedDayClientIds),
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
    // Birthday reminders: month-of-year only, derived from
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
  const apptIds = dayAppointments.map((a) => a.id);
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
  // visible appointments' payment state, no per-row query, no full history.
  const paymentStates = await getAppointmentPaymentStates(studio.id, apptIds, studio.timezone);

  // THE ONE historical read on the roster path.
  //
  // It used to be TWO. `getBeforeTodayPreviews` ran on Today only and supplied
  // the caution, the setup line and the record chips; this loader ran on every
  // day and supplied the previous treatment. That split is why a selected day
  // showed almost no preparation — and it was also, quietly, a correctness bug
  // on Today, because the Today-only pipeline asked a WEAKER question:
  //
  //   * no `before` bound at all, so a session that started earlier TODAY — or
  //     one belonging to a FUTURE booking — could supply "Remember"/"Caution"
  //   * no `record_status` filter, so a VOIDED session could supply them
  //   * no `excludeAppointmentId`, so the appointment's OWN session could be
  //     presented as the visit before it
  //   * `error` never bound on any of its four reads, so one failed query made
  //     the whole roster read as "new client"
  //
  // This loader asks the right question for every row on every day: each request
  // carries its OWN appointment boundary (`before` = that appointment's
  // starts_at) and its own exclusion, and it has no clock in it, so the answer
  // for a future day is derived exactly as today's is.
  //
  // Cost: TWO round-trips for the whole day, independent of how many
  // appointments it holds. Removing the second pipeline removed four queries
  // and three sequential waves from Today and cost nothing off it.
  const prepLoads = await loadLastChartedTreatmentsForClients({
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
  });

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
  const prepSummaryByAppointment = new Map<string, DashboardPrepSummary>();
  const prepByAppointment = new Map<string, PreVisitPrep>();
  for (const appt of visibleAppointments) {
    const load = prepLoads.get(appt.id) ?? null;
    const memory = load?.treatment
      ? buildAppointmentPrepMemory(prepMemoryInputFromTreatment(load.treatment))
      : null;
    const summary = toDashboardPrepSummary({
      memory,
      unavailable: load?.unavailable ?? false,
      // `narrative.plan` is the newest recorded "for next visit" note. The
      // loader builds it to survive both "nothing charted" and a failed block
      // read, so a note-only visit still reaches the practitioner.
      planNote: load?.narrative.plan?.text?.trim() || null,
    });
    prepSummaryByAppointment.set(appt.id, summary);

    // THE ROW'S PREPARATION, derived once, identically for every day.
    //
    // The client row handed in is this appointment's OWN to-one embed, not a
    // lookup into a map keyed by client id. That distinction is the whole point:
    // a map miss is indistinguishable from an incomplete record, whereas an
    // embed that did not come back is simply absent and licenses nothing.
    prepByAppointment.set(
      appt.id,
      buildPreVisitPrep({
        load,
        client: appt.client,
        compactSummary: summary.compactSummary,
      }),
    );
  }

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
    renderNow.toISOString(),
  );

  // PR #316: sterile items / probe lots expired or expiring within 30 days,
  // studio-scoped, for the on-dashboard "Supplies expiring" attention card.
  const expiringSupplies = await getExpiringSterileItems(studio.id, todayLocal);

  // Dashboard V2 Part 2B, the ONE To-do model.
  //
  // Everything below was already loaded for the four sub-sections this
  // replaces. `buildDashboardTodo` is PURE: no client, no query, no clock, no
  // model. It normalizes the four domains into one row grammar
  // (subject · reason · action), dedupes on domain identity, and orders by the
  // documented TODO_PRIORITY. Adding it costs ZERO additional round-trips.
  const dashboardTodo = buildDashboardTodo({
    assistant: followUpAssistant,
    attention: clientsNeedingAttention,
    supplies: expiringSupplies,
    metrics: practiceMetrics.actions,
    studio: {
      isOwner,
      intakesAwaitingReviewCount,
      activeServicesCount,
      paymentStatus,
    },
    todayLocal,
  });

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
        {/* `flex-wrap` matters: this header was the one multi-control row on
            the page without it, and it now carries day navigation beside the
            primary action. Without wrapping, 390px overflows horizontally. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {/* The heading names the day being shown. It says "Today" on the
                real present day, so the ordinary case reads exactly as before;
                it must not keep saying "Today" over another day's roster. */}
            <h2 className="text-lg font-medium">
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
            <DaySummary
              appointmentCount={visibleAppointments.length}
              clientCount={selectedDayClientIds.length}
            />
          </div>
          {/* Day navigation: server-rendered links, so the URL is shareable,
              browser Back works, and no client-side date state exists — this
              page deliberately holds ONE clock read and no timers. */}
          <nav aria-label="Change day" className={DAY_NAV_GROUP}>
            {canGoBack ? (
              <Link
                href={dashboardDayHref({
                  day: previousDay(selectedDayLocal),
                  todayLocal,
                  period,
                })}
                aria-label="Previous day"
                data-testid="dashboard-prev-day"
                className={DAY_NAV_SEGMENT}
              >
                ← Previous
              </Link>
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
                className={DAY_NAV_SEGMENT_DISABLED + DAY_NAV_DIVIDE}
              >
                Today
              </span>
            ) : (
              <Link
                href={dashboardDayHref({ day: todayLocal, todayLocal, period })}
                data-testid="dashboard-today"
                className={DAY_NAV_SEGMENT + DAY_NAV_DIVIDE}
              >
                Today
              </Link>
            )}
            {canGoForward ? (
              <Link
                href={dashboardDayHref({
                  day: nextDay(selectedDayLocal),
                  todayLocal,
                  period,
                })}
                aria-label="Next day"
                data-testid="dashboard-next-day"
                className={DAY_NAV_SEGMENT + DAY_NAV_DIVIDE}
              >
                Next →
              </Link>
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
          {/* The primary action in the appointments area is booking, not
              adding a client (Chloe: she'd never add a client here). Links
              to the calendar, where the quick-book flow lives — CARRYING the
              day being viewed, so stepping to a date and pressing the obvious
              book button does not silently land on today's week. */}
          <Link
            href={calendarHrefForDashboardDay({
              selectedDay: selectedDayLocal,
              todayLocal,
            })}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Book appointment
          </Link>
        </div>

        {visibleAppointments.length === 0 ? (
          <EmptyDayState selectedDay={selectedDayLocal} todayLocal={todayLocal} />
        ) : (
          <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {visibleAppointments.map((appt) => (
              <li key={appt.id}>
                <AppointmentRow
                  appt={appt}
                  prep={prepByAppointment.get(appt.id) ?? EMPTY_PREP}
                  viewingToday={viewingToday}
                  pinnedNoteText={
                    pinnedByClient.get(appt.client_id)?.text ?? null
                  }
                  intakeStatus={intakeByClient.get(appt.client_id) ?? null}
                  linkedSession={sessionByAppointment.get(appt.id) ?? null}
                  paymentState={paymentStates.get(appt.id) ?? "unavailable"}
                  historyAsked={viewingToday}
                  isCurrent={currentAppointmentIdSet.has(appt.id)}
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


      {/* ===================================================================
          TO DO: Dashboard V2 Part 2B.
          ===================================================================
          Part 1 put ONE heading over four independent products: "Action
          needed", "Follow-up assistant", "Supplies expiring" and "Needs
          attention". They still had four loaders, four row grammars, four
          empty states, and they asked for the same unresolved work more than
          once: most visibly "Aftercare not marked", which arrived both as a
          per-session row from the assistant and as a count tile computed over
          a different window in a different unit.

          Part 2B replaces the four visible sub-sections with ONE ordered list
          built from ONE normalized model:

              domain facts → lib/dashboard/todo-model.ts → one To-do list

          The domain loaders below are deliberately UNCHANGED: rewriting them
          would expand scope, and NO query was added: `buildDashboardTodo` is
          pure and consumes results the page already had. Deduplication is on
          domain identity (`kind:subjectId`), never on rendered text; ordering
          is documented in TODO_PRIORITY. Every action that worked before is
          carried through unchanged, including the assistant's deep links to a
          specific session or appointment. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">To do</h2>
        <DashboardTodoList todo={dashboardTodo} />
        {/* DASH-TRUTH-04: the quiet pilot feedback footer is gone from To do
            as well. See the note at the foot of this file. */}
      </section>

      {/* Relationship context, BELOW the operational work, never above it. */}
      <BirthdaysThisMonth
        birthdays={birthdaysThisMonth}
        today={todayLocal}
        accentColor={studio.birthday_reminder_color}
      />

      {/* ===================================================================
          Secondary: reporting and setup, below the operational hierarchy.
          ===================================================================
          PR #208's practice snapshot (period filter + appointment counts +
          service value + test-mode payment posture). It is REPORTING, so it is
          demoted below Today / To do / Birthdays rather than removed: the
          owner-only Financials route that will eventually own service value and
          payment posture does not exist yet, and deleting the only surface that
          shows them before their replacement exists would destroy working
          functionality. Nothing here was recomputed, renamed or duplicated,
          the only change to its numbers in this PR is the Sunday week
          boundary correction in resolvePeriodRange. */}
      <PracticeSnapshot
        metrics={practiceMetrics}
        livemode={inferStripeLivemode()}
        selectedDay={selectedDayLocal}
        todayLocal={todayLocal}
      />

      {/* CHLOE D2, setup that is DONE is not daily work.
          ------------------------------------------------------------------
          This card used to render in both states. Once every required item was
          satisfied it became a permanent "Booking page ready / Your public
          booking page is live" banner plus a column of ticks: a congratulation
          occupying the daily workspace forever.

          The gate is `readiness.status`, the EXISTING derived authority
          (lib/booking/readiness.ts). No new flag, no new column, no new query:
          `computeBookingReadiness` is already computed above for this card, and
          "ready" already means "every required item is satisfied". The card
          itself also returns null in that state, so the contract holds for any
          future caller and not only for this call site. */}
      {isOwner && bookingReadiness && bookingReadiness.status !== "ready" && (
        <BookingSetupCard readiness={bookingReadiness} />
      )}

      {/* PR #215: setup/readiness checklist entry point. A normal
          link card, never a blocking modal. PR #238: shown only while
          auto-detected steps remain; the full checklist always lives on
          /getting-started. Demoted out of the operational flow: setup is not
          daily work. */}
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

      {/* CHLOE D3, a finished checklist is not a dashboard card.
          ------------------------------------------------------------------
          PR #238 collapsed completed setup into a quiet footer reading "Setup
          complete. Getting started checklist →". Chloe's report is that the
          Dashboard says setup is complete AND still offers her the setup
          checklist; the footer is that contradiction in one line. When
          `setupComplete` is true the Dashboard now renders NOTHING here.

          Getting Started is not deleted and is not harder to find on purpose:
          /getting-started is a permanent route and is linked from the account
          menu (app/(app)/AccountMenu.tsx) and the mobile menu
          (app/(app)/MobileMenu.tsx). It is available deliberately rather than
          presented daily.

          The INCOMPLETE branch above is untouched: a studio that still has
          auto-detected steps outstanding keeps its progress card, so new-studio
          onboarding is unaffected. Onboarding v2 already hides its own pinned
          card once `model.isComplete` (see OnboardingSurface), so both systems
          now agree: no completed-setup card on the daily Dashboard.

          CHLOE D4, the "Pilot learning" card ("…Send it to Sam", "Send
          feedback", "Know another electrologist?") was PR #250 pilot tooling
          and no longer belongs in a practitioner's daily workspace. It was
          removed earlier and its component file deleted.

          DASH-TRUTH-04 finishes the job: the two quiet <PilotFeedbackPrompt>
          footers that survived under Today and To do are now gone too. The
          daily product no longer routes practitioner feedback directly to Sam.
          The PilotFeedbackPrompt component and the shared
          buildPilotFeedbackMailto helper are deliberately NOT deleted: this
          requirement is Dashboard-specific, and a census found no other live
          consumer to break, so removing the shared helper would be a wider
          decision than this tranche was asked to make. */}
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
  // the sentence appeared twice: once under the heading and once in the card
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
  prep,
  viewingToday,
  pinnedNoteText,
  intakeStatus,
  linkedSession,
  paymentState,
  prepSummary,
  historyAsked,
  isCurrent,
  cardOnFile,
  tz,
  timeFormat,
}: {
  appt: TodayAppointment;
  // The ONE derived preparation model for THIS appointment (keyed by
  // appointment id, so two same-client appointments never share a card).
  //
  // Positive-evidence only: every field is optional and an absent field renders
  // nothing. There is no member of this type that means "this client has no
  // history", which is what makes a capped or failed read unable to produce a
  // clinical denial on this row.
  prep: PreVisitPrep;
  // Chooses the section's temporal wording ONLY. The same evidence must produce
  // the same prep facts on both Today and any other selected day.
  viewingToday: boolean;
  pinnedNoteText: string | null;
  intakeStatus: ClientIntakeForm["status"] | null;
  linkedSession: { sessionId: string; hasChartedArea: boolean } | null;
  paymentState: AppointmentPaymentState;
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
  // Three states, never two. `unavailable` means the card read failed, which is
  // NOT the same claim as "this client has no card".
  // `null` = this studio has no card-on-file route, so the row asks no card
  // question at all: no pill, no nudge. Distinct from `unavailable`, which
  // means the question applies but the read failed.
  cardOnFile: CardOnFileStatus | null;
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
    // THE HISTORY QUESTION, asked ONE way.
    //
    // There used to be two authorities here and a four-case matrix to stop them
    // contradicting each other. One of them (the Before-Today workflow) could
    // only answer with a boolean, so an unread window and an empty history were
    // the same answer, and the matrix existed to stop that boolean calling a
    // ten-year client new.
    //
    // Now there is one rule, and it is POSITIVE: did we actually observe a prep
    // fact for this appointment?
    //
    //   observed something -> asked, and the answer is yes  ("Review Before Today")
    //   observed nothing   -> NOT ASKED                     (the neutral "Open client")
    //
    // The `{ asked: true, hasHistory: false }` branch is deliberately
    // unreachable from this page: proving a client HAS no history needs a
    // complete read of their history, which the Dashboard never performs and
    // does not need to. Both arms already resolve to a neutral affordance, so
    // dropping it changes no label a practitioner sees — it only stops the page
    // asserting something it cannot know.
    history:
      historyAsked && hasObservedPrepFact(prep)
        ? { asked: true, hasHistory: true }
        : { asked: false },
    sessionId: linkedSession?.sessionId ?? null,
    hasChartedArea: linkedSession?.hasChartedArea ?? false,
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
  const performerName = appt.practitioner?.display_name?.trim();
  const performerColor = resolvePractitionerColor(appt.practitioner?.color);
  const modality = appt.service?.modality
    ? appt.service.modality
    : null;
  const serviceName = appt.service?.name ?? null;
  const showAllergyFlag = !!appt.client?.allergies;
  // Chloe: "a button for consultation notes so i can start them immediately
  // from dashboard". The label is derived from the SERVICE MODALITY ALREADY
  // LOADED for this row (zero queries), so "Start consultation notes" is only
  // claimed on the visit where a consultation note is actually about to be
  // written.
  const isConsultationVisit = appt.service?.modality === "consultation";
  // Only when the card status is a TRUSTED "no card": never for a client who
  // already has one, and never off an `unavailable` read.
  const offerPortalLink = shouldOfferPortalLink(cardOnFile);

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
      data-testid={isCurrent ? "today-current-row" : undefined}
      data-current={isCurrent ? "true" : undefined}
      className={`flex flex-wrap items-start justify-between gap-3 py-4 pr-4 ${
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
          same text column (pl-[4.5rem] = the w-14 time cell + the gap-4), which
          is where it already appeared. The row body still opens the
          appointment; the disclosure is simply no longer part of it. */}
      <div className="flex min-w-0 flex-1 basis-64 flex-col">
        <Link
          href={`/calendar/${appt.id}`}
          className="flex min-w-0 gap-4"
        >
          <div className="w-14 flex-none text-sm font-medium tabular-nums text-neutral-700 dark:text-neutral-300">
            {time}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="truncate font-medium">
                {appt.client?.name ?? "Client deleted"}
              </span>
              {isCurrent && <CurrentPill />}
              <AppointmentStatusPill status={appt.status} />
              {/* Beside the NAME, exactly where Chloe asked for it, and ahead
                  of the intake line in the reading order. A non-interactive
                  span, so it is safe inside the row-body link. */}
              <CardOnFilePill status={cardOnFile} />
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
            {/* PREPARATION.
                ONE block, ONE model, both days. Only the section label changes
                with the day; the facts do not, because the same evidence must
                produce the same preparation whether the practitioner opens this
                appointment today or three days before it. */}
            <PreVisitPrepBlock prep={prep} viewingToday={viewingToday} />
          </div>
        </Link>
        {/* Dashboard V2 Part 2A: the previous treatment in place. Compact by
            default (one line naming the visit) and expandable to the complete
            #517 card WITHOUT leaving Today. Rendered only for a client who HAS
            history, so a first visit stays a single calm relationship line.

            GATED ON ITS OWN LOADER. The gate was once `workflow?.hasHistory`,
            which is null off Today by construction, so this region vanished on
            exactly the days a practitioner opens to PREPARE. It asks the prep
            loader's own three-state answer: a treatment, or a truthful "could
            not be loaded", or silence. Silence is never rendered as a claim
            about the client.

            CHLOE D1: it is a SIBLING of the row-body link, never a descendant.
            The left padding lines it up with the text column above it (w-14
            time cell + gap-4), so it reads as the last line of "Before today"
            exactly as it did before: it simply is no longer inside a control
            that navigates. */}
        {/* The plan note is NOT rendered again here.
            It used to be: Today printed it from the Before-Today model inside
            the row body, and every other day printed it from the prep loader
            here, under a `!workflow` guard. Two renderers meant two authorities
            — and they disagreed, because the Today one had no appointment bound.
            `PreVisitPrepBlock` above is now the single "Remember" on every day,
            which is also what makes "exactly once" assertable. */}
        {(prepSummary.hasTreatment || prepSummary.unavailable) && (
          <div className="pl-[4.5rem] text-xs">
            <DashboardTreatmentMemory
              appointmentId={appt.id}
              clientId={appt.client_id}
              clientName={appt.client?.name ?? "this client"}
              /* The NARROW projection. `prepSummary` also carries the plan
                 note, which the server renders itself and only off Today —
                 passing the whole object crossed that note to the browser on
                 Today, where nothing displays it. */
              summary={toDisclosureSummary(prepSummary)}
            />
          </div>
        )}
      </div>
      {/* ONE compact appointment footer. `gap-1` and `self-start` replace
          `gap-2` + `self-center`: on a phone this column wraps onto its own
          full-width line, where centring it against a tall text column opened
          dead space above and below with nothing in it. */}
      <div className="flex flex-col items-end gap-1 self-start">
        {/* Quick checkout (Chloe): take payment from the roster without opening
            charting. Paid/Processing/Refunded show a status badge instead. */}
        <AppointmentCheckoutCell
          appointmentId={appt.id}
          status={appt.status}
          paymentState={paymentState}
        />
        <Link
          href={nextAction.href}
          /* `min-h-[44px]` — this was the ONE control in the action area below
             the touch target, at 34px, while all three SECONDARY actions were
             already 44px. The most important control on the row was the
             hardest to hit. */
          className="inline-flex min-h-[44px] items-center rounded-md border border-neutral-300 px-3 text-xs font-medium text-neutral-700 hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-100 dark:hover:bg-neutral-900"
        >
          {nextAction.label}
        </Link>
        {/* Secondary by design: borderless, so it never competes with the
            resolved primary action (Start/Continue charting) or the checkout
            cell above it. Sibling of the row-body link, never nested inside
            it. */}
        {/* SECONDARY STRIP. One wrapping line rather than a stack of buttons:
            each item is quiet, borderless, and never competes with the resolved
            primary action or the checkout cell above. Every item here is a
            SIBLING of the row-body link, never nested inside it. */}
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {/* Chloe: consultation notes in ONE TAP from the Dashboard. It
              NAVIGATES to the canonical practitioner writer
              (/clients/<id>?tab=consultation, client_clinical_notes) exactly as
              the appointment-side ConsultationNotesCard does. No modal, no
              drawer, no second textarea, no second note action, no second
              clinical-note loader — a second writer is precisely what this
              contract exists to prevent. */}
          <Link
            href={`/clients/${appt.client_id}?tab=consultation`}
            data-testid="today-consultation-notes"
            className="inline-flex min-h-[44px] items-center rounded-md px-3 py-1.5 text-right text-xs font-medium text-neutral-600 underline-offset-2 hover:text-neutral-900 hover:underline dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            {isConsultationVisit
              ? "Start consultation notes"
              : "Consultation notes"}
          </Link>
          {intakeAction && (
            <Link
              href={intakeAction.href}
              data-testid="today-review-intake"
              className="inline-flex min-h-[44px] items-center rounded-md px-3 py-1.5 text-right text-xs font-medium text-neutral-600 underline-offset-2 hover:text-neutral-900 hover:underline dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              {intakeAction.label}
            </Link>
          )}
          {/* Only for a TRUSTED "no card". Reuses the existing practitioner
              portal-link authority whole; sends nothing until she clicks. */}
          {offerPortalLink && (
            <TodayPortalLinkButton
              clientId={appt.client_id}
              clientHasEmail={!!appt.client?.email?.trim()}
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
    throw new Error(`Failed to load intake status: ${error.message}`);
  }
  // Hone's canonical current-intake rule (newest non-deleted row by
  // created_at), applied in memory across the batch by the shared pure helper
  // so Today can never disagree with the page its link opens.
  return selectCurrentIntakeByClient((data ?? []) as TodayIntakeRow[]);
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

// Birthdays this month: practitioner-facing only. Renders nothing when
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
  // Studio-chosen accent (migration 0040). Never red/rose, that's
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
