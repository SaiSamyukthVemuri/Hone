import { describe, expect, it } from "vitest";
import { emailBookingReference } from "@/lib/email/booking-reference";
import { appointmentIdsForReference, normalizeAppointmentReference } from "@/lib/search/appointment-reference";

describe("normalizeAppointmentReference", () => {
  it.each([
    ["ABC234", "ABC234"], ["abc234", "ABC234"], ["  abc234\n", "ABC234"], ["#abc234", "ABC234"],
    ["Ref abc234", "ABC234"], ["REF: abc234", "ABC234"], ["reference #abc234", "ABC234"],
  ])("%j -> %j", (raw, want) => expect(normalizeAppointmentReference(raw)).toBe(want));
  it.each(["", "   ", "ABC23", "ABC2345", "ABC 234", "AB-234", "ABC10O", "ABCIL2", "Ada", null, undefined])("%j names no reference", (raw) =>
    expect(normalizeAppointmentReference(raw as string | null)).toBeNull());
  it("accepts every reference the email template can produce", () => {
    for (let i = 0; i < 500; i++) {
      const ref = emailBookingReference(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
      expect(normalizeAppointmentReference(ref)).toBe(ref);
    }
  });
});

describe("appointmentIdsForReference", () => {
  const ids = ["id-1", "id-2", "id-3"];
  it("returns exactly the ids whose email reference matches", () => {
    expect(appointmentIdsForReference(emailBookingReference("id-2"), ids)).toEqual(["id-2"]);
    expect(appointmentIdsForReference("ZZZZZZ", ids)).toEqual([]);
  });
  it("does not mutate its input", () => {
    const copy = [...ids];
    appointmentIdsForReference(emailBookingReference("id-1"), ids);
    expect(ids).toEqual(copy);
  });
});
