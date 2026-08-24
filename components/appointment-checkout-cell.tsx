import { CheckoutButton } from "@/components/checkout-button";
import type { AppointmentPaymentState } from "@/lib/billing/appointment-payment-state";

// The dashboard/calendar checkout cell for one appointment. Renders the SAME
// quick-checkout entry (CheckoutButton → shared modal) for chargeable
// appointments, or a status-labelled badge (never colour-only) for
// paid/processing/refunded, so an already-paid appointment shows "Paid", not a
// misleading Checkout. Only completed appointments are checkout-relevant;
// cancelled / no-show / confirmed render nothing.
// The five attested outcomes and their badge copy. Kept here, beside the
// emerald branch it must never be confused with, rather than imported from the
// vocabulary module — so anyone editing one is looking directly at the other.
const SETTLED_LABEL: Partial<Record<AppointmentPaymentState, string>> = {
  settled_cash: "Paid \u00b7 cash",
  settled_e_transfer: "Paid \u00b7 e-transfer",
  settled_other: "Paid \u00b7 other",
  settled_waived: "Fee waived",
  settled_owing: "Still owes",
};

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

  if (
    paymentState === "paid" ||
    paymentState === "refunded" ||
    paymentState === "refunded_full"
  ) {
    const label = paymentState === "paid" ? "Paid" : "Refunded";
    const badge = (
      <span
        data-testid={`appointment-payment-${paymentState}`}
        className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
      >
        <span aria-hidden>✓</span> {label}
      </span>
    );
    // THE DOOR OPENS ONLY ON A PROVEN FULL REFUND.
    //
    // `refunded` and `refunded_full` present identically — both are truthfully
    // "Refunded", and both keep the card fact and the refund fact intact. They
    // differ in one thing: whether the studio is still holding card money.
    //
    // A PARTIAL refund (and a refund whose amount cannot be read) stays
    // `refunded` and gets NO settlement entry point. Offering one there would
    // be a promise the next screen cannot keep — the payment card's cents-based
    // check would correctly hide every control, leaving a button that opens
    // onto nothing. Worse, it would invite recording a cash payment for money
    // the studio has not actually given back.
    //
    // The row state already carries the answer, so this branch makes no second
    // eligibility guess of its own.
    if (paymentState !== "refunded_full") return badge;

    // PAY-SETTLE / 0187. A REFUNDED VISIT NEEDS A ROUTE BACK.
    //
    // The refund gave the money back, so the visit is unpaid again — and the
    // client very often then pays another way. Until now the row said
    // "Refunded" forever with no control on it at all, so there was no way to
    // record the replacement payment from the surface the practitioner
    // actually uses.
    //
    // The badge STAYS: the card fact and the refund fact are history and are
    // never rewritten. What is added is a way in. Whether anything may
    // actually be recorded is decided twice below this — the payment card only
    // offers the controls when the refund was FULL (measured in cents, so a
    // partial refund still counts as money held), and the 0187 commands refuse
    // independently. This is a door, not a decision.
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        {badge}
        <CheckoutButton
          appointmentId={appointmentId}
          status={status}
          variant="compact"
          label="Record outcome"
        />
      </span>
    );
  }

  // PAY-SETTLE / 0187. A practitioner-ATTESTED outcome.
  //
  // THE COLOUR IS THE POINT. Emerald is reserved, everywhere in this product,
  // for money Hone actually verified — the branch above. These render in
  // NEUTRAL, and every label names HOW the visit was settled rather than
  // saying a bare "Paid", so a glance down the dashboard can never mistake a
  // practitioner's word for a Stripe receipt. That distinction is the whole
  // reason the settlement schema refuses to store a "card" method; throwing it
  // away in the CSS would undo it at the only layer Chloe actually reads.
  //
  // Checkout is deliberately NOT offered for a COLLECTED or WAIVED outcome.
  // That is the product outcome: an appointment settled in cash stops asking to
  // be charged, without anybody having run a payment that did not happen.
  //
  // `still_owes` IS THE EXCEPTION, and it is the whole reason this branch is
  // not a single shape. "Still owes" attests that the visit is UNPAID — which
  // is why it is the one method absent from the SQL blocking set, why
  // prepareSessionPaymentChargeAction lets it through, and why
  // settlementIsOutranked exists at all. Removing Checkout here contradicted
  // every one of those: the debt stayed collectable in the database and
  // uncollectable from the row Chloe actually looks at, leaving the session
  // detail page as the only way in.
  //
  // So the row states both facts. The badge stays NEUTRAL — an attestation is
  // never emerald, and it is never relabelled Paid — and the ordinary
  // CheckoutButton sits beside it. Not "Record outcome": an outcome has already
  // been recorded, and this is the ordinary card path for money still owed.
  const settled = SETTLED_LABEL[paymentState];
  if (settled) {
    const badge = (
      <span
        data-testid={`appointment-${paymentState}`}
        className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
      >
        {settled}
      </span>
    );
    if (paymentState !== "settled_owing") return badge;

    // The SAME shared entry point every other surface uses, in the same
    // badge-plus-control shape as the full-refund branch above. Nothing about
    // quick checkout is duplicated or re-implemented here.
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        {badge}
        <CheckoutButton
          appointmentId={appointmentId}
          status={status}
          variant="compact"
        />
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
