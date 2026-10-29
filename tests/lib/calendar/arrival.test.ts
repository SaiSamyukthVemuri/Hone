import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canOfferCheckIn, checkInOutcomeFor, isCheckedIn } from "@/lib/calendar/arrival";

// HON-48 check-in (0268), app side. Synthetic data only.

describe("isCheckedIn / canOfferCheckIn", () => {
  it("only a confirmed appointment with an arrival time is checked in", () => {
    expect(isCheckedIn({ status: "confirmed", arrived_at: "2031-03-04T15:05:00Z" })).toBe(true);
    expect(isCheckedIn({ status: "confirmed", arrived_at: null })).toBe(false);
    expect(isCheckedIn({ status: "confirmed" })).toBe(false); // column absent before 0268
    expect(isCheckedIn({ status: "cancelled", arrived_at: "2031-03-04T15:05:00Z" })).toBe(false);
    expect(isCheckedIn({ status: "no_show", arrived_at: "2031-03-04T15:05:00Z" })).toBe(false);
  });
  it("the action is offered on a confirmed appointment only", () => {
    expect(canOfferCheckIn({ status: "confirmed" })).toBe(true);
    for (const s of ["completed", "cancelled", "no_show"]) expect(canOfferCheckIn({ status: s })).toBe(false);
  });
});

describe("checkInOutcomeFor", () => {
  it("arrived, cleared and unchanged are successes", () => {
    expect(checkInOutcomeFor(true, "arrived", null)).toEqual({ ok: true, changed: true });
    expect(checkInOutcomeFor(false, "cleared", null)).toEqual({ ok: true, changed: true });
    expect(checkInOutcomeFor(true, "unchanged", null)).toEqual({ ok: true, changed: false });
  });
  it("a refusal is its own message, never success", () => {
    expect(checkInOutcomeFor(true, "not_authorized", null)).toEqual({ ok: false, error: "You can't check clients in." });
    expect(checkInOutcomeFor(true, "not_found", null).ok).toBe(false);
    expect(checkInOutcomeFor(true, "wrong_status", null).ok).toBe(false);
  });
  it("a database that has not applied 0268 yet is 'not available', not a crash and not success", () => {
    for (const error of [
      { code: "42883", message: "function public.set_appointment_arrived(uuid, uuid, boolean) does not exist" },
      { code: "PGRST202", message: "Could not find the function public.set_appointment_arrived in the schema cache" },
    ]) {
      expect(checkInOutcomeFor(true, null, error)).toEqual({ ok: false, error: "Check-in isn't available yet." });
    }
  });
  it("any other error, or an answer nobody expects, is a generic retry message", () => {
    expect(checkInOutcomeFor(true, null, { code: "08006", message: "connection" })).toEqual({ ok: false, error: "Could not update check-in. Please try again." });
    expect(checkInOutcomeFor(true, "surprise", null).ok).toBe(false);
    expect(checkInOutcomeFor(true, undefined, null).ok).toBe(false);
  });
});

describe("wiring", () => {
  const ACTIONS = readFileSync("app/(app)/calendar/actions.ts", "utf8");
  const BODY = ACTIONS.slice(ACTIONS.indexOf("export async function setAppointmentArrivedAction"));
  const END = BODY.indexOf("function formDataStr");
  const ACTION = BODY.slice(0, END);
  it("the action uses the user's own session and passes no actor", () => {
    expect(ACTION).toMatch(/await createClient\(\)/);
    expect(ACTION).not.toMatch(/createAdminClient|practitioner\.id|p_practitioner|p_actor/);
    expect(ACTION).toMatch(/rpc\("set_appointment_arrived"/);
  });
  it("the card and the drawer show the tag with a glyph and words", () => {
    const DAY = readFileSync("app/(app)/calendar/DayColumn.tsx", "utf8");
    const DRAWER = readFileSync("app/(app)/calendar/AppointmentPreviewDrawer.tsx", "utf8");
    expect(DAY).toMatch(/isCheckedIn\(a\) \? `\$\{ARRIVED_GLYPH\} \$\{ARRIVED_TAG\}` : null/);
    expect(DRAWER).toMatch(/isCheckedIn\(a\) &&/);
    expect(DRAWER).toMatch(/canOfferCheckIn\(a\) &&/);
  });
});
