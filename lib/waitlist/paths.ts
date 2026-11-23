// The one place the operator waitlist's URL paths are spelled.
//
// Every redirect target, revalidation, link, notification, email link and sign-in return target for the operator queue imports its path from here, so
// a later move of the queue changes this file (and the redirects) rather than some sixty scattered strings. The values are the CURRENT paths, unchanged:
// tests/lib/waitlist/waitlist-paths.test.ts pins each one and tests/source-guards/waitlist-path-literals.test.ts fails if a new spelling appears.
//
// Pure constants only, no imports: this file is read by client components, the edge middleware path and server code alike.

export const WAITLIST_PATH = "/settings/waitlist";
export const WAITLIST_SEARCH_PATH = `${WAITLIST_PATH}/search`;
export const WAITLIST_REPLIES_PATH = `${WAITLIST_PATH}/replies`;
export const WAITLIST_ARCHIVED_PATH = `${WAITLIST_PATH}/archived`;
export const WAITLIST_RELEASED_PATH = `${WAITLIST_PATH}/released`;
export const WAITLIST_OVER_INVITE_PATH = `${WAITLIST_PATH}/over-invite`;
