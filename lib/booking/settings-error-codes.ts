import { BUFFER_PRESET_MINUTES } from "@/lib/booking/buffer-presets";
import { PUBLIC_BOOKING_HORIZON_MONTHS_VALUES } from "@/lib/booking/horizon";

// /settings/booking failure banner. The save actions redirect with a CODE
// (`?error=slug_taken`), never text, and the page maps a recognised code to one
// of these fixed sentences. Anything else (unknown, empty, encoded, oversized,
// repeated) shows the generic sentence. The page used to print the `error`
// query value verbatim, so a crafted link could put any words in the studio's
// own red banner (content spoofing). The wording of every sentence below is the
// wording the actions used before.

export const BOOKING_SETTINGS_ERROR_SENTENCES = {
  not_owner: "Only studio owners can change booking preferences.",
  buffer_invalid: `Buffer must be one of: ${BUFFER_PRESET_MINUTES.join(", ")} minutes.`,
  horizon_invalid: `Booking horizon must be one of: ${PUBLIC_BOOKING_HORIZON_MONTHS_VALUES.join(", ")} months.`,
  slug_invalid: "Slug must be lowercase letters, numbers, and dashes (1-64 chars).",
  slug_reserved: "That booking link is reserved. Please choose another.",
  duration_invalid: "Default duration must be between 5 and 480 minutes.",
  slug_taken: "That slug is already taken. Pick another.",
  timezone_conflict:
    "Changing the timezone would push a blockout into a conflict with an existing calendar item. Reschedule or remove the affected appointment or block first.",
  save_failed: "Could not save your booking settings.",
  admission_save_failed: "Could not save that just now. Please try again.",
  admission_not_owner: "Only the studio owner can change this.",
  admission_invalid_mode: "That is not a valid choice.",
  admission_cutover_required:
    "This studio hasn't completed its new-client admission setup yet. " +
    "Choose Waitlist once to complete it, then Open and Closed become " +
    "available.",
} as const;

export type BookingSettingsErrorCode = keyof typeof BOOKING_SETTINGS_ERROR_SENTENCES;

export const BOOKING_SETTINGS_GENERIC_ERROR = BOOKING_SETTINGS_ERROR_SENTENCES.save_failed;

/** A failure with a recognised code; the only thing the save actions put in the URL. */
export class BookingSettingsError extends Error {
  constructor(readonly code: BookingSettingsErrorCode) {
    super(code);
    this.name = "BookingSettingsError";
  }
}

/** The fixed sentence for whatever arrived in `?error=`, or the generic one. */
export function bookingSettingsErrorSentence(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^[a-z_]{1,40}$/.test(value)) return BOOKING_SETTINGS_GENERIC_ERROR;
  return Object.hasOwn(BOOKING_SETTINGS_ERROR_SENTENCES, value)
    ? BOOKING_SETTINGS_ERROR_SENTENCES[value as BookingSettingsErrorCode]
    : BOOKING_SETTINGS_GENERIC_ERROR;
}

/** The redirect for a failure: a code only. */
export function bookingSettingsErrorUrl(code: BookingSettingsErrorCode): string {
  return `/settings/booking?error=${code}`;
}
