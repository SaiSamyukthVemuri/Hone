import { type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { parseClientsParams } from "@/lib/business-analytics/clients-params";
import { formatExact } from "@/lib/business-analytics/money-format";
import { loadOverview } from "@/lib/business-analytics/server/overview-read";
import { STATEMENTS_OWNER_ONLY } from "@/lib/finance/statement-screen";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

import { ClientsScreen } from "../clients-screen";
import { OverviewInvalidPeriod } from "../overview-screen";

// ===========================================================================
// Business → Analytics → Clients. Owner-only, READ-ONLY: no write, no Stripe, no mail, no service-role client, no migration.
// ===========================================================================
// THE GATE IS ON THE PAGE, before any read; the loader repeats it as its own first statement. FINANCIAL TRUTH IS NEVER CACHED.
// The address carries the period, the team member, a sort, a filter and a page: nothing personal. There is no search.
export const dynamic = "force-dynamic";

export const metadata = { title: "Analytics: Clients" };

export default async function AnalyticsClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">{STATEMENTS_OWNER_ONLY}</section>;
  }

  const jurisdiction = await getStudioPaymentJurisdiction(studio.id);
  const currency: PaymentCurrency | null = jurisdiction.ok ? jurisdiction.jurisdiction.currency : null;

  const raw = await searchParams;
  const parsed = parseClientsParams(raw, { strict: false });
  const clients = parsed.ok ? parsed.params : { sort: "spend" as const, chip: "all" as const, page: 1 };
  const clientNotices = parsed.ok ? parsed.notices : [];

  const read = await loadOverview(practitioner, studio, currency, raw, { strict: false, clients }, new Date());
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
  return <ClientsScreen view={read.view} params={read.params} clients={clients} notices={[...read.notices, ...clientNotices]} practitionerOptions={read.practitionerOptions} format={formatExact} />;
}
