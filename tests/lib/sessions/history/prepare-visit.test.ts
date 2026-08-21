import { afterEach, describe, expect, it, vi } from "vitest";

const STUDIO = "11111111-1111-1111-1111-111111111111";
const ALICE = "aaaaaaaa-0000-0000-0000-00000000000a";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import {
  loadVisitPreparation,
  loadVisitPreparations,
} from "@/lib/sessions/history/prepare-visit";
import type { HistoryRequest } from "@/lib/sessions/history/select-visit";
import type { VisitPreparation } from "@/lib/sessions/history/visit-summary";

afterEach(() => vi.clearAllMocks());

type Row = Record<string, unknown>;
type Issued = { table: string };

function fakeSupabase(byTable: Record<string, Row[]>, issued: Issued[], failTable?: string) {
  return {
    from(table: string) {
      issued.push({ table });
      const b: Record<string, unknown> = {};
      for (const verb of ["select", "eq", "in", "is", "lt", "or", "order", "limit"]) {
        b[verb] = () => b;
      }
      (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
        resolve(
          failTable === table
            ? { data: null, error: { code: "PGRST500", message: "boom" } }
            : { data: byTable[table] ?? [], error: null },
        );
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

const session = (over: Partial<Row> & { id: string; started_at: string }): Row => ({
  client_id: ALICE,
  modality: "electrolysis",
  record_status: "active",
  deleted_at: null,
  appointment_id: null,
  session_notes: null,
  next_session_note: null,
  ...counts(1),
  ...over,
});

const block = (id: string, session_id: string, over: Row = {}) => ({
  id,
  session_id,
  studio_id: STUDIO,
  primary_area: "Chin",
  side: "midline",
  minutes_performed: 30,
  machine_frequency: "27.12 MHz",
  probe_label: "Ballet F3",
  mode: "thermolysis",
  energy_level: 14,
  deleted_at: null,
  ...over,
});

/** Narrow a summary to its visit variant, failing loudly otherwise. */
function visitOf(summary: VisitPreparation["treatment"]) {
  if (summary.kind !== "visit") throw new Error(`expected a visit, got ${summary.kind}`);
  return summary;
}

const REQ = (over: Partial<HistoryRequest> = {}): HistoryRequest => ({
  requestKey: "appt-1",
  clientId: ALICE,
  before: "2026-05-01T09:00:00.000000+00:00",
  ...over,
});

async function run(byTable: Record<string, Row[]>, requests: HistoryRequest[], failTable?: string) {
  const issued: Issued[] = [];
  vi.mocked(createClient).mockResolvedValue(
    fakeSupabase(byTable, issued, failTable) as unknown as Awaited<ReturnType<typeof createClient>>,
  );
  const out = await loadVisitPreparations({ studioId: STUDIO, requests });
  return { out, issued };
}

// ---------------------------------------------------------------------------

describe("the three questions are answered by their OWN visits", () => {
  it("treatment, setup and guidance can come from three different visits", async () => {
    const { out } = await run(
      {
        sessions: [
          // Newest: charted, no setup block (entry-only), no caution.
          session({ id: "newest", started_at: "2026-04-03T00:00:00Z", ...counts(0, 4, 0, 0) }),
          // Middle: has a settings block -> the setup answer.
          session({ id: "setup-visit", started_at: "2026-04-02T00:00:00Z", ...counts(1, 0, 0, 0) }),
          // Oldest: carries the guidance.
          session({
            id: "guidance", started_at: "2026-04-01T00:00:00Z",
            next_session_note: "lower the energy one step", ...counts(1, 0, 0, 1),
          }),
        ],
        session_blocks: [
          block("b-setup", "setup-visit"),
          block("b-guid", "guidance", { caution_for_next_session: true, caution_note: "avoid the jawline" }),
        ],
        electrolysis_entries: [
          { id: "e1", session_id: "newest", block_id: null, deleted_at: null },
          { id: "e2", session_id: "newest", block_id: null, deleted_at: null },
          { id: "e3", session_id: "newest", block_id: null, deleted_at: null },
          { id: "e4", session_id: "newest", block_id: null, deleted_at: null },
        ],
      },
      [REQ()],
    );
    const p = out.get("appt-1")!.preparation;
    // The newest CHARTED visit is the entry-only one, and it is its own variant.
    expect(p.treatment.kind).toBe("visit");
    expect(visitOf(p.treatment).treatment.kind).toBe("legacy-entry-only");
    // "Latest setup" came from a DIFFERENT, older visit.
    expect(p.setup).toMatchObject({ kind: "recorded", sessionId: "setup-visit" });
    expect((p.setup as { line: string }).line).toContain("27.12 MHz");
    expect((p.setup as { line: string }).line).toContain("EL 14");
    // ...and the guidance from an older one still.
    expect(p.watchPlan).toMatchObject({ kind: "recorded", planNote: "lower the energy one step" });
    expect((p.watchPlan as { caution: string }).caution).toBe("avoid the jawline");
  });

  it("a laser visit keeps its narrative end to end", async () => {
    const { out } = await run(
      {
        sessions: [
          session({ id: "l-visit", started_at: "2026-04-01T00:00:00Z", modality: "laser", ...counts(0, 0, 2, 0) }),
        ],
        laser_entries: [
          { id: "l1", session_id: "l-visit", deleted_at: null, zone: "Upper lip", observation_notes: "Zone cleared well." },
          { id: "l2", session_id: "l-visit", deleted_at: null, zone: "Chin", observation_notes: null },
        ],
      },
      [REQ()],
    );
    const t = visitOf(out.get("appt-1")!.preparation.treatment).treatment;
    if (t.kind !== "laser") throw new Error("expected laser");
    expect(t.narrative).toEqual(["Zone cleared well."]);
  });
});

describe("absence and unavailability never look alike", () => {
  it("a COMPLETE window with no prior visit is a proven absence", async () => {
    const { out } = await run({ sessions: [] }, [REQ()]);
    expect(out.get("appt-1")!.preparation.treatment).toEqual({ kind: "no-prior-visit" });
  });

  it("a failed SELECTION read makes every answer unavailable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { out } = await run({}, [REQ()], "sessions");
    const p = out.get("appt-1")!.preparation;
    expect(p.treatment).toEqual({ kind: "evidence-unavailable", reason: "read-failed" });
    expect(p.setup.kind).toBe("unavailable");
    expect(p.watchPlan.kind).toBe("unavailable");
    spy.mockRestore();
  });

  it("a failed DETAIL read is unavailable, NOT a client with no history", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { out } = await run(
      { sessions: [session({ id: "s1", started_at: "2026-04-01T00:00:00Z" })] },
      [REQ()],
      "session_blocks",
    );
    expect(out.get("appt-1")!.preparation.treatment).toEqual({
      kind: "evidence-unavailable",
      reason: "read-failed",
    });
    spy.mockRestore();
  });

  it("a visit whose blocks were TRUNCATED is unavailable, not sparse", async () => {
    // The row says four live blocks; one came back.
    const { out } = await run(
      {
        sessions: [session({ id: "s1", started_at: "2026-04-01T00:00:00Z", ...counts(4) })],
        session_blocks: [block("b1", "s1")],
      },
      [REQ()],
    );
    expect(out.get("appt-1")!.preparation.treatment).toEqual({
      kind: "evidence-unavailable",
      reason: "incomplete",
    });
  });

  it("no guidance under a COMPLETE window is none-recorded, and renders nothing", async () => {
    const { out } = await run(
      {
        sessions: [session({ id: "s1", started_at: "2026-04-01T00:00:00Z", ...counts(1, 0, 0, 0) })],
        session_blocks: [block("b1", "s1")],
      },
      [REQ()],
    );
    expect(out.get("appt-1")!.preparation.watchPlan).toEqual({ kind: "none-recorded" });
  });
});

describe("only the SELECTED visits are read, and only twice", () => {
  it("two round-trips regardless of how many appointments are on screen", async () => {
    const requests = Array.from({ length: 8 }, (_, i) =>
      REQ({ requestKey: `appt-${i}`, before: `2026-05-0${(i % 8) + 1}T09:00:00.000000+00:00` }),
    );
    const { issued } = await run(
      {
        sessions: [session({ id: "s1", started_at: "2026-04-01T00:00:00Z" })],
        session_blocks: [block("b1", "s1")],
      },
      requests,
    );
    // ONE sessions read, then ONE read per detail relation — never per row.
    expect(issued.filter((q) => q.table === "sessions")).toHaveLength(1);
    expect(issued.filter((q) => q.table === "session_blocks")).toHaveLength(1);
    expect(issued.filter((q) => q.table === "electrolysis_entries")).toHaveLength(1);
  });

  it("no detail read at all when nothing was selected", async () => {
    const { issued } = await run({ sessions: [] }, [REQ()]);
    expect(issued.filter((q) => q.table !== "sessions")).toHaveLength(0);
  });
});

describe("the browser-facing projection stays compact", () => {
  it("preparation carries no clinical collection", async () => {
    const { out } = await run(
      {
        sessions: [session({ id: "s1", started_at: "2026-04-01T00:00:00Z" })],
        session_blocks: [block("b1", "s1", { caution_note: "avoid the jawline" })],
      },
      [REQ()],
    );
    const text = JSON.stringify(out.get("appt-1")!.preparation);
    for (const leaked of ["probe_lot_number", "reaction_notes", "entries", "structured_areas"]) {
      expect(text, leaked).not.toContain(leaked);
    }
    // ...while the server-side model is still there for surfaces that need it.
    expect(out.get("appt-1")!.memory).not.toBeNull();
    expect(out.get("appt-1")!.detail).not.toBeNull();
  });
});

describe("the single-appointment entry point is the SAME implementation", () => {
  it("returns the same shape for one request", async () => {
    const issued: Issued[] = [];
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(
        {
          sessions: [session({ id: "s1", started_at: "2026-04-01T00:00:00Z" })],
          session_blocks: [block("b1", "s1")],
        },
        issued,
      ) as unknown as Awaited<ReturnType<typeof createClient>>,
    );
    const p = await loadVisitPreparation({
      studioId: STUDIO,
      clientId: ALICE,
      before: "2026-05-01T09:00:00.000000+00:00",
    });
    expect(p.preparation.treatment.kind).toBe("visit");
    expect(p.session?.id).toBe("s1");
  });
});
