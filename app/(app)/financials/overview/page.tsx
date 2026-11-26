import { type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { localDateString } from "@/lib/booking/tz";
import { buildHomeFigures } from "@/lib/business-analytics/home-figures";
import { analyticsRawFor, parseHomeParams, statementMonthFor } from "@/lib/business-analytics/home-params";
import { loadOverview } from "@/lib/business-analytics/server/overview-read";
import { STATEMENTS_OWNER_ONLY } from "@/lib/finance/statement-screen";
import { yearMonthOf } from "@/lib/finance/statement-period";
import { timed } from "@/lib/observability/perf-timing";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

import { BusinessHome } from "./business-home";

// ===========================================================================
// Business → Overview. Owner-only, READ-ONLY: no write, no Stripe, no mail, no service-role client, no migration.
// ===========================================================================
// THE GATE IS ON THE PAGE, before any read; the Analytics loader repeats it as its own first statement. The figures are the Analytics Overview's own
// (lib/business-analytics): this page adds no money query. Everything is rendered on the server, so the first paint has the figures. FINANCIAL TRUTH IS NEVER CACHED.
export const dynamic = "force-dynamic";

export const metadata = { title: "Business overview" };

export default async function BusinessOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { practitioner, studio } = await timed("overview.identity", () => requirePractitionerWithStudio());
  if (practitioner.role !== "owner") {
    return <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">{STATEMENTS_OWNER_ONLY}</section>;
  }

  const now = new Date();
  const currentMonth = yearMonthOf(localDateString(now, studio.timezone));
  const { selection, notices } = parseHomeParams(await searchParams, currentMonth);

  const jurisdiction = await getStudioPaymentJurisdiction(studio.id);
  const currency: PaymentCurrency | null = jurisdiction.ok ? jurisdiction.jurisdiction.currency : null;

  const read = await timed("overview.domain", () => loadOverview(practitioner, studio, currency, analyticsRawFor(selection), { strict: false, names: false }, now));
  if (read.access !== "granted") return null; // unreachable: the role was checked above, and the loader checks it again
  const figures = read.ok ? buildHomeFigures(read.view) : null;

  return (
    <BusinessHome
      studioName={studio.name}
      selection={selection}
      notices={notices}
      currentMonth={currentMonth}
      statementMonth={statementMonthFor(selection, currentMonth)}
      asOfLocal={read.ok ? read.view.asOfLocal : localDateString(now, studio.timezone)}
      figures={figures}
    />
  );
}
