import type { SupabaseClient } from "@supabase/supabase-js";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  describeLeadAlert,
  leadAlertReason,
  LEAD_ALERT_MAX_ATTEMPTS,
  type LeadAlertStatus,
  type PlatformLeadKind,
} from "@/lib/platform-leads/alert-status";
import type { LeadAlertConfigurationStatus } from "@/lib/platform-leads/alert-delivery";
import { retryLeadAlertAction } from "./actions";

// LEAD-ALERT-01 (#826): what the operator console shows about new-lead alert
// emails. Everything is read through the service-role client the console
// already uses; no prospect detail is selected here (the lead tables on the
// page carry those). A load error is said out loud, never rendered as "no
// alert" or as all-clear.

export type LeadAlertRow = {
  id: string;
  lead_kind: PlatformLeadKind;
  demo_request_id: string | null;
  waitlist_id: string | null;
  status: LeadAlertStatus;
  attempt_count: number;
  next_attempt_at: string;
  accepted_at: string | null;
  failed_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  created_at: string;
};

const ALERT_COLUMNS =
  "id, lead_kind, demo_request_id, waitlist_id, status, attempt_count, next_attempt_at, accepted_at, failed_at, last_error_code, last_error_at, created_at";

/** Failed alerts per page of the card's retry list. */
export const FAILED_PAGE_SIZE = 10;

/**
 * The page of the failed list to show, from the URL. Every failed alert must
 * stay reachable for Retry, so the list pages rather than truncates.
 */
export function failedPageFrom(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 1 && n <= 10_000 ? n : 1;
}

export type LeadAlertsView = {
  loadError: boolean;
  failedPage: number;
  byDemoRequest: Map<string, LeadAlertRow>;
  byWaitlist: Map<string, LeadAlertRow>;
  counts: Record<LeadAlertStatus, number>;
  failed: LeadAlertRow[];
};

function emptyView(loadError: boolean): LeadAlertsView {
  return {
    loadError,
    byDemoRequest: new Map(),
    byWaitlist: new Map(),
    counts: { pending: 0, sending: 0, accepted: 0, failed: 0 },
    failed: [],
    failedPage: 1,
  };
}

export async function loadLeadAlerts(
  admin: SupabaseClient,
  demoRequestIds: string[],
  waitlistIds: string[],
  failedPage = 1,
): Promise<LeadAlertsView> {
  const from = (failedPage - 1) * FAILED_PAGE_SIZE;
  try {
    const forLeads = async (column: "demo_request_id" | "waitlist_id", ids: string[]) =>
      ids.length === 0
        ? { data: [] as LeadAlertRow[], error: null }
        : await admin.from("platform_lead_alerts").select(ALERT_COLUMNS).in(column, ids);
    const countOf = (status: LeadAlertStatus) =>
      admin
        .from("platform_lead_alerts")
        .select("id", { count: "exact", head: true })
        .eq("status", status);

    const [demo, waitlist, pending, sending, accepted, failed, failedRows] = await Promise.all([
      forLeads("demo_request_id", demoRequestIds),
      forLeads("waitlist_id", waitlistIds),
      countOf("pending"),
      countOf("sending"),
      countOf("accepted"),
      countOf("failed"),
      admin
        .from("platform_lead_alerts")
        .select(ALERT_COLUMNS)
        .eq("status", "failed")
        .order("failed_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, from + FAILED_PAGE_SIZE - 1),
    ]);
    if (
      demo.error || waitlist.error || pending.error || sending.error ||
      accepted.error || failed.error || failedRows.error
    ) {
      return emptyView(true);
    }

    const view = emptyView(false);
    for (const row of (demo.data ?? []) as LeadAlertRow[]) {
      if (row.demo_request_id) view.byDemoRequest.set(row.demo_request_id, row);
    }
    for (const row of (waitlist.data ?? []) as LeadAlertRow[]) {
      if (row.waitlist_id) view.byWaitlist.set(row.waitlist_id, row);
    }
    view.counts = {
      pending: pending.count ?? 0,
      sending: sending.count ?? 0,
      accepted: accepted.count ?? 0,
      failed: failed.count ?? 0,
    };
    view.failed = (failedRows.data ?? []) as LeadAlertRow[];
    view.failedPage = failedPage;
    return view;
  } catch {
    return emptyView(true);
  }
}

const TONE: Record<"ok" | "waiting" | "problem" | "none", string> = {
  ok: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  waiting: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  problem: "bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200",
  none: "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400",
};

/** One lead's alert, for the lead tables. */
export function LeadAlertCell({
  alert,
  loadError,
}: {
  alert: LeadAlertRow | undefined;
  loadError: boolean;
}) {
  if (loadError) {
    return <span className={`rounded px-1.5 py-0.5 text-xs ${TONE.problem}`}>Status unavailable</span>;
  }
  const badge = describeLeadAlert(
    alert
      ? {
          status: alert.status,
          attempt_count: alert.attempt_count,
          last_error_code: alert.last_error_code,
        }
      : null,
  );
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`w-fit rounded px-1.5 py-0.5 text-xs ${TONE[badge.tone]}`}>
        {badge.label}
      </span>
      {alert?.status === "accepted" && alert.accepted_at && (
        <span className="text-xs text-neutral-500">
          <FormattedDateTime iso={alert.accepted_at} />
        </span>
      )}
      {alert?.status === "pending" && alert.attempt_count > 0 && (
        <span className="text-xs text-neutral-500">
          Next try <FormattedDateTime iso={alert.next_attempt_at} />
        </span>
      )}
      {badge.detail && <span className="text-xs text-neutral-500">{badge.detail}</span>}
    </div>
  );
}

/** The console card: is the alert on, what is waiting, what failed. */
export function LeadAlertsCard({
  config,
  view,
}: {
  config: LeadAlertConfigurationStatus;
  view: LeadAlertsView;
}) {
  const blocked = config.state === "blocked";
  const problem = blocked || view.loadError || view.counts.failed > 0;
  const tone = problem
    ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    : "border-neutral-200 dark:border-neutral-800";
  return (
    <section id="lead-alerts" className={`rounded-lg border p-5 ${tone}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium">Lead alerts</h2>
        <span className="rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ring-1 ring-current/30">
          {blocked ? "Not sending" : "On"}
        </span>
      </div>
      <p className="mt-2 max-w-prose text-sm">
        {config.state === "ready" ? (
          <>
            Each new demo request or early-access signup emails the operator
            inbox ({config.maskedRecipient}). Nothing is sent to the prospect.
          </>
        ) : (
          <>
            {leadAlertReason(config.code)} New leads are still saved and listed
            below. Their alerts wait, at most 72 hours, until this is fixed.
          </>
        )}
      </p>
      {view.loadError ? (
        <p className="mt-3 text-sm font-medium">
          Alert status could not be loaded. Do not assume alerts are being sent.
        </p>
      ) : (
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-2"><dt className="opacity-70">Waiting</dt><dd className="tabular-nums">{view.counts.pending}</dd></div>
          <div className="flex gap-2"><dt className="opacity-70">Sending</dt><dd className="tabular-nums">{view.counts.sending}</dd></div>
          <div className="flex gap-2"><dt className="opacity-70">Failed</dt><dd className="tabular-nums">{view.counts.failed}</dd></div>
          <div className="flex gap-2"><dt className="opacity-70">Accepted</dt><dd className="tabular-nums">{view.counts.accepted}</dd></div>
        </dl>
      )}
      <p className="mt-2 text-xs opacity-80">
        Accepted means the email provider accepted the message. It does not
        confirm that it reached the inbox.
      </p>
      {!view.loadError && view.counts.failed > 0 && (
        <div className="mt-4" data-testid="lead-alerts-failed">
          <h3 className="text-sm font-medium">Failed alerts</h3>
          <FailedPager page={view.failedPage} shown={view.failed.length} total={view.counts.failed} />
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {view.failed.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{a.lead_kind === "demo_request" ? "Demo request" : "Early-access signup"}</span>
                <span className="text-xs opacity-80">
                  saved <FormattedDateTime iso={a.created_at} />
                </span>
                <span className="text-xs">
                  {leadAlertReason(a.last_error_code) ?? "Failed."} ({a.attempt_count} of{" "}
                  {LEAD_ALERT_MAX_ATTEMPTS} attempts)
                </span>
                <form action={retryLeadAlertAction}>
                  <input type="hidden" name="id" value={a.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-current/30 px-2 py-0.5 text-xs hover:bg-white/50 dark:hover:bg-black/30"
                  >
                    Retry
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Newer/older links over the failed list, so no failed alert is out of reach. */
function FailedPager({ page, shown, total }: { page: number; shown: number; total: number }) {
  const first = shown === 0 ? 0 : (page - 1) * FAILED_PAGE_SIZE + 1;
  const last = (page - 1) * FAILED_PAGE_SIZE + shown;
  const hasOlder = last < total;
  return (
    <p className="mt-1 flex flex-wrap gap-3 text-xs opacity-80">
      <span>
        Showing {first}–{last} of {total}, most recent first.
      </span>
      {page > 1 && (
        <a className="underline" href={`/admin?leadAlertsFailedPage=${page - 1}#lead-alerts`}>
          Newer
        </a>
      )}
      {hasOlder && (
        <a className="underline" href={`/admin?leadAlertsFailedPage=${page + 1}#lead-alerts`}>
          Older
        </a>
      )}
    </p>
  );
}
