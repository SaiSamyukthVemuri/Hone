import { formatStatementMoney } from "@/lib/finance/statement-money";
import { localDateString } from "@/lib/booking/tz";
import { loadOwnerClientStatement } from "@/lib/finance/owner-client-statement";
import { STATEMENT_MONTH_NOTICE } from "@/lib/finance/statement-copy";
import { monthRange, resolveStatementMonth, yearMonthOf } from "@/lib/finance/statement-period";
import { STATEMENTS_OWNER_ONLY, STATEMENT_READ_UNAVAILABLE, clientsListHref } from "@/lib/finance/statement-screen";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

import { ClientStatementView } from "../client-statement-view";
import { loadFinderState } from "../finder-data";
import { StatementsTabs } from "../statements-chrome";

// ===========================================================================
// One client's statement: a month or the full history. Owner-only, READ-ONLY; viewing never charges and never messages anyone.
// ===========================================================================
// The client comes from the URL as an id and is VERIFIED to belong to the signed-in owner's studio by the read module before anything else is read;
// another studio's id and an unknown id are the same "not found". THE GATE IS ON THE PAGE, before any read. FINANCIAL TRUTH IS NEVER CACHED.
export const dynamic = "force-dynamic";

export const metadata = { title: "Client statement" };

export default async function ClientStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ month?: string | string[]; view?: string | string[] }>;
}) {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">{STATEMENTS_OWNER_ONLY}</section>;
  }

  const { clientId } = await params;
  const sp = await searchParams;
  const now = new Date();
  const result = await loadOwnerClientStatement({ practitioner, studio, clientId, monthParam: sp.month, viewParam: sp.view, now });
  if (!result.ok) {
    const { month } = resolveStatementMonth(sp.month, yearMonthOf(localDateString(now, studio.timezone)));
    return (
      <section className="space-y-3 rounded-lg border border-line p-6 text-sm text-fg" role="alert">
        <p>{STATEMENT_READ_UNAVAILABLE[result.reason] ?? STATEMENT_READ_UNAVAILABLE.read_failed}</p>
        <a href={clientsListHref(month)} className="underline">Back to Clients</a>
      </section>
    );
  }
  const { month, view, currency } = result;
  // The tabs and "Find a client", as on the other statements screens. The finder is read only AFTER the owner gate above.
  const finder = await loadFinderState(practitioner, studio);

  return (
    <ClientStatementView
      document={result.document}
      month={month}
      monthLabel={monthRange(month).label}
      maxMonth={result.currentMonth}
      view={view}
      notice={result.fellBack ? STATEMENT_MONTH_NOTICE : null}
      offDocumentWithMoney={result.offDocumentWithMoney}
      format={(c) => formatStatementMoney(c, currency)}
      tabs={<StatementsTabs active="clients" month={month} />}
      finder={finder}
    />
  );
}
