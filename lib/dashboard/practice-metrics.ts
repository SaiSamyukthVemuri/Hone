import { createClient } from "@/lib/supabase/server";
import { addDays, todayInTz, utcInstantFromLocal } from "@/lib/booking/tz";
import {
  getClientProcedureRecords,
  type ClientProcedureRecord,
} from "@/lib/record-keeping/queries";

// PR #208: Practice Dashboard V1 metrics. Read-only aggregation over
// EXISTING tables (appointments + services price join, sessions /
// session_blocks via the record-keeping procedure read, and clearly
// labeled test-mode payment_charge_attempts counts). No payment
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
  const [{ data: apptRows }, { data: paymentRows }, procedureRecords] =
    await Promise.all([
      supabase
        .from("appointments")
        .select(
          "status, starts_at, cancellation_reason, service:services(price_cents)",
        )
        .eq("studio_id", studioId)
        .gte("starts_at", startUtc.toISOString())
        .lt("starts_at", endUtc.toISOString()),
      // Test-mode-only ledger counts for the period. Every row in
      // payment_charge_attempts is stripe_livemode=false by DB CHECK;
      // the card labels these explicitly as test-mode.
      supabase
        .from("payment_charge_attempts")
        .select("status, refund_status")
        .eq("studio_id", studioId)
        .gte("created_at", startUtc.toISOString())
        .lt("created_at", endUtc.toISOString()),
      getClientProcedureRecords(studioId, 100),
    ]);

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
  };
}
