import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { matchSlot, type MatchCandidate, type OpenedSlot } from "@/lib/waitlist/slot-match";

const SAT: OpenedSlot = { practitionerId: "p1", startsAt: "2026-11-28T15:00:00Z", durationMinutes: 60, timeZone: "America/Toronto" }; // Saturday 10:00 there
const TUE: OpenedSlot = { ...SAT, startsAt: "2026-11-24T15:00:00Z" };
const c = (entryId: string, o: Partial<MatchCandidate> = {}): MatchCandidate => ({ entryId, joinedAt: "2026-10-01T00:00:00Z", dayPreference: null, practitionerId: null, minimumMinutes: null, ...o });
const ids = (r: ReturnType<typeof matchSlot>) => (r.ok ? r.eligible.map((x) => x.entryId) : []);
const why = (r: ReturnType<typeof matchSlot>) => (r.ok ? Object.fromEntries(r.excluded.map((x) => [x.entryId, x.reason])) : {});

describe("matchSlot", () => {
  it("a named practitioner is a requirement; any matches every practitioner", () => {
    const r = matchSlot(SAT, [c("any"), c("mine", { practitionerId: "p1" }), c("other", { practitionerId: "p2" })]);
    expect(ids(r).sort()).toEqual(["any", "mine"]);
    expect(why(r)).toEqual({ other: "other_practitioner" });
  });
  it("the slot must be at least as long as the person's minimum; exactly as long is enough", () => {
    const r = matchSlot(SAT, [c("equal", { minimumMinutes: 60 }), c("longer", { minimumMinutes: 90 }), c("none")]);
    expect(ids(r).sort()).toEqual(["equal", "none"]);
    expect(why(r)).toEqual({ longer: "slot_too_short" });
  });
  it("day preference is read in the STUDIO's zone, not UTC", () => {
    const lateSunday: OpenedSlot = { ...SAT, startsAt: "2026-11-30T03:00:00Z" }; // Monday in UTC, Sunday 22:00 in Toronto
    expect(ids(matchSlot(lateSunday, [c("wd", { dayPreference: "weekdays" }), c("we", { dayPreference: "weekends" })]))).toEqual(["we"]);
    expect(ids(matchSlot(TUE, [c("wd", { dayPreference: "weekdays" }), c("we", { dayPreference: "weekends" }), c("both", { dayPreference: "both" })])).sort()).toEqual(["both", "wd"]);
    expect(why(matchSlot(TUE, [c("we", { dayPreference: "weekends" })]))).toEqual({ we: "day_not_preferred" });
  });
  it("the weekday changes at the STUDIO's midnight, exactly: one second either side (winter, then across the autumn clock change)", () => {
    const at = (iso: string, pref: "weekdays" | "weekends") => ids(matchSlot({ ...SAT, startsAt: iso }, [c("x", { dayPreference: pref })])).length === 1;
    // Friday 23:59:59 and Saturday 00:00:00 in Toronto (UTC-5 on 27/28 November).
    expect(at("2026-11-28T04:59:59Z", "weekdays")).toBe(true);
    expect(at("2026-11-28T05:00:00Z", "weekends")).toBe(true);
    expect(at("2026-11-28T05:00:00Z", "weekdays")).toBe(false);
    // The clocks went back on 1 November: Sunday 23:59:59 and Monday 00:00:00 are 05:00 UTC apart from the summer offset, so a fixed -4 would be wrong.
    expect(at("2026-11-03T04:59:59Z", "weekdays")).toBe(true); // Monday 23:59:59 stays a weekday...
    expect(at("2026-11-02T04:59:59Z", "weekends")).toBe(true); // ...and Sunday 23:59:59 is still the weekend
    expect(at("2026-11-02T05:00:00Z", "weekdays")).toBe(true); // Monday 00:00:00
  });
  it("a start with no time of day is refused: it would be read as UTC midnight, the previous evening in the studio's zone", () => {
    expect(matchSlot({ ...SAT, startsAt: "2026-11-28" }, [c("a")])).toEqual({ ok: false, reason: "invalid_slot" });
  });
  it("orders by the original join date, ties by entry id, an unknown join date last, and never by input order", () => {
    const list = [c("c", { joinedAt: null }), c("b", { joinedAt: "2026-09-01T00:00:00Z" }), c("a", { joinedAt: "2026-09-01T00:00:00Z" }), c("z", { joinedAt: "2026-08-01T00:00:00Z" }), c("bad", { joinedAt: "not a date" })];
    const forward = ids(matchSlot(SAT, list));
    expect(forward).toEqual(["z", "a", "b", "bad", "c"]);
    expect(ids(matchSlot(SAT, [...list].reverse()))).toEqual(forward);
  });
  it("refuses an unusable slot instead of guessing", () => {
    for (const bad of [{ ...SAT, startsAt: "nope" }, { ...SAT, timeZone: "Not/AZone" }, { ...SAT, durationMinutes: 0 }, { ...SAT, durationMinutes: Number.NaN }, { ...SAT, practitionerId: "" }]) {
      expect(matchSlot(bad, [c("a")])).toEqual({ ok: false, reason: "invalid_slot" });
    }
  });
  it("every candidate is either eligible or excluded with one reason, and none is lost", () => {
    const list = [c("a"), c("b", { practitionerId: "p2" }), c("d", { minimumMinutes: 999 }), c("e", { dayPreference: "weekdays" })];
    const r = matchSlot(SAT, list);
    if (!r.ok) throw new Error("slot");
    expect(r.eligible.length + r.excluded.length).toBe(list.length);
    expect(why(r)).toEqual({ b: "other_practitioner", d: "slot_too_short", e: "day_not_preferred" });
  });
  it("stays a pure rule: no imports, no reads, no clock, wired to nothing", () => {
    const src = readFileSync("lib/waitlist/slot-match.ts", "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/Date\.now|new Date\(\)|supabase|fetch\(|process\.env|await /);
  });
});
