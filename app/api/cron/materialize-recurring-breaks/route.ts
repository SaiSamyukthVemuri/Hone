import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";

// Daily rolling-horizon refresh for recurring break occurrences.
// For every active studio_recurring_break_rules row, materialize
// missing occurrences from today (in the studio's local tz)
// through today + 90 days. The RPC's underlying ON CONFLICT DO
// NOTHING on (rule_id, occurrence_date) makes repeated runs
// idempotent.
//
// If a rule's materialization fails (typically sqlstate 23P01: a
// freshly-extended occurrence collides with a manually-scheduled
// appointment, timed block, or full-day blockout), the cron does
// NOT silently swallow it. The failing rule is logged as a
// structured JSON line with event = "recurring_break_materialization_conflict"
// or "recurring_break_materialization_error", the run continues
// to attempt the remaining rules, and the response body lists
// every failure so monitoring sees it.

const HORIZON_DAYS = 90;

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
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("studio_recurring_break_rules")
    .select("id, studio_id, studio:studios(timezone)")
    .eq("active", true);

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
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

  return NextResponse.json({
    ok: failures.length === 0,
    rules_processed: rules.length,
    succeeded,
    failures,
  });
}
