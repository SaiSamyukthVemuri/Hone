// #828 G-07/G-26: the same-origin PostHog proxy. Replaces the bare
// next.config.ts rewrite, which forwarded every browser header (the page URL as
// Referer, the Supabase auth Cookie, the client IP) to PostHog. Only allowlisted
// paths, methods and headers pass; see lib/observability/egress-proxy.ts.

import {
  POSTHOG_ALLOWED_METHODS,
  forwardUpstream,
  posthogUpstreamUrl,
  readCappedBody,
} from "@/lib/observability/egress-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path?: string[] }> };

async function handle(req: Request, { params }: Context): Promise<Response> {
  if (!POSTHOG_ALLOWED_METHODS.includes(req.method)) return new Response(null, { status: 405 });
  const { path = [] } = await params;
  const url = new URL(req.url);
  const upstream = posthogUpstreamUrl(path, url.search, url.pathname.endsWith("/"));
  if (upstream === null) return new Response(null, { status: 404 });
  const body = req.method === "POST" ? await readCappedBody(req) : null;
  if (req.method === "POST" && body === null) return new Response(null, { status: 413 });
  return forwardUpstream(upstream, req.method, req.headers, body);
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
