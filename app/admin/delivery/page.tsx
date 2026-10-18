import { createAdminClient } from "@/lib/supabase/admin-server";
import { describeIncident, purposeLabel, type OwnerIncident } from "@/lib/delivery/incidents";
import { healthFindings, readEmailDeliveryHealth } from "@/lib/email/delivery-health";
import { concernLabel, ledgerStatusWords } from "@/lib/delivery/concerns";
import { closeDeliveryConcernAction, resolveDeliveryIncidentAction } from "./actions";

// DELIVERY-VISIBILITY-02 — platform support's delivery queue.
//
// Cross-studio and platform-only: /admin is gated by the ADMIN_EMAILS allowlist
// in app/admin/layout.tsx, and every read here runs through service_role-only
// commands (0215: support_delivery_incidents, support_email_receipt_outcomes,
// email_delivery_health). It shows operational metadata only: no client name,
// address, phone or message content. Unattributed and quarantined receipts are
// shown as counts, because they belong to no studio.

export const dynamic = "force-dynamic";

type SupportIncident = OwnerIncident & { studio_id: string; studio_name: string };
type SupportConcern = {
  concern_id: string;
  studio_name: string;
  appointment_id: string;
  channel: string;
  purpose: string;
  ledger_status_at_report: string;
  current_ledger_status: string | null;
  reported_at: string;
};
type ReceiptOutcome = {
  processing_state: string;
  processing_result: string | null;
  receipts: number;
  last_received_at: string;
};

function when(iso: string | null): string {
  return iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z" : "never";
}

export default async function DeliveryQueuePage() {
  const admin = createAdminClient();
  const [incidentsRes, outcomesRes, health, concernsRes] = await Promise.all([
    admin.rpc("support_delivery_incidents", { p_include_resolved: true }),
    admin.rpc("support_email_receipt_outcomes"),
    readEmailDeliveryHealth(admin),
    admin.rpc("support_delivery_concerns", { p_include_closed: false }),
  ]);
  if (incidentsRes.error) {
    throw new Error("Failed to load delivery incidents.");
  }
  const incidents = (incidentsRes.data ?? []) as SupportIncident[];
  const open = incidents.filter((i) => i.resolved_at === null);
  const resolved = incidents.filter((i) => i.resolved_at !== null);
  // An unreadable summary is UNKNOWN, never "no recent events" (Codex P2 4244834156).
  const outcomes: ReceiptOutcome[] | null =
    outcomesRes.error || !Array.isArray(outcomesRes.data) ? null : (outcomesRes.data as ReceiptOutcome[]);
  const findings = health ? healthFindings(health) : [];
  const concerns = (concernsRes.data ?? []) as SupportConcern[];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Message delivery</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Delivery problems across studios, one row per kind of problem with a count. Studio owners see their own
          incidents on Settings → Launch. Resolving closes the incident; the next failure of the same kind opens a new one.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Email delivery health</h2>
        {!health ? (
          <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
            Delivery health could not be read. Treat it as unknown, not healthy.
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <dt className="text-neutral-500">Pending events</dt>
            <dd>{health.pendingReceipts}</dd>
            <dt className="text-neutral-500">Oldest pending</dt>
            <dd>{health.oldestPendingSeconds === null ? "none" : `${Math.round(health.oldestPendingSeconds / 60)} min`}</dd>
            <dt className="text-neutral-500">Accepted, no report 24h+</dt>
            <dd>{health.unreportedAccepted}</dd>
            <dt className="text-neutral-500">Last recovery sweep</dt>
            <dd>{when(health.lastSweepAt)}</dd>
          </dl>
        )}
        {findings.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {findings.map((f) => (
              <li key={f.event} className="text-amber-900 dark:text-amber-200">
                {f.severity === "critical" ? "Critical: " : ""}
                {f.message}
              </li>
            ))}
          </ul>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">
            Resend events in the last 7 days, by outcome
          </summary>
          {outcomes === null ? (
            <p className="mt-2 text-xs text-red-800 dark:text-red-300">
              The event summary could not be read. Treat it as unknown, not as no events.
            </p>
          ) : outcomes.length === 0 ? (
            <p className="mt-2 text-xs text-neutral-500">No Resend events received in the last 7 days.</p>
          ) : (
            <table className="mt-2 text-xs">
              <thead>
                <tr className="text-left text-neutral-500">
                  <th className="pr-4">State</th>
                  <th className="pr-4">Result</th>
                  <th className="pr-4">Events</th>
                  <th>Latest</th>
                </tr>
              </thead>
              <tbody>
                {outcomes.map((o) => (
                  <tr key={`${o.processing_state}/${o.processing_result}`}>
                    <td className="pr-4">{o.processing_state}</td>
                    <td className="pr-4">{o.processing_result ?? "pending"}</td>
                    <td className="pr-4">{o.receipts}</td>
                    <td>{when(o.last_received_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </details>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Open incidents ({open.length})</h2>
        {open.length === 0 ? (
          <p className="text-sm text-neutral-500">No open delivery incidents.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {open.map((i) => {
              const d = describeIncident(i);
              return (
                <li key={i.incident_id} className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
                  <p className="font-medium">
                    {i.studio_name} · {d.title} · {i.occurrences}×
                    <span className="ml-2 text-xs font-normal text-neutral-500">
                      {d.owner === "hone" ? "Hone to act" : "Studio to act"}
                    </span>
                  </p>
                  <p className="text-xs text-neutral-600 dark:text-neutral-400">
                    {d.meaning} Reason: {i.last_reason ?? "not reported"}. First {when(i.first_seen_at)}, last {when(i.last_seen_at)}.
                  </p>
                  <form action={resolveDeliveryIncidentAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="incident_id" value={i.incident_id} />
                    <select name="resolution" defaultValue="fixed" className="rounded border px-2 py-1 text-xs" aria-label="Resolution">
                      <option value="fixed">Fixed</option>
                      <option value="acknowledged">Acknowledged</option>
                      <option value="not_actionable">Not actionable</option>
                    </select>
                    <button type="submit" className="rounded border px-2 py-1 text-xs">
                      Resolve
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Client says not received ({concerns.length} open)</h2>
        {concernsRes.error ? (
          <p className="text-sm text-red-800 dark:text-red-300">Concerns could not be loaded. Treat them as unknown.</p>
        ) : concerns.length === 0 ? (
          <p className="text-sm text-neutral-500">No open concerns.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {concerns.map((c) => (
              <li key={c.concern_id} className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
                <p className="font-medium">
                  {c.studio_name} · {concernLabel(c.channel, c.purpose)}
                </p>
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                  Reported {when(c.reported_at)}. When reported, {ledgerStatusWords(c.ledger_status_at_report)}. Now:{" "}
                  {c.current_ledger_status ? ledgerStatusWords(c.current_ledger_status) : "no tracked record"}.
                </p>
                <form action={closeDeliveryConcernAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="concern_id" value={c.concern_id} />
                  <select name="resolution" defaultValue="explained" className="rounded border px-2 py-1 text-xs" aria-label="Concern resolution">
                    <option value="explained">Explained to the studio</option>
                    <option value="resent_by_studio">Studio resent it</option>
                    <option value="provider_issue">Provider issue</option>
                    <option value="not_actionable">Not actionable</option>
                  </select>
                  <button type="submit" className="rounded border px-2 py-1 text-xs">
                    Close concern
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {resolved.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-medium">Resolved in the last 14 days</h2>
          <ul className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
            {resolved.map((i) => (
              <li key={i.incident_id}>
                {i.studio_name} · {purposeLabel(i.purpose)} {i.channel} {i.failure_class} · {i.occurrences}× · {i.resolution} {when(i.resolved_at)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
