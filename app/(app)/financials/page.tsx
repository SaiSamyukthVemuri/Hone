import { BusinessSubnav } from "@/components/business-subnav";
import {
  isReportingPeriod,
  type ReportingPeriod,
} from "@/lib/booking/reporting-period";
import { loadFinancialsView } from "@/lib/finance/financial-briefing";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

import { FinancialSpine } from "./financial-spine";

// ===========================================================================
// FINANCIALS — the owner's financial truth surface
// ===========================================================================
//
// FIN-01A Slice 1: "the spine and the unknown vocabulary". Owner-only,
// read-only, no migration, no RPC, no mutation, no Stripe call.
//
// WHAT THIS RELEASE ANSWERS: what the calendar held in a studio-local period,
// and how those appointments divided — still to happen, completed, cancelled,
// no-show. What became of the completed work, and any money at all, is a later
// slice and is ABSENT rather than stubbed; the screen says so in a sentence.
//
// THE GATE IS ON THE PAGE, not merely on navigation. The route is deliberately
// unadvertised for now — it carries no NAV_ENTRIES row and is recorded in
// NON_SEARCHABLE_ROUTES — but navigation hiding is not authority, and a
// practitioner who types the URL reaches this file. `loadFinancialsView`
// refuses on the role before it constructs a Supabase client, so the refusal
// below is not a hidden aggregate: no aggregate was ever read.
//
// It is still not a DATABASE boundary, and lib/finance/financial-briefing.ts
// says why at length.
//
// FINANCIAL TRUTH IS NEVER CACHED.
export const dynamic = "force-dynamic";

export const metadata = { title: "Financials" };

export default async function FinancialsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string | string[] }>;
}) {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  const sp = await searchParams;
  const requested = Array.isArray(sp.period) ? sp.period[0] : sp.period;
  // An unrecognised period falls back to the day rather than refusing: the
  // owner asked for this screen, and a bad query string is not a reason to
  // withhold it. It is never an unbounded window.
  const period: ReportingPeriod = isReportingPeriod(requested) ? requested : "today";

  const view = await loadFinancialsView(practitioner, studio, period);

  if (view.access === "refused") {
    return (
      // `text-fg`, not the `text-fg-muted` its sibling owner surfaces use:
      // muted on the sunken surface measures 4.54:1, and this sentence is the
      // page's entire content rather than a caption beside something else.
      <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">
        Only the studio owner can see studio financials.
      </section>
    );
  }

  // THE SUBNAV RENDERS ONLY PAST THE OWNER GATE, for the same reason it does
  // on /dashboard/capacity: the refusal above is the whole page for a
  // practitioner, and it must not also advertise two sibling owner surfaces.
  return (
    <div className="flex flex-col gap-6">
      <BusinessSubnav />
      <FinancialSpine briefing={view.briefing} />
    </div>
  );
}
