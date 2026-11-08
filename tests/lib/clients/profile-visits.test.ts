import { describe, expect, it } from "vitest";
import { pickLastVisit, pickNextAppointment } from "@/lib/clients/profile-visits";
import { pickLastTreatment } from "@/lib/sessions/clinical-summary";

const NOW = Date.parse("2026-10-31T15:00:00.000Z");
const s = (id: string, started_at: string, record_status: string | null = "final") => ({ id, started_at, record_status });
const a = (id: string, starts_at: string, status: string) => ({ id, starts_at, status });
const charted = (id: string, started_at: string) => ({ ...s(id, started_at), electrolysis_entries: [{}], laser_entries: [] });
const uncharted = (id: string, started_at: string) => ({ ...s(id, started_at, "draft"), electrolysis_entries: [], laser_entries: [] });

describe("Last visit: the later of the newest non-void past session and newest completed past appointment", () => {
  it("is the completed appointment when it is later than every session", () => {
    expect(pickLastVisit({ sessions: [s("s1", "2026-10-10T14:00:00Z")], appointments: [a("a1", "2026-10-25T14:00:00Z", "completed")], nowMs: NOW }))
      .toEqual({ kind: "appointment", id: "a1", at: "2026-10-25T14:00:00Z" });
  });
  it("is the session when it is later, even when uncharted (draft)", () => {
    expect(pickLastVisit({ sessions: [s("s1", "2026-10-20T14:00:00Z", "draft")], appointments: [a("a1", "2026-10-10T14:00:00Z", "completed")], nowMs: NOW }))
      .toEqual({ kind: "session", id: "s1", at: "2026-10-20T14:00:00Z" });
  });
  it("on an exact tie the session wins (same visit; it opens the chart)", () => {
    expect(pickLastVisit({ sessions: [s("s1", "2026-10-25T14:00:00Z")], appointments: [a("a1", "2026-10-25T14:00:00Z", "completed")], nowMs: NOW })?.kind).toBe("session");
  });
  it("never counts a void session, a future session, or a non-completed appointment", () => {
    expect(pickLastVisit({
      sessions: [s("void", "2026-10-29T14:00:00Z", "void"), s("future", "2026-11-02T14:00:00Z")],
      appointments: [a("c", "2026-10-28T14:00:00Z", "cancelled"), a("n", "2026-10-27T14:00:00Z", "no_show"), a("f", "2026-11-03T14:00:00Z", "confirmed"), a("fc", "2026-11-04T14:00:00Z", "completed")],
      nowMs: NOW,
    })).toBeNull();
  });
  it("ignores unparseable dates and is null with no history", () => {
    expect(pickLastVisit({ sessions: [s("bad", "garbage")], appointments: [a("bad", "", "completed")], nowMs: NOW })).toBeNull();
    expect(pickLastVisit({ sessions: [], appointments: [], nowMs: NOW })).toBeNull();
  });
  it("is judged against the instant, so an appointment an hour from now is not a visit", () => {
    expect(pickLastVisit({ sessions: [], appointments: [a("soon", "2026-10-31T16:00:00Z", "completed")], nowMs: NOW })).toBeNull();
    expect(pickLastVisit({ sessions: [], appointments: [a("just", "2026-10-31T14:59:00Z", "completed")], nowMs: NOW })?.id).toBe("just");
  });
});

describe("Next appointment: the nearest future CONFIRMED one", () => {
  it("picks the earliest future confirmed appointment", () => {
    expect(pickNextAppointment({ appointments: [a("late", "2026-12-01T14:00:00Z", "confirmed"), a("soon", "2026-11-03T14:00:00Z", "confirmed")], nowMs: NOW })).toEqual({ id: "soon", at: "2026-11-03T14:00:00Z" });
  });
  it("skips past, cancelled, no-show and completed ones", () => {
    expect(pickNextAppointment({ appointments: [a("p", "2026-10-30T14:00:00Z", "confirmed"), a("c", "2026-11-03T14:00:00Z", "cancelled"), a("n", "2026-11-04T14:00:00Z", "no_show"), a("d", "2026-11-05T14:00:00Z", "completed")], nowMs: NOW })).toBeNull();
  });
});

describe("the three values stay distinct (Sam's trap)", () => {
  const sessions = [charted("charted-old", "2026-10-10T14:00:00Z"), uncharted("uncharted-newer", "2026-10-20T14:00:00Z"), { ...uncharted("void-newest", "2026-10-29T14:00:00Z"), record_status: "void" }];
  const appointments = [a("done", "2026-10-25T14:00:00Z", "completed"), a("future", "2026-11-03T14:00:00Z", "confirmed"), a("cancelled", "2026-10-28T14:00:00Z", "cancelled")];
  it("Last visit, Last charted treatment and Next appointment are three different records", () => {
    const lastVisit = pickLastVisit({ sessions, appointments, nowMs: NOW });
    const lastCharted = pickLastTreatment(sessions, new Map());
    const next = pickNextAppointment({ appointments, nowMs: NOW });
    expect(lastVisit).toMatchObject({ kind: "appointment", id: "done" });
    expect(lastCharted?.id).toBe("charted-old");
    expect(next?.id).toBe("future");
  });
  it("an uncharted newer visit moves Last visit and leaves Last charted treatment alone", () => {
    const only = [charted("charted-old", "2026-10-10T14:00:00Z"), uncharted("newer", "2026-10-20T14:00:00Z")];
    expect(pickLastVisit({ sessions: only, appointments: [], nowMs: NOW })).toMatchObject({ kind: "session", id: "newer" });
    expect(pickLastTreatment(only, new Map())?.id).toBe("charted-old");
  });
});
