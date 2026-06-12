import Link from "next/link";
import { FormattedDateTime } from "@/components/formatted-date-time";
import type {
  DashboardPeriod,
  PracticeDashboardMetrics,
} from "@/lib/dashboard/practice-metrics";
import type { ClientsNeedingAttention } from "@/lib/dashboard/clients-needing-attention";

// PR #208: Practice Dashboard V1 snapshot. Plain, iPad-friendly cards:
// appointment counts, booked/completed SERVICE VALUE (service-menu
// prices; NEVER labeled revenue while live payments are disabled), a
// payments status card that keeps the test-mode posture explicit, and
// Hone-specific action cards linking into Record Keeping.

const PERIODS: Array<{ key: DashboardPeriod; label: string }> = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
];

function formatCad(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-neutral-600 dark:text-neutral-400">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function PracticeSnapshot({
  metrics,
  attention,
}: {
  metrics: PracticeDashboardMetrics;
  // PR #214: recorded-history attention list for the Action needed
  // section. Read-only; never medical advice.
  attention: ClientsNeedingAttention;
}) {
  const a = metrics.appointments;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {PERIODS.map((p) => (
          <Link
            key={p.key}
            href={`/dashboard?period=${p.key}`}
            aria-current={metrics.period === p.key ? "page" : undefined}
            className={
              metrics.period === p.key
                ? "rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
                : "rounded-full border border-neutral-300 px-4 py-2 text-sm text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:text-neutral-300"
            }
          >
            {p.label}
          </Link>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title={`Appointments ${metrics.periodLabel}`}>
          <p className="text-3xl font-semibold tabular-nums">{a.total}</p>
          <p className="text-xs text-neutral-500">
            {a.total === 1 ? "appointment" : "appointments"}{" "}
            {metrics.periodLabel}
          </p>
          <Stat label="Completed" value={a.completed} />
          <Stat label="Upcoming" value={a.upcoming} />
          <Stat label="Cancelled" value={a.cancelled} />
          <Stat label="No-shows" value={a.noShows} />
          <Stat label="Late cancellations" value={a.lateCancellations} />
        </Card>

        <Card title="Service value">
          <Stat
            label="Booked service value"
            value={formatCad(a.bookedValueCents)}
          />
          <Stat
            label="Completed service value"
            value={formatCad(a.completedValueCents)}
          />
          {/* REQUIRED posture copy while live payments are disabled. */}
          <p className="text-[11px] text-neutral-500">
            Values are based on booked service prices, not collected live
            payments.
          </p>
        </Card>

        <Card title="Payments">
          <Stat label="Live payments" value="Off" />
          <Stat label="Test payments" value="Available" />
          <Stat label="Collected revenue" value="Not enabled yet" />
          <div className="mt-1 border-t border-neutral-200 pt-2 dark:border-neutral-800">
            <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
              Test mode only ({metrics.periodLabel})
            </p>
            <Stat label="Test payments prepared" value={metrics.testPayments.prepared} />
            <Stat label="Test payments charged" value={metrics.testPayments.charged} />
            <Stat label="Test refunds" value={metrics.testPayments.refunds} />
          </div>
          <p className="text-[11px] text-neutral-500">
            Collected revenue will appear after live payments are enabled.
          </p>
        </Card>

        {/* PR #225: treatment-memory loop health. Studio-level only;
            never grouped or ranked by practitioner. */}
        <Card title="Charted within 24h">
          {metrics.chartedWithin24h.completedCount === 0 ? (
            <>
              <p className="text-sm text-neutral-500">
                No recent completed sessions yet.
              </p>
              <p className="text-[11px] text-neutral-500">
                Once appointments are completed, this shows how many were
                charted within 24 hours (last 7 days).
              </p>
            </>
          ) : (
            <>
              <p className="text-3xl font-semibold tabular-nums">
                {metrics.chartedWithin24h.chartedWithin24hCount}/
                {metrics.chartedWithin24h.completedCount}
              </p>
              <p className="text-xs text-neutral-500">
                Recently completed sessions with charting saved within 24
                hours (last 7 days).
              </p>
            </>
          )}
          <p className="text-[11px] text-neutral-500">
            Keeps Before Today and Treatment Intelligence current.
          </p>
        </Card>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Action needed</h2>
        <p className="text-xs text-neutral-500">
          Across your {metrics.actions.reviewedSessions} most recent charted
          sessions. Tap a card to open the client procedure records.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Link
            href="/records?section=procedures"
            className="rounded-lg border border-neutral-200 p-4 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
          >
            <p className="text-3xl font-semibold tabular-nums">
              {metrics.actions.incompleteRecords}
            </p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Incomplete procedure records
            </p>
          </Link>
          <Link
            href="/records?section=procedures"
            className="rounded-lg border border-neutral-200 p-4 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
          >
            <p className="text-3xl font-semibold tabular-nums">
              {metrics.actions.missingProbeLots}
            </p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Missing probe lot numbers
            </p>
          </Link>
          <Link
            href="/records?section=procedures"
            className="rounded-lg border border-neutral-200 p-4 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
          >
            <p className="text-3xl font-semibold tabular-nums">
              {metrics.actions.aftercareNotMarked}
            </p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Aftercare not marked
            </p>
          </Link>
          {/* PR #214: clinical treatment-memory attention (watch
              notes, next-visit plans, notable recorded reactions).
              Distinct from the record-completeness cards above. */}
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="text-3xl font-semibold tabular-nums">
              {attention.totalClients}
            </p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Clients needing attention
            </p>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              Based on recorded watch notes and next-visit plans.
            </p>
          </div>
        </div>

        {/* PR #214: compact attention list (top 5; "+ N more"). */}
        {attention.totalClients === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-4 text-sm text-neutral-500 dark:border-neutral-700">
            Nothing flagged from recorded treatment history.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {attention.clients.map((c) => (
              <li
                key={c.clientId}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-medium">{c.clientName}</span>
                    <span className="text-xs text-neutral-500">
                      <FormattedDateTime iso={c.latestDate} format="date" />
                    </span>
                    {c.hasWatch && (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-900 dark:bg-blue-900/40 dark:text-blue-200">
                        Watch note
                      </span>
                    )}
                    {c.hasPlan && (
                      <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
                        Plan for next visit
                      </span>
                    )}
                    {c.notableReactionLabel && (
                      <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
                        Latest recorded reaction: {c.notableReactionLabel}
                      </span>
                    )}
                    {c.latestToleranceRating != null && (
                      <span className="text-[11px] text-neutral-500">
                        Latest tolerance: {c.latestToleranceRating}/5
                      </span>
                    )}
                  </div>
                  {c.previewLine && (
                    <p className="mt-0.5 truncate text-xs text-neutral-600 dark:text-neutral-400">
                      {c.previewLine}
                    </p>
                  )}
                </div>
                <Link
                  href={`/clients/${c.clientId}`}
                  className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
                >
                  Open client →
                </Link>
              </li>
            ))}
            {attention.totalClients > attention.clients.length && (
              <li className="px-4 py-2 text-xs text-neutral-500">
                + {attention.totalClients - attention.clients.length} more
              </li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}
