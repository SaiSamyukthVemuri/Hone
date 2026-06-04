"use client";

import { useMemo, useState, useTransition } from "react";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  MANUAL_FEE_INTERNAL_NOTE_MAX_LENGTH,
  type ManualFeeEligibility,
  type ManualFeeChargeType,
} from "@/lib/billing/manual-fee-types";
import { prepareManualFeeChargeAction } from "./manual-fee-actions";

// ---------------------------------------------------------------------------
// ManualFeeChargeCard (PR #145).
// ---------------------------------------------------------------------------
//
// Practitioner-side card surfaced on the appointment detail page when the
// appointment is in cancelled or no_show status. Lets the practitioner:
//   1. See whether every piece of evidence (active card, signed
//      authorization, policy acknowledgement, configured fee amount) is
//      in place for either a late_cancel or a no_show fee.
//   2. Review the eligible preview (charge type, amount, card, evidence
//      timestamps).
//   3. Add a required internal note explaining the reason.
//   4. Press "Prepare manual fee charge" to record a 'ready' row in
//      manual_fee_charge_attempts via prepareManualFeeChargeAction.
//
// The button label is deliberately NOT "Charge" or "Bill"; this PR
// does not move money. The success copy makes that explicit: "Manual
// charge prepared. No money has been charged yet."
//
// The component takes BOTH eligibility decisions (late_cancel and
// no_show) as props so the practitioner can toggle between them
// without a server round-trip. The active toggle is local UI state.
// Submitting POSTs through the server action, which re-evaluates
// eligibility server-side; the rendered preview is purely a UI hint.

type Props = {
  appointmentId: string;
  // Two pre-computed eligibility snapshots, one per chargeable type.
  // The page-level loader fetches both so the toggle is instant; the
  // server action re-validates the chosen one before writing.
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
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [blockingReasons, setBlockingReasons] = useState<string[] | null>(
    null,
  );
  const [preparedAttemptId, setPreparedAttemptId] = useState<string | null>(
    null,
  );

  const selected = chargeType === "late_cancel" ? lateCancel : noShow;

  // Combined existing attempts surface across both types so the
  // practitioner can see "this appointment already has a ready
  // no_show attempt" while they're toggled to late_cancel.
  const allAttempts = useMemo(() => {
    const seen = new Set<string>();
    const merged: typeof lateCancel.existingAttempts = [];
    for (const row of [
      ...lateCancel.existingAttempts,
      ...noShow.existingAttempts,
    ]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
    return merged;
    // The eligibility snapshots include their own attempts arrays;
    // re-merging when either input array reference changes is the
    // intended behavior, so we depend on those references directly.
  }, [lateCancel, noShow]);

  if (preparedAttemptId) {
    return (
      <section className="flex flex-col gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-5 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
        <h3 className="text-base font-medium">
          Manual charge prepared. No money has been charged yet.
        </h3>
        <p className="text-emerald-800 dark:text-emerald-300">
          The studio recorded a {chargeTypeLabel(chargeType).toLowerCase()} of{" "}
          {selected.eligible
            ? formatCents(selected.amountCents, selected.currency)
            : "the configured amount"}
          . Charging the card on file is a separate step that hasn&rsquo;t
          shipped yet.
        </p>
      </section>
    );
  }

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
      setPreparedAttemptId(r.attemptId);
    });
  }

  return (
    <section className="flex flex-col gap-5 rounded-lg border border-neutral-200 bg-white p-5 text-sm dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium">Cancellation/no-show fee</h3>
        <p className="text-xs text-neutral-500">
          Only charge a fee if the client agreed to the card authorization
          and the appointment policy shown here.
        </p>
      </div>

      {/* Toggle between the two chargeable types. Both eligibility
          snapshots are loaded so the preview updates instantly. */}
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
            onClick={() => {
              setChargeType(t);
              setError(null);
              setBlockingReasons(null);
            }}
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

      {/* Existing attempts surface. Each prepared attempt is shown
          even when the practitioner is on the other type, so they
          notice "this already has a ready row". */}
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

      {!selected.eligible ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <span className="font-medium">Cannot prepare fee charge:</span>
          <ul className="ml-5 list-disc">
            {selected.blockingReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <dl className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
            <PreviewRow label="Charge type">
              {chargeTypeLabel(chargeType)}
            </PreviewRow>
            <PreviewRow label="Amount">
              {formatCents(selected.amountCents, selected.currency)}
            </PreviewRow>
            <PreviewRow label="Client">{selected.client.name}</PreviewRow>
            <PreviewRow label="Appointment">
              {selected.appointment.service_name ?? "Appointment"} ·{" "}
              <FormattedDateTime iso={selected.appointment.starts_at} />
            </PreviewRow>
            <PreviewRow label="Card">
              {describeCard(selected.card)}
            </PreviewRow>
            <PreviewRow label="Card authorization signed">
              <FormattedDateTime
                iso={selected.cardAuthorization.signed_at}
              />
            </PreviewRow>
            <PreviewRow label="Policy acknowledged">
              <FormattedDateTime
                iso={selected.policyAcknowledgement.acknowledged_at}
              />
            </PreviewRow>
          </dl>

          {/* Manual timing-classification warning. v1 cannot decide
              from data alone whether a cancellation crossed the
              studio's late-cancel window because the threshold is
              free-form text on studios.cancellation_policy_text.
              The practitioner is the system of record until a future
              PR adds structured thresholds. */}
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Timing classification is manual for this version. Confirm
            this appointment qualifies under the policy before preparing
            the charge.
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
      )}
    </section>
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
