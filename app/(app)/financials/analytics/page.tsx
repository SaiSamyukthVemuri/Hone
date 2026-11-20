import { type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { formatExact } from "@/lib/business-analytics/money-format";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { loadOverview } from "@/lib/business-analytics/server/overview-read";
import { STATEMENTS_OWNER_ONLY } from "@/lib/finance/statement-screen";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

import { OverviewInvalidPeriod, OverviewScreen } from "./overview-screen";

// ===========================================================================
// Business → Analytics → Overview. Owner-only, READ-ONLY: no write, no Stripe, no mail, no service-role client, no migration.
// ===========================================================================
// THE GATE IS ON THE PAGE, before any read; the loader repeats it as its own first statement. FINANCIAL TRUTH IS NEVER CACHED.
// The screen is shown only by a direct address for now: it has no navigation entry yet.
export const dynamic = "force-dynamic";

export const metadata = { title: "Analytics" };

export default async function AnalyticsOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">{STATEMENTS_OWNER_ONLY}</section>;
  }

  const jurisdiction = await getStudioPaymentJurisdiction(studio.id);
  const currency: PaymentCurrency | null = jurisdiction.ok ? jurisdiction.jurisdiction.currency : null;

  const read = await loadOverview(practitioner, studio, currency, await searchParams, { strict: false }, new Date());
  if (read.access !== "granted") return null; // unreachable: the role was checked above, and the loader checks it again
  if (!read.ok && read.reason === "period_invalid") return <OverviewInvalidPeriod params={read.params} notices={read.notices} practitionerOptions={read.practitionerOptions} />;
  if (!read.ok) {
    return (
      <section className="space-y-2 rounded-lg border border-line bg-surface p-6 text-sm text-fg" role="alert">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p>Analytics could not be read right now. Nothing is shown rather than a partial figure. Try again in a moment.</p>
      </section>
    );
  }
  return <OverviewScreen view={read.view} params={read.params} notices={read.notices} practitionerOptions={read.practitionerOptions} format={formatExact} />;
}
