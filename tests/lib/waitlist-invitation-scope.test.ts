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

// Codex P2. The window was validated by SHAPE only, so "2026-00-01" passed --
// and every comparison here is LEXICAL, so "2026-06-15" > "2026-00-01" held and
// an unreadable scope authorised an ordinary 2026 request. A fail-open in the
// one authority that decides whether a requested slot is inside the offer.
describe("scope dates must be real calendar dates, not merely YYYY-MM-DD shaped", () => {
  const MID_2026 = "2026-06-15T14:00:00Z";

  it.each([
    ["month 00", "2026-00-01"],
    ["month 13", "2026-13-01"],
    ["Feb 30", "2026-02-30"],
    ["Feb 29 in a common year", "2026-02-29"],
    ["April 31", "2026-04-31"],
    ["June 31", "2026-06-31"],
    ["Nov 31", "2026-11-31"],
    ["day 00", "2026-09-00"],
    ["day 32", "2026-01-32"],
  ])("an impossible START (%s) makes the scope unreadable", (_l, bad) => {
    expect(
      evaluate({ scope: { startDate: bad, endDate: "2026-12-31" }, startsAt: MID_2026 }),
    ).toEqual({ ok: false, reason: "unreadable_scope" });
  });

  it.each([
    ["month 00", "2026-00-31"],
    ["month 13", "2026-13-31"],
    ["Feb 30", "2026-02-30"],
    ["April 31", "2026-04-31"],
    ["day 32", "2026-01-32"],
  ])("an impossible END (%s) makes the scope unreadable", (_l, bad) => {
    expect(
      evaluate({ scope: { startDate: "2026-01-01", endDate: bad }, startsAt: MID_2026 }),
    ).toEqual({ ok: false, reason: "unreadable_scope" });
  });

  // The defect stated as the property it violated, in both directions.
  it("an impossible START cannot authorise a request that lexically sits after it", () => {
    const d = evaluate({
      scope: { startDate: "2026-00-01", endDate: "2026-12-31" },
      startsAt: MID_2026,
    });
    expect(d.ok, "an unreadable window must authorise nothing").toBe(false);
  });

  it("an impossible END cannot authorise a request that lexically sits before it", () => {
    const d = evaluate({
      scope: { startDate: "2026-01-01", endDate: "2026-13-31" },
      startsAt: MID_2026,
    });
    expect(d.ok).toBe(false);
  });

  it("a REAL leap day is still a valid window bound", () => {
    // 2028 is a leap year; Feb 29 exists and must be usable at either end.
    expect(
      evaluate({
        scope: { startDate: "2028-02-29", endDate: "2028-03-31" },
        startsAt: "2028-03-01T14:00:00Z",
      }).ok,
    ).toBe(true);
    expect(
      evaluate({
        scope: { startDate: "2028-02-01", endDate: "2028-02-29" },
        startsAt: "2028-02-15T14:00:00Z",
      }).ok,
    ).toBe(true);
  });

  it("the century leap rule is the full Gregorian one", () => {
    // 2000 is a leap year (divisible by 400); 1900 was not (divisible by 100).
    expect(
      evaluate({
        scope: { startDate: "2000-02-29", endDate: "2000-03-31" },
        startsAt: "2000-03-01T14:00:00Z",
      }).ok,
    ).toBe(true);
    expect(
      evaluate({
        scope: { startDate: "1900-02-29", endDate: "1900-03-31" },
        startsAt: "1900-03-01T14:00:00Z",
      }),
    ).toEqual({ ok: false, reason: "unreadable_scope" });
  });

  it("ordinary month lengths are respected at both ends", () => {
    for (const [d, ok] of [["2026-01-31", true], ["2026-04-30", true], ["2026-02-28", true]] as const) {
      expect(
        evaluate({ scope: { startDate: "2026-01-01", endDate: d }, startsAt: "2026-01-15T14:00:00Z" }).ok,
      ).toBe(ok);
    }
  });
});

// Codex P2-A. The calendar rules rejected impossible month/day combinations but
// still accepted year 0000 — a year that has never existed, since the Gregorian
// calendar runs 1 BC -> AD 1 and PostgreSQL's date type refuses it. Because
// every comparison here is lexical, "0000-01-01" sorted BEFORE every real date,
// so an impossible lower bound authorised everything after it.
describe("scope bounds must name a year that exists", () => {
  const MID_2026 = "2026-06-15T14:00:00Z";

  it("a year-zero START makes the scope unreadable", () => {
    expect(
      evaluate({ scope: { startDate: "0000-01-01", endDate: "2026-12-31" }, startsAt: MID_2026 }),
    ).toEqual({ ok: false, reason: "unreadable_scope" });
  });

  it("a year-zero END makes the scope unreadable", () => {
    expect(
      evaluate({ scope: { startDate: "0000-01-01", endDate: "0000-12-31" }, startsAt: MID_2026 }),
    ).toEqual({ ok: false, reason: "unreadable_scope" });
  });

  it("a year-zero START cannot authorise an ordinary requested slot", () => {
    expect(
      evaluate({ scope: { startDate: "0000-01-01", endDate: "2026-12-31" }, startsAt: MID_2026 }).ok,
    ).toBe(false);
  });

  it("a year-zero END cannot authorise an ordinary requested slot", () => {
    expect(
      evaluate({ scope: { startDate: "2026-01-01", endDate: "0000-12-31" }, startsAt: MID_2026 }).ok,
    ).toBe(false);
  });

  it("year 0001 is a real year: the window is READABLE, and refuses on range", () => {
    // "Readable" is the claim under test — the calendar validator accepts year 1
    // — so the refusal must be a RANGE refusal, never `unreadable_scope`.
    const out = evaluate({
      scope: { startDate: "0001-01-01", endDate: "0001-12-31" },
      startsAt: MID_2026,
    });
    expect(out).toEqual({ ok: false, reason: "date_after_scope" });

    // Deliberately NOT asserting that a year-1 INSTANT authorises. The shared
    // `localDateString` helper renders year 1 unpadded ("1-06-15"), so lexical
    // comparison against "0001-01-01" does not line up. That is a property of a
    // shared formatter at a year no invitation will ever carry, and it is not
    // what this fix is about — papering over it here would hide it.
  });
});
