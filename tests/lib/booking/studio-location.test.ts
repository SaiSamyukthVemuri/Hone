import { describe, expect, it } from "vitest";
import {
  ADDRESS_VISIBILITY_VALUES,
  addressVisibilityOf,
  appointmentEmailAddress,
  arrivalInstructionsOf,
  forAppointmentEmail,
  forPublicBookingPage,
  isAddressVisibility,
  publicBookingAddress,
} from "@/lib/booking/studio-location";

// HON-50 PR B. One place decides where studios.address is shown. All values
// are synthetic.

const ADDRESS = "100 Synthetic Avenue, Toronto ON";

describe("address visibility", () => {
  it("is the closed set booking_page | emails | both", () => {
    expect([...ADDRESS_VISIBILITY_VALUES]).toEqual(["booking_page", "emails", "both"]);
    expect(isAddressVisibility("both")).toBe(true);
    expect(isAddressVisibility("public")).toBe(false);
    expect(isAddressVisibility(undefined)).toBe(false);
  });

  it("an absent column (row loaded before the migration) or an unknown value reads as both, today's behaviour", () => {
    expect(addressVisibilityOf({ address: ADDRESS })).toBe("both");
    expect(
      addressVisibilityOf({ address: ADDRESS, address_visibility: "nonsense" as never }),
    ).toBe("both");
    expect(publicBookingAddress({ address: ADDRESS })).toBe(ADDRESS);
    expect(appointmentEmailAddress({ address: ADDRESS })).toBe(ADDRESS);
  });

  it.each([
    ["both", ADDRESS, ADDRESS],
    ["booking_page", ADDRESS, null],
    ["emails", null, ADDRESS],
  ] as const)("%s: booking page %s, emails %s", (visibility, page, email) => {
    const studio = { address: ADDRESS, address_visibility: visibility };
    expect(publicBookingAddress(studio)).toBe(page);
    expect(appointmentEmailAddress(studio)).toBe(email);
  });

  it.each([null, "", "   ", "\n\t "])(
    "a blank address (%j) is shown nowhere, whatever the visibility",
    (address) => {
      for (const v of ADDRESS_VISIBILITY_VALUES) {
        const studio = { address, address_visibility: v };
        expect(publicBookingAddress(studio)).toBeNull();
        expect(appointmentEmailAddress(studio)).toBeNull();
      }
    },
  );

  it("a non-blank address is returned exactly as stored (byte-identical to today's surfaces)", () => {
    const padded = "  100 Synthetic Avenue  ";
    expect(publicBookingAddress({ address: padded })).toBe(padded);
    expect(appointmentEmailAddress({ address: padded })).toBe(padded);
  });
});

describe("arrival instructions", () => {
  it("absent, null, empty or whitespace-only is no section", () => {
    expect(arrivalInstructionsOf({ address: null })).toBeNull();
    for (const v of [null, "", "   ", "\n \t"]) {
      expect(arrivalInstructionsOf({ address: null, arrival_instructions: v })).toBeNull();
    }
  });

  it("a value is trimmed and kept", () => {
    expect(
      arrivalInstructionsOf({ address: null, arrival_instructions: "  Park on the street.\n" }),
    ).toBe("Park on the street.");
  });

  it("does not depend on the address or its visibility", () => {
    expect(
      arrivalInstructionsOf({
        address: null,
        address_visibility: "booking_page",
        arrival_instructions: "Side door.",
      }),
    ).toBe("Side door.");
  });
});

describe("forPublicBookingPage", () => {
  it("replaces the address per visibility, drops arrival instructions, keeps every other field", () => {
    const row = {
      id: "s1",
      name: "Synthetic Studio",
      address: ADDRESS,
      address_visibility: "emails" as const,
      arrival_instructions: "Side door.",
    };
    expect(forPublicBookingPage(row)).toEqual({
      id: "s1",
      name: "Synthetic Studio",
      address: null,
      address_visibility: "emails",
      arrival_instructions: null,
    });
    expect(forPublicBookingPage({ ...row, address_visibility: "both" as const }).address).toBe(ADDRESS);
    expect(row.address).toBe(ADDRESS); // the input row is not mutated
  });
});

describe("forAppointmentEmail", () => {
  it("replaces the address per visibility and keeps arrival instructions and every other field", () => {
    const row = {
      id: "s1",
      address: ADDRESS,
      address_visibility: "booking_page" as const,
      arrival_instructions: "Side door.",
    };
    expect(forAppointmentEmail(row)).toEqual({ ...row, address: null });
    expect(forAppointmentEmail({ ...row, address_visibility: "emails" as const }).address).toBe(ADDRESS);
    expect(forAppointmentEmail({ id: "s1", address: ADDRESS }).address).toBe(ADDRESS);
    expect(row.address).toBe(ADDRESS);
  });
});
