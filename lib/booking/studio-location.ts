// HON-50. Where the studio's address is shown. ONE place decides it, so the
// public booking page and the appointment emails cannot disagree.
//
//   studios.address_visibility   'booking_page' | 'emails' | 'both'
//
// THE COLUMN DOES NOT EXIST YET. Its migration is drafted and waits for a
// number (willow/HON-50-SCHEMA-DRAFT.sql). Until it is applied every row reads
// as 'both', which is exactly today's behaviour: the booking page AND the
// appointment emails show the address. This module is the leak-safe routing
// that the column will plug into, so turning the setting on later changes no
// render path. A blank or whitespace-only address is shown nowhere.
//
// The public booking page renders forPublicBookingPage(row), never the raw
// row; the client appointment emails render forAppointmentEmail(row). Proved
// by tests/app/book/address-visibility-leak.test.ts and
// tests/lib/email/address-visibility-routing.test.ts.

export const ADDRESS_VISIBILITY_VALUES = ["booking_page", "emails", "both"] as const;
export type AddressVisibility = (typeof ADDRESS_VISIBILITY_VALUES)[number];

// Structural on purpose: the Studio type gains `address_visibility` (and the
// arrival-instructions field) only in the PR that adds the columns, because the
// curated db-types check refuses an app type column the database lacks.
type LocationFields = {
  address: string | null;
  address_visibility?: unknown;
  arrival_instructions?: unknown;
};

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

/**
 * The studio row as the PUBLIC booking page may see it: the address replaced
 * by publicBookingAddress(), and any email-only arrival instructions removed.
 * Every other field is unchanged.
 */
export function forPublicBookingPage<T extends LocationFields>(studio: T): T {
  const view: T = { ...studio, address: publicBookingAddress(studio) };
  if ("arrival_instructions" in view) view.arrival_instructions = null;
  return view;
}

/**
 * The studio row as a client APPOINTMENT EMAIL may see it (body and calendar
 * invite): the address replaced by appointmentEmailAddress(). Every other
 * field is unchanged.
 */
export function forAppointmentEmail<T extends LocationFields>(studio: T): T {
  return { ...studio, address: appointmentEmailAddress(studio) };
}
