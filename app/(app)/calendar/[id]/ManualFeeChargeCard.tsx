"use client";

import { useMemo, useState, useTransition } from "react";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  MANUAL_FEE_INTERNAL_NOTE_MAX_LENGTH,
  type EligibilityExistingAttemptSummary,
  type ManualFeeEligibility,
  type ManualFeeChargeType,
} from "@/lib/billing/manual-fee-types";
import {
  prepareManualFeeChargeAction,
  chargeManualFeeAttemptAction,
  cancelManualFeeChargeAttemptAction,
} from "./manual-fee-actions";

// ---------------------------------------------------------------------------
// ManualFeeChargeCard (PR #145 + PR #146).
// ---------------------------------------------------------------------------
//
// Renders the practitioner-facing manual fee surface on the appointment
// detail page. The card branches by whether an attempt already exists
// for the picked charge type:
//
//   * No attempt yet -> Prepare flow (PR #145): eligibility preview,
//     internal note, Prepare manual fee charge button.
//   * status='ready' -> Charge / Cancel flow (PR #146): test-mode-only
//     PaymentIntent confirm, plus the "Cancel prepared fee" path that
//     withdraws the attempt without ever touching Stripe.
//   * status='pending_stripe' -> calm "pending" message; the practitioner
//     refreshes or clicks Run test charge again, which routes through
//     the reconciliation path in lib/billing/manual-fee-charge.ts.
//   * status='succeeded' -> success surface with the PaymentIntent id.
//   * status='failed' -> failure surface with sanitized code/message.
//   * status='cancelled' -> the prepared-fee-cancelled surface.
//
// Test-mode wording is loud everywhere. The button label NEVER says
// "Charge live", "Bill", or anything that suggests money has moved
// outside of the test environment. The success copy includes the
// PaymentIntent id so the practitioner can cross-check in the Stripe
// dashboard.

type Props = {
  appointmentId: string;
  lateCancel: ManualFeeEligibility;
  noShow: ManualFeeEligibility;
};

function formatCents(cents: number, currency: string): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)} ${currency.toUpperCase()}`;
}

function chargeTypeLabel(t: ManualFeeChargeType): string {
  return t === "late_cancel" ? "Late cancellation fee" : "No-show fee";
}

function describeCard(
  card: NonNullable<ManualFeeEligibility["card"]>,
): string {
  const brand = card.brand.charAt(0).toUpperCase() + card.brand.slice(1);
  return `${brand} ending in ${card.last4}`;
}

export function ManualFeeChargeCard({
  appointmentId,
  lateCancel,
  noShow,
}: Props) {
  const [chargeType, setChargeType] =
    useState<ManualFeeChargeType>("late_cancel");
  const selected = chargeType === "late_cancel" ? lateCancel : noShow;

  // Merge attempts across both charge types so a 'ready' no_show
  // attempt is visible while the practitioner is on the late_cancel
  // tab.
  const allAttempts = useMemo(() => {
    const seen = new Set<string>();
    const merged: EligibilityExistingAttemptSummary[] = [];
    for (const row of [
      ...lateCancel.existingAttempts,
      ...noShow.existingAttempts,
    ]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
    return merged;
  }, [lateCancel, noShow]);

  // The "active" attempt for the selected type, if any. We surface
  // the most recent non-cancelled-non-failed row first; if no such
  // row exists we fall back to the most recent failed/cancelled row
  // so the practitioner sees the terminal-state copy before the
  // prepare form re-appears.
  const attemptForType = useMemo(() => {
    const sameType = allAttempts.filter((r) => r.charge_type === chargeType);
    const active = sameType.find((r) =>
      ["ready", "pending_stripe", "succeeded"].includes(r.status),
    );
    if (active) return active;
    return sameType[0] ?? null;
  }, [allAttempts, chargeType]);

  return (
    <section className="flex flex-col gap-5 rounded-lg border border-neutral-200 bg-white p-5 text-sm dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium">Cancellation/no-show fee</h3>
        <p className="text-xs text-neutral-500">
          Only charge a fee if the client agreed to the card authorization
          and the appointment policy shown here.
        </p>
        <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
          Test mode only. No live card will be charged.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Charge type"
        className="flex gap-1 rounded-md border border-neutral-200 p-1 text-xs dark:border-neutral-800"
      >
        {(["late_cancel", "no_show"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={chargeType === t}
            onClick={() => setChargeType(t)}
            className={`flex-1 rounded px-3 py-1.5 text-center ${
              chargeType === t
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            }`}
          >
            {chargeTypeLabel(t)}
          </button>
        ))}
      </div>

      {allAttempts.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">
            Existing attempts
          </span>
          <ul className="flex flex-col gap-1">
            {allAttempts.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-neutral-600 dark:text-neutral-400"
              >
                <span className="font-medium text-neutral-800 dark:text-neutral-200">
                  {chargeTypeLabel(row.charge_type)}
                </span>
                <span>·</span>
                <span>{formatCents(row.amount_cents, row.currency)}</span>
                <span>·</span>
                <span className="uppercase tracking-wider">{row.status}</span>
                <span>·</span>
                <FormattedDateTime iso={row.created_at} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Branch the form by attempt state for the selected type. */}
      {attemptForType ? (
        <AttemptStatusPanel
          attempt={attemptForType}
          appointmentId={appointmentId}
          card={
            selected.eligible ? selected.card : (selected.card ?? null)
          }
        />
      ) : !selected.eligible ? (
        <BlockedPanel reasons={selected.blockingReasons} />
      ) : (
        <PreparePanel
          appointmentId={appointmentId}
          chargeType={chargeType}
          eligibility={selected}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Blocked panel: used when no attempt exists yet and eligibility says
// the prepare flow cannot start.
// ---------------------------------------------------------------------------

function BlockedPanel({ reasons }: { reasons: string[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <span className="font-medium">Cannot prepare fee charge:</span>
      <ul className="ml-5 list-disc">
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prepare panel: preserves PR #145's behavior. Renders only when no
// attempt exists for the selected type and eligibility passes.
// ---------------------------------------------------------------------------

function PreparePanel({
  appointmentId,
  chargeType,
  eligibility,
}: {
  appointmentId: string;
  chargeType: ManualFeeChargeType;
  eligibility: Extract<ManualFeeEligibility, { eligible: true }>;
}) {
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [blockingReasons, setBlockingReasons] = useState<string[] | null>(
    null,
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBlockingReasons(null);
    const fd = new FormData();
    fd.set("appointment_id", appointmentId);
    fd.set("charge_type", chargeType);
    fd.set("internal_note", note);
    startTransition(async () => {
      const r = await prepareManualFeeChargeAction(fd);
      if (!r.ok) {
        setError(r.error);
        if (r.blockingReasons && r.blockingReasons.length > 0) {
          setBlockingReasons(r.blockingReasons);
        }
        return;
      }
      // Server action revalidates; the page will re-render with the
      // new attempt row visible.
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
        <PreviewRow label="Charge type">
          {chargeTypeLabel(chargeType)}
        </PreviewRow>
        <PreviewRow label="Amount">
          {formatCents(eligibility.amountCents, eligibility.currency)}
        </PreviewRow>
        <PreviewRow label="Client">{eligibility.client.name}</PreviewRow>
        <PreviewRow label="Appointment">
          {eligibility.appointment.service_name ?? "Appointment"} ·{" "}
          <FormattedDateTime iso={eligibility.appointment.starts_at} />
        </PreviewRow>
        <PreviewRow label="Card">
          {describeCard(eligibility.card)}
        </PreviewRow>
        <PreviewRow label="Card authorization signed">
          <FormattedDateTime iso={eligibility.cardAuthorization.signed_at} />
        </PreviewRow>
        <PreviewRow label="Policy acknowledged">
          <FormattedDateTime
            iso={eligibility.policyAcknowledgement.acknowledged_at}
          />
        </PreviewRow>
      </dl>

      <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Timing classification is manual for this version. Confirm this
        appointment qualifies under the policy before preparing the
        charge.
      </p>

      <label className="flex flex-col gap-1.5 text-xs">
        <span className="font-medium uppercase tracking-wider text-neutral-500">
          Internal note (required)
        </span>
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={MANUAL_FEE_INTERNAL_NOTE_MAX_LENGTH}
          required
          placeholder="What policy clause supports this charge?"
          className="w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <span className="text-neutral-500">
          {note.length}/{MANUAL_FEE_INTERNAL_NOTE_MAX_LENGTH}
        </span>
      </label>

      <div className="flex flex-col gap-3">
        <button
          type="submit"
          disabled={pending || note.trim().length === 0}
          className="self-start rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {pending ? "Preparing…" : "Prepare manual fee charge"}
        </button>
        <p className="text-xs italic text-neutral-500">
          This records intent only. No money is charged in this step.
        </p>
      </div>

      {error && (
        <div className="flex flex-col gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          <span>{error}</span>
          {blockingReasons && blockingReasons.length > 0 && (
            <ul className="ml-5 list-disc">
              {blockingReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Status panels: render the per-status surface for an existing attempt.
// ---------------------------------------------------------------------------

function AttemptStatusPanel({
  attempt,
  appointmentId,
  card,
}: {
  attempt: EligibilityExistingAttemptSummary;
  appointmentId: string;
  card: ManualFeeEligibility["card"] | null;
}) {
  switch (attempt.status) {
    case "ready":
      return (
        <ReadyPanel
          attempt={attempt}
          appointmentId={appointmentId}
          card={card}
        />
      );
    case "pending_stripe":
      return <PendingPanel attempt={attempt} appointmentId={appointmentId} />;
    case "succeeded":
      return <SucceededPanel attempt={attempt} />;
    case "failed":
      return <FailedPanel attempt={attempt} />;
    case "cancelled":
      return <CancelledPanel attempt={attempt} />;
    default:
      return (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          Attempt status: {attempt.status}
        </div>
      );
  }
}

function ReadyPanel({
  attempt,
  appointmentId,
  card,
}: {
  attempt: EligibilityExistingAttemptSummary;
  appointmentId: string;
  card: ManualFeeEligibility["card"] | null;
}) {
  const [chargePending, startCharge] = useTransition();
  const [cancelPending, startCancel] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  function runCharge() {
    setError(null);
    const fd = new FormData();
    fd.set("attempt_id", attempt.id);
    fd.set("confirm_charge", "true");
    startCharge(async () => {
      const r = await chargeManualFeeAttemptAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Success path: server revalidates; the page will re-render
      // showing the succeeded panel.
    });
  }

  function cancelPrepared(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fd = new FormData();
    fd.set("attempt_id", attempt.id);
    fd.set("cancelled_reason", cancelReason);
    startCancel(async () => {
      const r = await cancelManualFeeChargeAttemptAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Success path: page revalidates.
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
      <div className="flex flex-col gap-1">
        <h4 className="font-medium">Ready for test charge</h4>
        <p className="text-xs">
          Amount: {formatCents(attempt.amount_cents, attempt.currency)}
          {card && (
            <>
              {" · "}Card: {describeCard(card)}
            </>
          )}
        </p>
      </div>
      <ul className="ml-5 list-disc text-xs">
        <li>card authorization signed</li>
        <li>policy acknowledged</li>
        <li>internal note recorded</li>
      </ul>
      <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Test mode only. No live card will be charged.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runCharge}
          disabled={chargePending || cancelPending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {chargePending
            ? "Running…"
            : `Run test charge (${formatCents(attempt.amount_cents, attempt.currency)})`}
        </button>
        <button
          type="button"
          onClick={() => setCancelOpen((v) => !v)}
          disabled={chargePending || cancelPending}
          className="rounded-md border border-neutral-400 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          Cancel prepared fee
        </button>
      </div>

      {cancelOpen && (
        <form
          onSubmit={cancelPrepared}
          className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
        >
          <label className="flex flex-col gap-1.5 text-xs text-neutral-700 dark:text-neutral-300">
            <span className="font-medium uppercase tracking-wider text-neutral-500">
              Reason (required)
            </span>
            <textarea
              rows={2}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              maxLength={500}
              required
              placeholder="Why are you cancelling this prepared fee?"
              className="w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <span className="text-neutral-500">{cancelReason.length}/500</span>
          </label>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={cancelPending || cancelReason.trim().length === 0}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {cancelPending ? "Cancelling…" : "Cancel prepared fee"}
            </button>
            <button
              type="button"
              onClick={() => setCancelOpen(false)}
              disabled={cancelPending}
              className="text-xs text-neutral-600 hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-200"
            >
              Keep prepared
            </button>
          </div>
        </form>
      )}

      {/* appointmentId is consumed by the underlying server action via
          revalidatePath; we keep it referenced in scope so the
          unused-prop lint stays quiet. */}
      <span className="sr-only">{appointmentId}</span>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}
    </div>
  );
}

function PendingPanel({
  attempt,
  appointmentId,
}: {
  attempt: EligibilityExistingAttemptSummary;
  appointmentId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function refreshCharge() {
    setError(null);
    const fd = new FormData();
    fd.set("attempt_id", attempt.id);
    fd.set("confirm_charge", "true");
    startTransition(async () => {
      const r = await chargeManualFeeAttemptAction(fd);
      if (!r.ok) {
        setError(r.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <h4 className="font-medium">Stripe test charge pending.</h4>
      <p className="text-xs">
        The previous click is still resolving with Stripe. Click Refresh
        to recheck; the system will not create a second PaymentIntent.
      </p>
      <button
        type="button"
        onClick={refreshCharge}
        disabled={pending}
        className="self-start rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 disabled:opacity-50 dark:bg-amber-950"
      >
        {pending ? "Refreshing…" : "Refresh status"}
      </button>
      <span className="sr-only">{appointmentId}</span>
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}
    </div>
  );
}

function SucceededPanel({
  attempt,
}: {
  attempt: EligibilityExistingAttemptSummary;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
      <h4 className="font-medium">Test charge succeeded.</h4>
      <p className="text-xs">
        Amount: {formatCents(attempt.amount_cents, attempt.currency)}
        {attempt.charged_at && (
          <>
            {" · "}
            <FormattedDateTime iso={attempt.charged_at} />
          </>
        )}
      </p>
      {attempt.stripe_payment_intent_id && (
        <p className="text-xs font-mono text-emerald-800 dark:text-emerald-300">
          PaymentIntent: {attempt.stripe_payment_intent_id}
        </p>
      )}
    </div>
  );
}

function FailedPanel({
  attempt,
}: {
  attempt: EligibilityExistingAttemptSummary;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
      <h4 className="font-medium">Test charge failed.</h4>
      {attempt.failure_message && (
        <p className="text-xs">Reason: {attempt.failure_message}</p>
      )}
      {attempt.failure_code && (
        <p className="text-xs font-mono">Code: {attempt.failure_code}</p>
      )}
      {attempt.failed_at && (
        <p className="text-xs">
          <FormattedDateTime iso={attempt.failed_at} />
        </p>
      )}
    </div>
  );
}

function CancelledPanel({
  attempt,
}: {
  attempt: EligibilityExistingAttemptSummary;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      <h4 className="font-medium">
        Prepared fee was cancelled before charging.
      </h4>
      {attempt.cancelled_reason && (
        <p className="text-xs">Reason: {attempt.cancelled_reason}</p>
      )}
      {attempt.cancelled_at && (
        <p className="text-xs">
          <FormattedDateTime iso={attempt.cancelled_at} />
        </p>
      )}
    </div>
  );
}

function PreviewRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <dt className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
