import type { Metadata } from "next";
import { loadInvitationAction } from "./actions";
import { InvitationContainer } from "./InvitationContainer";

// WAIT-03 B3 — the recipient's invitation page.
//
// The token is a BEARER CREDENTIAL in the path, so `/invitation` is registered in
// lib/security/token-routes.ts. That single registry drives both the stricter
// privacy headers in next.config.ts (no Referer leak, no indexing) and the
// telemetry scrubber, so the credential cannot reach a third party or an error
// report.
//
// Rendering is dynamic and never cached: the offer's state changes underneath
// the link, and a cached "still available" page would send a recipient to book a
// slot that is gone -- or worse, show a live offer for an invitation that has
// since been revoked.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Your invitation",
  // Belt and braces alongside the X-Robots-Tag the token-route registry applies.
  robots: { index: false, follow: false },
};

export default async function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // The FIRST authority call happens on the server, before anything renders, so
  // a dead or forged link never paints an offer.
  const initial = await loadInvitationAction(token);
  return <InvitationContainer token={token} initial={initial} />;
}
