import { afterEach, describe, expect, it, vi } from "vitest";

// THE SELECTION AUTHORITY, ATTACKED.
//
// Behavioural tests against the real exported function with a faked PostgREST,
// because these properties are about WHICH rows enter WHICH appointment's window
// — something no source grep and no render test can observe.

const STUDIO = "11111111-1111-1111-1111-111111111111";
const ALICE = "aaaaaaaa-0000-0000-0000-00000000000a";
const BOB = "bbbbbbbb-0000-0000-0000-00000000000b";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import {
  HISTORY_ROWS_PER_CLIENT,
  loadClientHistories,
  type HistoryRequest,
  type HistorySession,
} from "@/lib/sessions/history/select-visit";
import { matchHistorical, type HistoricalAnswer } from "@/lib/sessions/history/window";

afterEach(() => vi.clearAllMocks());

type Row = Record<string, unknown>;
type Issued = { table: string; verbs: string[] };

function fakeSupabase(rows: Row[], issued: Issued[], error: unknown = null) {
  return {
    from(table: string) {
      const rec: Issued = { table, verbs: [] };
      issued.push(rec);
      const b: Record<string, unknown> = {};
      for (const verb of ["select", "eq", "in", "is", "lt", "or", "order", "limit"]) {
        b[verb] = (...args: unknown[]) => {
          rec.verbs.push(`${verb}:${String(args[0] ?? "")}`);
          return b;
        };
      }
      (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: error ? null : rows, error });
      return b;
    },
  };
}

const counts = (blocks: number, entries = 0, laser = 0, cautions = 0) => ({
  live_block_count: [{ count: blocks }],
  live_entry_count: [{ count: entries }],
  live_laser_count: [{ count: laser }],
  caution_count: [{ count: cautions }],
});

function session(
  over: Partial<Row> & { id: string; client_id: string; started_at: string },
): Row {
  return {
    modality: "electrolysis",
    record_status: "active",
    deleted_at: null,
    appointment_id: null,
    session_notes: null,
    next_session_note: null,
    ...counts(1),
    ...over,
  };
}

async function run(rows: Row[], requests: HistoryRequest[], error: unknown = null) {
  const issued: Issued[] = [];
  vi.mocked(createClient).mockResolvedValue(
    fakeSupabase(rows, issued, error) as unknown as Awaited<ReturnType<typeof createClient>>,
  );
  const out = await loadClientHistories({ studioId: STUDIO, requests });
  return { out, issued };
}

const tag = (a: HistoricalAnswer<HistorySession>) =>
  matchHistorical(a, {
    observed: (s) => s.id,
    none: () => "none",
    indeterminate: () => "indeterminate",
    failed: () => "failed",
  });

const REQ = (over: Partial<HistoryRequest> = {}): HistoryRequest => ({
  requestKey: "appt-1",
  clientId: ALICE,
  before: "2026-05-01T09:00:00.000000+00:00",
  ...over,
});

// ---------------------------------------------------------------------------

describe("the read declares its bound, its order, and NO column list", () => {
  it("orders canonically and asks for one row more than the budget", async () => {
    const { issued } = await run(
      [session({ id: "s1", client_id: ALICE, started_at: "2026-01-01T00:00:00+00:00" })],
      [REQ()],
    );
    const read = issued.find((q) => q.table === "sessions")!;
    expect(read.verbs).toContain("order:started_at");
    expect(read.verbs).toContain("order:id");
    expect(read.verbs).toContain(`limit:${HISTORY_ROWS_PER_CLIENT + 1}`);
    expect(read.verbs).toContain("eq:studio_id");
    expect(read.verbs).toContain("in:client_id");
  });

  it("selects `*` plus aggregates — no column list to drift", async () => {
    const { issued } = await run([], [REQ()]);
    const select = issued.find((q) => q.table === "sessions")!.verbs.find((v) =>
      v.startsWith("select:"),
    )!;
    expect(select).toMatch(/^select:\*, /);
    for (const clinical of ["hairs_treated", "primary_area", "energy_level"]) {
      expect(select).not.toContain(clinical);
    }
  });

  it("EXACTLY the budget is COMPLETE; one more row is EXHAUSTED", async () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        session({
          id: `s${i}`,
          client_id: ALICE,
          started_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00+00:00`,
          ...counts(0, 0, 0),
        }),
      );
    // Budget reached, not exceeded -> a PROVEN absence.
    const complete = await run(rows(HISTORY_ROWS_PER_CLIENT), [REQ()]);
    expect(tag(complete.out.get("appt-1")!.latestChartedVisit())).toBe("none");
    // One more row means more exist -> absence is NOT provable.
    const over = await run(rows(HISTORY_ROWS_PER_CLIENT + 1), [REQ()]);
    expect(tag(over.out.get("appt-1")!.latestChartedVisit())).toBe("indeterminate");
  });
});

describe("recency is safe by construction, absence is not", () => {
  const newer = session({ id: "newer", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00" });
  const older = session({ id: "older", client_id: ALICE, started_at: "2026-03-01T00:00:00+00:00" });

  it("picks the newest charted visit", async () => {
    const { out } = await run([newer, older], [REQ()]);
    expect(tag(out.get("appt-1")!.latestChartedVisit())).toBe("newer");
  });

  it("skips a newer UNCHARTED visit to reach the real treatment", async () => {
    const empty = session({
      id: "empty", client_id: ALICE, started_at: "2026-04-15T00:00:00+00:00", ...counts(0, 0, 0),
    });
    const { out } = await run([empty, newer], [REQ()]);
    expect(tag(out.get("appt-1")!.latestChartedVisit())).toBe("newer");
  });

  it("a row selected without counts POISONS the recency answer", async () => {
    const blind = session({ id: "blind", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00" });
    delete (blind as Row).live_block_count;
    const { out } = await run([blind, older], [REQ()]);
    expect(tag(out.get("appt-1")!.latestChartedVisit())).toBe("indeterminate");
  });
});

describe("same client, two appointments — separate cutoffs INSIDE the authority", () => {
  it("the earlier booking cannot see a visit the later one can", async () => {
    const between = session({
      id: "between", client_id: ALICE, started_at: "2026-04-01T12:00:00+00:00",
    });
    const early = session({ id: "early", client_id: ALICE, started_at: "2026-03-01T00:00:00+00:00" });
    const { out } = await run([between, early], [
      REQ({ requestKey: "morning", before: "2026-04-01T09:00:00.000000+00:00" }),
      REQ({ requestKey: "afternoon", before: "2026-04-01T16:00:00.000000+00:00" }),
    ]);
    expect(tag(out.get("morning")!.latestChartedVisit())).toBe("early");
    expect(tag(out.get("afternoon")!.latestChartedVisit())).toBe("between");
  });

  it("ONE fetch serves both — the batch property is not lost", async () => {
    const { issued } = await run(
      [session({ id: "s", client_id: ALICE, started_at: "2026-01-01T00:00:00+00:00" })],
      [REQ({ requestKey: "a" }), REQ({ requestKey: "b", before: "2026-06-01T00:00:00+00:00" })],
    );
    expect(issued.filter((q) => q.table === "sessions")).toHaveLength(1);
  });

  it("a request with NO horizon widens the shared read for everyone", async () => {
    const { issued } = await run([], [REQ({ requestKey: "a" }), REQ({ requestKey: "b", before: null })]);
    // `infinity`, not a clock read: a surface without a horizon must not invent one.
    expect(issued[0]!.verbs).toContain("lt:started_at");
  });
});

describe("the cutoff is compared at DATABASE precision", () => {
  it("200µs before the boundary is IN; 200µs after is OUT", async () => {
    // `new Date().getTime()` collapses these to a tie and would admit both.
    const before = session({ id: "before", client_id: ALICE, started_at: "2026-04-01T09:00:00.000123+00:00" });
    const after = session({ id: "after", client_id: ALICE, started_at: "2026-04-01T09:00:00.000789+00:00" });
    const { out } = await run([after, before], [REQ({ before: "2026-04-01T09:00:00.000456+00:00" })]);
    expect(tag(out.get("appt-1")!.latestChartedVisit())).toBe("before");
  });

  it("a visit EXACTLY at the cutoff is excluded — the bound is strict", async () => {
    const at = "2026-04-01T08:00:00.000000+00:00";
    const { out } = await run(
      [session({ id: "at-boundary", client_id: ALICE, started_at: at })],
      [REQ({ before: at })],
    );
    expect(tag(out.get("appt-1")!.latestChartedVisit())).toBe("none");
  });

  it("an UNPARSEABLE instant is REFUSED, never admitted", async () => {
    const { out } = await run(
      [session({ id: "garbled", client_id: ALICE, started_at: "not-a-timestamp" })],
      [REQ()],
    );
    expect(tag(out.get("appt-1")!.latestChartedVisit())).toBe("none");
  });
});

describe("a TIE on started_at is broken by the DATABASE, not re-opened here", () => {
  const tied = (id: string, over: Partial<Row> = {}) =>
    session({ id, client_id: ALICE, started_at: "2026-04-01T08:00:00.000000+00:00", ...over });

  it("the answer follows ARRIVAL order — any JS comparator would break one of these", async () => {
    const first = await run([tied("t-a"), tied("t-b")], [REQ()]);
    const second = await run([tied("t-b"), tied("t-a")], [REQ()]);
    expect(tag(first.out.get("appt-1")!.latestChartedVisit())).toBe("t-a");
    expect(tag(second.out.get("appt-1")!.latestChartedVisit())).toBe("t-b");
  });

  it("a tie group straddling the BOUND still answers recency, but not absence", async () => {
    const rows = Array.from({ length: HISTORY_ROWS_PER_CLIENT + 1 }, (_, i) =>
      tied(`tie-${i}`, i === 0 ? {} : { ...counts(0, 0, 0) }),
    );
    const { out } = await run(rows, [REQ()]);
    const h = out.get("appt-1")!;
    expect(tag(h.latestChartedVisit())).toBe("tie-0");
    expect(tag(h.latestPlanNote())).toBe("indeterminate");
  });
});

describe("exclusions happen INSIDE the authority", () => {
  it("a VOID visit is not history", async () => {
    const { out } = await run(
      [session({ id: "v", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00", record_status: "void" })],
      [REQ()],
    );
    expect(tag(out.get("appt-1")!.latestChartedVisit())).toBe("none");
  });

  it("the appointment's OWN visit record is not its previous treatment", async () => {
    const { out } = await run(
      [session({ id: "own", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00", appointment_id: "appt-1" })],
      [REQ({ excludeAppointmentId: "appt-1" })],
    );
    expect(tag(out.get("appt-1")!.latestChartedVisit())).toBe("none");
  });

  it("a SIBLING session on the same appointment is excluded too", async () => {
    // `appointment_id` has no unique constraint, so excluding one session id
    // would leave the sibling behind.
    const { out } = await run(
      [
        session({ id: "sib-a", client_id: ALICE, started_at: "2026-04-02T00:00:00+00:00", appointment_id: "appt-1" }),
        session({ id: "sib-b", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00", appointment_id: "appt-1" }),
      ],
      [REQ({ excludeAppointmentId: "appt-1" })],
    );
    expect(tag(out.get("appt-1")!.latestChartedVisit())).toBe("none");
  });

  it("the session being CHARTED is never its own previous treatment", async () => {
    const { out } = await run(
      [
        session({ id: "self", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00" }),
        session({ id: "older", client_id: ALICE, started_at: "2026-03-01T00:00:00+00:00" }),
      ],
      [REQ({ excludeSessionId: "self" })],
    );
    expect(tag(out.get("appt-1")!.latestChartedVisit())).toBe("older");
  });

  it("one client never receives another's visit", async () => {
    const { out } = await run(
      [session({ id: "bobs", client_id: BOB, started_at: "2026-04-01T00:00:00+00:00" })],
      [REQ()],
    );
    expect(tag(out.get("appt-1")!.latestChartedVisit())).toBe("none");
  });
});

describe("each question is asked at ITS OWN strength", () => {
  const blindBlocks = (id: string, startedAt: string) => {
    const r = session({ id, client_id: ALICE, started_at: startedAt });
    delete (r as Row).live_block_count;
    return r;
  };

  it("a stale older SETUP cannot win past an undecidable newer visit", async () => {
    const { out } = await run(
      [
        blindBlocks("newer-unknown", "2026-04-01T00:00:00+00:00"),
        session({ id: "older-setup", client_id: ALICE, started_at: "2026-03-01T00:00:00+00:00" }),
      ],
      [REQ()],
    );
    expect(tag(out.get("appt-1")!.latestVisitWithSetup())).toBe("indeterminate");
  });

  it("...but a KNOWN-EMPTY newer visit lets the older setup through", async () => {
    const { out } = await run(
      [
        session({ id: "newer-empty", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00", ...counts(0, 0, 0) }),
        session({ id: "older-setup", client_id: ALICE, started_at: "2026-03-01T00:00:00+00:00" }),
      ],
      [REQ()],
    );
    expect(tag(out.get("appt-1")!.latestVisitWithSetup())).toBe("older-setup");
  });

  it("a positive CAUTION survives a newer visit that recorded none", async () => {
    const { out } = await run(
      [
        session({ id: "newer-quiet", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00", ...counts(1, 0, 0, 0) }),
        session({ id: "older-caution", client_id: ALICE, started_at: "2026-03-01T00:00:00+00:00", ...counts(1, 0, 0, 2) }),
      ],
      [REQ()],
    );
    expect(tag(out.get("appt-1")!.observedCaution())).toBe("older-caution");
  });

  it("a positive CAUTION is not suppressed by an UNDECIDABLE newer visit either", async () => {
    const unknown = session({ id: "newer-unknown", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00" });
    delete (unknown as Row).caution_count;
    const { out } = await run(
      [unknown, session({ id: "older-caution", client_id: ALICE, started_at: "2026-03-01T00:00:00+00:00", ...counts(1, 0, 0, 1) })],
      [REQ()],
    );
    expect(tag(out.get("appt-1")!.observedCaution())).toBe("older-caution");
  });

  it("a positive REMEMBER survives a newer visit that wrote none", async () => {
    const { out } = await run(
      [
        session({ id: "newer-quiet", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00" }),
        session({ id: "older-plan", client_id: ALICE, started_at: "2026-03-01T00:00:00+00:00", next_session_note: "lower the energy one step" }),
      ],
      [REQ()],
    );
    expect(tag(out.get("appt-1")!.latestPlanNote())).toBe("older-plan");
  });
});

describe("the superseded claim is made by the AUTHORITY, conservatively", () => {
  it("a newer AUTHORITATIVELY-uncharted visit supersedes the selected one", async () => {
    const empty = session({ id: "empty", client_id: ALICE, started_at: "2026-04-15T00:00:00+00:00", ...counts(0, 0, 0) });
    const real = session({ id: "real", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00" });
    const { out } = await run([empty, real], [REQ()]);
    const h = out.get("appt-1")!;
    expect(h.supersededByUnchartedVisit(real as unknown as HistorySession)).toBe(true);
  });

  it("an UNDECIDABLE newer visit withholds the claim rather than guessing", async () => {
    const blind = session({ id: "blind", client_id: ALICE, started_at: "2026-04-15T00:00:00+00:00" });
    delete (blind as Row).live_block_count;
    const real = session({ id: "real", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00" });
    const { out } = await run([blind, real], [REQ()]);
    expect(
      out.get("appt-1")!.supersededByUnchartedVisit(real as unknown as HistorySession),
    ).toBe(false);
  });

  it("nothing newer at all means not superseded", async () => {
    const real = session({ id: "real", client_id: ALICE, started_at: "2026-04-01T00:00:00+00:00" });
    const { out } = await run([real], [REQ()]);
    expect(
      out.get("appt-1")!.supersededByUnchartedVisit(real as unknown as HistorySession),
    ).toBe(false);
  });
});

describe("a read error is a FAILURE, never an absence", () => {
  it("every request answers failed, and none answers none", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { out } = await run([], [REQ({ requestKey: "a" }), REQ({ requestKey: "b" })], {
      code: "PGRST500",
      message: "boom for client aaaaaaaa",
    });
    for (const key of ["a", "b"]) {
      const h = out.get(key)!;
      expect(tag(h.latestChartedVisit())).toBe("failed");
      expect(tag(h.latestVisitWithSetup())).toBe("failed");
      expect(tag(h.latestPlanNote())).toBe("failed");
      expect(tag(h.observedCaution())).toBe("failed");
      expect(tag(h.watchPlanSource())).toBe("failed");
      expect(tag(h.observedLegacyNotes())).toBe("failed");
    }
    const payload = JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
    expect(payload.event).toBe("client_history_read_failed");
    expect(JSON.stringify(payload)).not.toContain("boom for client");
    spy.mockRestore();
  });

  it("a failed read cannot license a superseded claim", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { out } = await run([], [REQ()], { code: "PGRST500" });
    expect(
      out.get("appt-1")!.supersededByUnchartedVisit({ id: "x" } as HistorySession),
    ).toBe(false);
    spy.mockRestore();
  });
});
