import { describe, expect, it } from "vitest";
import {
  answersFor,
  declinedAtLabel,
  declinedCount,
  declinedPeople,
  declinedSummaryText,
  latestDeclinePerPerson,
  type DeclineRecords,
} from "@/lib/waitlist/decline-visibility";
import type { FollowUpList, FollowUpRow } from "@/lib/waitlist/followups-owner";

const row = (id: string, entry: string, at: string) => ({ id, entry_id: entry, declined_at: at });
const fu = (over: Partial<FollowUpRow>): FollowUpRow => ({
  followupId: "f1", kind: "decline", invitationId: "i1", entryId: "e1", clientName: "X", openedAt: "2026-08-01T00:00:00Z", status: "open",
  whyNotWork: "too early", betterTimes: "evenings", answersErasedAt: null, submittedAt: "2026-08-01T00:00:00Z", closedAt: null, eraseBy: null, ...over,
});
const ok = (rows: FollowUpRow[], capped?: true): FollowUpList => ({ kind: "ok", rows, ...(capped ? { capped } : {}) });

describe("latestDeclinePerPerson", () => {
  it("keeps one row per entry: the most recent decline, newest first", () => {
    const out = latestDeclinePerPerson([
      row("i1", "e-a", "2026-08-10T10:00:00Z"),
      row("i2", "e-a", "2026-08-21T10:00:00Z"),
      row("i3", "e-b", "2026-08-22T10:00:00Z"),
    ]);
    expect(out.map((r) => r.id)).toEqual(["i3", "i2"]);
  });
  it("drops a row without a readable id, entry or time, never guessing", () => {
    expect(latestDeclinePerPerson([{ id: 1, entry_id: "e", declined_at: "2026-08-10T10:00:00Z" }, { id: "i", entry_id: "e", declined_at: "nope" }, { id: "i", entry_id: "e", declined_at: null }, { id: "i" }])).toEqual([]);
  });
  it("breaks an exact tie deterministically", () => {
    const a = latestDeclinePerPerson([row("i1", "e", "2026-08-10T10:00:00Z"), row("i2", "e", "2026-08-10T10:00:00Z")]);
    const b = latestDeclinePerPerson([row("i2", "e", "2026-08-10T10:00:00Z"), row("i1", "e", "2026-08-10T10:00:00Z")]);
    expect(a).toEqual(b);
  });
});

describe("declinedCount", () => {
  it("counts people, and unknown is null, never 0", () => {
    const ok: DeclineRecords = { kind: "ok", rows: [row("i1", "e-a", "2026-08-10T10:00:00Z"), row("i2", "e-a", "2026-08-11T10:00:00Z"), row("i3", "e-b", "2026-08-12T10:00:00Z")] };
    expect(declinedCount(ok)).toBe(2);
    expect(declinedCount({ kind: "ok", rows: [] })).toBe(0);
    expect(declinedCount({ kind: "unknown" })).toBeNull();
  });
});

describe("declinedPeople", () => {
  it("joins names by entry id, never by name; a missing entry keeps the row with no name", () => {
    const rec: DeclineRecords = { kind: "ok", rows: [row("i1", "e-a", "2026-08-10T10:00:00Z"), row("i2", "e-b", "2026-08-11T10:00:00Z")] };
    const p = declinedPeople(rec, new Map([["e-a", { name: "Alex", status: "waiting" }]]));
    expect(p.find((x) => x.entryId === "e-a")).toMatchObject({ name: "Alex", entryStatus: "waiting", invitationId: "i1" });
    expect(p.find((x) => x.entryId === "e-b")).toMatchObject({ name: null, entryStatus: null });
    expect(declinedPeople({ kind: "unknown" }, null)).toEqual([]);
  });
});

describe("answersFor", () => {
  it("gate off is 'not collected', which is not 'none on record'", () => {
    expect(answersFor("i1", false, ok([fu({})]))).toEqual({ kind: "not_collected" });
  });
  it("an unreadable or absent follow-up read is unreadable, never 'none'", () => {
    expect(answersFor("i1", true, { kind: "unknown" })).toEqual({ kind: "unreadable" });
    expect(answersFor("i1", true, null)).toEqual({ kind: "unreadable" });
  });
  it("matches by INVITATION id and only a decline follow-up", () => {
    expect(answersFor("i1", true, ok([fu({})]))).toEqual({ kind: "answers", why: "too early", better: "evenings" });
    expect(answersFor("i2", true, ok([fu({})]))).toEqual({ kind: "none_on_record" });
    expect(answersFor("i1", true, ok([fu({ kind: "withdrawal" })]))).toEqual({ kind: "none_on_record" });
  });
  it("a CAPPED list with no match is 'may be missing', never 'none on record'; a match in a capped list still shows its answers", () => {
    expect(answersFor("i9", true, ok([fu({})], true))).toEqual({ kind: "may_be_missing" });
    expect(answersFor("i1", true, ok([fu({})], true))).toEqual({ kind: "answers", why: "too early", better: "evenings" });
    expect(answersFor("i9", true, ok([fu({})]))).toEqual({ kind: "none_on_record" });
  });
  it("the invitation-scoped read decides when the page list has no row: an erased closed follow-up is 'erased', never 'none'", () => {
    const erased = fu({ invitationId: "i9", status: "handled", whyNotWork: null, betterTimes: null, answersErasedAt: "2026-09-01T00:00:00Z", closedAt: "2026-08-25T00:00:00Z" });
    const scoped = new Map([["i9", ok([erased])]]);
    expect(answersFor("i9", true, ok([fu({})]), scoped)).toEqual({ kind: "erased", at: "2026-09-01T00:00:00Z" });
    expect(answersFor("i9", true, ok([fu({})], true), scoped)).toEqual({ kind: "erased", at: "2026-09-01T00:00:00Z" }); // a capped page list changes nothing
    expect(answersFor("i9", true, { kind: "unknown" }, scoped)).toEqual({ kind: "erased", at: "2026-09-01T00:00:00Z" }); // nor does an unreadable one
    expect(answersFor("i9", true, ok([]), new Map([["i9", ok([])]]))).toEqual({ kind: "none_on_record" }); // read fine, nothing there
    expect(answersFor("i9", true, ok([]), new Map([["i9", { kind: "unknown" } as FollowUpList]]))).toEqual({ kind: "unreadable" });
    expect(answersFor("i9", true, ok([]), new Map([["i9", ok([fu({ kind: "withdrawal", invitationId: "i9" })])]]))).toEqual({ kind: "none_on_record" });
    expect(answersFor("i9", false, ok([]), scoped)).toEqual({ kind: "not_collected" });
  });
  it("a row the page list DID return wins over a scoped read", () => {
    const scoped = new Map([["i1", ok([fu({ whyNotWork: "stale", answersErasedAt: "2026-09-01T00:00:00Z" })])]]);
    expect(answersFor("i1", true, ok([fu({})]), scoped)).toEqual({ kind: "answers", why: "too early", better: "evenings" });
  });
  it("an erased answer reads as erased; empty answers read as none", () => {
    expect(answersFor("i1", true, ok([fu({ answersErasedAt: "2026-09-01T00:00:00Z", whyNotWork: null, betterTimes: null })]))).toEqual({ kind: "erased", at: "2026-09-01T00:00:00Z" });
    expect(answersFor("i1", true, ok([fu({ whyNotWork: null, betterTimes: null })]))).toEqual({ kind: "none_on_record" });
  });
});

describe("labels", () => {
  it("formats the decline time in the studio's zone and falls back to UTC for a bad zone", () => {
    expect(declinedAtLabel("2026-08-21T10:00:00Z", "America/Toronto")).toBe("Aug 21, 2026, 6:00 AM EDT");
    expect(declinedAtLabel("2026-11-21T10:00:00Z", "America/Toronto")).toContain("EST");
    expect(declinedAtLabel("2026-08-21T10:00:00Z", "not/a-zone")).toContain("10:00 AM UTC");
    expect(declinedAtLabel("2026-08-21T10:00:00Z", null)).toContain("UTC");
  });
  it("the summary text is singular, plural, zero, and honest when unknown", () => {
    expect(declinedSummaryText(1)).toBe("1 person has declined.");
    expect(declinedSummaryText(2)).toBe("2 people have declined.");
    expect(declinedSummaryText(0)).toBe("0 people have declined.");
    expect(declinedSummaryText(null)).toContain("couldn’t count");
  });
});
