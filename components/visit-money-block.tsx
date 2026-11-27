import { moneyRows, type VisitMoneySummary } from "@/lib/billing/visit-money";
import { formatMoney, type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";

/** Collected / Refunded / Net for one visit (or one statement), from the ONE helper in lib/billing/visit-money.ts. Same labels and order on every screen. */
export function VisitMoneyBlock({ summary, currency, testId = "visit-money", statement = false, stillToCollectCents = null }: { summary: VisitMoneySummary; currency: PaymentCurrency | null; testId?: string; statement?: boolean; stillToCollectCents?: number | null }) {
  const { rows, notFinalNote } = moneyRows(summary, { statement });
  return (
    <div data-testid={testId} className="flex flex-col gap-2">
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-base">
        {rows.map((r) => (
          <div key={r.key} className="contents">
            <dt className={r.key === "net" ? "font-semibold" : undefined}>{r.label}</dt>
            <dd className={r.key === "net" ? "text-right text-lg font-semibold tabular-nums" : "text-right font-medium tabular-nums"} data-testid={`${testId}-${r.key}`}>{formatMoney(r.cents, currency)}</dd>
          </div>
        ))}
        {stillToCollectCents !== null && (
          <div className="contents">
            <dt className="font-semibold">Still to collect</dt>
            <dd className="text-right font-medium tabular-nums" data-testid={`${testId}-still_to_collect`}>{formatMoney(stillToCollectCents, currency)}</dd>
          </div>
        )}
      </dl>
      {notFinalNote ? <p role="status" data-testid={`${testId}-not-final`} className="text-sm text-neutral-600 dark:text-neutral-400">{notFinalNote}</p> : null}
    </div>
  );
}
