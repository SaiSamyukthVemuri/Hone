import { CheckoutButton } from "@/components/checkout-button";
import type { AppointmentPaymentState } from "@/lib/billing/appointment-payment-state";

/** The coarse states a billed visit can be in that show a badge but no Checkout: paid, or unavailable while a card payment or refund is still with Stripe. */
export function billedEntryState(state: AppointmentPaymentState): boolean {
  return state === "paid" || state === "unavailable";
}

// Kept apart from AppointmentCheckoutOutcome so its branches stay one-per-state. The roster badge stays truthful; "Manage payments" opens the same checkout panel, which is the only
// place a split visit is refunded or a pending payment rechecked, so a plain badge would leave the owner no door after closing it (Codex P1 on #1827). Never offered for a visit
// without a bill, and it is not a charge control: a fully paid visit has nothing to collect.
export function BilledPaymentEntry({ appointmentId, status, state, buttonClassName }: { appointmentId: string; status: string | null; state: AppointmentPaymentState; buttonClassName?: string }) {
  const badge = state === "paid" ? (
    <span data-testid="appointment-payment-paid" className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
      <span aria-hidden>✓</span> Paid
    </span>
  ) : (
    <span data-testid="appointment-payment-unavailable" className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
      Payment status unavailable
    </span>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {badge}
      <CheckoutButton appointmentId={appointmentId} status={status} className={buttonClassName} variant="compact" label="Manage payments" />
    </span>
  );
}
