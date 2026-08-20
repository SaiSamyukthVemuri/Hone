import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eligibleSessionsForAppointment } from "@/lib/dashboard/before-today-previews";
import { buildTodayWorkflow, type TodayWorkflowInput } from "@/lib/dashboard/today-workflow";

// #605 REPAIR — history is bounded by the APPOINTMENT.
//
// The defect these pin: once the Dashboard could show any day, the briefing
// asked "what is this client's newest session, full stop", and the first
// attempt at fixing that simply refused to load history off Today — which
// turned "we did not look" into "there is nothing", so a returning client
// booked TOMORROW rendered as "New client · No charted history yet".

const A_SESSION = (over: Partial<{ id: string; started_at: string; appointment_id: string | null }> = {}) => ({
  id: "s1",
  started_at: "2026-08-01T14:00:00Z",
  appointment_id: null as string | null,
  ...over,
});

describe("1. TOMORROW — a returning client keeps their history", () => {
  it("a session before tomorrow's appointment IS eligible", () => {
    const priorSession = A_SESSION({ id: "prior", started_at: "2026-08-01T14:00:00Z" });
    const eligible = eligibleSessionsForAppointment([priorSession], {
      appointmentId: "appt-tomorrow",
      clientId: "c1",
      before: "2026-08-21T13:00:00Z",
    });
    // The whole point: tomorrow is not a reason to forget last week.
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe("prior");
  });
});

describe("2. TOMORROW — a genuinely new client is still new", () => {
  it("no prior session means no eligible session", () => {
    const eligible = eligibleSessionsForAppointment([], {
      appointmentId: "appt-tomorrow",
      clientId: "c1",
      before: "2026-08-21T13:00:00Z",
    });
    expect(eligible).toHaveLength(0);
  });
});

describe("3. PAST appointment — a LATER session must not leak backwards", () => {
  it("a session recorded AFTER the appointment is not its history", () => {
    // Appointment A: 2026-08-10 10:00. Session: 2026-08-12.
    const later = A_SESSION({ id: "later", started_at: "2026-08-12T15:00:00Z" });
    const earlier = A_SESSION({ id: "earlier", started_at: "2026-08-03T15:00:00Z" });
    const eligible = eligibleSessionsForAppointment([later, earlier], {
      appointmentId: "appt-a",
      clientId: "c1",
      before: "2026-08-10T14:00:00Z",
    });
    expect(eligible.map((s) => s.id)).toEqual(["earlier"]);
    // Viewing Aug 10 must NOT present Aug 12 as preparation for it. That
    // reading would also contradict the per-appointment memory beside it,
    // which does bound itself.
    expect(eligible.map((s) => s.id)).not.toContain("later");
  });
});

describe("4. SAME CLIENT, TWO APPOINTMENTS IN ONE DAY — why the key is the appointment", () => {
  // Appointment A 09:00 · session 11:00 · appointment B 15:00.
  const between = A_SESSION({ id: "between", started_at: "2026-08-20T15:00:00Z" }); // 11:00 local
  const apptA = { appointmentId: "A", clientId: "c1", before: "2026-08-20T13:00:00Z" };
  const apptB = { appointmentId: "B", clientId: "c1", before: "2026-08-20T19:00:00Z" };

  it("A does NOT see the session recorded after it", () => {
    expect(eligibleSessionsForAppointment([between], apptA)).toHaveLength(0);
  });

  it("B DOES see it", () => {
    expect(eligibleSessionsForAppointment([between], apptB).map((s) => s.id)).toEqual([
      "between",
    ]);
  });

  it("so ONE answer per client is provably insufficient", () => {
    // Same client, same day, same session set — two different truths. A map
    // keyed by client id cannot hold both, which is exactly why the loader
    // keys by appointment id.
    const a = eligibleSessionsForAppointment([between], apptA);
    const b = eligibleSessionsForAppointment([between], apptB);
    expect(a.length).not.toBe(b.length);
  });

  it("an appointment never counts its OWN session as its history", () => {
    // The session started FOR appointment B, a minute early. Without the
    // appointment_id check it would read as preparation for itself.
    const ownSession = A_SESSION({
      id: "own",
      started_at: "2026-08-20T18:59:00Z",
      appointment_id: "B",
    });
    expect(eligibleSessionsForAppointment([ownSession], apptB)).toHaveLength(0);
    // …and it is still legitimate history for a LATER appointment.
    expect(
      eligibleSessionsForAppointment([ownSession], {
        appointmentId: "C",
        clientId: "c1",
        before: "2026-08-27T13:00:00Z",
      }),
    ).toHaveLength(1);
  });

  it("the boundary is STRICT: a session at the exact appointment instant is not history", () => {
    const exact = A_SESSION({ id: "exact", started_at: "2026-08-20T13:00:00Z" });
    expect(eligibleSessionsForAppointment([exact], apptA)).toHaveLength(0);
  });
});

describe("5. NO N+1 — the per-appointment work is in memory", () => {
  const SRC = readFileSync(
    join(process.cwd(), "lib/dashboard/before-today-previews.ts"),
    "utf8",
  );
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const loaderBody = code.slice(code.indexOf("export async function getBeforeAppointmentPreviews("));

  it("the per-appointment loop issues no query", () => {
    const loop = loaderBody.slice(loaderBody.indexOf("for (const request of requests)"));
    expect(loop).not.toMatch(/await|supabase|\.from\(/);
  });

  it("the query count is fixed, not per appointment", () => {
    // sessions, session_blocks, clients, session_block_areas — four tables,
    // each read exactly once for the WHOLE roster.
    const tables = [...loaderBody.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]);
    expect(tables.sort()).toEqual([
      "clients",
      "session_blocks",
      "session_block_areas",
      "sessions",
    ].sort());
  });

  it("the sessions read is bounded by the WIDEST cutoff the roster needs", () => {
    // Without `.lt`, the 400-row budget would be spent on sessions no
    // appointment on this roster can use.
    expect(loaderBody).toMatch(/\.lt\("started_at", maxBefore\)/);
    expect(loaderBody).toMatch(/\.eq\("studio_id", studioId\)/);
  });
});

describe("UNAVAILABLE never becomes ABSENT", () => {
  const input = (over: Partial<TodayWorkflowInput> = {}): TodayWorkflowInput => ({
    appointmentId: "a1",
    clientId: "c1",
    clientName: "Someone",
    timeLabel: "9:00 AM",
    status: "confirmed",
    serviceName: null,
    hasHistory: false,
    nextVisitNote: null,
    cautionNote: null,
    setupLine: null,
    reminders: [],
    intake: "reviewed",
    charting: "none",
    ...over,
  });

  it("historyKnown defaults to true, so every existing caller is unchanged", () => {
    const [item] = buildTodayWorkflow([input()]).items;
    expect(item.historyKnown).toBe(true);
    expect(item.hasHistory).toBe(false);
    // A proven absence still earns the new-client priority.
    expect(item.priority).toBe(5);
  });

  it("a FAILED read is not a new client", () => {
    const [item] = buildTodayWorkflow([input({ historyKnown: false })]).items;
    expect(item.historyKnown).toBe(false);
    // It must not claim history either way.
    expect(item.hasHistory).toBe(false);
    // And it must NOT be ranked as a new client — that is a claim about the
    // person, reachable only from a read that answered.
    expect(item.priority).not.toBe(5);
  });

  it("an unavailable read never asserts history it did not establish", () => {
    const [item] = buildTodayWorkflow([
      input({ historyKnown: false, hasHistory: true, setupLine: "27.12 MHz" }),
    ]).items;
    expect(item.hasHistory).toBe(false);
    expect(item.setup).toBeNull();
  });
});

describe("the Dashboard renders the three history states distinctly", () => {
  const PAGE = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );

  it("unavailable is checked BEFORE the new-client branch", () => {
    // Comment-stripped: the page documents this very defect in prose above the
    // code, so a raw indexOf would compare against the explanation.
    const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const unavailable = code.indexOf("!workflow.historyKnown");
    const newClient = code.indexOf("New client · No charted history yet");
    expect(unavailable).toBeGreaterThan(-1);
    expect(newClient).toBeGreaterThan(-1);
    expect(unavailable).toBeLessThan(newClient);
  });

  it("the unavailable branch says so, neutrally", () => {
    expect(PAGE).toMatch(/History unavailable/);
  });

  it("the page passes the load's own outcome, not a coerced boolean", () => {
    expect(PAGE).toMatch(/historyKnown: beforeLoad\.ok/);
  });
});
