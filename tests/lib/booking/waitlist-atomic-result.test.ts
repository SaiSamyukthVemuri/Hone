import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  NESTED_APPOINTMENT_PREFIX,
  WAITLIST_BOOKING_RESULTS,
  normalizeWaitlistBookingResult,
} from "@/lib/booking/waitlist-atomic-result";

// ===========================================================================
// The 0195 result vocabulary, re-derived from the migration itself
// ===========================================================================
//
// THE GUARD THIS FILE EXISTS TO BE. A result added to 0195 without being added
// to the union would otherwise fall through the mapper as "unrecognised" — safe,
// but silent, and the binding would quietly stop explaining a refusal it could
// have explained. Reading the SQL is what makes the union falsifiable.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0195_waitlist_atomic_booking_conversion.sql"),
  "utf8",
);

/** Every literal the command returns directly, taken from the function body. */
function declaredResults(): string[] {
  const body = SQL.slice(
    SQL.indexOf("create or replace function public.create_waitlist_public_appointment"),
  );
  return [...new Set([...body.matchAll(/return query select '([a-z_]+)'/g)].map((m) => m[1]))];
}

describe("the 0195 vocabulary this binding claims to cover", () => {
  it("covers EXACTLY the results the migration declares", () => {
    const declared = declaredResults().sort();
    // Non-vacuity: a parse that found nothing would make the comparison trivial.
    expect(declared.length).toBeGreaterThan(5);
    expect(declared).toContain("created_and_converted");
    expect([...WAITLIST_BOOKING_RESULTS].sort()).toEqual(declared);
  });

  it("knows the prefixed forms the WA002 handler re-emits", () => {
    // 0195 rolls back and returns SQLERRM, which carries `appointment:<code>`,
    // `conversion:<code>` or the inconsistency sentinel.
    expect(SQL).toContain("appointment:%");
    expect(SQL).toContain("conversion:%");
    expect(SQL).toContain("inconsistent:appointment_without_id");
    expect(SQL).toContain("WA002");
  });
});

describe("translating a 0195 result", () => {
  it("treats ONLY created_and_converted as a booking", () => {
    expect(normalizeWaitlistBookingResult("created_and_converted")).toEqual({ kind: "created" });
    // `created` is the NESTED command's word. Reaching the caller unprefixed
    // would mean 0195 answered something it cannot answer.
    expect(normalizeWaitlistBookingResult("created").kind).toBe("unrecognised");
  });

  it("unwraps a nested booking refusal so ordinary semantics still apply", () => {
    for (const code of ["time_unavailable", "outside_availability", "not_a_public_slot"]) {
      expect(normalizeWaitlistBookingResult(`${NESTED_APPOINTMENT_PREFIX}${code}`)).toEqual({
        kind: "booking_refusal",
        code,
      });
    }
  });

  it("keeps every invitation refusal distinct and never a success", () => {
    for (const code of WAITLIST_BOOKING_RESULTS) {
      if (code === "created_and_converted") continue;
      const out = normalizeWaitlistBookingResult(code);
      expect(out, `${code}`).toEqual({ kind: "invitation_refusal", code });
      expect(out.kind).not.toBe("created");
    }
  });

  it("fails closed on conversion failures, inconsistency and the unknown", () => {
    for (const code of [
      "conversion:not_redeemed",
      "conversion:client_not_found",
      "inconsistent:appointment_without_id",
      "newly_invented_refusal",
      "",
      "CREATED_AND_CONVERTED",
    ]) {
      const out = normalizeWaitlistBookingResult(code);
      expect(out.kind, `${JSON.stringify(code)} must not book`).toBe("unrecognised");
    }
    expect(normalizeWaitlistBookingResult(null)).toEqual({
      kind: "unrecognised",
      code: "no_result",
    });
  });

  it("has no branch that turns an unknown result into a booking", () => {
    // Exhaustive over a generated space rather than a chosen one.
    for (let i = 0; i < 200; i += 1) {
      const junk = `r${i}_${"x".repeat(i % 7)}`;
      expect(normalizeWaitlistBookingResult(junk).kind).toBe("unrecognised");
    }
  });
});
