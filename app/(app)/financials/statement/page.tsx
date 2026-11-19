import { formatMoney, type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { localDateString } from "@/lib/booking/tz";
import { loadStatementView } from "@/lib/finance/statement-read";
import { isStatementMonth, yearMonthOf } from "@/lib/finance/statement-period";
import { STATEMENT_MONTH_NOTICE } from "@/lib/finance/statement-copy";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

import { StatementView } from "./statement-view";

// ===========================================================================
// HON-64 Slice A: the owner's visit-and-money statement. Owner-only, read-only, no migration, no print, no export.
// ===========================================================================
//
// A NEW ROUTE with its own read path. /financials (FIN-01A) keeps its no-money contract untouched: nothing in its import closure
// reaches this file, and this file imports nothing from it.
//
// THE GATE IS ON THE PAGE, before ANY read, including the currency lookup. The read module repeats it as its own first statement.
// FINANCIAL TRUTH IS NEVER CACHED.
export const dynamic = "force-dynamic";

export const metadata = { title: "Money statement" };

export default async function StatementPage({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">
        Only the studio owner can see the money statement.
      </section>
    );
  }

  const sp = await searchParams;
  const requested = Array.isArray(sp.month) ? sp.month[0] : sp.month;
  // An unrecognised month falls back to the current one; it is never an unbounded window.
  const current = yearMonthOf(localDateString(new Date(), studio.timezone));
  const valid = isStatementMonth(requested, current);
  const month = valid ? requested : current;
  const notice = requested !== undefined && !valid ? STATEMENT_MONTH_NOTICE : null;

  const jurisdiction = await getStudioPaymentJurisdiction(studio.id);
  const currency: PaymentCurrency | null = jurisdiction.ok ? jurisdiction.jurisdiction.currency : null;

  const view = await loadStatementView(practitioner, studio, month, currency);
  return <StatementView view={view} currency={currency} format={(c) => formatMoney(c, currency)} maxMonth={current} notice={notice} />;
}
