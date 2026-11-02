import { Suspense } from "react";
import Link from "next/link";

import type { NewClientReadiness } from "@/lib/booking/new-client-readiness";
import { BookingSetupCard } from "./BookingSetupCard";
import { PersonalChartingCard } from "./personal-charting-card";
import type { ChartedWithin24hMetrics } from "@/lib/dashboard/practice-metrics";
import { SetupStateNotice } from "./setup-state-notice";
import { buildSetupCardState } from "@/lib/dashboard/setup-card-model";
import { STAFF_MANAGED_UNKNOWN } from "@/lib/dashboard/staff-managed";
import { getClientBirthdaysForMonth } from "@/lib/clients/birthday-queries";
import { resolveBirthdayColor } from "@/lib/birthday-colors";
import type { BirthdayReminderColor, Studio } from "@/lib/types/database";
import { ChartedWithin24hCard, PracticeSnapshot } from "./practice-snapshot";
import {
  getPracticeDashboardMetrics,
  PROCEDURE_RECORD_WINDOW,
  type ProcedureActionMetrics,
} from "@/lib/dashboard/practice-metrics";
import { getClientsNeedingAttention } from "@/lib/dashboard/clients-needing-attention";
import { getMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";
import { getExpiringSterileItems } from "@/lib/record-keeping/queries";
import { NeedsAttentionPanel } from "./needs-attention-panel";
import { buildDashboardTodo } from "@/lib/dashboard/todo-model";
import {
  buildNeedsAttention,
  CHECK_UNAVAILABLE,
} from "@/lib/dashboard/needs-attention-model";
import type { IntakeAwaitingReview } from "@/lib/dashboard/intakes-awaiting-review";
import {
  buildGettingStarted,
  getGettingStartedSignals,
} from "@/lib/onboarding/getting-started";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { Skeleton } from "@/components/ui/skeleton";

// PERF-01C — the Dashboard's SECONDARY STACK, moved off the critical path.
//
// WHAT THIS IS
// ------------
// To do, Birthdays, the practice snapshot and the setup cards, lifted verbatim
// out of the page's return so they can arrive AFTER the day's roster instead of
// in front of it. Nothing about what they read, what they render, or who may
// read it changes. This is a rendering-order change and nothing else.
//
// WHY IT IS SAFE TO LIFT: every value below is consumed HERE and nowhere else.
// That was established mechanically, not by eye — no roster surface reads the
// attention sources, the practice metrics, the attention list, the assistant,
// expiring supplies or the getting-started signals.
//
// THE PART THAT IS EASY TO GET WRONG
// ----------------------------------
// This component does NOT start its own reads. It receives promises that
// PERF-01B (#655) already started in the page, before the roster query, and it
// awaits them here. Creating them in this component instead would delay every
// one of them until the parent had finished rendering — strictly worse than the
// serial code PERF-01B replaced. The promises are props for that reason, and it
// is the reason the props are typed as Promise<...> rather than as values.
//
// `settleLater` in the page already attaches a no-op catch to each of them, so
// widening the window between "started" and "awaited" — which is exactly what
// streaming does — cannot turn a rejection into an unhandled one. The await
// below still throws, and still reaches the error boundary.

// The FOUR values the page's `attentionSourcesPromise` resolves to, in order.
//
// It was five. ONB-03 removed the raw availability read: the canonical authority
// performs its own, correctly scoped, and a member nothing consumed could still
// reject and take the whole bundle -- and therefore readiness -- down with it.
// Each slot is DERIVED from the thing that actually produces or consumes it, so
// this cannot drift from the page without a type error: the payment slot is
// spelled as the exact field `buildDashboardTodo` reads, because that is its
// only consumer and `loadPaymentStatus` is private to the page module.
type AttentionSources = readonly [
  // R3: the clients whose CURRENT intake is awaiting review (not a row count).
  // `unavailable` = the intake read failed or hit its ceiling (this one count
  // only; the rest of Needs attention still renders).
  ReadonlyArray<IntakeAwaitingReview> | typeof CHECK_UNAVAILABLE,
  number,
  // `unavailable` = the owner's payment read failed (not "no payment setup").
  | Parameters<typeof buildDashboardTodo>[0]["studio"]["paymentStatus"]
  | typeof CHECK_UNAVAILABLE,
  Awaited<ReturnType<typeof getClientBirthdaysForMonth>>,
];

type Props = {
  /** Started in the page BEFORE the roster query. Never started here. */
  attentionSources: Promise<AttentionSources>;
  /** HON-65: own deferred read (never throws; false on any error). */
  staffManaged: Promise<boolean>;
  /** A practitioner's own charting figure; `null` for the owner (not read). */
  personalCharting: Promise<ChartedWithin24hMetrics | typeof CHECK_UNAVAILABLE | null>;
  /** The same read, with a failure kept distinct (`unknown`). */
  staffManagedRead: Promise<boolean | typeof STAFF_MANAGED_UNKNOWN>;
  /**
   * The canonical verdict, as a promise, resolved by the page ALONGSIDE the
   * bundle above rather than inside it.
   *
   * `null` for a non-owner: the card is owner-only and a non-owner should pay for
   * no readiness read at all.
   */
  bookingReadiness: Promise<NewClientReadiness | null>;
  // `null` for a non-owner: the loader never runs for them.
  practiceMetrics: Promise<Awaited<
    ReturnType<typeof getPracticeDashboardMetrics>
  > | null>;
  gettingStartedSignals: Promise<
    Awaited<ReturnType<typeof getGettingStartedSignals>>
  >;
  studio: Studio;
  isOwner: boolean;
  /**
   * The PURE scalar from the page (`isOwner && studio.onboarding_v2_enabled`).
   * It gates the getting-started card only. Deliberately NOT the onboarding
   * model: that read stays in the page, above the roster, untouched.
   */
  onboardingV2On: boolean;
  todayLocal: string;
  selectedDayLocal: string;
};

/**
 * THE FALLBACK. It says nothing, and that is the whole specification.
 *
 * Every card this stands in for renders a claim about the studio: a To-do list,
 * a birthday list, appointment counts, service value, a setup-progress
 * fraction. An empty To-do list means "nothing needs doing". A zero means zero.
 * "Getting started 4 of 4" means setup is finished. None of those are known
 * while the reads are in flight, so none of them may appear here — not as text,
 * not as a number, not as a dash standing in for a number.
 *
 * It also may NOT reuse the clinical "couldn't load" copy. That sentence
 * asserts a read FAILED, which is false while it is still running. Loaded,
 * absent and unavailable were three states; pending is a fourth, and it is the
 * only one with nothing to say.
 *
 * So: bars, cut to the shape of the cards they replace. `Skeleton` is already
 * `aria-hidden`, and its own contract puts the "this region is loading"
 * statement on the CONTAINER — which is the `aria-busy` region below, announced
 * once, rather than a dozen meaningless placeholders.
 *
 * Heights are deliberate, not decorative: they hold the settled stack's space
 * so the roster above never moves when this arrives. Nothing here is
 * interactive, so nothing can shift under a thumb mid-tap.
 */
export function SecondaryStackSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-live="off"
      data-testid="secondary-stack-pending"
      className="flex flex-col gap-10"
    >
      <section className="flex flex-col gap-3">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </section>
      <section className="flex flex-col gap-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-12 w-full" />
      </section>
      <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-full" />
      </section>
    </div>
  );
}

// Birthdays, top-right on desktop (the page places it; this is its own boundary). Same data as before:
// the birthdays bundle the page started before the roster, so no read is added or moved.
async function BirthdaysFromBundle({
  attentionSources,
  today,
  accentColor,
}: {
  attentionSources: Promise<AttentionSources>;
  today: string;
  accentColor: BirthdayReminderColor;
}) {
  const [, , , birthdaysThisMonth] = await attentionSources;
  return (
    <BirthdaysThisMonth
      birthdays={birthdaysThisMonth}
      today={today}
      accentColor={accentColor}
    />
  );
}

export function BirthdaysTopRight(props: {
  attentionSources: Promise<AttentionSources>;
  today: string;
  accentColor: BirthdayReminderColor;
}) {
  return (
    <div className="min-w-0 lg:col-start-2 lg:row-start-1">
      <Suspense fallback={null}>
        <BirthdaysFromBundle {...props} />
      </Suspense>
    </div>
  );
}

export async function SecondaryStack({
  staffManaged: staffManagedPromise,
  staffManagedRead: staffManagedReadPromise,
  personalCharting: personalChartingPromise,
  bookingReadiness,
  practiceMetrics: practiceMetricsPromise,
  gettingStartedSignals: gettingStartedSignalsPromise,
  studio,
  isOwner,
  onboardingV2On,
  todayLocal,
  selectedDayLocal,
}: Props) {
  // Birthdays ride in the same bundle the page started before the roster. The
  // To do / Needs attention sources are consumed by NeedsAttentionSection.
  const staffManaged = await staffManagedPromise;
  const personalCharting = await personalChartingPromise;
  const staffManagedUnknown = (await staffManagedReadPromise) === STAFF_MANAGED_UNKNOWN;

  // ONB-03: THE CANONICAL AUTHORITY, AWAITED INDEPENDENTLY (unchanged: the page
  // starts it as its own deferred read, so a sibling rejection cannot stop the
  // verdict, and `unknown` can still render).
  const readiness = await bookingReadiness;

  // PR #208: read-only practice metrics for the selected period.
  const practiceMetrics = await practiceMetricsPromise;

  // PR #215: Getting Started progress for the dashboard card.
  const gettingStartedSignals = await gettingStartedSignalsPromise;
  const gettingStarted = buildGettingStarted(gettingStartedSignals);
  const setupCard = buildSetupCardState({ isOwner, readiness, studio });

  // PR #238 (Chloe pilot): once every auto-detected setup step is done, the
  // Getting started card stops occupying the prime spot.
  const setupComplete =
    gettingStarted.autoTotal > 0 &&
    gettingStarted.autoDone === gettingStarted.autoTotal;

  // OWNER-CAP Slice 1: the owner's capacity briefing. A LINK, not a card: the figures on it are
  // studio-wide practice analytics an ordinary practitioner must not be shown, and the page refuses
  // them server-side before issuing a single analytics read. Rendered only under `isOwner` above.
  const capacityLink = (
    <Link
      href="/dashboard/capacity"
      className="flex items-baseline justify-between gap-3 border-t border-neutral-200 pt-4 text-sm hover:text-neutral-900 dark:border-neutral-800 dark:hover:text-neutral-100"
    >
      <span className="font-medium">Practice capacity</span>
      <span className="text-fg-muted">
        Who is in treatment, and who has no treatment booked &rarr;
      </span>
    </Link>
  );

  return (
    <div className="flex flex-col gap-10">
      {/* ===================================================================
          Secondary: reporting and setup, below the operational hierarchy.
          ===================================================================
          PR #208's practice snapshot (period filter + appointment counts +
          service value + test-mode payment posture). It is REPORTING, so it is
          demoted below Today / To do / Birthdays rather than removed: the
          owner-only Financials route that will eventually own service value and
          payment posture does not exist yet, and deleting the only surface that
          shows them before their replacement exists would destroy working
          functionality. */}
      {/* WS-D (settings redesign): the Practice Snapshot is OWNER-ONLY. It is a server component, so for any other role nothing of it,
          not its counts, period filter or copy, is rendered into the response. the metrics loader itself no longer runs for a non-owner (WS-DB); the roll-up they need comes from `getProcedureActionMetrics`. */}
      {isOwner && staffManagedUnknown && (
        <p
          role="status"
          data-testid="staff-managed-unknown"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
        >
          Could not read your client cancel and reschedule settings just now.
          Figures below use the standard view and may include items (such as
          late cancellations) that your settings would hide.
        </p>
      )}
      {/* ONE integrated card: the snapshot, then the owner's capacity link as its last row (passed as
          children). When the metrics could not load the link still renders on its own, as before. */}
      {isOwner && practiceMetrics && (
        <PracticeSnapshot
          metrics={practiceMetrics}
          livemode={inferStripeLivemode()}
          selectedDay={selectedDayLocal}
          todayLocal={todayLocal}
          staffManaged={staffManaged}
        >
          {capacityLink}
        </PracticeSnapshot>
      )}
      {isOwner && !practiceMetrics && capacityLink}

      {/* FIDELITY F, the lower row: Charting (the owner's studio-wide "Charted within 24h", or a
          practitioner's own figure) beside the booking card. Both were already live further down the
          page; they are MOVED here, not duplicated. The booking card keeps its truthful wording
          (an intentional pause reads "That is your setting, not unfinished setup", never a setup
          warning), and the incomplete-setup checklist stays its own separate card. */}
      <div data-testid="dashboard-lower-row" className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
        {!isOwner && personalCharting !== null && (
          <PersonalChartingCard
            metrics={personalCharting === CHECK_UNAVAILABLE ? null : personalCharting}
          />
        )}
          {isOwner && practiceMetrics && <ChartedWithin24hCard metrics={practiceMetrics} />}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
      {/* CHLOE D2, setup that is DONE is not daily work.
            ------------------------------------------------------------------
            This card used to render in both states. Once every required item was
            satisfied it became a permanent "Booking page ready" banner plus a
            column of ticks: a congratulation occupying the daily workspace
            forever.

            ONB-03: the gate is the CANONICAL authority
            (lib/booking/new-client-readiness.ts), the same one /settings/launch
            consumes, so the two owner surfaces cannot disagree. No new flag and
            no new column.

            `status !== "ready"` INCLUDES "unknown" ON PURPOSE. Unknown means an
            authority could not be read, so nobody has evidence this studio is
            ready -- hiding the card would assert exactly that. The card renders a
            distinct unknown state rather than an empty checklist, and it returns
            null itself for "ready", so the contract holds for any future caller
            and not only for this call site. */}
        {/* WS-DB: the owner's choice to pause new-client booking is its own
            state, not a "to-do" checklist, and a ready studio with launch items
            open gets a one-line pointer to /settings/launch. */}
        <SetupStateNotice state={setupCard} />
        {isOwner &&
          readiness &&
          readiness.status !== "ready" &&
          setupCard.kind !== "paused_by_owner" && (
            <BookingSetupCard readiness={readiness} staffManaged={staffManaged} />
          )}
        </div>
      </div>

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
            {gettingStartedSignals.nextStepSignalsAvailable
              ? `${gettingStarted.autoDone} of ${gettingStarted.autoTotal} steps complete →`
              : "Some steps could not be checked just now →"}
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

// Birthdays this month: practitioner-facing only. Renders nothing when
// the studio has no clients with a birthday in the current month so the
// dashboard stays quiet. Each row links to the client profile so the
// practitioner can pull up context before wishing them a happy birth
// month.
//
// Never sent as email/SMS. Never exposed to client/public surfaces.
//
// PERF-01C moved this here from the page, unchanged, because it is rendered
// only by this stack and a page module cannot export it to a child without an
// import cycle.
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

  // WS-DB: compact. One wrapped line of chips instead of a card per person, so a
  // month with many birthdays no longer pushes the setup cards off the screen.
  // Same data, same links (`?tab=personal`), same studio accent; today's
  // birthdays still carry the "Today" badge.
  // Compact, top-right: the first few are always visible (today's birthdays first); the rest stay one
  // click away inside a server-rendered <details>, so nobody is dropped. Nothing is sent to anyone.
  const ordered = [
    ...birthdays.filter((b) => b.day === todayDay),
    ...birthdays.filter((b) => b.day !== todayDay),
  ];
  const VISIBLE = 4;
  const shown = ordered.slice(0, VISIBLE);
  const rest = ordered.slice(VISIBLE);
  const chip = (b: (typeof birthdays)[number]) => {
    const isToday = b.day === todayDay;
    return (
      <li
        key={b.id}
        className={`flex items-baseline gap-2 rounded-full border px-3 py-1.5 ${accent.card}`}
      >
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
      </li>
    );
  };
  return (
    <section data-testid="dashboard-birthdays" className="flex min-w-0 flex-col gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="text-lg font-medium">Birthdays this month</h2>
      <ul className="flex flex-wrap gap-2">{shown.map(chip)}</ul>
      {rest.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-neutral-600 dark:text-neutral-400">
            {rest.length} more this month
          </summary>
          <ul className="mt-2 flex flex-wrap gap-2">{rest.map(chip)}</ul>
        </details>
      )}
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


// ---------------------------------------------------------------------------
// NEEDS ATTENTION (dashboard redesign, WS-DB).
//
// Replaces the flat "To do" list with ONE entry per client + session (pure model:
// lib/dashboard/needs-attention-model.ts). It consumes the SAME promises the page
// started before the roster query, so no read moved and none was added; the only
// new read is the per-client intake list, which REPLACES the old intake count
// (R3: newest-intake rule, see lib/dashboard/intakes-awaiting-review.ts).
//
// A rejection in any source throws here, through the route error boundary: the
// panel never turns a failed read into "nothing needs attention".
// ---------------------------------------------------------------------------
type NeedsAttentionInputs = {
  attentionSources: Promise<AttentionSources>;
  staffManaged: Promise<boolean>;
  procedureActions: Promise<ProcedureActionMetrics>;
  upcomingVisitClients: Promise<ReadonlySet<string> | typeof CHECK_UNAVAILABLE>;
  clientsNeedingAttention: Promise<
    Awaited<ReturnType<typeof getClientsNeedingAttention>>
  >;
  followUpAssistant: Promise<
    Awaited<ReturnType<typeof getMissingRecordsAssistant>>
  >;
  expiringSupplies: Promise<
    Awaited<ReturnType<typeof getExpiringSterileItems>>
  >;
  isOwner: boolean;
  todayLocal: string;
};

// Named unavailable checks of the Needs attention panel. Only payment setup and expiring supplies add
// studio items; every other check contributes client cards, so a count taken without one is not a count.
const UNAVAILABLE_INTAKE_REVIEW = "intake review";
const UNAVAILABLE_PAYMENT_SETUP = "payment setup";
const UNAVAILABLE_RECENT_SESSIONS = "recent sessions";
const UNAVAILABLE_MISSING_RECORDS = "missing records";
const UNAVAILABLE_RECORD_DETAILS = "record details";
const UNAVAILABLE_EXPIRING_SUPPLIES = "expiring supplies";
const STUDIO_ONLY_CHECKS: ReadonlySet<string> = new Set([UNAVAILABLE_PAYMENT_SETUP, UNAVAILABLE_EXPIRING_SUPPLIES]);

const EMPTY_PROCEDURE_ACTIONS: ProcedureActionMetrics = {
  reviewedSessions: 0,
  incompleteRecords: 0,
  missingProbeLots: 0,
  aftercareNotMarked: 0,
  recordsMissingDetails: 0,
  detailGaps: [],
};
const EMPTY_CLIENTS_NEEDING_ATTENTION: Awaited<ReturnType<typeof getClientsNeedingAttention>> = {
  totalClients: 0,
  clients: [],
  scanCapped: false,
};
const EMPTY_FOLLOW_UP_ASSISTANT: Awaited<ReturnType<typeof getMissingRecordsAssistant>> = {
  items: [],
  hasItems: false,
  totalFound: 0,
};

async function settleOrUnavailable<T>(
  promise: Promise<T>,
  fallback: T,
): Promise<{ value: T; unavailable: boolean }> {
  try {
    return { value: await promise, unavailable: false };
  } catch {
    return { value: fallback, unavailable: true };
  }
}

// The ONE place the Needs Attention model's input is resolved. The panel and the summary strip's "Clients to
// review" both call it with the same already-started promises, so the strip's number IS the panel's
// client count by construction (it reads `.clients.length` of this model), and no read is added.
async function resolveNeedsAttentionInput({
  attentionSources,
  staffManaged: staffManagedPromise,
  procedureActions: procedureActionsPromise,
  upcomingVisitClients: upcomingVisitClientsPromise,
  clientsNeedingAttention: clientsNeedingAttentionPromise,
  followUpAssistant: followUpAssistantPromise,
  expiringSupplies: expiringSuppliesPromise,
  isOwner,
  todayLocal,
}: NeedsAttentionInputs) {
  const [intakesRead, activeServicesCount, paymentStatusRead] =
    await attentionSources;
  const intakesUnavailable = intakesRead === CHECK_UNAVAILABLE;
  const intakesAwaitingReview = intakesUnavailable ? [] : intakesRead;
  const paymentUnavailable = paymentStatusRead === CHECK_UNAVAILABLE;
  const paymentStatus = paymentUnavailable ? null : paymentStatusRead;
  const staffManaged = await staffManagedPromise;
  // ONE FAILING LOADER NEVER TAKES THE PAGE DOWN. Each of these used to be awaited bare, so a rejection
  // threw out of this async component and fell to the route error boundary, replacing the whole
  // dashboard. Each now fails into its OWN named unavailable check: an empty fallback plus that
  // name, which the panel states and which the client count treats as unavailable. An empty fallback
  // without the name would read as "nothing to follow up", so the two always travel together.
  const procedureActionsRead = await settleOrUnavailable(procedureActionsPromise, EMPTY_PROCEDURE_ACTIONS);
  const procedureActions = procedureActionsRead.value;
  const upcomingVisitClients = await upcomingVisitClientsPromise;
  const clientsNeedingAttentionRead = await settleOrUnavailable(
    clientsNeedingAttentionPromise,
    EMPTY_CLIENTS_NEEDING_ATTENTION,
  );
  const clientsNeedingAttention = clientsNeedingAttentionRead.value;
  const followUpAssistantRead = await settleOrUnavailable(followUpAssistantPromise, EMPTY_FOLLOW_UP_ASSISTANT);
  const followUpAssistant = followUpAssistantRead.value;
  const expiringSuppliesRead = await settleOrUnavailable(expiringSuppliesPromise, []);
  const expiringSupplies = expiringSuppliesRead.value;

  const dashboardTodo = buildDashboardTodo({
    assistant: followUpAssistant,
    attention: clientsNeedingAttention,
    supplies: expiringSupplies,
    metrics: procedureActions,
    studio: {
      isOwner,
      intakesAwaitingReviewCount: intakesAwaitingReview.length,
      activeServicesCount,
      paymentStatus,
      staffManaged,
    },
    todayLocal,
  });

  return {
    assistant: followUpAssistant,
    intakesAwaitingReview,
    todo: dashboardTodo,
    unavailableChecks: [
      ...(intakesUnavailable ? [UNAVAILABLE_INTAKE_REVIEW] : []),
      ...(paymentUnavailable ? [UNAVAILABLE_PAYMENT_SETUP] : []),
      ...(clientsNeedingAttentionRead.unavailable ? [UNAVAILABLE_RECENT_SESSIONS] : []),
      ...(followUpAssistantRead.unavailable ? [UNAVAILABLE_MISSING_RECORDS] : []),
      ...(procedureActionsRead.unavailable ? [UNAVAILABLE_RECORD_DETAILS] : []),
      ...(expiringSuppliesRead.unavailable ? [UNAVAILABLE_EXPIRING_SUPPLIES] : []),
    ],
    treatmentMemoryNotReturned:
      clientsNeedingAttention.totalClients - clientsNeedingAttention.clients.length,
    recordDetailGaps: procedureActions.detailGaps,
    detailsWindow: procedureActions.detailGaps ? PROCEDURE_RECORD_WINDOW : null,
    upcomingVisitClientIds:
      upcomingVisitClients === CHECK_UNAVAILABLE
        ? undefined
        : upcomingVisitClients,
  };
}

export async function NeedsAttentionSection(props: NeedsAttentionInputs) {
  return (
    <NeedsAttentionPanel
      needs={buildNeedsAttention(await resolveNeedsAttentionInput(props))}
    />
  );
}

/**
 * The "Clients to review" value of the summary strip: the number of client cards in Needs Attention,
 * from the SAME model. A failed read renders "Unavailable", never 0 (a zero would claim nothing needs
 * review when nobody could read it).
 */
/**
 * The client count both the strip and the header pill show, from the SAME model as the panel. It is
 * null (rendered "Unavailable") when the read failed OR when any check that contributes client cards
 * could not run (intake review, recent sessions, missing records, record details): a count taken
 * without one could say 0 while someone needs review. Payment setup and expiring supplies only add
 * studio items and do not change this count.
 */
async function resolveClientReviewCount(props: NeedsAttentionInputs): Promise<number | null> {
  try {
    const model = buildNeedsAttention(await resolveNeedsAttentionInput(props));
    return model.unavailableChecks.some((c) => !STUDIO_ONLY_CHECKS.has(c)) ? null : model.clients.length;
  } catch {
    return null;
  }
}

async function ClientsToReviewValue(props: NeedsAttentionInputs) {
  const count = await resolveClientReviewCount(props);
  return (
    <span data-testid="summary-clients-to-review-value">
      {count === null ? "Unavailable" : count}
    </span>
  );
}

async function ClientCountPillValue(props: NeedsAttentionInputs) {
  const count = await resolveClientReviewCount(props);
  return (
    <span
      data-testid="needs-attention-count-pill"
      className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
    >
      {count === null ? "Unavailable" : `${count} ${count === 1 ? "client" : "clients"}`}
    </span>
  );
}

/** The header count pill of the Needs attention card: same model, same count as the strip. Own Suspense. */
export function NeedsAttentionCountPill(props: NeedsAttentionInputs) {
  return (
    <Suspense fallback={null}>
      <ClientCountPillValue {...props} />
    </Suspense>
  );
}

/** Own Suspense so the roster and the strip never wait on the model. The caller keys it per day/period. */
export function ClientsToReview(props: NeedsAttentionInputs) {
  return (
    <Suspense
      fallback={<span aria-hidden className="inline-block h-6 w-8 rounded bg-neutral-100 dark:bg-neutral-800" />}
    >
      <ClientsToReviewValue {...props} />
    </Suspense>
  );
}

// Wordless, like the secondary stack's: nothing about the studio is known yet.
export function NeedsAttentionSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-live="off"
      data-testid="needs-attention-pending"
      className="flex flex-col gap-2"
    >
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
