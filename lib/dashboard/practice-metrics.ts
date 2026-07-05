import { createClient } from "@/lib/supabase/server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { addDays, todayInTz, utcInstantFromLocal } from "@/lib/booking/tz";
import {
  getClientProcedureRecords,
  type ClientProcedureRecord,
} from "@/lib/record-keeping/queries";

// PR #208: Practice Dashboard V1 metrics. Read-only aggregation over
// EXISTING tables (appointments + services price join, sessions /
// session_blocks via the record-keeping procedure read, and
// CURRENT-mode payment_charge_attempts counts — the card labels flip
// between test and live with inferStripeLivemode()). No payment
// calculation, executor, or gate is touched; live payments remain
// disabled, so nothing here is "revenue": the UI labels everything
// as booked/completed SERVICE VALUE based on service menu prices.

export type DashboardPeriod = "today" | "week" | "month";

export function isDashboardPeriod(v: string | undefined): v is DashboardPeriod {
  return v === "today" || v === "week" || v === "month";
}

// Pure: resolve the studio-local date range for a period. `todayLocal`
// is the studio-local YYYY-MM-DD. Weeks start Monday; ranges are
// [startLocal, endLocalExclusive).
export function resolvePeriodRange(
  todayLocal: string,
  period: DashboardPeriod,
): { startLocal: string; endLocalExclusive: string; label: string } {
  if (period === "today") {
    return {
      startLocal: todayLocal,
      endLocalExclusive: addDays(todayLocal, 1),
      label: "today",
    };
  }
  if (period === "week") {
    // Day-of-week of the local date; anchor at noon UTC so the UTC
    // calendar day matches the local date string regardless of host tz.
    const dow = new Date(`${todayLocal}T12:00:00Z`).getUTCDay(); // 0=Sun
    const sinceMonday = (dow + 6) % 7;
    const startLocal = addDays(todayLocal, -sinceMonday);
    return {
      startLocal,
      endLocalExclusive: addDays(startLocal, 7),
      label: "this week",
    };
  }
  const startLocal = `${todayLocal.slice(0, 8)}01`;
  const [y, m] = todayLocal.split("-").map((p) => parseInt(p, 10));
  const nextMonth =
    m === 12
      ? `${y + 1}-01-01`
      : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { startLocal, endLocalExclusive: nextMonth, label: "this month" };
}

export type AppointmentMetricsInput = ReadonlyArray<{
  status: string;
  starts_at: string;
  cancellation_reason: string | null;
  price_cents: number | null;
}>;

export type AppointmentMetrics = {
  total: number;
  completed: number;
  upcoming: number;
  cancelled: number;
  noShows: number;
  lateCancellations: number;
  // Service-menu price totals; NOT collected revenue. Booked = active
  // bookings (confirmed + completed); appointments without a service
  // price contribute nothing (never invented).
  bookedValueCents: number;
  completedValueCents: number;
};

// Pure: fold appointment rows into the dashboard counts/values.
export function summarizeAppointments(
  rows: AppointmentMetricsInput,
  nowIso: string,
): AppointmentMetrics {
  const m: AppointmentMetrics = {
    total: rows.length,
    completed: 0,
    upcoming: 0,
    cancelled: 0,
    noShows: 0,
    lateCancellations: 0,
    bookedValueCents: 0,
    completedValueCents: 0,
  };
  for (const r of rows) {
    const price = r.price_cents ?? 0;
    if (r.status === "completed") {
      m.completed += 1;
      m.bookedValueCents += price;
      m.completedValueCents += price;
    } else if (r.status === "confirmed") {
      m.bookedValueCents += price;
      if (r.starts_at > nowIso) m.upcoming += 1;
    } else if (r.status === "cancelled") {
      m.cancelled += 1;
      if (r.cancellation_reason === "late_cancellation") {
        m.lateCancellations += 1;
      }
    } else if (r.status === "no_show") {
      m.noShows += 1;
    }
  }
  return m;
}

export type ProcedureActionMetrics = {
  reviewedSessions: number;
  incompleteRecords: number;
  missingProbeLots: number;
  aftercareNotMarked: number;
};

// Pure: completeness sweep over generated procedure records (the same
// shape Record Keeping renders). A record is incomplete when ANY of
// the health-inspection fields is missing: client DOB/phone/email/
// address, operator, at least one treatment area, a probe lot on
// every area, and the aftercare/risks mark.
export function summarizeProcedureCompleteness(
  records: ReadonlyArray<ClientProcedureRecord>,
): ProcedureActionMetrics {
  let incomplete = 0;
  let missingLots = 0;
  let aftercareNotMarked = 0;
  for (const r of records) {
    const areaLotsMissing = r.areas.filter(
      (a) => !a.probeLotNumber?.trim(),
    ).length;
    missingLots += areaLotsMissing;
    if (!r.aftercareExplainedAt) aftercareNotMarked += 1;
    const missingAny =
      !r.dateOfBirth ||
      !r.phone?.trim() ||
      !r.email?.trim() ||
      !r.address?.trim() ||
      !r.operatorName ||
      r.areas.length === 0 ||
      areaLotsMissing > 0 ||
      !r.aftercareExplainedAt;
    if (missingAny) incomplete += 1;
  }
  return {
    reviewedSessions: records.length,
    incompleteRecords: incomplete,
    missingProbeLots: missingLots,
    aftercareNotMarked,
  };
}

// PR #225: charted-within-24h, the treatment-memory loop health
// metric. v1 definition (documented in docs/13):
//   Denominator: appointments with status 'completed' whose ends_at
//     falls in the ROLLING last 7 days (independent of the period
//     selector, so the denominator stays stable).
//   Numerator: those whose first treatment-area save (the earliest
//     non-deleted session_block.created_at on a LINKED, non-deleted
//     session) is at most 24 hours after the appointment's ends_at.
//   "Charted" requires at least one treatment area: a session row
//     with zero areas has no recorded treatment details and does not
//     count. Unlinked sessions are not counted (the charting flow
//     that completes an appointment also stamps the link, so a
//     completed appointment charted normally is always linked).
// Boundary: exactly 24h counts as within. This is practice-health
// feedback for the studio as a whole; it is never grouped or ranked
// by practitioner.
export const CHARTED_WINDOW_DAYS = 7;
export const CHARTED_WITHIN_MS = 24 * 60 * 60 * 1000;

export type ChartedWithin24hInput = ReadonlyArray<{
  endsAt: string;
  firstChartedAt: string | null;
}>;

export type ChartedWithin24hMetrics = {
  completedCount: number;
  chartedWithin24hCount: number;
};

export function summarizeChartedWithin24h(
  rows: ChartedWithin24hInput,
): ChartedWithin24hMetrics {
  let charted = 0;
  for (const r of rows) {
    if (!r.firstChartedAt) continue;
    const endsMs = new Date(r.endsAt).getTime();
    const chartedMs = new Date(r.firstChartedAt).getTime();
    if (!Number.isFinite(endsMs) || !Number.isFinite(chartedMs)) continue;
    if (chartedMs - endsMs <= CHARTED_WITHIN_MS) charted += 1;
  }
  return { completedCount: rows.length, chartedWithin24hCount: charted };
}

// CURRENT-mode payment-attempt counts (the query is scoped by
// inferStripeLivemode()). The historical "testPayments" field/type names
// are kept for API stability; in a live deployment these are LIVE counts
// and the snapshot card labels them accordingly.
export type TestPaymentMetrics = {
  prepared: number;
  charged: number;
  refunds: number;
};

export type PracticeDashboardMetrics = {
  period: DashboardPeriod;
  periodLabel: string;
  appointments: AppointmentMetrics;
  testPayments: TestPaymentMetrics;
  actions: ProcedureActionMetrics;
  chartedWithin24h: ChartedWithin24hMetrics;
};

export async function getPracticeDashboardMetrics(
  studioId: string,
  timezone: string,
  period: DashboardPeriod,
): Promise<PracticeDashboardMetrics> {
  const todayLocal = todayInTz(timezone);
  const range = resolvePeriodRange(todayLocal, period);
  const startUtc = utcInstantFromLocal(range.startLocal, "00:00", timezone);
  const endUtc = utcInstantFromLocal(
    range.endLocalExclusive,
    "00:00",
    timezone,
  );

  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const windowStartIso = new Date(
    Date.now() - CHARTED_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const [
    { data: apptRows },
    { data: paymentRows },
    procedureRecords,
    { data: completedAppts },
  ] = await Promise.all([
      supabase
        .from("appointments")
        .select(
          "status, starts_at, cancellation_reason, service:services(price_cents)",
        )
        .eq("studio_id", studioId)
        .gte("starts_at", startUtc.toISOString())
        .lt("starts_at", endUtc.toISOString()),
      // CURRENT-mode ledger counts for the period. (The pre-0101
      // all-rows-are-test-mode invariant is defunct: 0101 dropped that
      // CHECK, prepare stamps inferStripeLivemode(), and 0105 allows one
      // test AND one live attempt per slot — an unscoped count would mix
      // modes and could double-count a single real-world payment. The
      // card labels flip with the mode.)
      supabase
        .from("payment_charge_attempts")
        .select("status, refund_status")
        .eq("studio_id", studioId)
        .eq("stripe_livemode", inferStripeLivemode())
        .gte("created_at", startUtc.toISOString())
        .lt("created_at", endUtc.toISOString()),
      // Same 100-session window as before; only the parameter shape
      // changed when PR #223 added the per-client filter option.
      getClientProcedureRecords(studioId, { limit: 100 }),
      // PR #225 charted-within-24h denominator: completed
      // appointments that ENDED in the rolling last 7 days.
      supabase
        .from("appointments")
        .select("id, ends_at")
        .eq("studio_id", studioId)
        .eq("status", "completed")
        .gte("ends_at", windowStartIso)
        .lte("ends_at", nowIso),
    ]);

  // PR #225 numerator: earliest non-deleted treatment-area save on a
  // linked, non-deleted session, per completed appointment. Two
  // batched reads; no N+1.
  const completedRows = (completedAppts ?? []) as Array<{
    id: string;
    ends_at: string;
  }>;
  const firstChartedByAppointment = new Map<string, string>();
  if (completedRows.length > 0) {
    const { data: linkedSessions } = await supabase
      .from("sessions")
      .select("id, appointment_id")
      .eq("studio_id", studioId)
      .in("appointment_id", completedRows.map((r) => r.id))
      .is("deleted_at", null);
    const sessionToAppointment = new Map(
      ((linkedSessions ?? []) as Array<{ id: string; appointment_id: string }>).map(
        (s) => [s.id, s.appointment_id],
      ),
    );
    if (sessionToAppointment.size > 0) {
      const { data: blockRows } = await supabase
        .from("session_blocks")
        .select("session_id, created_at")
        .eq("studio_id", studioId)
        .in("session_id", [...sessionToAppointment.keys()])
        .is("deleted_at", null);
      for (const b of (blockRows ?? []) as Array<{
        session_id: string;
        created_at: string;
      }>) {
        const apptId = sessionToAppointment.get(b.session_id);
        if (!apptId) continue;
        const existing = firstChartedByAppointment.get(apptId);
        if (!existing || b.created_at < existing) {
          firstChartedByAppointment.set(apptId, b.created_at);
        }
      }
    }
  }
  const chartedWithin24h = summarizeChartedWithin24h(
    completedRows.map((r) => ({
      endsAt: r.ends_at,
      firstChartedAt: firstChartedByAppointment.get(r.id) ?? null,
    })),
  );

  const appointments = summarizeAppointments(
    ((apptRows ?? []) as Array<{
      status: string;
      starts_at: string;
      cancellation_reason: string | null;
      service: { price_cents: number | null } | { price_cents: number | null }[] | null;
    }>).map((r) => {
      const svc = Array.isArray(r.service) ? r.service[0] : r.service;
      return {
        status: r.status,
        starts_at: r.starts_at,
        cancellation_reason: r.cancellation_reason,
        price_cents: svc?.price_cents ?? null,
      };
    }),
    new Date().toISOString(),
  );

  const testPayments: TestPaymentMetrics = {
    prepared: 0,
    charged: 0,
    refunds: 0,
  };
  for (const p of (paymentRows ?? []) as Array<{
    status: string;
    refund_status: string | null;
  }>) {
    if (p.status === "ready" || p.status === "pending_stripe") {
      testPayments.prepared += 1;
    }
    if (p.status === "succeeded") testPayments.charged += 1;
    if (p.refund_status === "succeeded") testPayments.refunds += 1;
  }

  return {
    period,
    periodLabel: range.label,
    appointments,
    testPayments,
    actions: summarizeProcedureCompleteness(procedureRecords),
    chartedWithin24h,
  };
}
