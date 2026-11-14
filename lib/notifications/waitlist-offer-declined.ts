// HON-7. The bell row for an invitee who declined the offered times. The ROW is written by the decline command in the database (atomic with
// the decline, dedupe_key 'waitlist-decline:<invitation_id>'); this module only holds the wording and the link so the UI and the command's
// tests agree on them. Sam's decision: the bell is as generic as the owner email. The title names no one and the body is empty, so nothing about
// the person reaches the bell, a screenshot or a log. There is deliberately no name variant: add one and the pinned test fails.
export const WAITLIST_OFFER_DECLINED_EVENT = "waitlist_offer_declined" as const;
export const WAITLIST_OFFER_DECLINED_HREF = "/settings/waitlist#follow-up";
export const WAITLIST_OFFER_DECLINED_TITLE = "A waitlist response needs your attention";
export const WAITLIST_OFFER_DECLINED_BODY = "";
