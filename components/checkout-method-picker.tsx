"use client";

import { PRACTITIONER_METHODS, SETTLEMENT_ACTION_LABEL, type SettlementMethod } from "@/lib/billing/settlement-types";

export type CheckoutMethod = "stripe" | SettlementMethod;

export function CheckoutMethodPicker({
  method, onSelect, isOwner, disabled = false, showStripe = true, stripeUnavailable,
}: {
  method: CheckoutMethod | null;
  onSelect: (method: CheckoutMethod) => void;
  isOwner: boolean;
  disabled?: boolean;
  showStripe?: boolean;
  stripeUnavailable?: string;
}) {
  const methods: CheckoutMethod[] = isOwner ? [...PRACTITIONER_METHODS, "waived"] : [...PRACTITIONER_METHODS];
  if (showStripe) methods.unshift("stripe");
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="text-sm font-medium">Payment method or outcome</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {methods.map(option => (
          <button
            key={option}
            type="button"
            aria-pressed={method === option}
            disabled={option === "stripe" && Boolean(stripeUnavailable)}
            title={option === "stripe" ? stripeUnavailable : undefined}
            data-testid={`settlement-open-${option}`}
            onClick={() => onSelect(option)}
            className="inline-flex min-h-[44px] items-center rounded-md border border-neutral-300 px-3 text-sm font-medium hover:bg-neutral-50 aria-pressed:border-neutral-900 aria-pressed:bg-neutral-900 aria-pressed:text-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900 dark:aria-pressed:border-white dark:aria-pressed:bg-white dark:aria-pressed:text-neutral-900"
          >
            {option === "stripe" ? "Stripe" : SETTLEMENT_ACTION_LABEL[option]}
          </button>
        ))}
      </div>
      {showStripe && stripeUnavailable && <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">{stripeUnavailable}</p>}
    </fieldset>
  );
}
