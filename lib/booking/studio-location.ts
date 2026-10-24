// HON-50. Where the studio's address is shown, and the arrival/parking
// instructions that go with it. ONE place decides both, so the public booking
// page and the appointment emails cannot disagree about an owner's choice.
//
//   studios.address_visibility   'booking_page' | 'emails' | 'both'
//   studios.arrival_instructions text, NULL = no section
//
// Both columns are optional at the type level: a row loaded with `select *`
// before the migration is applied carries neither. An absent or unknown
// visibility reads as 'both', which is exactly the behaviour before the column
// existed (booking page AND emails), and absent instructions render nothing.
// A blank address is shown nowhere, whatever the visibility says.
//
// The public booking page renders forPublicBookingPage(row), never the raw
// row: an 'emails'-only address must never reach the page's HTML or the props
// it hands to a client component (the RSC payload). Proved by
// tests/app/book/address-visibility-leak.test.ts.

import type { Studio } from "@/lib/types/database";

export const ADDRESS_VISIBILITY_VALUES = ["booking_page", "emails", "both"] as const;
export type AddressVisibility = (typeof ADDRESS_VISIBILITY_VALUES)[number];

// Matches the draft migration's CHECK (studios_arrival_instructions_check).
export const ARRIVAL_INSTRUCTIONS_MAX_LENGTH = 1000;

type LocationFields = Pick<Studio, "address"> &
  Partial<Pick<Studio, "address_visibility" | "arrival_instructions">>;

export function isAddressVisibility(value: unknown): value is AddressVisibility {
  return (
    typeof value === "string" &&
    (ADDRESS_VISIBILITY_VALUES as readonly string[]).includes(value)
  );
}

export function addressVisibilityOf(studio: LocationFields): AddressVisibility {
  return isAddressVisibility(studio.address_visibility)
    ? studio.address_visibility
    : "both";
}

// The stored value exactly as today's surfaces render it (no trimming, so a
// non-blank address is byte-identical to before); only a blank or
// whitespace-only value becomes null.
function nonBlankAddress(studio: LocationFields): string | null {
  return typeof studio.address === "string" && studio.address.trim() !== ""
    ? studio.address
    : null;
}

/** The address the PUBLIC booking page may show, or null. */
export function publicBookingAddress(studio: LocationFields): string | null {
  return addressVisibilityOf(studio) === "emails" ? null : nonBlankAddress(studio);
}

/**
 * The address a client's appointment email (and its calendar invite) may
 * show, or null.
 */
export function appointmentEmailAddress(studio: LocationFields): string | null {
  return addressVisibilityOf(studio) === "booking_page" ? null : nonBlankAddress(studio);
}

/** Arrival/parking instructions for appointment emails, or null for none. */
export function arrivalInstructionsOf(studio: LocationFields): string | null {
  const raw = studio.arrival_instructions;
  return typeof raw === "string" ? raw.trim() || null : null;
}

/**
 * The studio row as the PUBLIC booking page may see it: the address replaced
 * by publicBookingAddress() and the email-only arrival instructions removed.
 * Every other field is unchanged.
 */
export function forPublicBookingPage<T extends LocationFields>(studio: T): T {
  return { ...studio, address: publicBookingAddress(studio), arrival_instructions: null };
}

/**
 * The studio row as a client APPOINTMENT EMAIL may see it (body and calendar
 * invite): the address replaced by appointmentEmailAddress(). Every other
 * field, including the arrival instructions, is unchanged.
 */
export function forAppointmentEmail<T extends LocationFields>(studio: T): T {
  return { ...studio, address: appointmentEmailAddress(studio) };
}
