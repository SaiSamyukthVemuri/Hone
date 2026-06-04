import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { recordOpsAlert } from "@/lib/ops/alerts";

// Daily rolling-horizon refresh for recurring break occurrences.
// For every active studio_recurring_break_rules row, materialize
// missing occurrences from today (in the studio's local tz)
// through today + HORIZON_DAYS days. The RPC's underlying ON
// CONFLICT DO NOTHING on (rule_id, occurrence_date) makes
// repeated runs idempotent.
//
// If a rule's materialization fails (typically sqlstate 23P01: a
// freshly-extended occurrence collides with a manually-scheduled
// appointment, timed block, or full-day blockout), the cron does
// NOT silently swallow it. The failing rule is logged as a
// structured JSON line with event = "recurring_break_materialization_conflict"
// or "recurring_break_materialization_error", the run continues
// to attempt the remaining rules, and the response body lists
// every failure so monitoring sees it.
//
// Bumped from 90 → 186 in migration 0036 (Booking Horizon v1). The
// public booking horizon is now per-studio (3, 4, or 6 months); the
// maximum is 6 × 31 = 186 days. We pre-materialize for the maximum
// regardless of each studio's choice so a studio that increases
// their horizon does not get a coverage gap during the days between
// the increase and the next cron run. Excess rows for studios on
// shorter horizons are harmless — they sit in
// studio_calendar_reservations and are simply never read by the
// public booking page beyond that studio's selected window.

const HORIZON_DAYS = 186;

type RuleRow = {
  id: string;
  studio_id: string;
  studio: { timezone: string | null } | { timezone: string | null }[] | null;
};

type Failure = {
  rule_id: string;
  studio_id: string;
  error: string;
  code: string | null;
};

function horizonEndInTz(tz: string): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  noon.setUTCDate(noon.getUTCDate() + HORIZON_DAYS);
  return `${noon.getUTCFullYear()}-${String(noon.getUTCMonth() + 1).padStart(2, "0")}-${String(noon.getUTCDate()).padStart(2, "0")}`;
}

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("studio_recurring_break_rules")
      .select("id, studio_id, studio:studios(timezone)")
      .eq("active", true);

    if (error) {
      // PR #153. Database lookup failure at the top of the cron is
      // route-level; surface as cron_route_failed and 500.
      await recordOpsAlert({
        severity: "critical",
        event: "cron_route_failed",
        message: error.message,
        route: "/api/cron/materialize-recurring-breaks",
        safeDetails: {
          stage: "rule_lookup",
          code: error.code ?? null,
          duration_ms: Date.now() - startedAt,
        },
      });
      return NextResponse.json(
        { ok: false, error: "cron_failed" },
        { status: 500 },
      );
    }

    const rules = (data ?? []) as RuleRow[];
    const failures: Failure[] = [];
    let succeeded = 0;

    for (const r of rules) {
      const studio = Array.isArray(r.studio) ? (r.studio[0] ?? null) : r.studio;
      const tz = studio?.timezone ?? "America/Toronto";
      const horizonEnd = horizonEndInTz(tz);
      const { error: rpcErr } = await admin.rpc(
        "materialize_recurring_break_rule",
        { p_rule_id: r.id, p_horizon_end: horizonEnd },
      );
      if (rpcErr) {
        const event =
          rpcErr.code === "23P01"
            ? "recurring_break_materialization_conflict"
            : "recurring_break_materialization_error";
        console.error(
          JSON.stringify({
            event,
            rule_id: r.id,
            studio_id: r.studio_id,
            code: rpcErr.code ?? null,
            error: rpcErr.message,
            timestamp: new Date().toISOString(),
          }),
        );
        failures.push({
          rule_id: r.id,
          studio_id: r.studio_id,
          error: rpcErr.message,
          code: rpcErr.code ?? null,
        });
        continue;
      }
      succeeded += 1;
    }

    // PR #153. If any rule failed, surface a single warning-severity
    // alert summarising the count rather than one alert per rule.
    // 23P01 collisions are expected when a freshly-extended
    // occurrence intersects a manually-scheduled appointment / block;
    // the per-rule structured log above already captures them.
    if (failures.length > 0) {
      await recordOpsAlert({
        severity: "warning",
        event: "recurring_break_materialization_failures",
        message: `${failures.length}/${rules.length} recurring-break rules failed materialization.`,
        route: "/api/cron/materialize-recurring-breaks",
        safeDetails: {
          rules_processed: rules.length,
          failures_count: failures.length,
          succeeded,
          // Codes only; no studio_id list to keep the safe_details
          // payload bounded. The structured per-rule logs above
          // carry the studio_id for operator triage.
          failure_codes: failures.map((f) => f.code ?? "unknown").slice(0, 50),
        },
      });
    }

    return NextResponse.json({
      ok: failures.length === 0,
      rules_processed: rules.length,
      succeeded,
      failures,
    });
  } catch (err) {
    await recordOpsAlert({
      severity: "critical",
      event: "cron_route_failed",
      message:
        err instanceof Error ? err.message : String(err ?? "unknown error"),
      route: "/api/cron/materialize-recurring-breaks",
      safeDetails: {
        duration_ms: Date.now() - startedAt,
      },
    });
    return NextResponse.json(
      { ok: false, error: "cron_failed" },
      { status: 500 },
    );
  }
}
