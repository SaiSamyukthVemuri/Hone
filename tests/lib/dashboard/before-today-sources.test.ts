import { afterEach, describe, expect, it, vi } from "vitest";

// Which visit each Today-row line came from, over a stand-in for the database that REALLY applies the
// studio, client, deleted and time filters, so isolation is tested and not assumed. Synthetic data only.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { getBeforeTodayPreviews } from "@/lib/dashboard/before-today-previews";
import { memorySourceLabels } from "@/lib/dashboard/memory-source-labels";

afterEach(() => vi.clearAllMocks());

const STUDIO = "11111111-1111-1111-1111-111111111111";
const OTHER_STUDIO = "22222222-2222-2222-2222-222222222222";
const CLIENT = "aaaaaaaa-0000-0000-0000-00000000000a";
const OTHER_CLIENT = "bbbbbbbb-0000-0000-0000-00000000000b";
const APPT = "cccccccc-0000-0000-0000-00000000000c";
const VISIT_AT = "2026-11-12T15:00:00.000Z";
const NOW = "2026-11-12T12:00:00.000Z";
const TZ = "America/New_York";

type Row = Record<string, unknown>;
let n = 0;
const sess = (clientId: string, startedAt: string, over: Row = {}): Row => ({
  id: `s${++n}`, studio_id: STUDIO, client_id: clientId, started_at: startedAt, deleted_at: null, record_status: "draft",
  next_session_note: null, aftercare_and_risks_explained_at: null, modality: "electrolysis", appointment_id: null,
  electrolysis_entries: [], laser_entries: [], ...over,
});
const blk = (sessionId: string, area: string, caution: string | null = null, studio = STUDIO, order = 0): Row => ({
  id: `b${++n}`, studio_id: studio, session_id: sessionId, deleted_at: null, sort_order: order, block_name: area, primary_area: area,
  side: null, custom_area_detail: null, mode: "thermo", apilus_modality: null, energy_level: 14, minutes_performed: 30,
  probe_label: "Probe", probe_lot_number: null, machine_frequency: null, tolerance_rating: 3, reaction_type: null, reaction_notes: null,
  caution_for_next_session: caution != null, caution_note: caution, electrolysis_entries: [],
});

function db(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b);
      b.in = (c: string, v: unknown[]) => ((rows = rows.filter((r) => v.includes(r[c]))), b);
      b.is = (c: string, v: null) => ((rows = rows.filter((r) => (r[c] ?? null) === v)), b);
      b.order = (c: string, o: { ascending: boolean }) => ((rows = [...rows].sort((x, y) => (String(x[c]) < String(y[c]) ? -1 : 1) * (o.ascending ? 1 : -1))), b);
      b.limit = (k: number) => ((rows = rows.slice(0, k)), b);
      (b as { then: unknown }).then = (res: (v: { data: Row[]; error: null }) => unknown) => res({ data: rows, error: null });
      return b;
    },
  };
}

async function labelsFor(tables: Record<string, Row[]>, clientId = CLIENT) {
  vi.mocked(createClient).mockResolvedValue(db({ clients: [{ id: clientId, studio_id: STUDIO, date_of_birth: "1990-01-01", phone: "x", address: "y" }], session_block_areas: [], ...tables }) as never);
  const out = await getBeforeTodayPreviews(STUDIO, [clientId], [{ clientId, appointmentId: APPT, startsAt: VISIT_AT }]);
  const p = out.get(APPT)!;
  return { preview: p, labels: memorySourceLabels(p.sources, NOW, TZ) };
}

describe("Today row: which visit did each line come from?", () => {
  it("Codex P2: the newest charted visit has only laser entries (no blocks), so the setup line is an OLDER visit's: the label names that visit, not the newest", async () => {
    const older = sess(CLIENT, "2026-10-20T15:00:00Z");
    const newest = sess(CLIENT, "2026-11-10T15:00:00Z", { modality: "laser", laser_entries: [{ id: "l1", deleted_at: null }] });
    const { preview, labels } = await labelsFor({
      sessions: [older, newest],
      session_blocks: [blk(older.id as string, "Jaw")],
    });
    expect(preview.setupLine).not.toBeNull(); // the setup comes from the older visit's blocks
    expect(preview.sources?.latestAt).toBe("2026-11-10T15:00:00Z");
    expect(labels.setup).toBe("Setup from 20 Oct (the latest visit on 10 Nov has no charted setup)");
    expect(labels.setup).not.toBe("Setup from 10 Nov");
  });

  it("several visits and areas, the newest visit has no notes and no charting: notes and setup come from earlier visits, and say so", async () => {
    const old = sess(CLIENT, "2026-10-03T15:00:00Z", { next_session_note: "Go gently on the chin" });
    const mid = sess(CLIENT, "2026-10-20T15:00:00Z");
    const newest = sess(CLIENT, "2026-11-10T15:00:00Z"); // an incomplete draft: no notes, no blocks
    const { preview, labels } = await labelsFor({
      sessions: [old, mid, newest],
      session_blocks: [blk(old.id as string, "Chin"), blk(old.id as string, "Upper lip", null, STUDIO, 1), blk(mid.id as string, "Jaw")],
    });
    expect(preview.nextVisitNote).toBe("Go gently on the chin");
    expect(preview.setupLine).not.toBeNull(); // a setup line exists, from the mid visit
    expect(preview.sources?.latestAt).toBe("2026-11-10T15:00:00Z");
    expect(labels.notes).toBe("Notes from 3 Oct (the latest visit on 10 Nov has no notes)");
    expect(labels.setup).toBe("Setup from 20 Oct (the latest visit on 10 Nov has no charted setup)");
  });

  it("when the newest visit has the notes and the charting, nothing is skipped and nothing is excused", async () => {
    const old = sess(CLIENT, "2026-10-03T15:00:00Z", { next_session_note: "old plan" });
    const newest = sess(CLIENT, "2026-11-10T15:00:00Z", { next_session_note: "new plan" });
    const { preview, labels } = await labelsFor({ sessions: [old, newest], session_blocks: [blk(old.id as string, "Chin"), blk(newest.id as string, "Jaw")] });
    expect(preview.nextVisitNote).toBe("new plan");
    expect(labels).toEqual({ notes: "Notes from 10 Nov", setup: "Setup from 10 Nov" });
  });

  it("a VOID newer visit is not 'the latest visit' and its note is never used", async () => {
    const real = sess(CLIENT, "2026-10-20T15:00:00Z", { next_session_note: "real plan" });
    const voided = sess(CLIENT, "2026-11-11T15:00:00Z", { record_status: "void", next_session_note: "void plan" });
    const { preview, labels } = await labelsFor({ sessions: [real, voided], session_blocks: [blk(real.id as string, "Chin")] });
    expect(preview.nextVisitNote).toBe("real plan");
    expect(preview.sources?.latestAt).toBe("2026-10-20T15:00:00Z");
    expect(labels.notes).toBe("Notes from 20 Oct");
  });

  it("a DELETED newer visit is invisible", async () => {
    const real = sess(CLIENT, "2026-10-20T15:00:00Z", { next_session_note: "real plan" });
    const gone = sess(CLIENT, "2026-11-11T15:00:00Z", { deleted_at: "2026-11-11T16:00:00Z", next_session_note: "deleted plan" });
    const { preview } = await labelsFor({ sessions: [real, gone], session_blocks: [blk(real.id as string, "Chin")] });
    expect(preview.nextVisitNote).toBe("real plan");
    expect(preview.sources?.latestAt).toBe("2026-10-20T15:00:00Z");
  });

  it("an EDITED (re-timed) session is placed by its corrected time: one moved to after this visit is not history, one moved earlier is", async () => {
    const moved = sess(CLIENT, "2026-11-13T15:00:00Z", { next_session_note: "moved past the visit" });
    const earlier = sess(CLIENT, "2026-10-01T15:00:00Z", { next_session_note: "corrected earlier" });
    const { preview, labels } = await labelsFor({ sessions: [moved, earlier], session_blocks: [blk(earlier.id as string, "Chin")] });
    expect(preview.nextVisitNote).toBe("corrected earlier");
    expect(labels.notes).toBe("Notes from 1 Oct");
  });

  it("the visit's own linked session is excluded and is not 'the latest visit'", async () => {
    const own = sess(CLIENT, "2026-11-12T14:55:00Z", { appointment_id: APPT, next_session_note: "this visit's own note" });
    const prior = sess(CLIENT, "2026-10-20T15:00:00Z", { next_session_note: "prior plan" });
    const { preview } = await labelsFor({ sessions: [own, prior], session_blocks: [blk(prior.id as string, "Chin")] });
    expect(preview.nextVisitNote).toBe("prior plan");
    expect(preview.sources?.latestAt).toBe("2026-10-20T15:00:00Z");
  });

  it("a caution on the newest visit counts as notes from the newest visit", async () => {
    const s = sess(CLIENT, "2026-11-10T15:00:00Z");
    const { preview, labels } = await labelsFor({ sessions: [s], session_blocks: [blk(s.id as string, "Chin", "redness last time")] });
    expect(preview.cautionNote).toContain("redness last time");
    expect(labels.notes).toBe("Notes from 10 Nov");
  });

  it("CLIENT isolation: another client's newer visit is never this client's source or latest visit", async () => {
    const mine = sess(CLIENT, "2026-10-20T15:00:00Z", { next_session_note: "mine" });
    const theirs = sess(OTHER_CLIENT, "2026-11-11T15:00:00Z", { next_session_note: "theirs" });
    const { preview } = await labelsFor({ sessions: [mine, theirs], session_blocks: [blk(mine.id as string, "Chin"), blk(theirs.id as string, "Jaw")] });
    expect(preview.nextVisitNote).toBe("mine");
    expect(preview.sources?.latestAt).toBe("2026-10-20T15:00:00Z");
  });

  it("STUDIO isolation: a newer visit in another studio is never read", async () => {
    const mine = sess(CLIENT, "2026-10-20T15:00:00Z", { next_session_note: "mine" });
    const foreign = sess(CLIENT, "2026-11-11T15:00:00Z", { studio_id: OTHER_STUDIO, next_session_note: "foreign" });
    const { preview } = await labelsFor({ sessions: [mine, foreign], session_blocks: [blk(mine.id as string, "Chin"), blk(foreign.id as string, "Jaw", null, OTHER_STUDIO)] });
    expect(preview.nextVisitNote).toBe("mine");
    expect(preview.sources?.latestAt).toBe("2026-10-20T15:00:00Z");
  });

  it("a client with visits but no notes at all has no notes label (an absence is not a source)", async () => {
    const s = sess(CLIENT, "2026-10-20T15:00:00Z");
    const { labels } = await labelsFor({ sessions: [s], session_blocks: [blk(s.id as string, "Chin")] });
    expect(labels.notes).toBeNull();
    expect(labels.setup).toBe("Setup from 20 Oct");
  });

  it("selection is unchanged: the same rows give the same notes and setup as before the labels existed", async () => {
    const a = sess(CLIENT, "2026-10-03T15:00:00Z", { next_session_note: "plan A" });
    const b = sess(CLIENT, "2026-11-10T15:00:00Z");
    const { preview } = await labelsFor({ sessions: [a, b], session_blocks: [blk(a.id as string, "Chin")] });
    expect(preview.hasHistory).toBe(true);
    expect(preview.nextVisitNote).toBe("plan A");
  });
});
