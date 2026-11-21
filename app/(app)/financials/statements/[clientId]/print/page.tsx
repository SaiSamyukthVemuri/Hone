import { formatStatementMoney } from "@/lib/finance/statement-money";
import { monthRange } from "@/lib/finance/statement-period";
import { loadOwnerClientStatement } from "@/lib/finance/owner-client-statement";
import { STATEMENTS_OWNER_ONLY, STATEMENT_READ_UNAVAILABLE, clientStatementHref } from "@/lib/finance/statement-screen";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

import { StatementPrintView } from "../../statement-print-view";

// The printable client statement. Owner-only, READ-ONLY; the gate is on the page, before any read (the loader repeats it as its first statement).
// FINANCIAL TRUTH IS NEVER CACHED.
export const dynamic = "force-dynamic";

export const metadata = { title: "Statement (print)" };

export default async function ClientStatementPrintPage({
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
  const result = await loadOwnerClientStatement({ practitioner, studio, clientId, monthParam: sp.month, viewParam: sp.view, now: new Date() });
  if (!result.ok) {
    return (
      <section className="rounded-lg border border-line p-6 text-sm text-fg" role="alert">
        {STATEMENT_READ_UNAVAILABLE[result.reason] ?? STATEMENT_READ_UNAVAILABLE.read_failed}
      </section>
    );
  }
  return (
    <StatementPrintView
      document={result.document}
      offDocumentWithMoney={result.offDocumentWithMoney}
      backHref={clientStatementHref(clientId, result.month, result.view)}
      timezone={studio.timezone}
      currency={result.currency}
      monthLabel={monthRange(result.month).label}
      format={(c) => formatStatementMoney(c, result.currency)}
    />
  );
}
