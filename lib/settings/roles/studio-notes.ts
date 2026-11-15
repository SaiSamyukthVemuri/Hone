// Owner-only studio settings that sit beside the permission rows but are NOT permission keys (Sam, 3 Nov, batch 3). The wording is
// decided; the page shows it as given. Keep it in step with the catalog's FIXED_OWNER_ONLY notes (DN-18 erasure, DN-20 portal).

export type StudioLink = { href: string; label: string };

/** Booking-rules key (admit.booking_rules): the key covers windows and new-client rules only; the rest lives on other pages. */
export const BOOKING_RULES_SCOPE_TEXT =
  "This covers the booking window and the public new-client booking rules only. Everything else about booking is set elsewhere.";

export const BOOKING_RULES_LINKS: readonly StudioLink[] = [
  { href: "/settings/studio/details", label: "Studio details" },
  { href: "/settings/services", label: "Service settings" },
];

/** Keys that carry the booking-rules scope text and links. */
export const BOOKING_RULES_KEYS: readonly string[] = ["admit.booking_rules"];

export const ERASURE_NOTE = {
  title: "Permanent client erasure",
  body: "Recording a request deletes nothing; erasure is not available yet. Only you can record a request, and it is reviewed and confirmed before anything could happen.",
} as const;

export const PORTAL_OFF_CONFIRMATION = {
  title: "Turning the client portal off",
  intro: "Only you can turn the client portal on or off. Turning it off affects:",
  affected: [
    "Messaging clients in the portal",
    "Rebooking through the portal",
    "Saving a card through the portal",
    "Existing portal links and sessions, which stop working at once",
  ],
  continues: "Intake and consent forms continue to work. All records are kept.",
} as const;
