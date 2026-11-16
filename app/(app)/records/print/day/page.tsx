import type { Metadata } from "next";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { DayPacketView } from "../_packet/day-packet-view";

// HON-46 / G-26 Option B. This route used to take ?clientId=&day= and so put both in the URL. It no longer reads the
// query at all: it always renders the view with nothing selected, which refuses ("Open this page from a client").
// The packet is opened only through /records/print/ticket/<ticket>, which is minted by a POST from the session page.
// Kept (rather than deleted) so an old bookmark lands on a clear refusal instead of a 404, and so the page still
// sends no referrer and asks not to be indexed.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Clinical record",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function DayPacketPage() {
  await requirePractitionerWithStudio(); // the identity guard every authenticated page resolves itself
  return <DayPacketView />;
}
