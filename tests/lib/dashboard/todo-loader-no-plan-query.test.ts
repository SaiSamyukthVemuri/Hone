import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Review 3779063526: the obsolete plan-follow-up read path is GONE from the
// To-do loader.
//
// The `follow_up` To-do kind was retired (a plan for the next visit is clinical
// memory, not unresolved work), but its plumbing outlived it: the loader still
// selected `next_session_note`, derived follow-up client ids, ran an extra
// `appointments` query gated purely on "this session has a plan", and carried
// `nextVisitNote` / `hasUpcomingAppointment` through `RecordedSession` that
// nothing read.
//
// A source grep cannot prove a query is not ISSUED, so this records every
// query the loader actually makes against a stub and asserts on them.

type Recorded = { table: string; columns: string; filters: string[] };
const queries: Recorded[] = [];

const rows: Record<string, unknown[]> = {
  sessions: [],
  session_blocks: [],
  appointments: [],
  client_intakes: [],
  clients: [],
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const rec: Recorded = { table, columns: "", filters: [] };
      queries.push(rec);
      const q: Record<string, unknown> = {};
      const chain =
        (name: string) =>
        (...args: unknown[]) => {
          rec.filters.push(`${name}:${String(args[0] ?? "")}`);
          return q;
        };
      q.select = (cols: string) => {
        rec.columns = String(cols ?? "");
        return q;
      };
      for (const m of ["eq", "in", "gte", "lte", "lt", "gt", "neq", "is", "order", "limit"]) {
        q[m] = chain(m);
      }
      q.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        resolve({ data: rows[table] ?? [], error: null });
      return q;
    },
  }),
}));

import { getMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";

beforeEach(() => {
  queries.length = 0;
  // One recent charted session that HAS a plan for the next visit, the exact
  // condition that used to trigger the follow-up client-id derivation and the
  // extra future-appointments query.
  rows.sessions = [
    {
      id: "sess-1",
      client_id: "client-1",
      started_at: "2026-08-10T10:00:00.000Z",
      next_session_note: "PLAN_SENTINEL_DO_NOT_TRANSPORT",
      aftercare_and_risks_explained_at: "2026-08-10T11:00:00.000Z",
      client: { id: "client-1", name: "A Client", archived_at: null },
    },
  ];
  rows.session_blocks = [];
  rows.appointments = [];
  rows.client_intakes = [];
});
afterEach(() => vi.clearAllMocks());

describe("the To-do loader does not read or transport plans", () => {
  it("never selects next_session_note", async () => {
    await getMissingRecordsAssistant("studio-1", "2026-08-11");
    const sessionSelects = queries.filter((q) => q.table === "sessions");
    expect(sessionSelects.length).toBeGreaterThan(0);
    for (const q of sessionSelects) {
      expect(q.columns).not.toContain("next_session_note");
    }
  });

  it("issues no appointments query gated on a plan existing", async () => {
    await getMissingRecordsAssistant("studio-1", "2026-08-11");
    // The retired query was the only one filtering appointments by client_id
    // with a future starts_at floor and a cancelled exclusion.
    const followUpShaped = queries.filter(
      (q) =>
        q.table === "appointments" &&
        q.filters.some((f) => f.startsWith("in:client_id")) &&
        q.filters.some((f) => f.startsWith("gte:starts_at")),
    );
    expect(followUpShaped).toHaveLength(0);
  });

  it("no plan text appears anywhere in the returned To-do data", async () => {
    const out = await getMissingRecordsAssistant("studio-1", "2026-08-11");
    expect(JSON.stringify(out)).not.toContain("PLAN_SENTINEL_DO_NOT_TRANSPORT");
    // and no follow-up item is produced
    expect(out.items.some((i) => i.type === ("follow_up" as never))).toBe(false);
  });

  it("control: the loader really did run and query (so the assertions are not vacuous)", async () => {
    await getMissingRecordsAssistant("studio-1", "2026-08-11");
    expect(queries.length).toBeGreaterThan(1);
    expect(queries.map((q) => q.table)).toContain("sessions");
  });
});
