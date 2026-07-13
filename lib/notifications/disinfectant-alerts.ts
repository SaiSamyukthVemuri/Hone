import "server-only";
import type { createClient } from "@/lib/supabase/server";
import {
  disinfectantDueStatus,
  daysBetween,
} from "@/lib/record-keeping/disinfectant-status";

// Overdue-disinfectant operational alerts for the Notification Centre (Willow —
// Issue #420 follow-up / Chloe: overdue "Replace now" disinfectants should also
// appear in Notifications).
//
// COMPUTED, NOT PERSISTED. The overdue condition is a read-time DERIVED state
// (lib/record-keeping/disinfectant-status.ts, the SAME source of truth the
// Records page renders), so these alerts are computed on each Notification Centre
// / header-badge render — never a stored row, cron, or email/SMS. That gives free
// auto-resolution (recording a replacement / discard / a later due date makes the
// item no longer overdue, so the alert simply stops being computed), free
// deduplication (exactly one alert per overdue record, keyed by the record id),
// and no duplicate on repeated loads. A new batch (new record) that later goes
// overdue yields a new alert. No migration required.
//
// Privacy: the alert carries ONLY studio-operational, member-visible fields
// already shown on the Records page — the product/container label, the replace-by
// date, and days overdue. NEVER a client name, appointment, treatment/health data,
// or an internal database identifier (the record id is used only as a stable React
// key + dedup identity; it is never rendered).

export type OverdueDisinfectantAlert = {
  // Stable dedup identity (kind + record id). Used as the list key; not displayed.
  id: string;
  recordId: string;
  title: string;
  body: string;
  // Non-sensitive product/container label (record_keeping_disinfectants.disinfectant_name).
  contextLabel: string;
  dueDate: string; // YYYY-MM-DD replace-by date
  daysOverdue: number;
  daysOverdueText: string;
  // Operational safety alert. Sorts ahead of routine notifications but is NOT a
  // payment/security/clinical critical.
  severity: "warning";
  href: string;
  actionLabel: string;
};

type DisinfectantRow = {
  id: string;
  disinfectant_name: string | null;
  discard_due_date: string | null;
  date_discarded: string | null;
};

const DISINFECTANTS_HREF = "/records?section=disinfectants";

// Pure + deterministic (studio-local `todayYmd` is passed in), so it is fully
// unit-testable and timezone-consistent with the Records UI. Overdue is decided
// by the ONE shared helper (disinfectantDueStatus) — never re-derived here.
export function computeOverdueDisinfectantAlerts(
  records: ReadonlyArray<DisinfectantRow>,
  todayYmd: string,
): OverdueDisinfectantAlert[] {
  const today = todayYmd.slice(0, 10);
  const alerts: OverdueDisinfectantAlert[] = [];
  for (const r of records) {
    if (disinfectantDueStatus(r, today) !== "overdue") continue;
    const dueDate = (r.discard_due_date ?? "").slice(0, 10);
    const daysOverdue = daysBetween(dueDate, today); // due < today ⇒ positive
    alerts.push({
      id: `disinfectant-overdue:${r.id}`,
      recordId: r.id,
      title: "Replace disinfectant now",
      body: "A disinfectant record is overdue for replacement.",
      contextLabel: r.disinfectant_name?.trim() || "Disinfectant",
      dueDate,
      daysOverdue,
      daysOverdueText:
        daysOverdue === 1 ? "1 day overdue" : `${daysOverdue} days overdue`,
      severity: "warning",
      href: DISINFECTANTS_HREF,
      actionLabel: "Review disinfectant records",
    });
  }
  // Most overdue first; stable tiebreak by record id so ordering is deterministic.
  alerts.sort(
    (a, b) =>
      b.daysOverdue - a.daysOverdue ||
      (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
  );
  return alerts;
}

// Bounded, studio-scoped read + compute. Uses the RLS cookie client (the caller
// passes the authenticated client + the server-derived studio id), so tenancy is
// enforced by is_studio_member(studio_id) AND the explicit studio filter — no
// browser-supplied id is trusted. Fetches only the currently-in-use batches that
// carry a replace-by date (a naturally small set), capped for safety; the overdue
// decision + display are then applied by the pure helper above. One query — no
// per-record / per-practitioner lookups.
export async function loadOverdueDisinfectantAlerts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
  todayYmd: string,
  limit = 500,
): Promise<OverdueDisinfectantAlert[]> {
  try {
    const { data, error } = await supabase
      .from("record_keeping_disinfectants")
      .select("id, disinfectant_name, discard_due_date, date_discarded")
      .eq("studio_id", studioId)
      .is("date_discarded", null) // not yet discarded/replaced
      .not("discard_due_date", "is", null) // has a replace-by date
      .order("discard_due_date", { ascending: true })
      .limit(limit);
    if (error) return [];
    return computeOverdueDisinfectantAlerts((data ?? []) as DisinfectantRow[], todayYmd);
  } catch {
    return [];
  }
}
