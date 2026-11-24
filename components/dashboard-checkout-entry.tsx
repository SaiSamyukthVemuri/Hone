"use client";

import { useRef, useState, type ReactNode } from "react";
import { MarkAppointmentCompleteControl } from "@/components/appointment/mark-complete-control";
import { CheckoutMethodPicker, type CheckoutMethod } from "@/components/checkout-method-picker";
import { getDashboardCheckoutQuoteAction } from "@/app/(app)/quick-checkout-actions";
import { CheckoutFeeFields, checkoutDraftAmount, createCheckoutFeeDraft, isReceivedMethod, type CheckoutFeeDraft } from "@/components/checkout-fee-fields";
import { formatMoney, type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { QuickCheckoutModal } from "@/components/quick-checkout-modal";
import type { AppointmentPaymentState } from "@/lib/billing/appointment-payment-state";
import type { CardOnFileStatus } from "@/lib/payment-methods/card-on-file";

// This owner-only row receives the same financially scoped facts as its status badge.
// Method choice is an intention. The modal re-reads eligibility after completion.
export function DashboardCheckoutEntry({
  appointmentId,
  startsAt,
  status,
  paymentState,
  cardOnFile,
  visitLabel,
  children,
}: {
  appointmentId: string;
  startsAt: string;
  status: "confirmed" | "completed";
  paymentState: AppointmentPaymentState;
  cardOnFile?: CardOnFileStatus | null;
  children: ReactNode;
  visitLabel?: string;
}) {
  const [method, setMethod] = useState<CheckoutMethod | null>(null);
  const [open, setOpen] = useState(false);
  const [feeDraft, setFeeDraft] = useState<CheckoutFeeDraft | undefined>();
  const [currency, setCurrency] = useState<PaymentCurrency | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const quoteRequest = useRef(0);
  const newPayment = paymentState === "chargeable" || paymentState === "no_session";
  const existingOutcome = paymentState === "settled_owing" || paymentState === "refunded_full";
  const stripeUnavailable = paymentState === "no_session"
    ? "A treatment chart is needed for card checkout."
    : cardOnFile === "no_card"
      ? "This client has no saved card."
      : cardOnFile === "unavailable"
        ? "Card status could not be verified."
        : undefined;

  function openCheckout() {
    const request = ++quoteRequest.current;
    setFeeDraft(undefined);
    setCurrency(null);
    setLoadingQuote(newPayment);
    if (newPayment) {
      getDashboardCheckoutQuoteAction(appointmentId).then(quote => {
        if (request !== quoteRequest.current || !quote) return;
        setFeeDraft(createCheckoutFeeDraft(quote.referenceCents));
        setCurrency(quote.currency);
      }).catch(() => {
        // Finishing treatment is still available when pricing cannot be read.
      }).finally(() => {
        if (request === quoteRequest.current) setLoadingQuote(false);
      });
    }
    if (!newPayment) {
      setMethod(null);
    } else if (paymentState === "no_session" || cardOnFile === "no_card") {
      setMethod("paid_e_transfer");
    } else {
      setMethod(cardOnFile === "card_on_file" ? "stripe" : null);
    }
  }

  const finalCents = feeDraft ? checkoutDraftAmount(feeDraft.finalFee) : null;
  const confirmationCents = feeDraft && isReceivedMethod(method)
    ? checkoutDraftAmount(feeDraft.received ?? feeDraft.finalFee)
    : finalCents;
  const freeVisit = feeDraft?.referenceCents === 0;
  const confirmLabel = method === "waived" || finalCents === 0
    ? "Confirm fee waiver"
    : method === "still_owes" ? "Record amount owed"
    : confirmationCents === null ? "Confirm payment" : `Confirm payment · ${formatMoney(confirmationCents, currency)}`;

  return (
    <>
      {(status === "completed" || !newPayment) && children}
      {status === "confirmed" && (
        <MarkAppointmentCompleteControl
          appointmentId={appointmentId}
          startsAt={startsAt}
          checkout={newPayment || existingOutcome ? {
            visitLabel,
            onOpen: openCheckout,
            onCompleted: () => {
              ++quoteRequest.current;
              setOpen(!freeVisit);
            },
            choices: newPayment ? busy => freeVisit ? (
              <p role="status" className="mt-3 text-sm font-medium">No charge required · {formatMoney(0, currency)}</p>
            ) : (
              <div className="mt-4">
                {feeDraft ? (
                  <CheckoutFeeFields draft={feeDraft} currency={currency} onChange={setFeeDraft}
                    showReceived={isReceivedMethod(method) && finalCents !== 0} disabled={busy} />
                ) : (
                  <p role="status" className="mb-3 text-xs text-neutral-600 dark:text-neutral-400">
                    {loadingQuote ? "Loading visit fee…" : "Visit fee unavailable. You can still finish the visit."}
                  </p>
                )}
                <CheckoutMethodPicker
                  method={method}
                  onSelect={setMethod}
                  isOwner
                  disabled={busy}
                  stripeUnavailable={stripeUnavailable}
                />
                <button
                  type="button"
                  disabled
                  className="mt-4 min-h-[44px] cursor-not-allowed rounded-md border border-neutral-300 px-4 text-sm opacity-60 dark:border-neutral-700"
                >
                  {confirmLabel}
                </button>
              </div>
            ) : undefined,
          } : undefined}
        />
      )}
      {open && (
        <QuickCheckoutModal
          appointmentId={appointmentId}
          open
          initialMethod={method ?? undefined}
          initialFeeDraft={feeDraft}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
