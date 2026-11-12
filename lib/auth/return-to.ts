// HON-7. Return to a specific internal page after a signed-out visitor signs in.
//
// THE BOUNDARY. What survives the sign-in is never a path, a URL or any visitor-supplied text: it is the NAME of an entry in RETURN_TARGETS below,
// chosen by matching the request's exact pathname (and, for one entry, the exact query) against that table. The destination a callback redirects to
// is looked up from the table by name, so no input can make it point anywhere the table does not already say. That is why this cannot be an open
// redirect: there is nothing attacker-controlled left to redirect with.
//
// AUTHORITY IS NOT CARRIED. A target only says where to land; the destination page re-checks the signed-in user's role itself (Settings -> Waitlist
// refuses a non-owner), so a non-owner who signs in and lands there gets the page's refusal, not data.
//
// The #fragment is never sent to a server, so a link such as /settings/waitlist?followup=1#follow-up loses its fragment at the sign-in redirect.
// The query `followup=1` stands in for it: it selects the target whose destination carries the fragment.

export const RETURN_TO_COOKIE = "hone_return_to";
export const RETURN_TO_COOKIE_MAX_AGE_SECONDS = 60 * 60;

type Target = { key: string; pathname: string; query: string; destination: string };

// Exact entries only. Extend deliberately, one reviewed line at a time.
export const RETURN_TARGETS: ReadonlyArray<Target> = [
  { key: "waitlist_followup", pathname: "/settings/waitlist", query: "?followup=1", destination: "/settings/waitlist#follow-up" },
  { key: "waitlist", pathname: "/settings/waitlist", query: "", destination: "/settings/waitlist" },
];

/** The target key for a signed-out request, or null. `search` is the raw query string including the leading "?" (or ""). */
export function returnToKeyFor(pathname: string, search: string): string | null {
  if (typeof pathname !== "string" || typeof search !== "string") return null;
  // A trailing slash is the same page; nothing else is normalised.
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const hit = RETURN_TARGETS.find((t) => t.pathname === p && t.query === search);
  return hit ? hit.key : null;
}

/** The internal destination for a stored key, or null for anything that is not exactly one of the table's keys. */
export function returnToDestination(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const hit = RETURN_TARGETS.find((t) => t.key === key);
  return hit ? hit.destination : null;
}

/** Read the return-to key from a Cookie header without any framework dependency. Returns the raw value only if it is a known key. */
export function returnToKeyFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== RETURN_TO_COOKIE) continue;
    const value = part.slice(i + 1).trim();
    return returnToDestination(value) ? value : null;
  }
  return null;
}
