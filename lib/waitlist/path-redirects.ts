// A pure map from the operator waitlist's CURRENT paths to a new base path, for the day the queue moves. It is NOT wired to any route, middleware or
// link: nothing imports it yet except its tests. It exists so the redirect rules are written and proven before the move, not during it.
//
// Rules: only the queue page and its five sub-pages are mapped (exact match, one trailing slash tolerated); the query string is carried over untouched;
// any other path, a lookalike, or a path with extra segments maps to null (never a guess). The target base must be a single-slash internal path, or the
// function throws, so it cannot be turned into an open redirect. A #fragment is never sent to a server, so it is not handled here: the sign-in case is
// covered by the return-to table in lib/auth/return-to.ts.

import {
  WAITLIST_ARCHIVED_PATH,
  WAITLIST_OVER_INVITE_PATH,
  WAITLIST_PATH,
  WAITLIST_RELEASED_PATH,
  WAITLIST_REPLIES_PATH,
  WAITLIST_SEARCH_PATH,
} from "@/lib/waitlist/paths";

const SUBPATHS: ReadonlyArray<readonly [string, string]> = [
  [WAITLIST_SEARCH_PATH, "/search"],
  [WAITLIST_REPLIES_PATH, "/replies"],
  [WAITLIST_ARCHIVED_PATH, "/archived"],
  [WAITLIST_RELEASED_PATH, "/released"],
  [WAITLIST_OVER_INVITE_PATH, "/over-invite"],
];

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
  if (p === WAITLIST_PATH) return `${newBase}${search}`;
  const hit = SUBPATHS.find(([legacy]) => legacy === p);
  return hit ? `${newBase}${hit[1]}${search}` : null;
}
