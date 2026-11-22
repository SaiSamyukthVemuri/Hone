import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { loadWaitlistAnalytics } from "@/lib/business-analytics/server/waitlist-read";
import { estimateWindowCapacityAction } from "@/app/(app)/settings/waitlist/window-capacity-actions";
import { WaitlistScreen } from "../waitlist-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics: Waitlist" };

export default async function AnalyticsWaitlistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") return <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">Only the studio owner can see Analytics.</section>;
  const read = await loadWaitlistAnalytics(practitioner, studio, await searchParams, new Date());
  if (read.access !== "granted") return null;
  const capacity = read.params.serviceId ? await estimateWindowCapacityAction({ serviceId: read.params.serviceId, windowDays: read.params.days, allowedWeekdays: null }) : null;
  return <WaitlistScreen read={read} capacity={capacity} />;
}
