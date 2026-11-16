// Is this POST from our own page? Decided from request HEADERS only, never from request.url: under `next start` behind a
// proxy, request.url can carry the server's own listen host rather than the host the browser used.
//
//   1. Sec-Fetch-Site decides when present (the browser sets it; a page cannot). Only "same-origin" passes.
//   2. Otherwise the Origin header must be a real origin (scheme://host[:port], nothing else) whose host equals the host
//      the request was addressed to. "null" and a missing Origin are refused.
//
// "The host the request was addressed to" is the Host header. Only ON A PLATFORM THAT SETS IT (Vercel, which overwrites
// any client-supplied value) is x-forwarded-host used instead. Off-platform a client can send x-forwarded-host itself,
// so it is never trusted there: an attacker's page cannot choose the host we compare against.

type HeaderReader = { get(name: string): string | null };

export function onForwardingPlatform(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL === "1";
}

export function addressedHost(headers: HeaderReader, platform: boolean): string | null {
  if (platform) {
    const forwarded = headers.get("x-forwarded-host");
    if (forwarded) {
      const first = forwarded.split(",")[0].trim().toLowerCase();
      if (first) return first;
    }
  }
  const host = headers.get("host");
  return host ? host.trim().toLowerCase() : null;
}

export function isSameOriginPost(headers: HeaderReader, platform: boolean = onForwardingPlatform()): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = headers.get("origin");
  if (origin === null || origin === "null") return false;
  const expected = addressedHost(headers, platform);
  if (expected === null) return false;
  try {
    const parsed = new URL(origin);
    // An Origin is exactly scheme://host[:port]: userinfo, a path or a look-alike host is not one.
    return parsed.origin === origin && parsed.host === expected;
  } catch {
    return false;
  }
}
