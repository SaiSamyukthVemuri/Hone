import type { PaymentCountrySummary } from "@/lib/billing/payment-jurisdiction";
import { SectionLabel } from "@/components/ui/section-label";

// PAY-CCY-04 (#824). Where this studio takes payments, and whether its Stripe
// account agrees. Server-rendered from describePaymentCountry; this component
// decides nothing. Read-only: the country is changed only by Hone support
// (set_studio_payment_jurisdiction, 0214), so there is no control here.

const TONE: Record<PaymentCountrySummary["tone"], string> = {
  ok: "border-neutral-200 dark:border-neutral-800",
  attention: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",
  blocked: "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40",
  unknown: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",
};

export function PaymentCountryCard({ summary }: { summary: PaymentCountrySummary }) {
  return (
    <section
      data-testid="payment-country-card"
      data-tone={summary.tone}
      className={`flex flex-col gap-1 rounded-md border p-4 ${TONE[summary.tone]}`}
    >
      <SectionLabel as="h3">Payment country and currency</SectionLabel>
      <p className="text-sm font-medium" data-testid="payment-country-heading">
        {summary.heading}
      </p>
      <p className="text-sm text-neutral-600 dark:text-neutral-300">{summary.detail}</p>
    </section>
  );
}
