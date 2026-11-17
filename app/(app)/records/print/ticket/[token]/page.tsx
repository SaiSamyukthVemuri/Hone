import type { Metadata } from "next";
import Link from "next/link";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { resolveTicket } from "@/lib/records/print/ticket-resolve";
import { consumeTicketNonce } from "@/lib/records/print/ticket-store";
import { DayPacketView } from "../../_packet/day-packet-view";
import { ReopenButton } from "./reopen-button";

// The day packet, opened by an OPAQUE one-use ticket instead of ?clientId=&day=. The path holds only the
// ticket (no client id, no day). The route is in the token-route registry (lib/security/token-routes.ts), so it gets
// Referrer-Policy: no-referrer and noindex headers, the Sentry path scrub, and Vercel Analytics / PostHog drop it
// instead of sending the path. The ticket is bound to this studio and this owner, lives five minutes, and opens once.
// A refusal says only that the link is no longer valid and shows no clinical content and no reason beyond that.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Clinical record",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function TicketedDayPacketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { practitioner, studio } = await requirePractitionerWithStudio();
  const resolved = await resolveTicket({
    secret: process.env.PRINT_TICKET_SECRET,
    binding: { studioId: studio.id, ownerId: practitioner.id },
    ticket: token,
    consume: consumeTicketNonce,
  });
  if (!resolved.ok) {
    return (
      <div role="alert" data-testid="day-packet-refusal" className="flex flex-col gap-2 text-sm">
        <p className="text-base font-medium">This print link is no longer valid.</p>
        <p>Open Print again from the client&rsquo;s session. A print link works once and for five minutes.</p>
        <p className="text-neutral-600">No clinical record is shown.</p>
        <ReopenButton ticket={token} />
        <Link href="/records" prefetch={false} referrerPolicy="no-referrer" className="text-neutral-600 underline print:hidden">
          Back to Record Keeping
        </Link>
      </div>
    );
  }
  return <DayPacketView clientId={resolved.clientId} day={resolved.day} />;
}
