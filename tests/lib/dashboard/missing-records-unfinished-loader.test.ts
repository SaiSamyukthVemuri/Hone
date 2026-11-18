import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-45: the loader's read for "past, still CONFIRMED, has a chart". The pure builder is tested elsewhere; this exercises the
// QUERY the loader actually issues (table, embed, filters) and how it folds the rows. Synthetic values only.

type Rec = { table: string; n: number; columns: string; filters: string[] };
const recs: Rec[] = [];
const calls = new Map<string, number>();
const data: Record<string, unknown[]> = {};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const n = (calls.get(table) ?? 0) + 1;
      calls.set(table, n);
      const rec: Rec = { table, n, columns: "", filters: [] };
      recs.push(rec);
      const q: Record<string, unknown> = {};
      q.select = (c: string) => { rec.columns = String(c); return q; };
      for (const m of ["eq", "in", "gte", "lte", "lt", "gt", "neq", "is", "not", "order", "limit"]) {
        q[m] = (...args: unknown[]) => { rec.filters.push(`${m}:${args.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("=")}`); return q; };
      }
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: data[rec.columns.includes("sessions!inner") ? "open" : `${table}#${n}`] ?? [], error: null });
      return q;
    },
  }),
}));

import { getMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";

const NOW = "2026-10-24T12:00:00.000Z";
const client = (over: Record<string, unknown> = {}) => ({ id: "c1", name: "Rae T.", archived_at: null, ...over });
const appt = (over: Record<string, unknown> = {}) => ({ id: "a1", client_id: "c1", starts_at: "2026-10-23T15:00:00.000Z", client: client(), sessions: [{ id: "s1" }], ...over });

beforeEach(() => {
  recs.length = 0;
  calls.clear();
  for (const k of Object.keys(data)) delete data[k];
});

describe("the unfinished-visit read", () => {
  it("is ONE appointments read (sessions embedded inner): CONFIRMED, already ended, studio-scoped, live sessions only", async () => {
    await getMissingRecordsAssistant("studio-1", NOW);
    const open = recs.find((r) => r.table === "appointments" && r.columns.includes("sessions!inner"));
    expect(open, "the unfinished-visit read was issued").toBeDefined();
    expect(open!.filters).toContain("eq:studio_id=studio-1");
    expect(open!.filters).toContain("eq:status=confirmed");
    expect(open!.filters).toContain(`lte:ends_at=${NOW}`);
    expect(open!.filters.some((f) => f.startsWith("gte:starts_at="))).toBe(true);
    expect(open!.filters).toContain("eq:sessions.studio_id=studio-1");
    expect(open!.filters).toContain("is:sessions.deleted_at=null");
    // It reads, and only reads: nothing about money, completion or sending.
    expect(open!.columns).not.toMatch(/payment|charge|stripe|postcare/i);
  });

  it("is bounded DETERMINISTICALLY: most recently ended first, id as the tie-break, THEN the cap (past the cap the newest are shown)", async () => {
    await getMissingRecordsAssistant("studio-1", NOW);
    const open = recs.find((r) => r.table === "appointments" && r.columns.includes("sessions!inner"))!;
    const tail = open.filters.filter((f) => /^(order|limit):/.test(f));
    expect(tail).toEqual(['order:ends_at={"ascending":false}', 'order:id={"ascending":false}', "limit:100"]);
  });

  it("turns the rows into Finish-visit items: one per appointment, archived clients skipped, either embed shape accepted", async () => {
    data["open"] = [
      appt(),
      appt({ id: "a2", client_id: "c2", client: client({ id: "c2", name: "Sam K." }), sessions: { id: "s2" } }), // object embed
      appt({ id: "a3", client_id: "c3", client: client({ id: "c3", archived_at: "2026-01-01T00:00:00Z" }), sessions: [{ id: "s3" }] }),
      appt({ id: "a4", sessions: null }),
      appt({ id: "a5", sessions: [] }),
    ];
    const out = await getMissingRecordsAssistant("studio-1", NOW);
    const finish = out.items.filter((i) => i.type === "unfinished");
    // Order of the rows is preserved (the database orders them).
    expect(finish.map((i) => i.appointmentId)).toEqual(["a1", "a2"]);
    expect(finish.find((i) => i.appointmentId === "a1")).toMatchObject({
      href: "/clients/c1/sessions/s1",
      actionLabel: "Finish visit",
      chip: "Not finished",
    });
  });

  it("no matching rows: no unfinished items, and the rest of the assistant is unchanged", async () => {
    const out = await getMissingRecordsAssistant("studio-1", NOW);
    expect(out.items.filter((i) => i.type === "unfinished")).toEqual([]);
  });
});
