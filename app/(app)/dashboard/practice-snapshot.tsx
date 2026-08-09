import Link from "next/link";
import type {
  DashboardPeriod,
  PracticeDashboardMetrics,
} from "@/lib/dashboard/practice-metrics";

// PR #208: Practice Dashboard V1 snapshot. Plain, iPad-friendly cards:
// appointment counts, booked/completed SERVICE VALUE (service-menu
// prices; NEVER labeled revenue — collected totals are not a
// dashboard metric), a
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
  livemode = false,
}: {
  metrics: PracticeDashboardMetrics;
  // PR #323: deployment mode. Gates the factual "Live payments On/Off" +
  // "Test payments" labels in the Payments card. Defaults false (test).
  livemode?: boolean;
}) {
  const a = metrics.appointments;
  return (
    <section className="flex flex-col gap-4">
      {/* This section carries its own h2. Without one, its cards' h3s would
          nest under the PRECEDING h2 in the accessibility tree — "Birthdays
          this month" — so a screen-reader user navigating by heading would
          find "Service value" and "Payments" as children of Birthdays. The
          attention surface this file used to host is gone entirely: Dashboard
          V2 Part 2B folded it into the one normalized To-do model
          (lib/dashboard/todo-model.ts). This file is REPORTING only. */}
      <h2 className="text-lg font-medium">Practice snapshot</h2>
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
          {/* REQUIRED posture copy for the test-mode branch. */}
          <p className="text-[11px] text-neutral-500">
            Values are based on booked service prices, not collected live
            payments.
          </p>
        </Card>

        <Card title="Payments">
          {/* Mode-aware card (the promised #323 copy fast-follow, done after
              live billing was proven). The counts come from the CURRENT
              deployment mode only (practice-metrics is scoped by
              inferStripeLivemode()), so the labels flip with the mode —
              live counts are never rendered under test-mode copy. The
              test-only status lines below are hidden in live. */}
          <Stat label="Live payments" value={livemode ? "On" : "Off"} />
          {!livemode && <Stat label="Test payments" value="Available" />}
          {!livemode && (
            <Stat label="Collected revenue" value="Not enabled yet" />
          )}
          <div className="mt-1 border-t border-neutral-200 pt-2 dark:border-neutral-800">
            <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
              {livemode ? "Live payments" : "Test mode only"} (
              {metrics.periodLabel})
            </p>
            <Stat
              label={livemode ? "Payments prepared" : "Test payments prepared"}
              value={metrics.testPayments.prepared}
            />
            <Stat
              label={livemode ? "Payments charged" : "Test payments charged"}
              value={metrics.testPayments.charged}
            />
            <Stat
              label={livemode ? "Refunds" : "Test refunds"}
              value={metrics.testPayments.refunds}
            />
          </div>
          {!livemode && (
            <p className="text-[11px] text-neutral-500">
              Collected revenue will appear after live payments are enabled.
            </p>
          )}
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
    </section>
  );
}
