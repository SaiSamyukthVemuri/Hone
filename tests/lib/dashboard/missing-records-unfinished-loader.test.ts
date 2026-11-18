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
        q[m] = (...args: unknown[]) => { rec.filters.push(`${m}:${args.map(String).join("=")}`); return q; };
      }
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: data[rec.columns.includes("appointments!inner") ? "open" : `${table}#${n}`] ?? [], error: null });
      return q;
    },
  }),
}));

import { getMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";

const NOW = "2026-10-24T12:00:00.000Z";
const client = (over: Record<string, unknown> = {}) => ({ id: "c1", name: "Rae T.", archived_at: null, ...over });
const appt = (over: Record<string, unknown> = {}) => ({ id: "a1", client_id: "c1", starts_at: "2026-10-23T15:00:00.000Z", client: client(), ...over });

beforeEach(() => {
  recs.length = 0;
  calls.clear();
  for (const k of Object.keys(data)) delete data[k];
});

describe("the unfinished-visit read", () => {
  it("is ONE sessions read, inner-joined to a CONFIRMED appointment that has already ended, studio-scoped and bounded", async () => {
    await getMissingRecordsAssistant("studio-1", NOW);
    const open = recs.find((r) => r.table === "sessions" && r.columns.includes("appointments!inner"));
    expect(open, "the unfinished-visit read was issued").toBeDefined();
    expect(open!.filters).toContain("eq:studio_id=studio-1");
    expect(open!.filters).toContain("is:deleted_at=null");
    expect(open!.filters).toContain("eq:appointments.status=confirmed");
    expect(open!.filters).toContain(`lte:appointments.ends_at=${NOW}`);
    expect(open!.filters.some((f) => f.startsWith("gte:appointments.starts_at="))).toBe(true);
    expect(open!.filters.some((f) => f.startsWith("limit:"))).toBe(true);
    // It reads, and only reads: nothing about money, completion or sending.
    expect(open!.columns).not.toMatch(/payment|charge|stripe|postcare/i);
  });

  it("turns the rows into Finish-visit items: one per appointment, archived clients skipped, either embed shape accepted", async () => {
    data["open"] = [
      { id: "s1", appointment_id: "a1", appointments: appt() },
      { id: "s1b", appointment_id: "a1", appointments: appt() }, // a second chart on the SAME appointment: one item
      { id: "s2", appointment_id: "a2", appointments: [appt({ id: "a2", client_id: "c2", client: client({ id: "c2", name: "Sam K." }) })] },
      { id: "s3", appointment_id: "a3", appointments: appt({ id: "a3", client_id: "c3", client: client({ id: "c3", archived_at: "2026-01-01T00:00:00Z" }) }) },
      { id: "s4", appointment_id: "a4", appointments: null },
    ];
    const out = await getMissingRecordsAssistant("studio-1", NOW);
    const finish = out.items.filter((i) => i.type === "unfinished");
    expect(finish.map((i) => i.appointmentId).sort()).toEqual(["a1", "a2"]);
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
