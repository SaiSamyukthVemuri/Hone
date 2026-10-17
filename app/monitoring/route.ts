// #828 G-07/G-26: Sentry's same-origin tunnel (Sentry.init({ tunnel:
// "/monitoring" }) in instrumentation-client.ts). Replaces withSentryConfig's
// tunnelRoute, a bare rewrite that forwarded every browser header (the page URL
// as Referer, the Supabase auth Cookie, the client IP) to Sentry. As in
// Sentry's documented tunnel, only the envelope body is forwarded, and only for
// Hone's own DSN; see lib/observability/egress-proxy.ts.

import {
  forwardUpstream,
  readCappedBody,
  sentryEnvelopeUpstreamUrl,
} from "@/lib/observability/egress-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = await readCappedBody(req);
  if (body === null) return new Response(null, { status: 413 });
  const upstream = sentryEnvelopeUpstreamUrl(body);
  if (upstream === null) return new Response(null, { status: 400 });
  return forwardUpstream(upstream, "POST", req.headers, body);
}
