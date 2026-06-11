import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  resolveOpsAlertAction,
  sendTestCriticalAlertAction,
} from "./actions";

// PR #193. Operator dashboard for ops_alerts: the human-visible
// surface the live-payments audit (docs/18 §6) flagged as a P0
// blocker. Admin-only: app/admin/layout.tsx redirects non-admins
// before this page renders, and the resolve action re-checks
// isAdmin server-side.
//
// Reads use the service-role client deliberately: ops_alerts rows
// with studio_id NULL (webhook failures before lineage resolution)
// are invisible to studio-member RLS by design and the operator is
// exactly who must see them.
//
// What renders is safe by construction: every safe_details payload
// was passed through the lib/ops/alerts.ts redactor at write time
// (credential keys + secret/JWT/bearer-shaped values stripped), and
// alert columns carry ids + sanitized messages only. No card data,
// clinical content, or raw webhook payloads exist in this table.

export const dynamic = "force-dynamic";

type OpsAlertRow = {
  id: string;
  created_at: string;
  severity: "info" | "warning" | "critical";
  event: string;
  message: string;
  studio_id: string | null;
  appointment_id: string | null;
  client_id: string | null;
  stripe_event_id: string | null;
  stripe_payment_intent_id: string | null;
  manual_fee_attempt_id: string | null;
  route: string | null;
  safe_details: Record<string, unknown>;
  resolved_at: string | null;
  resolution_note: string | null;
};

const SEVERITY_ORDER: Record<OpsAlertRow["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function severityBadge(severity: OpsAlertRow["severity"]): string {
  if (severity === "critical") {
    return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300";
  }
  if (severity === "warning") {
    return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
  }
  return "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
}

function idLines(alert: OpsAlertRow): Array<{ label: string; value: string }> {
  const lines: Array<{ label: string; value: string }> = [];
  if (alert.studio_id) lines.push({ label: "studio", value: alert.studio_id });
  if (alert.appointment_id)
    lines.push({ label: "appointment", value: alert.appointment_id });
  if (alert.client_id) lines.push({ label: "client", value: alert.client_id });
  if (alert.stripe_event_id)
    lines.push({ label: "stripe event", value: alert.stripe_event_id });
  if (alert.stripe_payment_intent_id)
    lines.push({ label: "payment intent", value: alert.stripe_payment_intent_id });
  if (alert.manual_fee_attempt_id)
    lines.push({ label: "fee attempt", value: alert.manual_fee_attempt_id });
  if (alert.route) lines.push({ label: "route", value: alert.route });
  return lines;
}

export default async function OpsAlertsPage() {
  const admin = createAdminClient();
  const [unresolvedRes, resolvedRes] = await Promise.all([
    admin
      .from("ops_alerts")
      .select("*")
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("ops_alerts")
      .select("*")
      .not("resolved_at", "is", null)
      .order("resolved_at", { ascending: false })
      .limit(25),
  ]);
  if (unresolvedRes.error) {
    throw new Error(`Failed to load alerts: ${unresolvedRes.error.message}`);
  }

  // Critical first, then warning, then info; newest first within a
  // severity. The fetch is newest-first so the JS sort is stable.
  const unresolved = ((unresolvedRes.data ?? []) as OpsAlertRow[]).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const resolved = (resolvedRes.data ?? []) as OpsAlertRow[];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ops alerts</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Unresolved first, critical on top. Resolve once handled; the row
            stays for history. Critical alerts also email the operators in
            OPS_ALERT_EMAILS.
          </p>
        </div>
        {/* PR #195: deterministic smoke for the REAL alert pipeline
            (recordOpsAlert -> durable row -> critical email). The new
            alert appears in Unresolved below; the email lands in
            OPS_ALERT_EMAILS inboxes. Resolve it like any alert. */}
        <form action={sendTestCriticalAlertAction}>
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-3 py-2 text-xs font-medium hover:bg-neutral-50"
          >
            Send test critical alert
          </button>
        </form>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Unresolved
          <span className="ml-2 text-sm font-normal text-neutral-500">
            {unresolved.length}
          </span>
        </h2>
        {unresolved.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-sm text-neutral-500">
            No unresolved alerts. Quiet is good.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {unresolved.map((alert) => (
              <li
                key={alert.id}
                className="rounded-lg border border-neutral-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${severityBadge(alert.severity)}`}
                  >
                    {alert.severity}
                  </span>
                  <span className="font-mono text-sm font-medium">
                    {alert.event}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {new Date(alert.created_at).toISOString()}
                  </span>
                </div>
                <p className="mt-2 text-sm text-neutral-800">{alert.message}</p>
                {idLines(alert).length > 0 && (
                  <p className="mt-1.5 text-xs text-neutral-500">
                    {idLines(alert)
                      .map((l) => `${l.label}: ${l.value}`)
                      .join(" · ")}
                  </p>
                )}
                {Object.keys(alert.safe_details ?? {}).length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-900">
                      Details (redacted at write time)
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-neutral-50 p-2 text-xs">
                      {JSON.stringify(alert.safe_details, null, 2)}
                    </pre>
                  </details>
                )}
                <form
                  action={resolveOpsAlertAction}
                  className="mt-3 flex flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="alert_id" value={alert.id} />
                  <input
                    type="text"
                    name="resolution_note"
                    placeholder="Resolution note (optional)"
                    className="w-64 rounded-md border border-neutral-300 px-2 py-1.5 text-xs"
                  />
                  <button
                    type="submit"
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50"
                  >
                    Mark resolved
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Recently resolved
          <span className="ml-2 text-sm font-normal text-neutral-500">
            last {resolved.length}
          </span>
        </h2>
        {resolved.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing resolved yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {resolved.map((alert) => (
              <li
                key={alert.id}
                className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600"
              >
                <span
                  className={`mr-2 rounded-full px-2 py-0.5 text-xs font-medium uppercase ${severityBadge(alert.severity)}`}
                >
                  {alert.severity}
                </span>
                <span className="font-mono">{alert.event}</span>
                <span className="ml-2 text-xs text-neutral-500">
                  resolved {alert.resolved_at ? new Date(alert.resolved_at).toISOString() : ""}
                </span>
                {alert.resolution_note && (
                  <p className="mt-1 text-xs text-neutral-500">
                    {alert.resolution_note}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
