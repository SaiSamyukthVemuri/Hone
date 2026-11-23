import { type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { localDateString } from "@/lib/booking/tz";
import { formatStatementMoney } from "@/lib/finance/statement-money";
import { parsePageParam } from "@/lib/finance/statement-paging";
import { loadStatementView } from "@/lib/finance/statement-read";
import { resolveStatementMonth, yearMonthOf } from "@/lib/finance/statement-period";
import { STATEMENT_MONTH_NOTICE } from "@/lib/finance/statement-copy";
import { timed } from "@/lib/observability/perf-timing";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

import { loadFinderState } from "../statements/finder-data";
import { StatementsTabs } from "../statements/statements-chrome";
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

export default async function StatementPage({ searchParams }: { searchParams: Promise<{ month?: string | string[]; page?: string | string[] }> }) {
  const { practitioner, studio } = await timed("statements.identity", () => requirePractitionerWithStudio());
  if (practitioner.role !== "owner") {
    return (
      <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">
        Only the studio owner can see the money statement.
      </section>
    );
  }

  const sp = await searchParams;
  // An unrecognised or out-of-range month falls back to the current one, with a visible notice; it is never an unbounded window.
  const current = yearMonthOf(localDateString(new Date(), studio.timezone));
  const { month, fellBack } = resolveStatementMonth(sp.month, current);
  const notice = fellBack ? STATEMENT_MONTH_NOTICE : null;

  const jurisdiction = await getStudioPaymentJurisdiction(studio.id);
  const currency: PaymentCurrency | null = jurisdiction.ok ? jurisdiction.jurisdiction.currency : null;

  const view = await timed("statements.domain", () => loadStatementView(practitioner, studio, month, currency));
  // "Find a client" beside the tabs, as on the Clients tab. Read only AFTER the owner gate above; the month is the one in view.
  const finder = await loadFinderState(practitioner, studio);
  // Wide screens get the reference's content width: a contained breakout of the Statements content only (the app shell and its navigation are unchanged).
  return (
    <div className="bg-surface min-[1140px]:-mx-[45px]">
      <StatementView
        view={view}
        currency={currency}
        format={(c) => formatStatementMoney(c, currency)}
        maxMonth={current}
        notice={notice}
        page={parsePageParam(sp.page)}
        tabs={<StatementsTabs active="studio" month={month} />}
        studioName={studio.name}
        finder={finder}
      />
    </div>
  );
}
