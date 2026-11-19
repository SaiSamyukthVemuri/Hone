import { formatMoney, type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { localDateString } from "@/lib/booking/tz";
import { loadClientStatementRead } from "@/lib/finance/client-statement-read";
import { buildStatementDocument } from "@/lib/finance/statement-document";
import { STATEMENT_MONTH_NOTICE } from "@/lib/finance/statement-copy";
import { monthRange, resolveStatementMonth, yearMonthOf } from "@/lib/finance/statement-period";
import { STATEMENTS_OWNER_ONLY, STATEMENT_READ_UNAVAILABLE, clientsListHref, parseClientView } from "@/lib/finance/statement-screen";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

import { ClientStatementView } from "../client-statement-view";

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
  const current = yearMonthOf(localDateString(now, studio.timezone));
  const { month, fellBack } = resolveStatementMonth(sp.month, current);
  const view = parseClientView(sp.view);

  const jurisdiction = await getStudioPaymentJurisdiction(studio.id);
  const currency: PaymentCurrency | null = jurisdiction.ok ? jurisdiction.jurisdiction.currency : null;

  const unavailable = (reason: string) => (
    <section className="space-y-3 rounded-lg border border-line p-6 text-sm text-fg" role="alert">
      <p>{STATEMENT_READ_UNAVAILABLE[reason] ?? STATEMENT_READ_UNAVAILABLE.read_failed}</p>
      <a href={clientsListHref(month)} className="underline">Back to Clients</a>
    </section>
  );

  const read = await loadClientStatementRead(practitioner, studio, currency, clientId, now);
  if (read.access !== "granted") return unavailable("read_failed");
  if (!read.ok) return unavailable(read.reason);

  const built = buildStatementDocument({
    studioId: studio.id,
    identity: { studioName: studio.name, legalEntityName: null, address: null, contactEmail: null },
    client: read.client,
    scope: view === "history" ? { kind: "full_history" } : { kind: "month", month },
    currency: read.studioCurrency,
    preparedOn: localDateString(now, studio.timezone),
    visits: read.visits,
    feeItems: read.feeItems,
  });
  if (!built.ok) return unavailable("build_failed");

  return (
    <ClientStatementView
      document={built.document}
      month={month}
      monthLabel={monthRange(month).label}
      maxMonth={current}
      view={view}
      notice={fellBack ? STATEMENT_MONTH_NOTICE : null}
      offDocumentWithMoney={read.offDocumentWithMoney}
      format={(c) => formatMoney(c, currency)}
    />
  );
}
