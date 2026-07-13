import { CheckoutButton } from "@/components/checkout-button";
import type { AppointmentPaymentState } from "@/lib/billing/appointment-payment-state";

// The dashboard/calendar checkout cell for one appointment. Renders the SAME
// quick-checkout entry (CheckoutButton → shared modal) for chargeable
// appointments, or a status-labelled badge (never colour-only) for
// paid/processing/refunded — so an already-paid appointment shows "Paid", not a
// misleading Checkout. Only completed appointments are checkout-relevant;
// cancelled / no-show / confirmed render nothing.
export function AppointmentCheckoutCell({
  appointmentId,
  status,
  paymentState,
}: {
  appointmentId: string;
  status: string | null;
  paymentState: AppointmentPaymentState;
}) {
  if (status !== "completed") return null;

  if (paymentState === "paid" || paymentState === "refunded") {
    const label = paymentState === "paid" ? "Paid" : "Refunded";
    return (
      <span
        data-testid={`appointment-payment-${paymentState}`}
        className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
      >
        <span aria-hidden>✓</span> {label}
      </span>
    );
  }

  if (paymentState === "processing") {
    return (
      <span
        data-testid="appointment-payment-processing"
        className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      >
        Processing
      </span>
    );
  }

  // chargeable or no_session → the shared Checkout entry. The modal resolves the
  // accurate state (and routes to charting when there is no session yet).
  return (
    <CheckoutButton appointmentId={appointmentId} status={status} variant="compact" />
  );
}
