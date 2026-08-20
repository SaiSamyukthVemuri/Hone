import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  eligibleSessionsForAppointment,
  historyStatesFromBatch,
  isBatchTruncated,
  previewSessionBudget,
  type BlockRow,
  type SessionRow,
} from "@/lib/dashboard/before-today-previews";
import { buildTodayWorkflow, type TodayWorkflowInput } from "@/lib/dashboard/today-workflow";
import {
  shouldOfferHistoryReview,
  shouldShowTreatmentMemory,
} from "@/lib/dashboard/before-today-previews";

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
  const loaderBody = code.slice(code.indexOf("export async function getAppointmentHistory("));

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
    expect(loaderBody).toMatch(/\.limit\(budget\)/);
    expect(loaderBody).toMatch(/\.eq\("studio_id", studioId\)/);
  });
});

describe("UNAVAILABLE never becomes ABSENT — the workflow model", () => {
  const input = (over: Partial<TodayWorkflowInput> = {}): TodayWorkflowInput => ({
    appointmentId: "a1",
    clientId: "c1",
    clientName: "Someone",
    timeLabel: "9:00 AM",
    status: "confirmed",
    serviceName: null,
    history: "absent",
    nextVisitNote: null,
    cautionNote: null,
    setupLine: null,
    reminders: [],
    intake: "reviewed",
    charting: "none",
    ...over,
  });

  it("a PROVEN absence still earns the new-client priority", () => {
    const [item] = buildTodayWorkflow([input({ history: "absent" })]).items;
    expect(item.history).toBe("absent");
    expect(item.priority).toBe(5);
  });

  it("an UNAVAILABLE read does not", () => {
    const [item] = buildTodayWorkflow([input({ history: "unavailable" })]).items;
    expect(item.history).toBe("unavailable");
    // The new-client rank is a claim about the person, reachable only from a
    // read that answered.
    expect(item.priority).not.toBe(5);
  });

  it("an UNAVAILABLE read asserts no history-derived fact", () => {
    const [item] = buildTodayWorkflow([
      input({ history: "unavailable", setupLine: "27.12 MHz" }),
    ]).items;
    expect(item.setup).toBeNull();
  });

  it("the item carries NO boolean beside the state", () => {
    // The whole point of the repair: a `hasHistory` boolean next to the state
    // reads as authoritative at the call site, which is how `unavailable` got
    // flattened three separate times.
    const [item] = buildTodayWorkflow([input()]).items;
    expect(item).not.toHaveProperty("hasHistory");
    expect(item).not.toHaveProperty("historyKnown");
  });

  it("only PRESENT carries the preparation facts through", () => {
    const [item] = buildTodayWorkflow([
      input({ history: "present", setupLine: "27.12 MHz" }),
    ]).items;
    expect(item.setup).toBe("27.12 MHz");
  });
});

describe("the intent predicates carry the asymmetry", () => {
  it("treatment memory renders for PRESENT and UNAVAILABLE, never for ABSENT", () => {
    // This asymmetry IS the fix for the independent-loader defect. The prep
    // loader is a separate query with its own answer; when this history load
    // fails it must still be allowed to show what it read, or to say that it
    // could not read it. Only a proven absence means there is nothing.
    expect(shouldShowTreatmentMemory("present")).toBe(true);
    expect(shouldShowTreatmentMemory("unavailable")).toBe(true);
    expect(shouldShowTreatmentMemory("absent")).toBe(false);
  });

  it("the returning-client review is offered ONLY for PRESENT", () => {
    expect(shouldOfferHistoryReview("present")).toBe(true);
    expect(shouldOfferHistoryReview("absent")).toBe(false);
    expect(shouldOfferHistoryReview("unavailable")).toBe(false);
  });
});

describe("the Dashboard renders the three history states distinctly", () => {
  const PAGE = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );
  const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("unavailable is checked BEFORE the new-client branch", () => {
    const unavailable = CODE.indexOf('workflow.history === "unavailable"');
    const newClient = CODE.indexOf("New client · No charted history yet");
    expect(unavailable).toBeGreaterThan(-1);
    expect(newClient).toBeGreaterThan(-1);
    expect(unavailable).toBeLessThan(newClient);
  });

  it("the new-client line is reachable ONLY from a proven absence", () => {
    expect(CODE).toMatch(/workflow\.history === "absent" \? \(/);
  });

  it("the unavailable branch says so, neutrally", () => {
    expect(PAGE).toMatch(/History unavailable/);
  });

  it("the page passes the per-appointment STATE, not a page-wide boolean", () => {
    expect(CODE).toMatch(/history: history\.status/);
    expect(CODE).not.toMatch(/historyKnown/);
    expect(CODE).not.toMatch(/beforeLoad\.ok/);
  });

  it("the treatment-memory region is gated by the PREDICATE, not by hasHistory", () => {
    // The exact defect: `{workflow?.hasHistory && (` deleted a chart that the
    // INDEPENDENT prep loader had already read successfully.
    expect(CODE).not.toMatch(/\{workflow\?\.hasHistory && \(/);
    expect(CODE).toMatch(
      /shouldShowTreatmentMemory\(workflow\?\.history \?\? "unavailable"\) && \(/,
    );
  });

  it("the prep-memory props still come from the prep loader, not from history", () => {
    // One loader's failure must not become another loader's failure.
    expect(CODE).toMatch(/memory=\{prepMemory\.memory\}/);
    expect(CODE).toMatch(/unavailable=\{prepMemory\.unavailable\}/);
    // …and the prep fold never consults the history load.
    const fold = CODE.slice(
      CODE.indexOf("prepMemoryByAppointment"),
      CODE.indexOf("todayWorkflowInputs"),
    );
    expect(fold).not.toMatch(/historyByAppointment|history\.status/);
  });

  it("the next action is chosen from the STATE", () => {
    expect(CODE).toMatch(/history: workflow\?\.history \?\? "unavailable"/);
  });

  it("absence chips cannot render outside the present arm", () => {
    // Every missing-record chip is an ABSENCE claim. It used to sit one JSX
    // level outside the ternary, guarded only by `reminders` happening to
    // default to [].
    const chips = CODE.indexOf("workflow.missingRecords.length > 0");
    const setup = CODE.indexOf("Latest setup:");
    const memoryGate = CODE.indexOf("shouldShowTreatmentMemory(");
    expect(chips).toBeGreaterThan(-1);
    // Inside the arm that renders "Latest setup", i.e. after it opens and
    // before the arm closes and the treatment-memory region begins.
    expect(chips).toBeGreaterThan(setup);
    expect(chips).toBeLessThan(memoryGate);
  });
});

// ===========================================================================
// TRUNCATION — the shared batch cannot turn a missing row into an absent one.
// ===========================================================================
//
// Proven against the PURE resolver, because the defect only appears when one
// client's history is deep enough to starve another's, which is exactly the
// state that is hard to stage against a database.

const CLIENT_FIELDS = new Map([
  ["dense", { date_of_birth: null, phone: null, address: null }],
  ["quiet", { date_of_birth: null, phone: null, address: null }],
]);

function session(over: Partial<SessionRow> & { id: string; client_id: string; started_at: string }): SessionRow {
  return {
    appointment_id: null,
    next_session_note: null,
    aftercare_and_risks_explained_at: null,
    modality: "electrolysis",
    electrolysis_entries: [{ hairs_treated: 20, deleted_at: null }],
    laser_entries: [],
    ...over,
  } as SessionRow;
}

const APPT = (id: string, clientId: string) => ({
  appointmentId: id,
  clientId,
  before: "2026-08-21T13:00:00Z",
});

describe("the session budget is derived from the ROSTER, not a magic number", () => {
  it("scales with the number of clients", () => {
    expect(previewSessionBudget(1)).toBeLessThan(previewSessionBudget(4));
  });

  it("is capped, so a very large day cannot ask for an unbounded payload", () => {
    expect(previewSessionBudget(10_000)).toBe(previewSessionBudget(1_000));
  });

  it("is never negative or zero-by-accident", () => {
    expect(previewSessionBudget(0)).toBe(0);
    expect(previewSessionBudget(1)).toBeGreaterThan(0);
  });
});

describe("truncation is DETECTED, not guessed", () => {
  it("a full batch counts as truncated", () => {
    // `>=`, not `>`: PostgREST can never return more than the limit, so `>`
    // would be dead code that never fires.
    expect(isBatchTruncated(300, 300)).toBe(true);
    expect(isBatchTruncated(299, 300)).toBe(false);
  });
});

describe("1-2. a COMPLETE batch answers authoritatively", () => {
  const sessionsByClient = new Map([
    ["dense", [session({ id: "s1", client_id: "dense", started_at: "2026-08-01T14:00:00Z" })]],
    ["quiet", []],
  ]);

  it("a returning client is PRESENT", () => {
    const out = historyStatesFromBatch({
      requests: [APPT("a-dense", "dense")],
      sessionsByClient,
      blocksBySession: new Map(),
      clientFields: CLIENT_FIELDS,
      sessionsTruncated: false,
    });
    expect(out.get("a-dense")?.status).toBe("present");
  });

  it("a genuinely first-time client is ABSENT", () => {
    const out = historyStatesFromBatch({
      requests: [APPT("a-quiet", "quiet")],
      sessionsByClient,
      blocksBySession: new Map(),
      clientFields: CLIENT_FIELDS,
      sessionsTruncated: false,
    });
    expect(out.get("a-quiet")?.status).toBe("absent");
  });
});

describe("3-6. a TRUNCATED batch may not manufacture an absence", () => {
  // The scenario: one client with a very long history fills the shared read,
  // so a quieter client's older sessions never came back at all.
  const sessionsByClient = new Map([
    ["dense", [session({ id: "s1", client_id: "dense", started_at: "2026-08-01T14:00:00Z" })]],
    ["quiet", []],
  ]);
  const truncated = () =>
    historyStatesFromBatch({
      requests: [APPT("a-dense", "dense"), APPT("a-quiet", "quiet")],
      sessionsByClient,
      blocksBySession: new Map(),
      clientFields: CLIENT_FIELDS,
      sessionsTruncated: true,
    });

  it("3. a client with no returned history is NOT absent", () => {
    expect(truncated().get("a-quiet")?.status).not.toBe("absent");
  });

  it("4. the crowded-out client is UNAVAILABLE", () => {
    expect(truncated().get("a-quiet")?.status).toBe("unavailable");
  });

  it("the client who DID come back keeps their answer", () => {
    // Each client's slice is a recency PREFIX, so a positive finding survives
    // truncation. Degrading everyone would throw away good evidence.
    expect(truncated().get("a-dense")?.status).toBe("present");
  });

  it("5-6. UNAVAILABLE cannot reach the new-client copy or ranking", () => {
    const status = truncated().get("a-quiet")!.status;
    const [item] = buildTodayWorkflow([
      {
        appointmentId: "a-quiet",
        clientId: "quiet",
        clientName: "Quiet Client",
        timeLabel: "9:00 AM",
        status: "confirmed",
        serviceName: null,
        history: status,
        nextVisitNote: null,
        cautionNote: null,
        setupLine: null,
        reminders: [],
        intake: "reviewed",
        charting: "none",
      },
    ]).items;
    expect(item.history).toBe("unavailable");
    expect(item.priority).not.toBe(5);
    expect(shouldOfferHistoryReview(item.history)).toBe(false);
    // …and the memory region still renders, so the independent loader speaks.
    expect(shouldShowTreatmentMemory(item.history)).toBe(true);
  });

  it("a missing CLIENT ROW is unavailable, not a client with three blank records", () => {
    const out = historyStatesFromBatch({
      requests: [APPT("a-orphan", "orphan")],
      sessionsByClient: new Map(),
      blocksBySession: new Map(),
      clientFields: CLIENT_FIELDS,
      sessionsTruncated: false,
    });
    expect(out.get("a-orphan")?.status).toBe("unavailable");
  });
});

describe("7-8. the loader stays batched and studio-scoped", () => {
  const SRC = readFileSync(
    join(process.cwd(), "lib/dashboard/before-today-previews.ts"),
    "utf8",
  );
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const loader = code.slice(code.indexOf("export async function getAppointmentHistory("));

  it("7. every read is bounded AND every child read has an explicit limit", () => {
    // The blocks and areas reads used to have NO limit at all, so their only
    // bound was the PostgREST server cap — which is invisible to the client
    // and therefore undetectable.
    expect((loader.match(/\.limit\(/g) ?? []).length).toBe(3);
    expect(loader).toMatch(/\.limit\(MAX_PREVIEW_CHILD_ROWS\)/);
  });

  it("8. every read is fenced to the studio", () => {
    const tables = (loader.match(/\.from\(/g) ?? []).length;
    expect((loader.match(/\.eq\("studio_id", studioId\)/g) ?? []).length).toBe(tables);
  });

  it("a truncated CHILD read makes the whole load unavailable", () => {
    // Blocks and areas are ordered by sort_order / display_order, NOT by
    // recency, so their truncation is not a prefix — it corrupts positive
    // claims rather than merely omitting them.
    expect(loader).toMatch(
      /if \(isBatchTruncated\(blocks\.length, MAX_PREVIEW_CHILD_ROWS\)\) \{\s*return unavailableForAll\(\);/,
    );
    expect(loader).toMatch(
      /if \(isBatchTruncated\(areaList\.length, MAX_PREVIEW_CHILD_ROWS\)\) \{\s*return unavailableForAll\(\);/,
    );
  });

  it("the session order carries a deterministic tie-break", () => {
    expect(loader).toMatch(/\.order\("id", \{ ascending: false \}\)/);
  });
});
