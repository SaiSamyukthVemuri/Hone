// Canonical addresses for the owner workspace, used by navigation, actions and notifications.
export const LEGACY_WAITLIST_PATH = "/settings/waitlist";
export const WAITLIST_PATH = "/waitlist";
export const WAITLIST_SEARCH_PATH = `${WAITLIST_PATH}/search`;
export const WAITLIST_REPLIES_PATH = `${WAITLIST_PATH}/replies`;
export const WAITLIST_ARCHIVED_PATH = `${WAITLIST_PATH}/archived`;
export const WAITLIST_RELEASED_PATH = `${WAITLIST_PATH}/released`;
export const WAITLIST_OVER_INVITE_PATH = `${WAITLIST_PATH}/over-invite`;

export const LEGACY_WAITLIST_ROUTES = [
  WAITLIST_PATH, WAITLIST_SEARCH_PATH, WAITLIST_REPLIES_PATH,
  WAITLIST_ARCHIVED_PATH, WAITLIST_RELEASED_PATH, WAITLIST_OVER_INVITE_PATH,
].map((destination) => ({
  source: LEGACY_WAITLIST_PATH + destination.slice(WAITLIST_PATH.length),
  destination,
}));
