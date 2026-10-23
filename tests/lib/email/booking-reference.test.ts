import { describe, expect, it } from "vitest";
import { emailBookingReference } from "@/lib/email/booking-reference";

// Codex P1 4354990813 on #1049: the per-booking subject label. It must keep
// distinct bookings apart, stay identical across renders of one booking, and
// carry nothing recoverable about the booking.

const A = "6f1c2a4e-9b3d-4c8e-a1f2-3b4c5d6e7f80";
const B = "0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";

describe("emailBookingReference", () => {
  it("is 6 characters of an unambiguous alphabet", () => {
    expect(emailBookingReference(A)).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
  });
  it("is stable for one booking", () => {
    expect(emailBookingReference(A)).toBe(emailBookingReference(A));
  });
  it("differs between bookings", () => {
    expect(emailBookingReference(A)).not.toBe(emailBookingReference(B));
  });
  it("contains no part of the appointment id", () => {
    const ref = emailBookingReference(A).toLowerCase();
    for (const part of A.split("-")) expect(part).not.toContain(ref);
    expect(A.replace(/-/g, "")).not.toContain(ref);
  });
});
