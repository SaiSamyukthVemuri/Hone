"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  recordAppointmentSettlementAction,
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
  settledAmountCents?: number | null;
  /** Hidden entirely once Hone has verified card money — see the card. */
  defaultAmountCents?: number | null;
};

export function AppointmentSettlementControls({
  appointmentId,
  isOwner,
  settledMethod = null,
  settledAmountCents = null,
  defaultAmountCents = null,
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
        setOpen(null);
        router.refresh();
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
