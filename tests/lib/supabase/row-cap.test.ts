import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A read AT the API row cap may have been cut, silently. The reads below are ordered by sort_order across
// many sessions, so a cut can lose the NEWEST session's blocks. They must fail closed. Synthetic data only.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { API_MAX_ROWS, mayBeTruncated } from "@/lib/supabase/row-cap";
import { loadLastChartedTreatmentsForClients } from "@/lib/sessions/last-treatment-loader";
import { getBeforeTodayPreviews } from "@/lib/dashboard/before-today-previews";

afterEach(() => vi.restoreAllMocks());

const STUDIO = "11111111-1111-1111-1111-111111111111";
const CLIENT = "aaaaaaaa-0000-0000-0000-00000000000a";
const APPT = "cccccccc-0000-0000-0000-00000000000c";

describe("the cap constant", () => {
  it("equals max_rows in supabase/config.toml, so the two cannot drift", () => {
    const toml = readFileSync(join(process.cwd(), "supabase/config.toml"), "utf8");
    expect(Number(/^max_rows\s*=\s*(\d+)/m.exec(toml)?.[1])).toBe(API_MAX_ROWS);
  });
  it("a count at or past the cap may be truncated; one below it may not", () => {
    expect(mayBeTruncated(API_MAX_ROWS - 1)).toBe(false);
    expect(mayBeTruncated(API_MAX_ROWS)).toBe(true);
    expect(mayBeTruncated(API_MAX_ROWS + 1)).toBe(true);
    expect(mayBeTruncated(0)).toBe(false);
  });
});

type Row = Record<string, unknown>;
function fake(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const b: Record<string, unknown> = {};
      for (const v of ["select", "eq", "in", "is", "lt", "neq", "order"]) b[v] = () => b;
      b.limit = (n: number) => ((rows = rows.slice(0, n)), b);
      (b as { then: unknown }).then = (res: (v: { data: Row[]; error: null }) => unknown) => res({ data: rows, error: null });
      return b;
    },
  };
}
const use = (tables: Record<string, Row[]>) => vi.mocked(createClient).mockResolvedValue(fake(tables) as never);

const prepSession = (id: string): Row => ({
  id, client_id: CLIENT, started_at: "2026-10-20T10:00:00Z", modality: "electrolysis", record_status: "active", deleted_at: null,
  appointment_id: null, session_notes: null, next_session_note: null,
  electrolysis_entries: [{ id: `${id}-e`, block_id: `${id}-b`, deleted_at: null, created_at: "2026-10-20T10:05:00Z" }], laser_entries: [],
});
const prepBlock = (sessionId: string, i = 0): Row => ({ id: `${sessionId}-b${i || ""}`, session_id: sessionId, sort_order: 0, primary_area: "Chin", side: null, structured_areas: [], deleted_at: null });
const filler = (n: number): Row[] => Array.from({ length: n }, (_, i) => prepBlock(`other-${i}`, i + 1));

describe("the dashboard prep loader fails closed at the row cap", () => {
  const ask = () => loadLastChartedTreatmentsForClients({ studioId: STUDIO, requests: [{ requestKey: "r", clientId: CLIENT }] });
  it("one block short of the cap: answers normally from the blocks it has", async () => {
    use({ sessions: [prepSession("s1")], session_blocks: [prepBlock("s1"), ...filler(API_MAX_ROWS - 2)] });
    const r = (await ask()).get("r")!;
    expect(r.unavailable).toBe(false);
    expect(r.treatment).not.toBeNull();
  });
  it("exactly at the cap: unavailable, never a treatment built from possibly cut blocks, never 'new client'", async () => {
    use({ sessions: [prepSession("s1")], session_blocks: [prepBlock("s1"), ...filler(API_MAX_ROWS - 1)] });
    const r = (await ask()).get("r")!;
    expect(r.unavailable).toBe(true);
    expect(r.treatment).toBeNull();
  });
  it("the failure is logged as a classification only: no ids, no clinical values", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    use({ sessions: [prepSession("s1")], session_blocks: filler(API_MAX_ROWS) });
    await ask();
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("row_cap_reached"));
    expect(line).toBeTruthy();
    expect(line).not.toContain(CLIENT);
    expect(line).not.toContain("Chin");
    expect(JSON.parse(line!)).toMatchObject({ event: "appointment_prep_blocks_batch_row_cap_reached", studio_id: STUDIO });
  });
});

describe("the Today Before-today reads fail closed at the row cap", () => {
  const sess = (id: string): Row => ({
    id, studio_id: STUDIO, client_id: CLIENT, started_at: "2026-10-20T10:00:00Z", deleted_at: null, record_status: "draft",
    next_session_note: "plan", aftercare_and_risks_explained_at: null, modality: "electrolysis", appointment_id: null,
    electrolysis_entries: [], laser_entries: [],
  });
  const blk = (sessionId: string, i: number): Row => ({
    id: `b${i}`, session_id: sessionId, sort_order: 0, block_name: "Chin", primary_area: "Chin", side: null, custom_area_detail: null,
    mode: "thermo", apilus_modality: null, energy_level: 14, minutes_performed: 30, probe_label: "P", probe_lot_number: null,
    machine_frequency: null, tolerance_rating: 3, reaction_type: null, reaction_notes: null, caution_for_next_session: false,
    caution_note: null, electrolysis_entries: [],
  });
  const ask = async (blocks: Row[]) => {
    use({ sessions: [sess("s1")], session_blocks: blocks, session_block_areas: [], clients: [{ id: CLIENT, date_of_birth: "1990-01-01", phone: "x", address: "y" }] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    return (await getBeforeTodayPreviews(STUDIO, [CLIENT], [{ clientId: CLIENT, appointmentId: APPT, startsAt: "2026-11-12T15:00:00.000Z" }])).get(APPT)!;
  };
  it("one block short of the cap: the preview is answered", async () => {
    const p = await ask([blk("s1", 0), ...Array.from({ length: API_MAX_ROWS - 2 }, (_, i) => blk("other", i + 1))]);
    expect(p.unavailable).toBe(false);
    expect(p.hasHistory).toBe(true);
  });
  it("at the cap: unavailable, never a partial answer rendered as the history", async () => {
    const p = await ask([blk("s1", 0), ...Array.from({ length: API_MAX_ROWS - 1 }, (_, i) => blk("other", i + 1))]);
    expect(p.unavailable).toBe(true);
    expect(p.hasHistory).toBe(false);
    expect(p.setupLine).toBeNull();
    expect(p.nextVisitNote).toBeNull();
  });
});
