"use client";

import { useState } from "react";
import type { CheckoutMethod } from "@/components/checkout-method-picker";
import { centsToAmountInputValue, parseCadAmountToCents } from "@/lib/billing/cad-amount";
import { currencyLabel, formatMoney, type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { SESSION_PAYMENT_ADJUSTMENT_REASON_MAX_LENGTH, SESSION_PAYMENT_AMOUNT_CEILING_CENTS } from "@/lib/billing/session-payment-types";

export type CheckoutFeeDraft = {
  referenceCents: number;
  finalFee: string;
  received: string | null;
  reason: string;
};

export function createCheckoutFeeDraft(referenceCents: number): CheckoutFeeDraft {
  return { referenceCents, finalFee: centsToAmountInputValue(referenceCents), received: null, reason: "" };
}

export function checkoutDraftAmount(raw: string): number | null {
  const value = parseCadAmountToCents(raw, SESSION_PAYMENT_AMOUNT_CEILING_CENTS);
  return value.ok ? value.cents : null;
}

export function isReceivedMethod(method: CheckoutMethod | null | undefined) {
  return method === "paid_cash" || method === "paid_e_transfer" || method === "paid_other_external";
}

/** A changed server quote invalidates the old draft; an opened payment must use
 * the amount Chloe can see. No draft is stored outside this checkout. */
export function useCheckoutFeeDraft(referenceCents: number | null, initial?: CheckoutFeeDraft) {
  const [edited, setDraft] = useState(initial);
  const draft = referenceCents === null || referenceCents <= 0 ? undefined
    : edited?.referenceCents === referenceCents ? edited
    : createCheckoutFeeDraft(referenceCents);
  return [draft, setDraft] as const;
}

export function writeFeeAdjustment(fd: FormData, draft: CheckoutFeeDraft, finalCents: number) {
  if (draft.referenceCents === finalCents) return;
  fd.set("reference_fee_cents", String(draft.referenceCents));
  fd.set("final_fee_cents", String(finalCents));
  fd.set("fee_adjustment_reason", draft.reason.trim());
}

export function waivedVisitData(appointmentId: string, draft: CheckoutFeeDraft, note?: FormDataEntryValue | null) {
  const fd = new FormData();
  fd.set("appointment_id", appointmentId);
  fd.set("amount_cents", String(draft.referenceCents));
  writeFeeAdjustment(fd, draft, 0);
  if (typeof note === "string" && note.trim()) fd.set("note", note.trim());
  return fd;
}

export function CheckoutFeeFields({draft, onChange, currency, showReceived, disabled = false}: {
  draft: CheckoutFeeDraft;
  onChange: (next: CheckoutFeeDraft) => void;
  currency: PaymentCurrency | null;
  showReceived: boolean;
  disabled?: boolean;
}) {
  const final = checkoutDraftAmount(draft.finalFee);
  const received = checkoutDraftAmount(draft.received ?? draft.finalFee);
  const inputClass = "mt-1 block min-h-[44px] w-full rounded-md border border-neutral-300 px-3 py-2 text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-950";
  return (
    <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm font-medium">
        Final fee{currency && ` (${currencyLabel(currency)})`}
        <input aria-label="Final fee" data-testid="checkout-final-fee" inputMode="decimal" maxLength={16} autoComplete="off"
          className={inputClass} value={draft.finalFee} onChange={e => onChange({...draft, finalFee: e.target.value})} />
        <span className="mt-1 block text-xs font-normal text-neutral-600 dark:text-neutral-400">
          Booked fee {formatMoney(draft.referenceCents, currency)}
        </span>
      </label>
      {showReceived && final !== 0 && <label className="text-sm font-medium">
        Amount received{currency && ` (${currencyLabel(currency)})`}
        <input aria-label="Amount received" data-testid="settlement-amount" inputMode="decimal" maxLength={16} autoComplete="off"
          className={inputClass} value={draft.received ?? draft.finalFee}
          onChange={e => onChange({...draft, received: e.target.value})} />
        {received !== null && final !== null && received > 0 && received < final && (
          <span className="mt-1 block text-xs font-normal">Balance remaining {formatMoney(final - received, currency)}</span>
        )}
      </label>}
      {final !== draft.referenceCents && <label className="text-sm font-medium sm:col-span-2">
        Reason for adjustment
        <input aria-label="Reason for price adjustment" data-testid="checkout-fee-reason" maxLength={SESSION_PAYMENT_ADJUSTMENT_REASON_MAX_LENGTH}
          className={inputClass} required value={draft.reason} onChange={e => onChange({...draft, reason: e.target.value})} />
      </label>}
    </fieldset>
  );
}
