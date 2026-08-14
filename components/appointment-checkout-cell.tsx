import { CheckoutButton } from "@/components/checkout-button";
import type { AppointmentPaymentState } from "@/lib/billing/appointment-payment-state";

// The dashboard/calendar checkout cell for one appointment. Renders the SAME
// quick-checkout entry (CheckoutButton → shared modal) for chargeable
// appointments, or a status-labelled badge (never colour-only) for
// paid/processing/refunded, so an already-paid appointment shows "Paid", not a
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

  // FREE-01. A deliberately $0 service is not something to check out. Showing
  // Checkout here asked the practitioner to run a payment for a service the
  // studio decided is free: most obviously a free consultation. This renders
  // the fact instead, and it is reached for ANY studio with an authoritative $0
  // service; nothing here is specific to one studio.
  if (paymentState === "free") {
    return (
      <span
        data-testid="appointment-payment-free"
        className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
      >
        No payment required
      </span>
    );
  }

  // Reviews 3779063521 / 3779063523. A read this state depends on failed, so
  // Hone does not know. Claim nothing: no Checkout, no "No payment required",
  // no "Paid"/"Processing"/"Refunded", no "no session". The money-moving
  // prepare/execute actions remain the real safety boundary and fail closed on
  // their own; this is presentation honesty.
  if (paymentState === "unavailable") {
    return (
      <span
        data-testid="appointment-payment-unavailable"
        className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
      >
        Payment status unavailable
      </span>
    );
  }

  // chargeable or no_session → the shared Checkout entry. The modal resolves the
  // accurate state (and routes to charting when there is no session yet).
  return (
    <CheckoutButton appointmentId={appointmentId} status={status} variant="compact" />
  );
}
