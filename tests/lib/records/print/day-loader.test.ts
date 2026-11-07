import { describe, expect, it } from "vitest";
import { loadDayPacket, type PacketQuery, type PacketReader } from "@/lib/records/print/day-loader";

type Call = { table: string; ops: Array<[string, ...unknown[]]> };

/** A recording fake: honours gt(id)/range paging over fixed tables, records every filter. */
function fake(tables: Record<string, Array<Record<string, unknown>>>, opts: { pageCap?: number; failTable?: string } = {}) {
  const calls: Call[] = [];
  const reader: PacketReader = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const q: PacketQuery = {
        select: (c) => (call.ops.push(["select", c]), q),
        eq: (c, v) => (call.ops.push(["eq", c, v]), q),
        is: (c, v) => (call.ops.push(["is", c, v]), q),
        in: (c, v) => (call.ops.push(["in", c, v]), q),
        gt: (c, v) => (call.ops.push(["gt", c, v]), q),
        gte: (c, v) => (call.ops.push(["gte", c, v]), q),
        lt: (c, v) => (call.ops.push(["lt", c, v]), q),
        order: (c, o) => (call.ops.push(["order", c, o]), q),
        range: (a, b) => (call.ops.push(["range", a, b]), q),
        then(onfulfilled, onrejected) {
          if (opts.failTable === table) return Promise.resolve({ data: null, error: { message: "row data" } }).then(onfulfilled, onrejected);
          let rows = [...(tables[table] ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
          for (const [op, c, v] of call.ops) {
            if (op === "eq") rows = rows.filter((r) => r[c as string] === v);
            if (op === "is") rows = rows.filter((r) => r[c as string] === v);
            if (op === "in") rows = rows.filter((r) => (v as string[]).includes(r[c as string] as string));
            if (op === "gt") rows = rows.filter((r) => String(r[c as string]) > String(v));
            if (op === "gte") rows = rows.filter((r) => String(r[c as string]) >= String(v));
            if (op === "lt") rows = rows.filter((r) => String(r[c as string]) < String(v));
          }
          return Promise.resolve({ data: rows.slice(0, opts.pageCap ?? 1000), error: null }).then(onfulfilled, onrejected);
        },
      };
      return q;
    },
  };
  return { reader, calls };
}

const STUDIO = "studio-a";
const CLIENT = "client-1";
const TZ = "America/Toronto";
const sess = (id: string, started: string, over: Record<string, unknown> = {}) => ({
  id, studio_id: STUDIO, client_id: CLIENT, deleted_at: null, started_at: started, ended_at: null, modality: "x", session_notes: null,
  performed_by_practitioner_id: "p1", practitioner_id: "p1", aftercare_and_risks_explained_at: null, aftercare_and_risks_explained_by: null, ...over,
});
const noAreas = () => Promise.resolve(new Map());
const run = (reader: PacketReader, day = "2026-05-10") =>
  loadDayPacket({ supabase: reader, studioId: STUDIO, clientId: CLIENT, day, timezone: TZ, loadBlockAreas: noAreas });

describe("loadDayPacket", () => {
  it("filters studio, client, live rows and the studio-local day bounds in SQL, and selects named columns", async () => {
    const { reader, calls } = fake({ sessions: [sess("s1", "2026-05-10T15:00:00.000Z")], practitioners: [{ id: "p1", display_name: "Dana" }] });
    await run(reader);
    const q = calls.find((c) => c.table === "sessions")!;
    expect(q.ops).toContainEqual(["eq", "studio_id", STUDIO]);
    expect(q.ops).toContainEqual(["eq", "client_id", CLIENT]);
    expect(q.ops).toContainEqual(["is", "deleted_at", null]);
    expect(q.ops).toContainEqual(["gte", "started_at", "2026-05-10T04:00:00.000Z"]);
    expect(q.ops).toContainEqual(["lt", "started_at", "2026-05-11T04:00:00.000Z"]);
    const cols = String(q.ops.find((o) => o[0] === "select")![1]);
    for (const banned of ["phone", "email", "address", "date_of_birth", "price", "personal"]) expect(cols).not.toContain(banned);
  });
  it("returns only this client's selected-day sessions even if a query returned more (second scoping)", async () => {
    const { reader } = fake({
      sessions: [
        sess("ok", "2026-05-10T15:00:00.000Z"),
        sess("other-client", "2026-05-10T15:00:00.000Z", { client_id: "client-2" }),
        sess("next-day", "2026-05-11T15:00:00.000Z"),
      ],
      practitioners: [{ id: "p1", display_name: "Dana" }],
    });
    const r = await run(reader);
    // The fake applies the SQL filters, so also prove the in-memory scope separately below.
    expect(r.ok && r.value.sessions.map((s) => s.id)).toEqual(["ok"]);
  });
  it("COMPLETE PAGING: 2,300 blocks across three pages are all read, none dropped", async () => {
    const sessions = Array.from({ length: 3 }, (_, i) => sess(`s${i}`, `2026-05-10T1${i}:00:00.000Z`));
    const blocks = Array.from({ length: 2300 }, (_, i) => ({ id: `b${String(i).padStart(5, "0")}`, session_id: "s0", deleted_at: null, studio_id: STUDIO }));
    const { reader } = fake({ sessions, session_blocks: blocks, practitioners: [{ id: "p1", display_name: "Dana" }] });
    const r = await run(reader);
    expect(r.ok && r.value.blocks.length).toBe(2300);
  });
  it("an empty day reads no children at all", async () => {
    const { reader, calls } = fake({ sessions: [sess("s1", "2026-05-09T15:00:00.000Z")] });
    const r = await run(reader);
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ sessions: [], blocks: [] }) });
    expect(calls.map((c) => c.table)).toEqual(["sessions"]);
  });
  it("never touches client_personal_notes, payments, or any contact table", async () => {
    const { reader, calls } = fake({ sessions: [sess("s1", "2026-05-10T15:00:00.000Z")], practitioners: [{ id: "p1", display_name: "Dana" }] });
    await run(reader);
    expect(new Set(calls.map((c) => c.table))).toEqual(new Set(["sessions", "session_blocks", "electrolysis_entries", "laser_entries", "practitioners"]));
  });
  it("fails closed on a read error in any table, with no message carried out", async () => {
    for (const failTable of ["sessions", "session_blocks", "electrolysis_entries", "laser_entries", "practitioners"]) {
      const { reader } = fake({ sessions: [sess("s1", "2026-05-10T15:00:00.000Z")], practitioners: [{ id: "p1", display_name: "D" }] }, { failTable });
      const r = await run(reader);
      expect(r, failTable).toEqual({ ok: false, reason: "read_failed" });
    }
  });
  it("fails closed when the structured-area read throws", async () => {
    const { reader } = fake({ sessions: [sess("s1", "2026-05-10T15:00:00.000Z")], practitioners: [{ id: "p1", display_name: "D" }] });
    const r = await loadDayPacket({ supabase: reader, studioId: STUDIO, clientId: CLIENT, day: "2026-05-10", timezone: TZ, loadBlockAreas: () => Promise.reject(new Error("x")) });
    expect(r).toEqual({ ok: false, reason: "read_failed" });
  });
  it("an unresolvable day or timezone is refused before any read", async () => {
    const { reader, calls } = fake({});
    expect(await run(reader, "2026-13-01")).toEqual({ ok: false, reason: "unresolvable_day" });
    expect(await loadDayPacket({ supabase: reader, studioId: STUDIO, clientId: CLIENT, day: "2026-05-10", timezone: "Nope/Zone", loadBlockAreas: noAreas })).toEqual({ ok: false, reason: "unresolvable_day" });
    expect(calls).toHaveLength(0);
  });
  it("anti-vacuity: the in-memory scope drops a foreign row even when the query layer leaks it", async () => {
    const leaky = fake({ sessions: [sess("mine", "2026-05-10T15:00:00.000Z"), sess("theirs", "2026-05-10T15:00:00.000Z", { client_id: "client-2" })] });
    // Make the fake ignore eq() so the "query" returns both rows.
    const orig = leaky.reader.from.bind(leaky.reader);
    const leakyReader: PacketReader = { from: (t) => { const q = orig(t); const e = q.eq.bind(q); q.eq = (c, v) => (c === "client_id" ? q : e(c, v)); return q; } };
    const r = await run(leakyReader);
    expect(r.ok && r.value.sessions.map((s) => s.id)).toEqual(["mine"]);
  });
});
