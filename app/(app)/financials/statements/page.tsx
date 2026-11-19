import { formatMoney, type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { localDateString } from "@/lib/booking/tz";
import { FINDER_CLIENT_CAP, STATEMENTS_OWNER_ONLY, parseClientsParams, sameNameClientIds } from "@/lib/finance/statement-screen";
import { loadFinderClients, loadLastVisitDates, loadStatementDirectory, LAST_VISIT_MAX_CLIENTS } from "@/lib/finance/statement-directory-read";
import { monthRange, yearMonthOf } from "@/lib/finance/statement-period";
import { STATEMENT_MONTH_NOTICE } from "@/lib/finance/statement-copy";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

import { ClientsView, type ClientsViewProps } from "./clients-view";

// ===========================================================================
// The Clients tab of Statements: every client with a visit in the month, and Find a client. Owner-only, READ-ONLY.
// ===========================================================================
// No write, no Stripe, no mail, no service-role client, no migration. Viewing never charges and never messages a client.
// THE GATE IS ON THE PAGE, before any read; every loader repeats it as its own first statement. FINANCIAL TRUTH IS NEVER CACHED.
export const dynamic = "force-dynamic";

export const metadata = { title: "Statements: Clients" };

export default async function StatementsClientsPage({ searchParams }: { searchParams: Promise<{ month?: string | string[]; page?: string | string[] }> }) {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">{STATEMENTS_OWNER_ONLY}</section>;
  }

  const now = new Date();
  const current = yearMonthOf(localDateString(now, studio.timezone));
  const { month, fellBack, page } = parseClientsParams(await searchParams, current);

  const jurisdiction = await getStudioPaymentJurisdiction(studio.id);
  const currency: PaymentCurrency | null = jurisdiction.ok ? jurisdiction.jurisdiction.currency : null;

  const read = await loadStatementDirectory(practitioner, studio, currency, month, now);
  const directory: ClientsViewProps["directory"] =
    read.access === "granted" && read.ok ? { ok: true, value: read.directory } : { ok: false, reason: read.access === "granted" && !read.ok ? read.reason : "read_failed" };

  const found = await loadFinderClients(practitioner, studio);
  let finder: ClientsViewProps["finder"] = { state: "unavailable" };
  if (found.access === "granted" && found.ok) {
    if (found.clients.length > FINDER_CLIENT_CAP) finder = { state: "too_many" };
    else {
      const sameName = sameNameClientIds(found.clients);
      // Two clients with one name are told apart by their last visit date; beyond the bound, or on any failure, the screen says only "same name".
      const last = sameName.length <= LAST_VISIT_MAX_CLIENTS ? await loadLastVisitDates(practitioner, studio, sameName) : null;
      finder = { state: "ok", clients: found.clients, lastVisits: last && last.access === "granted" && last.ok ? last.lastVisit : null };
    }
  }

  return (
    <ClientsView
      month={month}
      monthLabel={monthRange(month).label}
      maxMonth={current}
      timezone={studio.timezone}
      notice={fellBack ? STATEMENT_MONTH_NOTICE : null}
      page={page}
      format={(c) => formatMoney(c, currency)}
      directory={directory}
      finder={finder}
    />
  );
}
