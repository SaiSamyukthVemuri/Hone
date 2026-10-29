"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  recordAppointmentSettlementAction,
  supersedeAppointmentSettlementAction,
  waiveAppointmentFeeAction,
  type SettlementActionResult,
} from "@/app/(app)/appointment-settlement-actions";
import {
  PRACTITIONER_METHODS,
  SETTLEMENT_ACTION_LABEL,
  SETTLEMENT_BADGE_LABEL,
  type SettlementMethod,
} from "@/lib/billing/settlement-types";
import { formatCadFromCents } from "@/lib/billing/cad-amount";

// PAY-SETTLE. The outcome controls, rendered UNDER the existing Charge path
// inside SessionPaymentPrepareCard.
//
// WHY IT LIVES IN THE CARD AND NOT IN AppointmentCheckoutCell. The recon
// conclusion that the cell is "the single checkout chokepoint" is true for the
// dashboard and calendar ROWS, and the cell keeps that job: it renders the
// entry point and the settled badge. But the card has a THIRD render site the
// cell never reaches — app/(app)/clients/[id]/sessions/[sessionId]/page.tsx —
// so controls placed only in the cell would leave the session-detail page
// card-only, which is the surface a practitioner uses when she is already
// looking at the chart. Putting the controls in the card covers all three
// surfaces with one implementation; the cell keeps the badge.
//
// THE CHARGE PATH IS UNTOUCHED. Nothing here prepares, executes, refunds or
// receipts anything, and no Stripe call is reachable from this component.

type Props = {
  appointmentId: string;
  isOwner: boolean;
  /** The live disposition, when one already exists. */
  settledMethod?: SettlementMethod | null;
  /** The live record's id. Present only so an owner can correct exactly that record. */
  settledId?: string | null;
  settledAmountCents?: number | null;
  /** Hidden entirely once Hone has verified card money — see the card. */
  defaultAmountCents?: number | null;
  /**
   * Called after a settlement is successfully recorded, BEFORE the submission
   * stops being pending.
   *
   * WHY THIS EXISTS. `router.refresh()` re-renders the SERVER tree, which is
   * enough for the session detail page — its settlement props come from a
   * server component. It is NOT enough inside QuickCheckoutModal, which holds
   * its trusted checkout context in CLIENT state (`ctx`) and refreshes it with
   * its own `fetchContext`. Without this hook the modal kept its pre-record
   * context: the buttons stayed, and the only thing stopping a second record
   * was the command answering `already_settled` — a refusal doing a UI's job.
   *
   * The modal passes a silent refetch here. Optional, because a caller whose
   * props already come from the server refresh needs nothing more.
   */
  onRecorded?: () => void | Promise<void>;
};

export function AppointmentSettlementControls({
  appointmentId,
  isOwner,
  settledMethod = null,
  settledId = null,
  settledAmountCents = null,
  defaultAmountCents = null,
  onRecorded,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<SettlementMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState<string>(
    defaultAmountCents !== null && defaultAmountCents >= 0
      ? (defaultAmountCents / 100).toFixed(2)
      : "",
  );
  const [note, setNote] = useState("");

  // ALREADY SETTLED. The record is shown as a fact, and there is no edit
  // control here for anyone: a correction is owner-only and append-only, and it
  // is deliberately not a casual inline affordance next to the amount box.
  if (settledMethod) {
    return (
      <div
        data-testid="appointment-settlement-recorded"
        className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-300"
      >
        <span className="font-medium">
          {SETTLEMENT_BADGE_LABEL[settledMethod]}
        </span>
        {typeof settledAmountCents === "number" && (
          <> {"·"} {formatCadFromCents(settledAmountCents)}</>
        )}
        <p className="mt-1 text-neutral-500 dark:text-neutral-400">
          Recorded by the studio, not verified by Hone.
          {isOwner
            ? " Only the studio owner can correct this, and the original record is kept."
            : " Ask the studio owner if this needs correcting."}
        </p>
        {/* HON-45 G1. A visit left as "Still owes" can later be paid outside
            Hone. Only the owner can record that, through the existing
            append-only correction: the "Still owes" record is kept and a
            replacement is added. Nothing here takes a payment. */}
        {isOwner && settledMethod === "still_owes" && settledId && (
          <ReceivedPaymentCorrection
            appointmentId={appointmentId}
            settledId={settledId}
            outstandingCents={settledAmountCents}
            onRecorded={onRecorded}
          />
        )}
      </div>
    );
  }

  const submit = (method: SettlementMethod) => {
    setError(null);
    const cents = parseAmountToCents(amount);
    if (cents === null) {
      setError("Enter an amount like 45 or 45.00.");
      return;
    }
    const fd = new FormData();
    fd.set("appointment_id", appointmentId);
    fd.set("amount_cents", String(cents));
    if (note.trim()) fd.set("note", note.trim());
    startTransition(async () => {
      let r: SettlementActionResult;
      if (method === "waived") {
        r = await waiveAppointmentFeeAction(fd);
      } else {
        fd.set("method", method);
        r = await recordAppointmentSettlementAction(fd);
      }
      if (r.ok) {
        // 1. close the local method form
        setOpen(null);
        // 2. refresh the server tree (enough on its own for the session page)
        router.refresh();
        // 3. AWAIT the caller's own refresh while the submission is still
        //    pending, so the buttons never reappear for the instant between
        //    "recorded" and the new context arriving. A failure here must not
        //    look like a failed RECORD — the settlement is already committed —
        //    so it is swallowed; the worst case is the pre-existing stale view,
        //    and the command still refuses a duplicate.
        if (onRecorded) {
          try {
            await onRecorded();
          } catch {
            // deliberately ignored: see above
          }
        }
        return;
      }
      setError(r.message);
    });
  };

  const methods: SettlementMethod[] = isOwner
    ? [...PRACTITIONER_METHODS, "waived"]
    : [...PRACTITIONER_METHODS];

  return (
    <div
      data-testid="appointment-settlement-controls"
      className="border-t border-neutral-200 pt-3 dark:border-neutral-800"
    >
      <p className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
        Or record how this was settled
      </p>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        {/* The sentence that carries the whole product decision. */}
        This records what you say happened. It does not take a payment and Hone
        does not verify it.
      </p>
      {/* HON-45. When a paid method is TRUE. A claim sent to an insurer is not
          money received, so it is never "paid another way", and it is not the
          client's debt either. Until money arrives the visit simply stays
          outstanding; nothing needs recording. */}
      <p
        data-testid="settlement-received-rule"
        className="mt-1 text-xs text-neutral-500 dark:text-neutral-400"
      >
        Choose a paid method only once the money has actually been received. An
        insurance claim that has been sent is not a payment: leave the visit
        outstanding until it is paid.
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        {methods.map((m) => (
          <button
            key={m}
            type="button"
            disabled={pending}
            data-testid={`settlement-open-${m}`}
            onClick={() => {
              setError(null);
              setOpen((current) => (current === m ? null : m));
            }}
            className={`inline-flex min-h-[44px] items-center rounded-md border px-3 text-xs font-medium disabled:opacity-50 ${
              open === m
                ? "border-neutral-800 bg-neutral-100 dark:border-neutral-300 dark:bg-neutral-800"
                : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            }`}
          >
            {SETTLEMENT_ACTION_LABEL[m]}
          </button>
        ))}
      </div>

      {/* Owner-only, and said out loud rather than left as a missing button. */}
      {!isOwner && (
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          Waiving a fee is a studio-owner decision.
        </p>
      )}

      {open && (
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-xs text-neutral-700 dark:text-neutral-300">
            {open === "waived"
              ? "Amount waived"
              : open === "still_owes"
                ? "Amount still owed"
                : "Amount collected"}
            <input
              inputMode="decimal"
              value={amount}
              disabled={pending}
              data-testid="settlement-amount"
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 block w-40 rounded-md border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label className="text-xs text-neutral-700 dark:text-neutral-300">
            Note (optional, kept internal)
            <input
              value={note}
              maxLength={500}
              disabled={pending}
              data-testid="settlement-note"
              onChange={(e) => setNote(e.target.value)}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <div>
            <button
              type="button"
              disabled={pending}
              data-testid={`settlement-confirm-${open}`}
              onClick={() => submit(open)}
              className="inline-flex min-h-[44px] items-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {pending ? "Recording..." : `Record ${SETTLEMENT_ACTION_LABEL[open].toLowerCase()}`}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p
          role="alert"
          data-testid="settlement-error"
          className="mt-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200"
        >
          {error}
        </p>
      )}
    </div>
  );
}

// Local, deliberately strict. The server re-parses and the database bounds the
// value, so this exists to give immediate feedback, never to decide anything.
function parseAmountToCents(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number.parseFloat(text) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 200000
    ? cents
    : null;
}

// HON-45 G1. Owner-only: record that the money for a "Still owes" visit has now
// been received outside Hone. It calls the EXISTING supersede command, which
// owns every rule (owner check, required reason, stale target, card-money
// refusal); this form adds no fee, deposit or policy rule of its own.
const RECEIVED_METHODS = ["paid_cash", "paid_e_transfer", "paid_other_external"] as const;

function ReceivedPaymentCorrection({
  appointmentId,
  settledId,
  outstandingCents,
  onRecorded,
}: {
  appointmentId: string;
  settledId: string;
  outstandingCents: number | null;
  onRecorded?: () => void | Promise<void>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<SettlementMethod | null>(null);
  const [amount, setAmount] = useState(
    typeof outstandingCents === "number" && outstandingCents >= 0
      ? (outstandingCents / 100).toFixed(2)
      : "",
  );
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    if (!method) {
      setError("Choose how the money was received.");
      return;
    }
    const cents = parseAmountToCents(amount);
    if (cents === null) {
      setError("Enter an amount like 45 or 45.00.");
      return;
    }
    if (!reason.trim()) {
      setError("Say why you are correcting this record.");
      return;
    }
    const fd = new FormData();
    fd.set("settlement_id", settledId);
    fd.set("appointment_id", appointmentId);
    fd.set("method", method);
    fd.set("amount_cents", String(cents));
    fd.set("reason", reason.trim());
    startTransition(async () => {
      const r = await supersedeAppointmentSettlementAction(fd);
      if (r.ok) {
        setOpen(false);
        router.refresh();
        if (onRecorded) {
          try {
            await onRecorded();
          } catch {
            // the correction is already committed; a stale view is the worst case
          }
        }
        return;
      }
      setError(r.message);
    });
  };

  return (
    <div data-testid="settlement-received" className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      {!open ? (
        <button
          type="button"
          data-testid="settlement-received-open"
          onClick={() => setOpen(true)}
          className="inline-flex min-h-[44px] items-center rounded-md border border-neutral-300 px-3 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Record payment received
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            Use this only once the money has actually been received. The
            &ldquo;Still owes&rdquo; record is kept in the history and a new
            record is added. This records what you say happened; Hone does not
            verify it.
          </p>
          <div className="flex flex-wrap gap-2">
            {RECEIVED_METHODS.map((m) => (
              <button
                key={m}
                type="button"
                disabled={pending}
                aria-pressed={method === m}
                data-testid={`settlement-received-method-${m}`}
                onClick={() => setMethod(m)}
                className={`inline-flex min-h-[44px] items-center rounded-md border px-3 text-xs font-medium disabled:opacity-50 ${
                  method === m
                    ? "border-neutral-800 bg-neutral-100 dark:border-neutral-300 dark:bg-neutral-800"
                    : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                }`}
              >
                {SETTLEMENT_ACTION_LABEL[m]}
              </button>
            ))}
          </div>
          <label className="text-xs text-neutral-700 dark:text-neutral-300">
            Amount received
            <input
              inputMode="decimal"
              value={amount}
              disabled={pending}
              data-testid="settlement-received-amount"
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 block w-40 rounded-md border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label className="text-xs text-neutral-700 dark:text-neutral-300">
            Reason for the correction (required, kept with the record)
            <input
              value={reason}
              maxLength={500}
              disabled={pending}
              data-testid="settlement-received-reason"
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              data-testid="settlement-received-confirm"
              onClick={submit}
              className="inline-flex min-h-[44px] items-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {pending ? "Recording..." : "Record payment received"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setOpen(false)}
              className="inline-flex min-h-[44px] items-center rounded-md border border-neutral-300 px-3 text-xs dark:border-neutral-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" data-testid="settlement-received-error" className="mt-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </p>
      )}
    </div>
  );
}
