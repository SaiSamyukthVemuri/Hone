import Link from "next/link";

import { getAvailabilityDefaults } from "@/lib/booking/queries";
import { computeBookingReadiness } from "@/lib/booking/readiness";
import { BookingSetupCard } from "./BookingSetupCard";
import { getClientBirthdaysForMonth } from "@/lib/clients/birthday-queries";
import { resolveBirthdayColor } from "@/lib/birthday-colors";
import type { BirthdayReminderColor, Studio } from "@/lib/types/database";
import { PracticeSnapshot } from "./practice-snapshot";
import { getPracticeDashboardMetrics } from "@/lib/dashboard/practice-metrics";
import { getClientsNeedingAttention } from "@/lib/dashboard/clients-needing-attention";
import { getMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";
import { getExpiringSterileItems } from "@/lib/record-keeping/queries";
import { DashboardTodoList } from "./todo-list";
import { buildDashboardTodo } from "@/lib/dashboard/todo-model";
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

// The five values the page's `attentionSourcesPromise` resolves to, in order.
// Each slot is DERIVED from the thing that actually produces or consumes it, so
// this cannot drift from the page without a type error: the payment slot is
// spelled as the exact field `buildDashboardTodo` reads, because that is its
// only consumer and `loadPaymentStatus` is private to the page module.
type AttentionSources = readonly [
  number,
  number,
  Parameters<typeof buildDashboardTodo>[0]["studio"]["paymentStatus"],
  Awaited<ReturnType<typeof getClientBirthdaysForMonth>>,
  Awaited<ReturnType<typeof getAvailabilityDefaults>>,
];

type Props = {
  /** Started in the page BEFORE the roster query. Never started here. */
  attentionSources: Promise<AttentionSources>;
  practiceMetrics: Promise<
    Awaited<ReturnType<typeof getPracticeDashboardMetrics>>
  >;
  clientsNeedingAttention: Promise<
    Awaited<ReturnType<typeof getClientsNeedingAttention>>
  >;
  followUpAssistant: Promise<
    Awaited<ReturnType<typeof getMissingRecordsAssistant>>
  >;
  expiringSupplies: Promise<
    Awaited<ReturnType<typeof getExpiringSterileItems>>
  >;
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

export async function SecondaryStack({
  attentionSources,
  practiceMetrics: practiceMetricsPromise,
  clientsNeedingAttention: clientsNeedingAttentionPromise,
  followUpAssistant: followUpAssistantPromise,
  expiringSupplies: expiringSuppliesPromise,
  gettingStartedSignals: gettingStartedSignalsPromise,
  studio,
  isOwner,
  onboardingV2On,
  todayLocal,
  selectedDayLocal,
}: Props) {
  // "Needs attention" sources. Each is independently safe to fail; if a
  // single signal can't be fetched we render the rest. All checks here
  // are bounded SELECTs on tables we already have RLS on.
  const [
    intakesAwaitingReviewCount,
    activeServicesCount,
    paymentStatus,
    birthdaysThisMonth,
    availabilityDefaults,
  ] = await attentionSources;

  // Booking readiness for the owner card. Derived only; no schema flag.
  // The card itself is owner-only (rendered below). Public booking is
  // soft-gated independently in app/book/[slug]/page.tsx.
  const openAvailabilityDaysCount = isOwner
    ? availabilityDefaults.filter(
        (d: AttentionSources[4][number]) =>
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
  const practiceMetrics = await practiceMetricsPromise;

  // PR #214: recorded-history attention list (two batched reads over
  // the 200 most recent sessions; unique clients counted once).
  const clientsNeedingAttention = await clientsNeedingAttentionPromise;

  // PR #249: Missing Records / Follow-up Assistant V1. Rules-based only
  // (no AI, no model, no provider, no action).
  const followUpAssistant = await followUpAssistantPromise;

  // PR #316: sterile items / probe lots expired or expiring within 30 days.
  const expiringSupplies = await expiringSuppliesPromise;

  // Dashboard V2 Part 2B, the ONE To-do model. `buildDashboardTodo` is PURE:
  // no client, no query, no clock, no model. Adding it costs ZERO round-trips.
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
  const gettingStarted = buildGettingStarted(await gettingStartedSignalsPromise);

  // PR #238 (Chloe pilot): once every auto-detected setup step is done, the
  // Getting started card stops occupying the prime spot.
  const setupComplete =
    gettingStarted.autoTotal > 0 &&
    gettingStarted.autoDone === gettingStarted.autoTotal;

  return (
    <div className="flex flex-col gap-10">
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

          The domain loaders are deliberately UNCHANGED: rewriting them would
          expand scope, and NO query was added: `buildDashboardTodo` is pure and
          consumes results the page already had. Deduplication is on domain
          identity (`kind:subjectId`), never on rendered text; ordering is
          documented in TODO_PRIORITY. Every action that worked before is
          carried through unchanged, including the assistant's deep links to a
          specific session or appointment. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">To do</h2>
        <DashboardTodoList todo={dashboardTodo} />
        {/* DASH-TRUTH-04: the quiet pilot feedback footer is gone from To do
            as well. See the note at the foot of the dashboard page. */}
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
          functionality. */}
      <PracticeSnapshot
        metrics={practiceMetrics}
        livemode={inferStripeLivemode()}
        selectedDay={selectedDayLocal}
        todayLocal={todayLocal}
      />

      {/* OWNER-CAP Slice 1: the owner's capacity briefing. A LINK, not a card:
          the figures on it are studio-wide practice analytics an ordinary
          practitioner must not be shown, and the page refuses them server-side
          before issuing a single analytics read. Rendering it here keeps the
          surface reachable without another nav tab. */}
      {isOwner && (
        <Link
          href="/dashboard/capacity"
          className="flex items-baseline justify-between gap-3 rounded-lg border border-line px-4 py-3 text-sm hover:bg-surface-sunken"
        >
          <span className="font-medium">Practice capacity</span>
          <span className="text-fg-muted">
            Who is in treatment, and who has no treatment booked &rarr;
          </span>
        </Link>
      )}

      {/* CHLOE D2, setup that is DONE is not daily work.
          ------------------------------------------------------------------
          This card used to render in both states. Once every required item was
          satisfied it became a permanent "Booking page ready" banner plus a
          column of ticks: a congratulation occupying the daily workspace
          forever.

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
