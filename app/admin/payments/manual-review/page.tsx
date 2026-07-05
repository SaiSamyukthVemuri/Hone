import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { AdminModeBadge } from "@/app/admin/mode-badge";
import { isAdmin } from "@/lib/admin";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  STUCK_PENDING_THRESHOLD_MINUTES,
  MANUAL_REVIEW_NEXT_STEP,
  selectPaymentReviewAlerts,
  toStuckAttemptView,
  type StuckAttemptRow,
  type ReviewAlertRow,
  type StuckAttemptView,
  type ReviewAlertView,
} from "@/lib/billing/payment-manual-review";

// PR #290. Read-only admin payment manual-review queue.
//
// PR #281 made payment success authoritative: a Stripe-succeeded charge that
// Hone could not persist returns needs_manual_review and records a CRITICAL
// ops alert (the row stays 'pending_stripe'). docs/16 §17.7 documents the
// read-only SQL an operator runs to find these; this page is the in-app,
// payment-attempt-centric surface of exactly those two checks, before live
// payments. It is READ ONLY: it renders two derived sections and links to
// /admin/ops-alerts (where the existing resolve action lives). It NEVER
// mutates a payment attempt or an alert and NEVER calls Stripe. Resolution,
// retry, and refund are deliberately NOT here — see the runbook (docs/16 §17).
//
// Access: admin-only. The app/admin layout already redirects non-admins; this
// page re-verifies isAdmin (defense in depth for a payment-sensitive surface)
// and reads via the service-role client so studio_id-NULL alerts are visible
// to the operator (matching /admin/ops-alerts). No client names are rendered —
// only ids (the studios/[id] privacy convention).

export const dynamic = "force-dynamic";

const ATTEMPT_SELECT =
  "id, studio_id, client_id, session_id, appointment_id, charge_reason, amount_cents, currency, status, stripe_payment_intent_id, stripe_livemode, failure_code, created_at, updated_at, studio:studios(name)";
const ALERT_SELECT =
  "id, created_at, severity, event, message, studio_id, client_id, appointment_id, stripe_payment_intent_id, route";

export default async function PaymentManualReviewPage() {
  // Defense-in-depth admin re-check (read-only; never mutates).
  const rls = await createClient();
  const {
    data: { user },
  } = await rls.auth.getUser();
  if (!user || !isAdmin(user.email)) notFound();

  const admin = createAdminClient();
  const cutoffIso = new Date(
    Date.now() - STUCK_PENDING_THRESHOLD_MINUTES * 60_000,
  ).toISOString();

  // Section 1 — attempts stuck in pending_stripe past the reconcile window
  // (docs/16 §17.7 query 1). READ ONLY.
  const { data: stuckRows, error: stuckErr } = await admin
    .from("payment_charge_attempts")
    .select(ATTEMPT_SELECT)
    .eq("status", "pending_stripe")
    .lt("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(100);
  // A failed read must NEVER render as an empty "all clear" queue — that would
  // hide real payment risk. Surface it loudly with a generic message (the raw
  // provider error is never leaked, matching the PR #285 redaction posture).
  if (stuckErr) {
    throw new Error("Could not load the payment manual-review queue.");
  }
  const stuck = ((stuckRows ?? []) as unknown as StuckAttemptRow[]).map(
    toStuckAttemptView,
  );

  // Section 2 — unresolved CRITICAL payment ops alerts (docs/16 §17.7 query
  // 3/6). Fetch unresolved criticals, then keep payment events only. READ ONLY.
  const { data: alertRows, error: alertErr } = await admin
    .from("ops_alerts")
    .select(ALERT_SELECT)
    .eq("severity", "critical")
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (alertErr) {
    throw new Error("Could not load the payment manual-review queue.");
  }
  const alerts = selectPaymentReviewAlerts(
    (alertRows ?? []) as unknown as ReviewAlertRow[],
  );

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <Link
          href="/admin"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← Admin
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          Payment manual review
        </h1>
        <p className="max-w-prose text-sm text-neutral-600 dark:text-neutral-400">
          Read-only queue of payment attempts that need operator review: charges
          stuck in <span className="font-mono">pending_stripe</span> past{" "}
          {STUCK_PENDING_THRESHOLD_MINUTES} minutes, and unresolved{" "}
          <strong>critical</strong> payment alerts (e.g. Stripe succeeded but
          Hone could not persist). Warning-level reconciliation alerts stay on{" "}
          <Link href="/admin/ops-alerts" className="underline">
            Ops alerts
          </Link>
          .
        </p>
        <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {MANUAL_REVIEW_NEXT_STEP}
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Stuck payment attempts
          <span className="ml-2 text-sm font-normal text-neutral-500">
            {stuck.length}
          </span>
        </h2>
        {stuck.length === 0 ? (
          <EmptyCard>
            No payment attempts stuck in pending_stripe. Quiet is good.
          </EmptyCard>
        ) : (
          <ul className="flex flex-col gap-3">
            {stuck.map((a) => (
              <StuckAttemptCard key={a.attemptId} attempt={a} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Unresolved critical payment alerts
          <span className="ml-2 text-sm font-normal text-neutral-500">
            {alerts.length}
          </span>
        </h2>
        {alerts.length === 0 ? (
          <EmptyCard>No unresolved critical payment alerts.</EmptyCard>
        ) : (
          <ul className="flex flex-col gap-3">
            {alerts.map((al) => (
              <ReviewAlertCard key={al.alertId} alert={al} />
            ))}
          </ul>
        )}
        <p className="text-xs text-neutral-500">
          Resolve an alert on the{" "}
          <Link href="/admin/ops-alerts" className="underline">
            Ops alerts
          </Link>{" "}
          page after reconciling it in Stripe and Hone.
        </p>
      </section>
    </div>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
      {children}
    </div>
  );
}



function IdLine({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <span className="text-xs text-neutral-500">
      {label}: <span className="font-mono">{value}</span>
    </span>
  );
}

function StuckAttemptCard({ attempt }: { attempt: StuckAttemptView }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {attempt.status ?? "unknown"}
        </span>
        <AdminModeBadge livemode={attempt.livemode} />
        {attempt.chargeReason && (
          <span className="text-sm font-medium">{attempt.chargeReason}</span>
        )}
        {attempt.amountLabel && (
          <span className="text-sm text-neutral-700 dark:text-neutral-300">
            {attempt.amountLabel}
          </span>
        )}
        <span className="text-xs text-neutral-500">
          updated <FormattedDateTime iso={attempt.updatedAt} />
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        <IdLine label="attempt" value={attempt.attemptId} />
        <IdLine label="payment intent" value={attempt.stripePaymentIntentId} />
        {attempt.studioName ? (
          <span className="text-xs text-neutral-500">
            studio: {attempt.studioName}
          </span>
        ) : (
          <IdLine label="studio" value={attempt.studioId} />
        )}
        <IdLine label="client" value={attempt.clientId} />
        <IdLine label="session" value={attempt.sessionId} />
        <IdLine label="appointment" value={attempt.appointmentId} />
        <IdLine label="failure" value={attempt.failureCode} />
      </div>
    </li>
  );
}

function ReviewAlertCard({ alert }: { alert: ReviewAlertView }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium uppercase text-red-800 dark:bg-red-950 dark:text-red-300">
          {alert.severity}
        </span>
        <span className="font-mono text-sm font-medium">{alert.event}</span>
        <span className="text-xs text-neutral-500">
          <FormattedDateTime iso={alert.createdAt} />
        </span>
      </div>
      <p className="text-sm text-neutral-800 dark:text-neutral-200">
        {alert.message}
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        <IdLine label="payment intent" value={alert.stripePaymentIntentId} />
        <IdLine label="studio" value={alert.studioId} />
        <IdLine label="client" value={alert.clientId} />
        <IdLine label="appointment" value={alert.appointmentId} />
        <IdLine label="route" value={alert.route} />
      </div>
    </li>
  );
}
