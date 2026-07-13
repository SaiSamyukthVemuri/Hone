import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { todayInTz } from "@/lib/booking/tz";
import {
  loadOverdueDisinfectantAlerts,
  type OverdueDisinfectantAlert,
} from "@/lib/notifications/disinfectant-alerts";
import { markAllReadFormAction } from "./actions";
import type { PractitionerNotification } from "@/lib/types/database";

// PR #164. Practitioner notification center. Server component.
// Lists the studio's notifications newest-first (RLS-scoped via the
// authenticated client). Unread rows have a small dot + tinted
// background; clicking a row's title goes to the href the helper
// composed (today: /calendar/<appointment_id>). "Mark all read"
// uses the server action in ./actions.ts.
//
// Willow follow-up: overdue disinfectant "Replace now" records also surface here
// as COMPUTED operational safety alerts (lib/notifications/disinfectant-alerts.ts)
// — derived from the same read-time source of truth as the Records page, so they
// auto-resolve when a replacement is recorded. They are not persisted rows and do
// not participate in per-row read state: a still-overdue safety item must stay
// visible, so "Mark all read" (which clears the persisted event rows) never hides
// it. Recording the replacement is the authoritative resolution.

const NOTIFICATION_LIST_LIMIT = 100;

export default async function NotificationsPage() {
  const { studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("practitioner_notifications")
    .select(
      "id, studio_id, practitioner_id, event_type, title, body, appointment_id, client_id, href, read_at, created_at",
    )
    .eq("studio_id", studio.id)
    .order("created_at", { ascending: false })
    .limit(NOTIFICATION_LIST_LIMIT);
  if (error) {
    throw new Error(`Failed to load notifications: ${error.message}`);
  }
  const notifications = (data ?? []) as PractitionerNotification[];
  const unreadCount = notifications.filter((n) => n.read_at == null).length;

  // Computed overdue-disinfactant operational alerts (studio-local "today"). One
  // bounded, studio-scoped, RLS-gated read; the studio id is server-derived.
  const overdueAlerts = await loadOverdueDisinfectantAlerts(
    supabase,
    studio.id,
    todayInTz(studio.timezone),
  );

  const hasAnything = notifications.length > 0 || overdueAlerts.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Notifications
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Operational alerts, new bookings, cancellations, and reschedules
            across {studio.name}.
          </p>
        </div>
        {unreadCount > 0 && (
          <form action={markAllReadFormAction}>
            <button
              type="submit"
              className="min-h-[44px] rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Mark all read
            </button>
          </form>
        )}
      </header>

      {/* Operational safety alerts (computed, always visible while unresolved) —
          sorted ahead of routine notifications. */}
      {overdueAlerts.length > 0 && (
        <section aria-label="Operational alerts" className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-amber-800 dark:text-amber-300">
            Operational alerts
          </h2>
          <ul className="flex flex-col gap-2" data-testid="operational-alerts">
            {overdueAlerts.map((a) => (
              <OverdueDisinfectantCard key={a.id} alert={a} />
            ))}
          </ul>
        </section>
      )}

      {!hasAnything ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          No notifications yet. Operational alerts and new bookings,
          cancellations, and reschedules will show up here.
        </div>
      ) : notifications.length > 0 ? (
        <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {notifications.map((n) => (
            <NotificationRow key={n.id} notification={n} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Computed overdue-disinfactant operational alert card. Warning-toned, but the
// status is stated in words (not colour alone); the whole card links to the
// authorized Records disinfectants section, and the action target is ≥44px.
function OverdueDisinfectantCard({
  alert,
}: {
  alert: OverdueDisinfectantAlert;
}) {
  return (
    <li className="overflow-hidden rounded-lg border border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30">
      <div className="flex flex-col gap-1.5 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-100">
            <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-900 dark:bg-amber-800 dark:text-amber-100">
              Overdue
            </span>
            {alert.title}
          </p>
          <p className="text-[11px] uppercase tracking-wider text-amber-700 dark:text-amber-300">
            Operational alert
          </p>
        </div>
        <p className="text-sm text-amber-900/90 dark:text-amber-100/90">
          {alert.body}
        </p>
        <p className="break-words text-xs text-amber-800 dark:text-amber-200">
          {alert.contextLabel} · Replace by {alert.dueDate} · {alert.daysOverdueText}
        </p>
        <Link
          href={alert.href}
          className="mt-1 inline-flex min-h-[44px] items-center self-start rounded-md border border-amber-400 bg-white px-3 text-sm font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-neutral-950 dark:text-amber-100 dark:hover:bg-amber-950/50"
        >
          {alert.actionLabel}
        </Link>
      </div>
    </li>
  );
}

function NotificationRow({
  notification,
}: {
  notification: PractitionerNotification;
}) {
  const isUnread = notification.read_at == null;
  // Wrap the row in the deep-link when href is present so the
  // whole card is clickable; otherwise render as a static row.
  const inner = (
    <div
      className={`flex flex-col gap-1 px-4 py-3 ${isUnread ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {isUnread && (
            <span
              aria-hidden
              className="mr-2 inline-block h-2 w-2 rounded-full bg-rose-600 align-middle"
            />
          )}
          {notification.title}
        </p>
        <p className="text-[11px] uppercase tracking-wider text-neutral-500">
          <FormattedDateTime iso={notification.created_at} />
        </p>
      </div>
      {notification.body && (
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          {notification.body}
        </p>
      )}
    </div>
  );
  if (notification.href) {
    return (
      <li>
        <Link
          href={notification.href}
          className="block hover:bg-neutral-50 dark:hover:bg-neutral-900"
        >
          {inner}
        </Link>
      </li>
    );
  }
  return <li>{inner}</li>;
}
