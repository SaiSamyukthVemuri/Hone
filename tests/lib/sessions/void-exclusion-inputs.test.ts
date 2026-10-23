import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// HON-10 row 1 (Sam): a VOID session and ITS BLOCKS never feed treatment
// intelligence or prep.
// ===========================================================================
//
// Every input that reads sessions or blocks for these surfaces, and how each
// one now excludes `record_status = 'void'`:
//
//   1. pickLastTreatment            selector skips void (block G in
//                                   latest-history-authority.test.ts, and here)
//   2. pickPreClientWatchPlanSource selector skips void (the note-OR-caution
//                                   content rule, HON-10 row 2, is unchanged)
//   3. buildTreatmentIntelligence   drops void sessions AND every block keyed
//                                   to them before counting anything
//   4. CHART "From last visit"      SQL `.neq("record_status", "void")`
//   5. appointment prep loader      chartedSessionCandidates drops void rows,
//                                   and blocks are read ONLY for those ids
//   6. dashboard Before-today       feeds 1-3 with record_status selected;
//                                   proven end to end below
//
// Each case puts a void session's block in the input and asserts it is gone,
// paired with the identical fixture marked 'draft' as the negative control, so
// the exclusion is attributable to record_status and nothing else.

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { getBeforeTodayPreviews } from "@/lib/dashboard/before-today-previews";
import {
  pickLastTreatment,
  pickPreClientWatchPlanSource,
} from "@/lib/sessions/clinical-summary";
import {
  buildTreatmentIntelligence,
  type IntelligenceBlockInput,
  type IntelligenceSessionInput,
} from "@/lib/sessions/treatment-intelligence";
import { chartedSessionCandidates } from "@/lib/sessions/charted-session";

afterEach(() => vi.clearAllMocks());

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const NEWER = "2026-03-10T10:00:00Z";
const OLDER = "2026-01-10T10:00:00Z";
type Status = "void" | "draft";

function intelSession(
  id: string,
  started_at: string,
  record_status: string | null,
  next_session_note: string | null = null,
): IntelligenceSessionInput {
  return {
    id,
    started_at,
    record_status,
    next_session_note,
    electrolysis_entries: [],
    laser_entries: [],
  };
}

function intelBlock(
  session_id: string,
  area: string,
  minutes: number,
  caution_note: string | null = null,
): IntelligenceBlockInput {
  return {
    session_id,
    primary_area: area,
    block_name: null,
    mode: "thermo",
    apilus_modality: null,
    energy_level: 14,
    machine_frequency: null,
    probe_label: "F3",
    minutes_performed: minutes,
    tolerance_rating: 3,
    reaction_type: null,
    caution_for_next_session: caution_note != null,
    caution_note,
    entry_hairs: [40],
  };
}

describe("1 — pickLastTreatment", () => {
  const run = (status: Status) =>
    pickLastTreatment(
      [
        { ...intelSession("newer", NEWER, status), electrolysis_entries: [] },
        { ...intelSession("older", OLDER, "draft"), electrolysis_entries: [] },
      ],
      new Map([
        ["newer", [{}]],
        ["older", [{}]],
      ]),
    )?.id;

  it("a void newest session with a live block is skipped", () => {
    expect(run("void")).toBe("older");
  });
  it("control: the same session as draft is the last treatment", () => {
    expect(run("draft")).toBe("newer");
  });
});

describe("2 — pickPreClientWatchPlanSource", () => {
  const run = (status: Status) =>
    pickPreClientWatchPlanSource(
      [
        { id: "newer", started_at: NEWER, record_status: status, next_session_note: "VOID plan" },
        { id: "older", started_at: OLDER, record_status: "draft", next_session_note: "Live plan" },
      ],
      new Map([
        ["newer", [{ caution_for_next_session: true, caution_note: "VOID caution" }]],
      ]),
    )?.id;

  it("a void session's note and caution block are never the Watch/Plan source", () => {
    expect(run("void")).toBe("older");
  });
  it("control: the same session as draft is the source", () => {
    expect(run("draft")).toBe("newer");
  });
});

describe("3 — buildTreatmentIntelligence", () => {
  const run = (status: Status) =>
    buildTreatmentIntelligence({
      sessionsNewestFirst: [
        intelSession("newer", NEWER, status, "VOID plan"),
        intelSession("older", OLDER, "draft", "Live plan"),
      ],
      blocks: [
        intelBlock("newer", "Upper lip", 30, "VOID caution"),
        intelBlock("older", "Chin", 10),
      ],
    });

  it("a void session and its blocks contribute nothing", () => {
    const intel = run("void");
    expect(intel.overall.chartedSessions).toBe(1);
    expect(intel.overall.minutes).toBe(10);
    expect(intel.areas.map((a) => a.name)).toEqual(["Chin"]);
    expect(intel.latestWatchNote ?? "").not.toMatch(/VOID/);
    expect(intel.latestPlan ?? "").not.toMatch(/VOID/);
  });
  it("control: the same session as draft is counted", () => {
    const intel = run("draft");
    expect(intel.overall.chartedSessions).toBe(2);
    expect(intel.overall.minutes).toBe(40);
    expect(intel.areas.map((a) => a.name).sort()).toEqual(["Chin", "Upper lip"]);
  });
  it("a void session's blocks are dropped even when the void session is the ONLY one", () => {
    const intel = buildTreatmentIntelligence({
      sessionsNewestFirst: [intelSession("v", NEWER, "void")],
      blocks: [intelBlock("v", "Chin", 30)],
    });
    expect(intel.charted).toBe(false);
  });
});

describe("4 — CHART 'From last visit' note read", () => {
  // The charting page reads this note straight from SQL; there is no pure
  // seam, so the query chain itself is pinned.
  const CHART = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
  const chain = (src: string) =>
    /const \{ data: previousWithNote \}[\s\S]*?\.maybeSingle\(\)/.exec(src)?.[0] ?? "";

  it("the previous-note query excludes void sessions", () => {
    expect(chain(CHART)).toMatch(/\.neq\("record_status", "void"\)/);
  });
  it("control: the pin locates the real chain and fails on it without the filter", () => {
    expect(chain(CHART)).toMatch(/\.not\("next_session_note", "is", null\)/);
    const without = CHART.replace(/\s*\.neq\("record_status", "void"\)/, "");
    expect(chain(without)).not.toMatch(/\.neq\("record_status", "void"\)/);
  });
});

describe("5 — appointment prep loader", () => {
  const rows = (status: Status) => [
    { id: "newer", started_at: NEWER, record_status: status, deleted_at: null, appointment_id: null, electrolysis_entries: [], laser_entries: [] },
    { id: "older", started_at: OLDER, record_status: "draft", deleted_at: null, appointment_id: null, electrolysis_entries: [], laser_entries: [] },
  ];

  it("void rows never become candidates, so their blocks are never read", () => {
    expect(chartedSessionCandidates(rows("void")).map((c) => c.id)).toEqual(["older"]);
    const LOADER = read("lib/sessions/last-treatment-loader.ts");
    // Both block reads are keyed ONLY by the filtered candidate ids.
    expect(LOADER).toMatch(/\.in\(\s*"session_id",\s*candidates\.map\(\(s\) => s\.id\),?\s*\)/);
    expect(LOADER).toMatch(/\.in\("session_id", allCandidateIds\)/);
  });
  it("control: the same row as draft is a candidate", () => {
    expect(chartedSessionCandidates(rows("draft")).map((c) => c.id)).toEqual(["newer", "older"]);
  });
});

// --- 6. Dashboard Before-today, end to end through the real loader ---------

const STUDIO = "11111111-1111-1111-1111-111111111111";
const CLIENT = "aaaaaaaa-0000-0000-0000-00000000000a";
type Row = Record<string, unknown>;

function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const verb of ["select", "eq", "in", "is", "order", "limit"]) {
        builder[verb] = () => builder;
      }
      (builder as { then: unknown }).then = (
        resolve: (v: { data: Row[]; error: null }) => unknown,
      ) => resolve({ data: tables[table] ?? [], error: null });
      return builder;
    },
  };
}

function block(id: string, session_id: string, area: string, caution_note: string | null): Row {
  return {
    id,
    session_id,
    sort_order: 0,
    block_name: area,
    primary_area: area,
    side: null,
    custom_area_detail: null,
    mode: "thermo",
    apilus_modality: null,
    energy_level: 14,
    minutes_performed: 30,
    probe_label: area === "Upper lip" ? "VOID probe" : "Live probe",
    probe_lot_number: null,
    machine_frequency: null,
    tolerance_rating: 3,
    reaction_type: null,
    reaction_notes: null,
    caution_for_next_session: caution_note != null,
    caution_note,
    electrolysis_entries: [],
  };
}

async function preview(status: Status) {
  const session = (id: string, started_at: string, record_status: string, note: string): Row => ({
    id,
    client_id: CLIENT,
    started_at,
    record_status,
    next_session_note: note,
    aftercare_and_risks_explained_at: null,
    modality: "electrolysis",
    electrolysis_entries: [],
    laser_entries: [],
  });
  vi.mocked(createClient).mockResolvedValue(
    fakeSupabase({
      sessions: [
        session("newer", NEWER, status, "VOID plan"),
        session("older", OLDER, "draft", "Live plan"),
      ],
      session_blocks: [
        block("b-new", "newer", "Upper lip", "VOID caution"),
        block("b-old", "older", "Chin", "Live caution"),
      ],
      clients: [{ id: CLIENT, date_of_birth: "1990-04-02", phone: "555-0100", address: "1 Example St" }],
      session_block_areas: [],
    }) as unknown as Awaited<ReturnType<typeof createClient>>,
  );
  const p = (await getBeforeTodayPreviews(STUDIO, [CLIENT])).get(CLIENT);
  return JSON.stringify(p ?? null);
}

describe("6 — dashboard Before-today preview (real loader, faked PostgREST)", () => {
  it("a void session's note, caution and block setup never reach the preview", async () => {
    const out = await preview("void");
    expect(out).not.toMatch(/VOID/);
    expect(out).toMatch(/Live/);
  });
  it("control: the same session as draft does reach it", async () => {
    expect(await preview("draft")).toMatch(/VOID/);
  });
  it("the loader selects record_status, so the filters are never fed undefined", () => {
    expect(read("lib/dashboard/before-today-previews.ts")).toMatch(
      /"id, client_id, started_at, record_status, /,
    );
  });
});
