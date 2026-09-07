import { describe, expect, it } from "vitest";
import { localDateString, localDayOfWeek } from "@/lib/booking/tz";
import {
  evaluateInvitationScope,
  type InvitationScope,
} from "@/lib/booking/waitlist-invitation-scope";

// WAIT-03B B2. This module is the ONLY enforcement of the requested-slot half of
// a scoped invitation. No accepted B1/B1.5c command evaluates a service, a date
// or a weekday against a requested appointment -- `redeem_..._verified` takes a
// token and a capability and never learns which slot was chosen. So every case
// below is load-bearing: a hole here is a hole in the product, not in a
// convenience helper.

const TZ = "America/Toronto";

function scope(over: Partial<InvitationScope> = {}): InvitationScope {
  return {
    serviceId: "svc-1",
    startDate: "2026-09-07",
    endDate: "2026-09-20",
    allowedWeekdays: null,
    ...over,
  };
}

function evaluate(args: {
  scope?: Partial<InvitationScope>;
  serviceId?: string;
  startsAt: string;
  tz?: string;
}) {
  return evaluateInvitationScope({
    scope: scope(args.scope),
    requestedServiceId: args.serviceId ?? "svc-1",
    requestedStartsAt: new Date(args.startsAt),
    studioTimezone: args.tz ?? TZ,
    localDateString,
    localDayOfWeek,
  });
}

describe("scoped invitation — service binding", () => {
  it("admits the offered service", () => {
    expect(evaluate({ startsAt: "2026-09-10T14:00:00Z" }).ok).toBe(true);
  });

  it("refuses a different service, even inside the date window", () => {
    const d = evaluate({ serviceId: "svc-2", startsAt: "2026-09-10T14:00:00Z" });
    expect(d).toEqual({ ok: false, reason: "service_not_in_scope" });
  });
});

describe("scoped invitation — date window is inclusive on both ends", () => {
  it("admits the first day", () => {
    // 13:00Z is 09:00 in Toronto, so the local date is unambiguously the 7th.
    expect(evaluate({ startsAt: "2026-09-07T13:00:00Z" }).ok).toBe(true);
  });

  it("admits the last day", () => {
    expect(evaluate({ startsAt: "2026-09-20T13:00:00Z" }).ok).toBe(true);
  });

  it("refuses the day before", () => {
    expect(evaluate({ startsAt: "2026-09-06T13:00:00Z" })).toEqual({
      ok: false,
      reason: "date_before_scope",
    });
  });

  it("refuses the day after", () => {
    expect(evaluate({ startsAt: "2026-09-21T13:00:00Z" })).toEqual({
      ok: false,
      reason: "date_after_scope",
    });
  });
});

describe("scoped invitation — weekday restriction", () => {
  // 2026-09-14 is a Monday; extract(dow) Monday = 1.
  it("admits an allowed weekday", () => {
    const d = evaluate({
      scope: { allowedWeekdays: [1] },
      startsAt: "2026-09-14T13:00:00Z",
    });
    expect(d).toEqual({ ok: true, localDate: "2026-09-14", weekday: 1 });
  });

  it("refuses a weekday outside the offer", () => {
    // 2026-09-15 is a Tuesday.
    expect(
      evaluate({ scope: { allowedWeekdays: [1] }, startsAt: "2026-09-15T13:00:00Z" }),
    ).toEqual({ ok: false, reason: "weekday_not_in_scope" });
  });

  it("treats NULL weekdays as every day inside the range", () => {
    for (const day of ["2026-09-07", "2026-09-12", "2026-09-20"]) {
      expect(evaluate({ startsAt: `${day}T13:00:00Z` }).ok).toBe(true);
    }
  });

  // FAILS CLOSED. B1's CHECK requires 1..7 entries when the column is non-null,
  // so an empty array cannot arise through the supported path -- but if one ever
  // did, "no days listed" must never be read as "every day".
  it("refuses an empty weekday array rather than reading it as unrestricted", () => {
    expect(
      evaluate({ scope: { allowedWeekdays: [] }, startsAt: "2026-09-14T13:00:00Z" }),
    ).toEqual({ ok: false, reason: "unreadable_scope" });
  });

  it("refuses an out-of-range weekday value", () => {
    expect(
      evaluate({ scope: { allowedWeekdays: [7] }, startsAt: "2026-09-14T13:00:00Z" }),
    ).toEqual({ ok: false, reason: "unreadable_scope" });
  });
});

describe("scoped invitation — the studio timezone is authoritative, not UTC", () => {
  // THE CASE THIS EXISTS FOR: 2026-09-14T01:30:00Z is Monday in UTC and in
  // Berlin, but still SUNDAY 21:30 in Toronto. An offer for Mondays only must
  // refuse it for a Toronto studio and admit it for a Berlin one. Evaluating in
  // UTC would silently admit a Sunday booking for every studio west of it.
  const instant = "2026-09-14T01:30:00Z";

  it("refuses a Monday-only offer for a Toronto studio when it is still Sunday there", () => {
    expect(
      evaluate({ scope: { allowedWeekdays: [1] }, startsAt: instant, tz: "America/Toronto" }),
    ).toEqual({ ok: false, reason: "weekday_not_in_scope" });
  });

  it("admits the same instant for a Berlin studio, where it is Monday", () => {
    expect(
      evaluate({ scope: { allowedWeekdays: [1] }, startsAt: instant, tz: "Europe/Berlin" }),
    ).toEqual({ ok: true, localDate: "2026-09-14", weekday: 1 });
  });

  it("shifts the date boundary too, not just the weekday", () => {
    // Same instant, a window that ENDS on the 13th: live in Toronto (still the
    // 13th there), over in Berlin (already the 14th).
    const s = { startDate: "2026-09-01", endDate: "2026-09-13" };
    expect(evaluate({ scope: s, startsAt: instant, tz: "America/Toronto" }).ok).toBe(true);
    expect(evaluate({ scope: s, startsAt: instant, tz: "Europe/Berlin" })).toEqual({
      ok: false,
      reason: "date_after_scope",
    });
  });
});

describe("scoped invitation — an unreadable offer never defaults to permissive", () => {
  it.each([
    ["missing service", { serviceId: "" }],
    ["malformed start date", { startDate: "2026-9-7" }],
    ["malformed end date", { endDate: "not-a-date" }],
    ["inverted window", { startDate: "2026-09-20", endDate: "2026-09-07" }],
  ])("refuses: %s", (_label, over) => {
    expect(
      evaluate({ scope: over as Partial<InvitationScope>, startsAt: "2026-09-10T14:00:00Z" }),
    ).toEqual({ ok: false, reason: "unreadable_scope" });
  });

  it("refuses an unparseable requested instant", () => {
    expect(
      evaluateInvitationScope({
        scope: scope(),
        requestedServiceId: "svc-1",
        requestedStartsAt: new Date("not a date"),
        studioTimezone: TZ,
        localDateString,
        localDayOfWeek,
      }),
    ).toEqual({ ok: false, reason: "unreadable_scope" });
  });

  it("refuses an empty studio timezone rather than guessing one", () => {
    expect(evaluate({ startsAt: "2026-09-10T14:00:00Z", tz: "" })).toEqual({
      ok: false,
      reason: "unreadable_scope",
    });
  });
});
