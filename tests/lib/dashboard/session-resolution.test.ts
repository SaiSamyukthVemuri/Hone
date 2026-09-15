import { describe, expect, it } from "vitest";
import {
  resolveChartAction,
  groupLiveSessionsByAppointment,
  type LinkedSession,
} from "@/lib/dashboard/session-resolution";

// ===========================================================================
// CHART-SESSION-01 / #699 — the zero / one / many chart decision
//
// Injected session sets only. No database, no Supabase, no runtime surface —
// the resolver is deliberately not wired into the dashboard yet, because
// `Start charting` must not become tappable before `start_session` is
// appointment-safe (finding 4008020858).
// ===========================================================================

const CLIENT = "client-1";
const APPT = "appt-A";
const OTHER = "appt-B";

function s(id: string, startedAt: string, modality = "electrolysis"): LinkedSession {
  return { id, startedAt, modality };
}

describe("ZERO live sessions — begin", () => {
  it("offers Start charting", () => {
    const r = resolveChartAction(CLIENT, APPT, []);
    expect(r.kind).toBe("none");
    expect(r.label).toBe("Start charting");
  });

  it("carries the appointment id so lineage is stamped on the new session", () => {
    const r = resolveChartAction(CLIENT, APPT, []);
    expect(r.href).toBe(`/clients/${CLIENT}/sessions/new?appointment_id=${APPT}`);
  });

  it("encodes an appointment id that would otherwise break the query string", () => {
    const r = resolveChartAction(CLIENT, "a&b=c", []);
    expect(r.href).toContain("appointment_id=a%26b%3Dc");
  });
});

describe("EXACTLY ONE live session — open it, by id", () => {
  it("offers Open chart", () => {
    const r = resolveChartAction(CLIENT, APPT, [s("sess-1", "2026-09-14T10:00:00Z")]);
    expect(r.kind).toBe("one");
    expect(r.label).toBe("Open chart");
  });

  it("navigates to THAT EXACT session, never back through sessions/new", () => {
    const r = resolveChartAction(CLIENT, APPT, [s("sess-1", "2026-09-14T10:00:00Z")]);
    expect(r.href).toBe(`/clients/${CLIENT}/sessions/sess-1`);
    // The load-bearing negative: an existing chart is OPENED, not re-derived
    // through the coalesce window.
    expect(r.href).not.toContain("sessions/new");
    expect(r.href).not.toContain("appointment_id");
  });

  it("exposes the id so the caller cannot have to re-guess it", () => {
    const r = resolveChartAction(CLIENT, APPT, [s("sess-1", "2026-09-14T10:00:00Z")]);
    expect(r.kind === "one" && r.sessionId).toBe("sess-1");
  });
});

describe("MORE THAN ONE live session — refuse to choose", () => {
  const two = [
    s("sess-old", "2026-09-14T09:00:00Z"),
    s("sess-new", "2026-09-14T11:00:00Z"),
  ];

  it("offers View charts, not a silently-picked chart", () => {
    const r = resolveChartAction(CLIENT, APPT, two);
    expect(r.kind).toBe("many");
    expect(r.label).toBe("View charts");
  });

  it("NEVER resolves to a single session href", () => {
    const r = resolveChartAction(CLIENT, APPT, two);
    // The defect this replaces: last-row-wins handed back one arbitrary id.
    expect(r.href).not.toBe(`/clients/${CLIENT}/sessions/sess-new`);
    expect(r.href).not.toBe(`/clients/${CLIENT}/sessions/sess-old`);
  });

  it("hands back EVERY session identity, losing none", () => {
    const r = resolveChartAction(CLIENT, APPT, two);
    expect(r.kind === "many" && r.sessions.map((x) => x.id)).toEqual([
      "sess-new",
      "sess-old",
    ]);
  });

  it("lists newest first", () => {
    const r = resolveChartAction(CLIENT, APPT, [
      s("a", "2026-09-14T08:00:00Z"),
      s("c", "2026-09-14T12:00:00Z"),
      s("b", "2026-09-14T10:00:00Z"),
    ]);
    expect(r.kind === "many" && r.sessions.map((x) => x.id)).toEqual(["c", "b", "a"]);
  });

  it("breaks an EXACT started_at tie by id, so the order cannot reshuffle", () => {
    // Two starts inside one transaction-clock tick share a timestamp. Without
    // the id tiebreak the comparator may return either order and "the newest
    // chart" stops being a stable claim between renders.
    const tie = "2026-09-14T10:00:00Z";
    const forward = resolveChartAction(CLIENT, APPT, [s("aaa", tie), s("bbb", tie)]);
    const reversed = resolveChartAction(CLIENT, APPT, [s("bbb", tie), s("aaa", tie)]);
    expect(forward.kind === "many" && forward.sessions.map((x) => x.id)).toEqual([
      "bbb",
      "aaa",
    ]);
    expect(reversed.kind === "many" && reversed.sessions.map((x) => x.id)).toEqual([
      "bbb",
      "aaa",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const input = [s("a", "2026-09-14T08:00:00Z"), s("b", "2026-09-14T12:00:00Z")];
    const snapshot = input.map((x) => x.id);
    resolveChartAction(CLIENT, APPT, input);
    expect(input.map((x) => x.id)).toEqual(snapshot);
  });

  it("treats multi-modality on one appointment as legitimate, not an error", () => {
    // 0068 cardinality: electrolysis + laser on one appointment is ordinary.
    const r = resolveChartAction(CLIENT, APPT, [
      s("elec", "2026-09-14T10:00:00Z", "electrolysis"),
      s("laser", "2026-09-14T11:00:00Z", "laser"),
    ]);
    expect(r.kind).toBe("many");
    expect(r.kind === "many" && r.sessions.map((x) => x.modality)).toEqual([
      "laser",
      "electrolysis",
    ]);
  });
});

describe("grouping replaces last-row-wins", () => {
  it("keeps EVERY session for an appointment instead of overwriting", () => {
    const g = groupLiveSessionsByAppointment([
      { ...s("s1", "2026-09-14T09:00:00Z"), appointmentId: APPT },
      { ...s("s2", "2026-09-14T10:00:00Z"), appointmentId: APPT },
      { ...s("s3", "2026-09-14T11:00:00Z"), appointmentId: APPT },
    ]);
    // The defect: `.set(appointment_id, …)` left exactly one of these.
    expect(g.get(APPT)?.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("never mixes one appointment's chart into another's", () => {
    const g = groupLiveSessionsByAppointment([
      { ...s("a1", "2026-09-14T09:00:00Z"), appointmentId: APPT },
      { ...s("b1", "2026-09-14T09:05:00Z"), appointmentId: OTHER },
    ]);
    expect(g.get(APPT)?.map((x) => x.id)).toEqual(["a1"]);
    expect(g.get(OTHER)?.map((x) => x.id)).toEqual(["b1"]);
  });

  it("DROPS unlinked sessions rather than inferring a link from proximity", () => {
    // Inferring a link from nearness is exactly finding 4008020858.
    const g = groupLiveSessionsByAppointment([
      { ...s("unlinked", "2026-09-14T09:00:00Z"), appointmentId: null },
      { ...s("linked", "2026-09-14T09:01:00Z"), appointmentId: APPT },
    ]);
    expect(g.get(APPT)?.map((x) => x.id)).toEqual(["linked"]);
    expect([...g.values()].flat().map((x) => x.id)).not.toContain("unlinked");
  });

  it("leaves an appointment with no sessions ABSENT, so zero stays distinguishable", () => {
    const g = groupLiveSessionsByAppointment([
      { ...s("a1", "2026-09-14T09:00:00Z"), appointmentId: APPT },
    ]);
    expect(g.has(OTHER)).toBe(false);
    // …and an absent appointment resolves to the begin branch.
    expect(resolveChartAction(CLIENT, OTHER, g.get(OTHER) ?? []).kind).toBe("none");
  });
});

describe("appointment status has NO say in which chart opens", () => {
  it("resolves identically whatever the appointment's lifecycle state", () => {
    // A completed appointment does not make its chart read-only: treatment
    // sessions stay editable operational records. Status is the appointment
    // lifecycle authority and is deliberately not an input here — this test
    // pins that by the resolver having no status parameter to vary.
    const one = [s("sess-1", "2026-09-14T10:00:00Z")];
    const r = resolveChartAction(CLIENT, APPT, one);
    expect(r.label).toBe("Open chart");
    expect(r.href).toBe(`/clients/${CLIENT}/sessions/sess-1`);
  });

  it("never emits a read-only or view-only label", () => {
    for (const set of [[], [s("x", "2026-09-14T10:00:00Z")], [
      s("x", "2026-09-14T10:00:00Z"),
      s("y", "2026-09-14T11:00:00Z"),
    ]]) {
      const label = resolveChartAction(CLIENT, APPT, set).label;
      expect(["Start charting", "Open chart", "View charts"]).toContain(label);
    }
  });
});
