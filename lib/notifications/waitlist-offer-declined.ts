// HON-7. The bell row for an invitee who declined the offered times. The ROW is written by the decline command in the database (atomic with
// the decline, dedupe_key 'waitlist-decline:<invitation_id>'); this module only holds the wording and the link so the UI and the command's
// tests agree on them. Whether the title carries the person's name is Sam's call (D-RET): change TITLE_WITH_NAME here and nowhere else.
export const WAITLIST_OFFER_DECLINED_EVENT = "waitlist_offer_declined" as const;
export const WAITLIST_OFFER_DECLINED_HREF = "/settings/waitlist#follow-up";
export const WAITLIST_OFFER_DECLINED_TITLE_WITH_NAME = (name: string): string => `${name} couldn't make the offered times.`;
export const WAITLIST_OFFER_DECLINED_TITLE_NO_NAME = "An invitee couldn't make the offered times.";
export const WAITLIST_OFFER_DECLINED_TITLE = WAITLIST_OFFER_DECLINED_TITLE_WITH_NAME;
