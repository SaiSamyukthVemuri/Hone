import { describe, expect, it } from "vitest";
import { attributeVisit, type VisitSession } from "@/lib/sessions/visit-attribution";

// HON-59 (no schema). One client visit (appointment) can hold several
// practitioners' charts, one session each, because a session already carries
// its practitioner and its blocks inherit that author. This attributes each
// practitioner's own recorded time and keeps elapsed distinct from summed.
// It infers no billable total, no unit and no charge.

const VISIT = "appt-1";
const t = (hhmm: string) => `2026-11-02T${hhmm}:00.000Z`;
const block = (minutes: number | null, s?: string, e?: string, deleted = false) => ({
  minutes_performed: minutes,
  started_at: s ? t(s) : null,
  ended_at: e ? t(e) : null,
  deleted_at: deleted ? t("23:00") : null,
});
const session = (practitionerId: string, blocks: VisitSession["blocks"], appointmentId: string | null = VISIT): VisitSession =>
  ({ id: `s-${practitionerId}`, practitionerId, appointmentId, blocks });

describe("attributeVisit", () => {
  it("unequal contributions stay with their author and are not averaged", () => {
    const r = attributeVisit(VISIT, [
      session("A", [block(40, "10:00", "10:40")]),
      session("B", [block(15, "10:40", "10:55")]),
    ]);
    expect(r.practitioners.map((p) => [p.practitionerId, p.recordedMinutes])).toEqual([["A", 40], ["B", 15]]);
    expect(r.summedMinutes).toBe(55);
  });

  it("sequential work: summed equals recorded span; concurrency not shown", () => {
    const r = attributeVisit(VISIT, [
      session("A", [block(40, "10:00", "10:40")]),
      session("B", [block(15, "10:40", "10:55")]),
    ]);
    expect(r.recordedSpanMinutes).toBe(55);
    expect(r.concurrentRecorded).toBe(false);
  });

  it("overlapping practitioners: summed exceeds the recorded span and is flagged concurrent", () => {
    const r = attributeVisit(VISIT, [
      session("A", [block(30, "10:00", "10:30")]),
      session("B", [block(30, "10:15", "10:45")]),
    ]);
    expect(r.summedMinutes).toBe(60);
    expect(r.recordedSpanMinutes).toBe(45);
    expect(r.concurrentRecorded).toBe(true);
  });

  it("a different appointment's chart, or an unlinked one, is refused, not folded in", () => {
    const r = attributeVisit(VISIT, [
      session("A", [block(20)]),
      session("B", [block(99)], "appt-2"),
      session("C", [block(77)], null),
    ]);
    expect(r.practitioners.map((p) => p.practitionerId)).toEqual(["A"]);
    expect(r.summedMinutes).toBe(20);
    expect(r.excludedSessionCount).toBe(2);
  });

  it("removed blocks are ignored; missing minutes are unknown, never zero", () => {
    const r = attributeVisit(VISIT, [
      session("A", [block(25), block(50, undefined, undefined, true)]),
      session("B", [block(null)]),
    ]);
    expect(r.practitioners.find((p) => p.practitionerId === "A")!.recordedMinutes).toBe(25);
    expect(r.practitioners.find((p) => p.practitionerId === "B")!.recordedMinutes).toBeNull();
    expect(r.summedMinutes).toBe(25);
    expect(r.hasUnknown).toBe(true);
  });

  it("two sessions by one practitioner are one contribution", () => {
    const r = attributeVisit(VISIT, [
      { ...session("A", [block(10)]), id: "s1" },
      { ...session("A", [block(5)]), id: "s2" },
    ]);
    expect(r.practitioners).toHaveLength(1);
    expect(r.practitioners[0].recordedMinutes).toBe(15);
  });

  it("no span is claimed without recorded start and end times", () => {
    const r = attributeVisit(VISIT, [session("A", [block(30)]), session("B", [block(30)])]);
    expect(r.recordedSpanMinutes).toBeNull();
    expect(r.concurrentRecorded).toBe(false);
  });

  it("emits no billing field", () => {
    const r = attributeVisit(VISIT, [session("A", [block(30)])]);
    expect(Object.keys(r).join(",")).not.toMatch(/bill|unit|charge|price|amount/i);
  });

  // Codex P2 4408020900: a partly recorded contribution is a floor, not a total.
  it("one session with a recorded and an unrecorded block keeps the unknown indicator", () => {
    const r = attributeVisit(VISIT, [session("A", [block(20), block(null)])]);
    expect(r.practitioners[0].recordedMinutes).toBe(20);
    expect(r.practitioners[0].incomplete).toBe(true);
    expect(r.summedMinutes).toBe(20);
    expect(r.hasUnknown).toBe(true);
  });

  it("merging a practitioner's known and unknown sessions keeps the unknown indicator", () => {
    const r = attributeVisit(VISIT, [
      { id: "s1", practitionerId: "A", appointmentId: VISIT, blocks: [block(30)] },
      { id: "s2", practitionerId: "A", appointmentId: VISIT, blocks: [block(null)] },
    ]);
    expect(r.practitioners).toHaveLength(1);
    expect(r.practitioners[0].recordedMinutes).toBe(30);
    expect(r.practitioners[0].incomplete).toBe(true);
    expect(r.hasUnknown).toBe(true);
  });

  it("a fully recorded contribution is not incomplete, and deleted blocks do not count", () => {
    const r = attributeVisit(VISIT, [session("A", [block(20), block(null, undefined, undefined, true)])]);
    expect(r.practitioners[0].incomplete).toBe(false);
    expect(r.hasUnknown).toBe(false);
  });
});
