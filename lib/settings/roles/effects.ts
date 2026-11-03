// The SPECIFIC effect of each setting that "Affects future studio business" (Sam, batch 4 item 4), and the fixed-baseline wording for
// the client directory (item 3). Page copy, keyed by catalog key; a test requires a line for every key the catalog labels so. The
// wording was confirmed by OPS as a routine copy choice; it states only that the change applies from now on, never what happens to existing records.

// The Roles page grants ability, so every line starts "Whoever holds this can" (OPS, 3 Nov). Applied consistently.
export const FUTURE_EFFECTS: Record<string, string> = {
  "avail.manage_studio_hours": "Whoever holds this can change the studio's opening hours that clients can book within, from now on.",
  "price.service_list": "Whoever holds this can change the price shown for each service on new bookings, from now on.",
  "price.fee_amounts": "Whoever holds this can change the amount of the studio's fees, from now on.",
  "wlrules.invitation_rounds": "Whoever holds this can change how the waitlist invites clients in rounds, from now on.",
  "wlrules.policy_and_text": "Whoever holds this can change the waitlist rules and the wording clients see, from now on.",
  "admit.change_policy": "Whoever holds this can change whether the studio is open, on a waitlist or closed to new clients, from now on. The setting itself stays on its normal page.",
  "admit.booking_rules": "Whoever holds this can change the booking window and the new-client booking rules, from now on.",
};

export const BASELINE_NOTES: Record<string, string> = {
  "client.view_directory":
    "A fixed baseline, not a switch: active practitioners and receptionists in this studio see names and basic contact details. It grants no legal identity, clinical information, bulk export or access to another studio. A role without legal-name access sees the preferred name, otherwise \"Name on file\".",
};
