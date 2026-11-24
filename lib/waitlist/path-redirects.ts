// Forward only the six historical waitlist routes. Match the path exactly and keep the raw query intact.
import { LEGACY_WAITLIST_ROUTES, WAITLIST_PATH } from "./paths";

/** A new base must be an internal path: one leading slash, no second slash or backslash right after it, no scheme, no control characters, no trailing slash. */
function assertInternalBase(base: string): void {
  const ok =
    typeof base === "string" &&
    /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(base);
  if (!ok) throw new Error(`waitlist redirect base is not an internal path: ${JSON.stringify(base)}`);
}

/** Where a request for `pathname` + `search` (the raw query including "?" or "") should go once the queue lives at `newBase`; null when it is not a waitlist path. */
export function redirectForLegacyWaitlistPath(pathname: string, search: string, newBase: string): string | null {
  assertInternalBase(newBase);
  if (typeof pathname !== "string" || typeof search !== "string") return null;
  if (search !== "" && !search.startsWith("?")) return null;
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const hit = LEGACY_WAITLIST_ROUTES.find(({ source }) => source === p);
  return hit ? newBase + hit.destination.slice(WAITLIST_PATH.length) + search : null;
}
