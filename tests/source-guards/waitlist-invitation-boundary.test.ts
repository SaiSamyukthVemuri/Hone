import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// WAIT-03 B3 — the recipient surface's boundary.
//
// The behavioural suite proves the screen renders no booking control on a dead
// end. This proves the SOURCE cannot mutate at all, which is the stronger
// statement: B1.5c exists because possession of the invitation URL must not be
// authority, and a presentation layer that could reach a server action would
// hand that authority straight back.
//
// It also pins the "no second availability engine" rule, which is a shape a
// behavioural test cannot see: a component that computed its own slots would
// pass every render assertion in this repository.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments explain the rules; they must never satisfy them. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const SCREEN = codeOnly(read("app/features/waitlist-invitation/InvitationScreen.tsx"));
const STATE = codeOnly(read("lib/waitlist/invitation-offer.ts"));

describe("the recipient surface cannot mutate", () => {
  it("declares no server action", () => {
    expect(SCREEN, "a server action was declared in the view").not.toContain("use server");
    expect(STATE).not.toContain("use server");
  });

  it("imports no action module", () => {
    for (const src of [SCREEN, STATE]) {
      expect(src).not.toMatch(/from\s+["'][^"']*actions["']/);
      expect(src).not.toMatch(/from\s+["'][^"']*\/actions[^"']*["']/);
    }
  });

  it("performs no network call of its own", () => {
    for (const src of [SCREEN, STATE]) {
      expect(src).not.toContain("fetch(");
      expect(src).not.toContain("XMLHttpRequest");
      expect(src).not.toContain("navigator.sendBeacon");
    }
  });

  it("never reaches a database client", () => {
    for (const src of [SCREEN, STATE]) {
      expect(src).not.toContain("supabase");
      expect(src).not.toContain("createClient");
    }
  });

  it("book and decline are CALLBACKS the container supplies", () => {
    // The only way this surface can cause an effect is one the eventual
    // B2-owned container hands it.
    expect(SCREEN).toContain("onBook: () => void");
    expect(SCREEN).toContain("onDecline: () => void");
  });
});

describe("there is no second availability engine", () => {
  it("slots arrive as data and are never computed", () => {
    for (const forbidden of [
      "day_of_week",
      "practitioner_availability",
      "studio_wide",
      "generateSlots",
      "buildSlots",
      "availability_exceptions",
    ]) {
      expect(SCREEN, `computed availability: ${forbidden}`).not.toContain(forbidden);
      expect(STATE, `computed availability: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("date arithmetic comes from the shared tz helpers, not a local copy", () => {
    expect(STATE).toContain('from "@/lib/booking/tz"');
    expect(STATE).toContain("localDateString");
    // NOTHING here builds a Date. The window walk uses tz.addDays and the
    // weekday comes from B2's contract, so there is no local date construction
    // left to drift.
    // Dates are constructed only to PARSE -- a slot instant for B2's evaluator,
    // and a YMD for its day label. What must not exist is window arithmetic:
    // no adding days, no comparing against the scope bounds by hand.
    expect(STATE).not.toContain("addDays");
    expect(STATE).not.toContain("setUTCDate");
    expect(STATE).not.toContain("getTime() +");
  });
});

// B2 IS NOW THE AUTHORITY, AND B3 CONSUMES IT.
//
// The pure slice injected a weekday contract because B2 was unfrozen. It is
// frozen now, so these assertions pin the stronger property: B3 reaches the
// window verdict through B2's OWN evaluator, and restates neither the
// numbering nor the null/empty rule. The pure slice had that rule INVERTED --
// it read an empty list as "every day" where B1 fails closed -- which is
// exactly the divergence a second implementation produces.
describe("the window rule is B2's, reached through B2's evaluator", () => {
  it("calls evaluateInvitationScope rather than re-deriving the rule", () => {
    expect(STATE).toContain('from "@/lib/booking/waitlist-invitation-scope"');
    expect(STATE).toContain("evaluateInvitationScope({");
  });

  it("carries no window comparison of its own", () => {
    // A local date/weekday comparison would be the second engine.
    expect(STATE).not.toContain("startDate <");
    expect(STATE).not.toContain("> scope.endDate");
    expect(STATE).not.toMatch(/allowedWeekdays\s*\.includes/);
  });

  it("computes no weekday from a date", () => {
    for (const forbidden of ["getUTCDay", "getDay(", "day_of_week", "dayOfWeek"]) {
      expect(STATE, `B3 computed a weekday: ${forbidden}`).not.toContain(forbidden);
      expect(SCREEN, `B3 computed a weekday: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("projects through the studio timezone, not naive UTC", () => {
    // A weekday read in UTC would refuse a Monday-evening slot east of UTC.
    expect(STATE).toContain("localDayOfWeek");
    expect(STATE).toContain("studioTimezone");
  });

  it("the SCREEN never sees a weekday index or a scope at all", () => {
    expect(SCREEN).toContain("windowDescription");
    expect(SCREEN).not.toContain("allowedWeekdays");
    expect(SCREEN).not.toContain("evaluateInvitationScope");
  });
});

describe("possession is not authority", () => {
  it("the slot list is gated on proven proof", () => {
    // The whole reason B1.5c exists. A forwarded link shows the offer's shape
    // and nothing bookable.
    expect(STATE).toContain('ctx.proof.kind !== "proven"');
    const gate = STATE.indexOf('ctx.proof.kind !== "proven"');
    const build = STATE.indexOf("filterSlotsToScope(scope", gate);
    expect(gate, "slots are built before proof is checked").toBeLessThan(build);
  });

  it("the raw contact never reaches the screen", () => {
    expect(SCREEN).not.toContain("deliveryContact");
    expect(SCREEN).toContain("maskedContact");
  });
});

describe("the recipient learns nothing about anyone else", () => {
  it("no queue, position or other-prospect vocabulary in the source", () => {
    for (const forbidden of [
      "queuePosition",
      "position_in_queue",
      "aheadOfYou",
      "otherProspects",
      "waitlistCount",
      "entryCount",
    ]) {
      expect(SCREEN, `leaked: ${forbidden}`).not.toContain(forbidden);
      expect(STATE, `leaked: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("a bad token and a malformed offer are indistinguishable to the recipient", () => {
    // Telling them apart would confirm to a bearer that a token exists.
    const slice = STATE.slice(STATE.indexOf('case "invalid_token"'));
    expect(slice).toContain('case "unscoped"');
    const between = slice.slice(0, slice.indexOf("return"));
    expect(between, "the two verdicts diverge before returning").not.toContain("if");
  });
});

describe("the offered window is narrowed on the way to the screen", () => {
  it("the view state filters slots rather than trusting them", () => {
    expect(STATE).toContain("filterSlotsToScope(scope, ctx.presentation.studioTimezone, ctx.slots)");
  });

  it("an unreadable instant fails closed rather than being admitted", () => {
    const fn = STATE.slice(
      STATE.indexOf("export function slotWithinScope"),
      STATE.indexOf("export function filterSlotsToScope"),
    );
    expect(fn.length).toBeGreaterThan(100);
    expect(fn).toContain("Number.isNaN(startsAt.getTime())");
    expect(fn).toContain("return false;");
  });
});
