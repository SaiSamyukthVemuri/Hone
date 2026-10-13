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

// The default is gone: every call now states its studio zone.
const UTC = "UTC";
const CLIENT = "client-1";
const APPT = "appt-A";
const OTHER = "appt-B";

function s(id: string, startedAt: string, modality = "electrolysis"): LinkedSession {
  return { id, startedAt, modality };
}

describe("ZERO live sessions — begin", () => {
  it("offers Start charting", () => {
    const r = resolveChartAction(CLIENT, APPT, [], UTC);
    expect(r.kind).toBe("none");
    expect(r.label).toBe("Start charting");
  });

  it("carries the appointment id so lineage is stamped on the new session", () => {
    const r = resolveChartAction(CLIENT, APPT, [], UTC);
    expect(r.kind === "none" && r.href).toBe(
      `/clients/${CLIENT}/sessions/new?appointment_id=${APPT}`,
    );
  });

  it("encodes an appointment id that would otherwise break the query string", () => {
    const r = resolveChartAction(CLIENT, "a&b=c", [], UTC);
    expect(r.kind === "none" && r.href).toContain("appointment_id=a%26b%3Dc");
  });
});

describe("EXACTLY ONE live session — open it, by id", () => {
  it("offers Open chart", () => {
    const r = resolveChartAction(CLIENT, APPT, [s("sess-1", "2026-09-14T10:00:00Z")], UTC);
    expect(r.kind).toBe("one");
    expect(r.label).toBe("Open chart");
  });

  it("navigates to THAT EXACT session, never back through sessions/new", () => {
    const r = resolveChartAction(CLIENT, APPT, [s("sess-1", "2026-09-14T10:00:00Z")], UTC);
    if (r.kind !== "one") throw new Error(`expected one, got ${r.kind}`);
    expect(r.href).toBe(`/clients/${CLIENT}/sessions/sess-1`);
    // The load-bearing negative: an existing chart is OPENED, not re-derived
    // through the coalesce window.
    expect(r.href).not.toContain("sessions/new");
    expect(r.href).not.toContain("appointment_id");
  });

  it("exposes the id so the caller cannot have to re-guess it", () => {
    const r = resolveChartAction(CLIENT, APPT, [s("sess-1", "2026-09-14T10:00:00Z")], UTC);
    expect(r.kind === "one" && r.sessionId).toBe("sess-1");
  });
});

describe("MORE THAN ONE live session — refuse to choose", () => {
  const two = [
    s("sess-old", "2026-09-14T09:00:00Z"),
    s("sess-new", "2026-09-14T11:00:00Z"),
  ];

  it("offers View charts, not a silently-picked chart", () => {
    const r = resolveChartAction(CLIENT, APPT, two, UTC);
    expect(r.kind).toBe("many");
    expect(r.label).toBe("View charts");
  });

  it("carries NO navigation href — the chooser expands in place", () => {
    const r = resolveChartAction(CLIENT, APPT, two, UTC);
    // The defect this replaces: last-row-wins handed back one arbitrary id.
    // And there is deliberately no appointment-charts page to navigate to.
    expect(r).not.toHaveProperty("href");
  });

  it("introduces NO new appointment-charts route", () => {
    const r = resolveChartAction(CLIENT, APPT, two, UTC);
    expect(r.kind === "many" && r.choices.every((c) => !c.href.includes("/appointments/"))).toBe(true);
    expect(r.kind === "many" && r.choices.every((c) => !c.href.endsWith("/charts"))).toBe(true);
  });

  it("links every row to the EXISTING session route", () => {
    const r = resolveChartAction(CLIENT, APPT, two, UTC);
    expect(r.kind === "many" && r.choices.map((c) => c.href)).toEqual([
      `/clients/${CLIENT}/sessions/sess-new`,
      `/clients/${CLIENT}/sessions/sess-old`,
    ]);
  });

  it("hands back EVERY session identity, losing none", () => {
    const r = resolveChartAction(CLIENT, APPT, two, UTC);
    expect(r.kind === "many" && r.choices.map((x) => x.sessionId)).toEqual([
      "sess-new",
      "sess-old",
    ]);
  });

  it("lists newest first", () => {
    const r = resolveChartAction(CLIENT, APPT, [
      s("a", "2026-09-14T08:00:00Z"),
      s("c", "2026-09-14T12:00:00Z"),
      s("b", "2026-09-14T10:00:00Z"),
    ], UTC);
    expect(r.kind === "many" && r.choices.map((x) => x.sessionId)).toEqual(["c", "b", "a"]);
  });

  it("breaks an EXACT started_at tie by id, so the order cannot reshuffle", () => {
    // Two starts inside one transaction-clock tick share a timestamp. Without
    // the id tiebreak the comparator may return either order and "the newest
    // chart" stops being a stable claim between renders.
    const tie = "2026-09-14T10:00:00Z";
    const forward = resolveChartAction(CLIENT, APPT, [s("aaa", tie), s("bbb", tie)], UTC);
    const reversed = resolveChartAction(CLIENT, APPT, [s("bbb", tie), s("aaa", tie)], UTC);
    expect(forward.kind === "many" && forward.choices.map((x) => x.sessionId)).toEqual([
      "bbb",
      "aaa",
    ]);
    expect(reversed.kind === "many" && reversed.choices.map((x) => x.sessionId)).toEqual([
      "bbb",
      "aaa",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const input = [s("a", "2026-09-14T08:00:00Z"), s("b", "2026-09-14T12:00:00Z")];
    const snapshot = input.map((x) => x.id);
    resolveChartAction(CLIENT, APPT, input, UTC);
    expect(input.map((x) => x.id)).toEqual(snapshot);
  });

  it("treats multi-modality on one appointment as legitimate, not an error", () => {
    // 0068 cardinality: electrolysis + laser on one appointment is ordinary.
    const r = resolveChartAction(CLIENT, APPT, [
      s("elec", "2026-09-14T10:00:00Z", "electrolysis"),
      s("laser", "2026-09-14T11:00:00Z", "laser"),
    ], UTC);
    expect(r.kind).toBe("many");
    expect(r.kind === "many" && r.choices.map((x) => x.label)).toEqual([
      "Laser · 11:00 AM",
      "Electrolysis · 10:00 AM",
    ]);
  });
});

describe("chooser labels use existing facts only", () => {
  const TZ = "America/Toronto";

  it("reads <Modality> · <local started time> in the STUDIO's zone", () => {
    // 18:04Z is 2:04 PM in Toronto (EDT).
    const r = resolveChartAction(
      CLIENT,
      APPT,
      [s("s1", "2026-09-14T18:04:00Z", "electrolysis"), s("s2", "2026-09-14T18:18:00Z", "laser")],
      TZ,
    );
    expect(r.kind === "many" && r.choices.map((c) => c.label)).toEqual([
      "Laser · 2:18 PM",
      "Electrolysis · 2:04 PM",
    ]);
  });

  it("REQUIRES a zone — omitting it no longer silently means UTC", () => {
    // P2 4010764268. The contract promises studio-local labels; a default
    // satisfied that promise in name only, and "6:04 PM" against a 2:04 PM
    // appointment reads as data rather than as a bug. Omission is now a
    // compile error, which this asserts at the type level: the call below
    // does not compile without a fourth argument.
    // @ts-expect-error - timeZone is required, not defaulted
    resolveChartAction(CLIENT, APPT, [s("a", "2026-09-14T18:04:00Z")]);
  });

  it("uses the studio zone, not UTC, so the times match the day as it ran", () => {
    const utc = resolveChartAction(CLIENT, APPT, [
      s("a", "2026-09-14T18:04:00Z"),
      s("b", "2026-09-14T19:00:00Z"),
    ], UTC);
    const toronto = resolveChartAction(
      CLIENT,
      APPT,
      [s("a", "2026-09-14T18:04:00Z"), s("b", "2026-09-14T19:00:00Z")],
      TZ,
    );
    expect(utc.kind === "many" && utc.choices[1]!.label).toBe("Electrolysis · 6:04 PM");
    expect(toronto.kind === "many" && toronto.choices[1]!.label).toBe("Electrolysis · 2:04 PM");
  });

  it("falls back to UTC rather than throwing on an unusable zone", () => {
    const r = resolveChartAction(
      CLIENT,
      APPT,
      [s("a", "2026-09-14T18:04:00Z"), s("b", "2026-09-14T19:00:00Z")],
      "Not/AZone",
    );
    expect(r.kind === "many" && r.choices[1]!.label).toBe("Electrolysis · 6:04 PM");
  });

  it("ALLOWS identical visible labels rather than inventing a difference", () => {
    // Two electrolysis sessions in the same minute legitimately read the same.
    // Nothing is appended to the visible label to force them apart.
    const r = resolveChartAction(
      CLIENT,
      APPT,
      [s("aaa", "2026-09-14T18:04:00Z"), s("bbb", "2026-09-14T18:04:30Z")],
      TZ,
    );
    expect(r.kind === "many" && r.choices.map((c) => c.label)).toEqual([
      "Electrolysis · 2:04 PM",
      "Electrolysis · 2:04 PM",
    ]);
  });

  it("keeps links and order deterministic even when labels collide", () => {
    const tie = "2026-09-14T18:04:00Z";
    const a = resolveChartAction(CLIENT, APPT, [s("aaa", tie), s("bbb", tie)], TZ);
    const b = resolveChartAction(CLIENT, APPT, [s("bbb", tie), s("aaa", tie)], TZ);
    expect(a.kind === "many" && a.choices.map((c) => c.href)).toEqual([
      `/clients/${CLIENT}/sessions/bbb`,
      `/clients/${CLIENT}/sessions/aaa`,
    ]);
    expect(b.kind === "many" && b.choices.map((c) => c.href)).toEqual(
      a.kind === "many" ? a.choices.map((c) => c.href) : [],
    );
  });

  it("gives colliding labels DISTINCT accessible names, by position only", () => {
    const tie = "2026-09-14T18:04:00Z";
    const r = resolveChartAction(CLIENT, APPT, [s("aaa", tie), s("bbb", tie)], TZ);
    const names = r.kind === "many" ? r.choices.map((c) => c.accessibleName) : [];
    expect(names).toEqual([
      "Electrolysis · 2:04 PM — chart 1 of 2",
      "Electrolysis · 2:04 PM — chart 2 of 2",
    ]);
    // Unambiguous to a screen reader...
    expect(new Set(names).size).toBe(names.length);
    // ...without asserting anything clinical about either chart.
    for (const n of names) {
      expect(n).not.toMatch(/latest|newest|current|primary|main/i);
    }
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
    expect(resolveChartAction(CLIENT, OTHER, g.get(OTHER) ?? [], UTC).kind).toBe("none");
  });
});

describe("appointment status has NO say in which chart opens", () => {
  it("resolves identically whatever the appointment's lifecycle state", () => {
    // A completed appointment does not make its chart read-only: treatment
    // sessions stay editable operational records. Status is the appointment
    // lifecycle authority and is deliberately not an input here — this test
    // pins that by the resolver having no status parameter to vary.
    const one = [s("sess-1", "2026-09-14T10:00:00Z")];
    const r = resolveChartAction(CLIENT, APPT, one, UTC);
    if (r.kind !== "one") throw new Error(`expected one, got ${r.kind}`);
    expect(r.label).toBe("Open chart");
    expect(r.href).toBe(`/clients/${CLIENT}/sessions/sess-1`);
  });

  it("never emits a read-only or view-only label", () => {
    for (const set of [[], [s("x", "2026-09-14T10:00:00Z")], [
      s("x", "2026-09-14T10:00:00Z"),
      s("y", "2026-09-14T11:00:00Z"),
    ]]) {
      const label = resolveChartAction(CLIENT, APPT, set, UTC).label;
      expect(["Start charting", "Open chart", "View charts"]).toContain(label);
    }
  });
});
