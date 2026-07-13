// Compact, practitioner-facing payment summary header. Answers the only
// questions Chloe needs during charting — is it paid? how much? — in one line,
// without processor internals. Presentation only: it derives nothing and calls
// no action; the caller passes the derived summary + slots the existing actions
// and the owner-only technical disclosure as children.

import {
  formatCadFromCents,
  type PaymentSummary,
} from "@/lib/payments/payment-summary-presenter";

const TONE_DOT: Record<PaymentSummary["tone"], string> = {
  paid: "bg-emerald-500",
  ready: "bg-blue-500",
  processing: "bg-amber-500",
  issue: "bg-red-500",
  neutral: "bg-neutral-400",
};

export function PaymentSummaryCard({
  summary,
  heading = "Payment",
  subLine,
  children,
}: {
  summary: PaymentSummary;
  heading?: string;
  // e.g. "Jul 12, 2026 at 3:03 PM" or a receipt line — small secondary text.
  subLine?: React.ReactNode;
  // actions, receipt status, technical disclosure.
  children?: React.ReactNode;
}) {
  const amount = formatCadFromCents(summary.amountCents);
  const headlineText = summary.tone === "issue" ? "Payment issue" : heading;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5" data-testid="payment-summary">
        <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          {headlineText}
        </h3>
        <p
          data-testid={`payment-summary-${summary.kind}`}
          className="flex items-center gap-2 text-base font-semibold"
        >
          <span
            aria-hidden
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${TONE_DOT[summary.tone]}`}
          />
          {/* status is in the words, not just the dot colour */}
          <span>
            {summary.headline}
            {amount ? ` · ${amount}` : ""}
          </span>
        </p>
        {subLine ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {subLine}
          </p>
        ) : null}
      </div>
      {children}
    </div>
  );
}
