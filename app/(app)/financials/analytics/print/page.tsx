import { type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { formatExact } from "@/lib/business-analytics/money-format";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { overviewQuery } from "@/lib/business-analytics/overview-params";
import { loadOverview } from "@/lib/business-analytics/server/overview-read";
import { STATEMENTS_OWNER_ONLY } from "@/lib/finance/statement-screen";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

import { PRINT_CSS } from "../../statements/statement-print-view";
import { PrintButton } from "../../statements/print-button";
import { OVERVIEW_PATH, OverviewScreen } from "../overview-screen";

// The printable Analytics Overview. Owner-only, READ-ONLY; the gate is on the page, before any read (the loader repeats it as its first statement).
// The same figures as the screen, from the same loader. FINANCIAL TRUTH IS NEVER CACHED. The title is fixed text: it never carries a team member.
export const dynamic = "force-dynamic";

export const metadata = { title: "Analytics (print)" };

export default async function AnalyticsOverviewPrintPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">{STATEMENTS_OWNER_ONLY}</section>;
  }
  const jurisdiction = await getStudioPaymentJurisdiction(studio.id);
  const currency: PaymentCurrency | null = jurisdiction.ok ? jurisdiction.jurisdiction.currency : null;

  // A printed page must say exactly what it was asked for, so a bad value is refused here, not replaced by the default.
  const read = await loadOverview(practitioner, studio, currency, await searchParams, { strict: true }, new Date());
  if (read.access !== "granted") return null; // unreachable: the role was checked above, and the loader checks it again
  if (!read.ok) {
    return (
      <section className="rounded-lg border border-line p-6 text-sm text-fg" role="alert">
        {read.reason === "bad_request" ? "That address asks for a period or team member that is not available, so nothing is printed." : "Analytics could not be read right now. Nothing is printed rather than a partial figure."}
      </section>
    );
  }
  return (
    <div className="space-y-4">
      <style>{PRINT_CSS}</style>
      <div className="flex flex-wrap items-center gap-3" data-print-hide>
        <PrintButton />
        <a href={`${OVERVIEW_PATH}${overviewQuery(read.params)}`} className="text-sm underline">Back to Analytics</a>
      </div>
      <OverviewScreen view={read.view} params={read.params} notices={[]} practitionerOptions={read.practitionerOptions} format={formatExact} print />
    </div>
  );
}
