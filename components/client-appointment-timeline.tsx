import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { FormattedDateTime } from "@/components/formatted-date-time";
import type { ClientAppointmentTimelineRow } from "@/lib/supabase/queries";

// PR #157. Appointment timeline rendered on the client profile's
// Sessions tab. Subsumes the prior "Visits awaiting charting" section
// by surfacing the full appointment history (upcoming + past +
// cancelled + no-show) with explicit Chart session / View session
// affordances per row, using the PR #156 appointment_id FK to decide
// which row already has a session attached.
//
// Server component. The grouping logic runs once per page render;
// row-level date/time formatting is delegated to the existing
// <FormattedDateTime> client component so the AM/PM rendering stays
// in the user's browser timezone (the same component the rest of the
// app already uses).
//
// Buckets, in order of practitioner urgency:
//   1. Upcoming           confirmed AND starts_at > now
//   2. Needs charting     past AND (confirmed | completed) AND no linked session
//   3. Charted            linked session exists
//   4. Cancelled          status = cancelled
//   5. No-show            status = no_show
//
// An appointment with status='cancelled' that nevertheless somehow has
// a linked session still appears under "Cancelled" with an extra
// "View session" affordance, not under "Charted". The status takes
// precedence so the practitioner is not visually told a cancelled
// appointment was treated.
//
// Sections render only when non-empty; an empty timeline renders a
// single calm "no appointments on file" line so the surface does not
// collapse to zero height.

type Bucket =
  | "upcoming"
  | "needsCharting"
  | "charted"
  | "cancelled"
  | "noShow";

function classify(
  row: ClientAppointmentTimelineRow,
  nowMs: number,
): Bucket {
  if (row.status === "cancelled") return "cancelled";
  if (row.status === "no_show") return "noShow";
  const startMs = new Date(row.starts_at).getTime();
  if (Number.isFinite(startMs) && startMs > nowMs && row.status === "confirmed") {
    return "upcoming";
  }
  if (row.linked_session) return "charted";
  // Past + confirmed/completed + no linked session.
  return "needsCharting";
}

type Group = {
  key: Bucket;
  heading: string;
  hint: string | null;
  rows: ClientAppointmentTimelineRow[];
};

export function ClientAppointmentTimeline({
  clientId,
  rows,
}: {
  clientId: string;
  rows: ReadonlyArray<ClientAppointmentTimelineRow>;
}) {
  const nowMs = Date.now();
  // PR #191 (Chloe smoke feedback): "Needs charting" renders ABOVE
  // "Upcoming". Charting debt is the actionable item on this tab;
  // upcoming appointments are reference. PR #194: everything except
  // Needs charting is collapsible (Upcoming can be huge when clients
  // book weeks ahead; charted history grows forever); cancelled and
  // no-shows share one collapsed group.
  const groups: Group[] = [
    {
      key: "needsCharting",
      heading: "Needs charting",
      hint: "Past appointments without a session record yet. Charting from here links the session to the appointment.",
      rows: [],
    },
    { key: "upcoming", heading: "Upcoming", hint: null, rows: [] },
    { key: "charted", heading: "History", hint: null, rows: [] },
    { key: "cancelled", heading: "Cancelled and no-shows", hint: null, rows: [] },
    { key: "noShow", heading: "No-show", hint: null, rows: [] },
  ];
  const groupByKey = new Map(groups.map((g) => [g.key, g] as const));
  for (const row of rows) {
    const key = classify(row, nowMs);
    groupByKey.get(key)?.rows.push(row);
  }

  // PR #194: cancelled + no-show render as ONE collapsed group.
  const cancelledGroup = groupByKey.get("cancelled");
  const noShowGroup = groupByKey.get("noShow");
  if (cancelledGroup && noShowGroup && noShowGroup.rows.length > 0) {
    cancelledGroup.rows.push(...noShowGroup.rows);
    noShowGroup.rows = [];
  }

  const nonEmpty = groups.filter((g) => g.rows.length > 0);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">Appointments</h2>
        <p className="text-xs text-neutral-500">
          {rows.length === 0
            ? "No appointments on file."
            : `${rows.length} ${rows.length === 1 ? "appointment" : "appointments"}`}
        </p>
      </div>
      {nonEmpty.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          When this client books, their appointments will show up here. You can
          chart from each row.
        </div>
      ) : (
        nonEmpty.map((g) => (
          <TimelineGroup
            key={g.key}
            group={g}
            clientId={clientId}
            nowMs={nowMs}
          />
        ))
      )}
    </section>
  );
}

function TimelineGroup({
  group,
  clientId,
  nowMs,
}: {
  group: Group;
  clientId: string;
  nowMs: number;
}) {
  // PR #194 (Chloe retest): only "Needs charting" stays expanded by
  // default; Upcoming, Charted, and Cancelled/no-shows collapse so a
  // heavily-booked or long-history client does not bury the tab.
  // Native <details> keeps this dependency-free and server-rendered.
  const openByDefault = group.key === "needsCharting";
  return (
    <details open={openByDefault} className="flex flex-col gap-2">
      <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2 pt-1 [&::-webkit-details-marker]:hidden">
        <h3 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          <span className="mr-1 text-neutral-400">▸</span>
          {group.heading}
          <span className="ml-2 text-neutral-400">({group.rows.length})</span>
        </h3>
        {group.hint && (
          <p className="text-xs text-neutral-500">{group.hint}</p>
        )}
      </summary>
      <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {group.rows.map((row) => (
          <TimelineRow
            key={row.id}
            row={row}
            bucket={group.key}
            clientId={clientId}
            nowMs={nowMs}
          />
        ))}
      </ul>
    </details>
  );
}

function TimelineRow({
  row,
  bucket,
  clientId,
  nowMs,
}: {
  row: ClientAppointmentTimelineRow;
  bucket: Bucket;
  clientId: string;
  nowMs: number;
}) {
  const serviceLabel = row.service_name ?? "Appointment";
  const modalitySuffix = row.service_modality ? ` · ${row.service_modality}` : "";
  const startMs = new Date(row.starts_at).getTime();
  const isPast = Number.isFinite(startMs) && startMs <= nowMs;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          <FormattedDateTime iso={row.starts_at} />
          {row.ends_at && (
            <>
              <span className="text-neutral-400"> to </span>
              <FormattedDateTime iso={row.ends_at} format="time" />
            </>
          )}
        </div>
        <div className="text-xs text-neutral-500">
          {serviceLabel}
          {modalitySuffix}
          <StatusBadge bucket={bucket} isPast={isPast} />
        </div>
        {bucket === "cancelled" && (
          <CancelledMeta
            cancelledAt={row.cancelled_at}
            reason={row.cancellation_reason}
          />
        )}
        {bucket === "charted" && row.linked_session && (
          <p className="mt-1 text-xs text-neutral-500">
            Charted as{" "}
            <FormattedDateTime
              iso={row.linked_session.started_at}
              format="datetime"
            />{" "}
            · {row.linked_session.modality}
          </p>
        )}
        {row.postcare_email_sent_at && (
          // Postcare send visibility (read-only). "Sent" is the recorded send
          // timestamp, not a delivery confirmation. Only shown when a send
          // was recorded, so this reads as a per-client postcare history.
          <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
            Postcare sent{" "}
            <FormattedDateTime
              iso={row.postcare_email_sent_at}
              format="datetime"
            />
            {row.postcare_email_send_attempts > 1
              ? ` · ${row.postcare_email_send_attempts} attempts`
              : ""}
          </p>
        )}
      </div>
      <TimelineActions row={row} bucket={bucket} clientId={clientId} />
    </li>
  );
}

function StatusBadge({
  bucket,
  isPast,
}: {
  bucket: Bucket;
  isPast: boolean;
}) {
  const variants: Record<Bucket, { label: string; classes: string }> = {
    upcoming: {
      label: "Confirmed",
      classes:
        "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
    },
    needsCharting: {
      label: isPast ? "Not charted yet" : "Confirmed",
      classes:
        "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
    },
    charted: {
      label: "Charted",
      classes:
        "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
    },
    cancelled: {
      label: "Cancelled",
      classes:
        "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    },
    noShow: {
      label: "No-show",
      classes:
        "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    },
  };
  const v = variants[bucket];
  return (
    <span
      className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${v.classes}`}
    >
      {v.label}
    </span>
  );
}

function CancelledMeta({
  cancelledAt,
  reason,
}: {
  cancelledAt: string | null;
  reason: string | null;
}) {
  if (!cancelledAt && !reason) return null;
  return (
    <div className="mt-1 text-xs text-neutral-500">
      {cancelledAt && (
        <span>
          Cancelled <FormattedDateTime iso={cancelledAt} />
        </span>
      )}
      {cancelledAt && reason && <span> · </span>}
      {reason && <span>Reason: {reason}</span>}
    </div>
  );
}

function TimelineActions({
  row,
  bucket,
  clientId,
}: {
  row: ClientAppointmentTimelineRow;
  bucket: Bucket;
  clientId: string;
}) {
  // Cancelled and no_show rows never expose "Chart session" because
  // there is no treatment to record. They DO expose "View session" if
  // a linked session exists (rare today but possible if a session was
  // logged and the appointment was later cancelled).
  if (bucket === "cancelled" || bucket === "noShow") {
    return (
      <div className="flex flex-wrap gap-2">
        {row.linked_session && (
          <Link
            href={`/clients/${clientId}/sessions/${row.linked_session.id}`}
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            View session
          </Link>
        )}
        <Link
          href={`/calendar/${row.id}`}
          className={buttonClasses({ variant: "secondary", size: "sm" })}
        >
          Open appointment
        </Link>
      </div>
    );
  }
  // Charted: View session is primary; opening the appointment is
  // secondary (calendar detail still surfaces the chart-state card).
  if (bucket === "charted" && row.linked_session) {
    return (
      <div className="flex flex-wrap gap-2">
        <Link
          href={`/clients/${clientId}/sessions/${row.linked_session.id}`}
          className={buttonClasses({ variant: "primary", size: "sm" })}
        >
          View session
        </Link>
        <Link
          href={`/calendar/${row.id}`}
          className={buttonClasses({ variant: "secondary", size: "sm" })}
        >
          Open appointment
        </Link>
      </div>
    );
  }
  // Needs charting: Chart session is primary. Carries the
  // ?appointment_id query parameter so startSessionAction validates
  // lineage (PR #156 patch) and stamps the FK on the new session row.
  if (bucket === "needsCharting") {
    return (
      <div className="flex flex-wrap gap-2">
        <Link
          href={`/clients/${clientId}/sessions/new?appointment_id=${encodeURIComponent(row.id)}`}
          className={buttonClasses({ variant: "primary", size: "sm" })}
        >
          Chart session
        </Link>
        <Link
          href={`/calendar/${row.id}`}
          className={buttonClasses({ variant: "secondary", size: "sm" })}
        >
          Open appointment
        </Link>
      </div>
    );
  }
  // Upcoming: Open appointment only. We deliberately do NOT expose
  // "Chart session" on a future row; the calendar appointment detail
  // page is the right place to start charting at treatment time, and
  // its own card already gates on appointment status. A practitioner
  // who insists on charting early can still do so by opening the
  // appointment and clicking the card.
  return (
    <Link
      href={`/calendar/${row.id}`}
      className={buttonClasses({ variant: "primary", size: "sm" })}
    >
      Open appointment
    </Link>
  );
}
