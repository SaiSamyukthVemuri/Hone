import { beforeEach, describe, expect, it, vi } from "vitest";

// DAT-002: three dashboard panel loaders discarded the `error` of their reads,
// so a failed read returned exactly what a studio with nothing to show returns.
// Each now refuses with a fixed message (the #981 pattern), which the route
// error boundary renders as "could not load". Every read of every loader is
// failed in turn, against a fixture where all of them run. Synthetic ids only.

const state = vi.hoisted(() => ({ fail: null as string | null, calls: new Map<string, number>() }));

const client = { id: "client-1", name: "Client A", archived_at: null };
const ROWS: Record<string, unknown[]> = {
  sessions: [
    {
      id: "sess-1", client_id: "client-1", appointment_id: "appt-1",
      started_at: "2026-10-20T15:00:00.000Z", next_session_note: "Recheck the area",
      aftercare_and_risks_explained_at: null, client,
    },
  ],
  session_blocks: [
    {
      session_id: "sess-1", primary_area: "chin", block_name: null, custom_area_detail: null,
      probe_lot_number: null, caution_for_next_session: true, caution_note: null,
      reaction_type: null, tolerance_rating: null, electrolysis_entries: [],
    },
  ],
  appointments: [{ id: "appt-1", client_id: "client-1", starts_at: "2026-10-20T15:00:00.000Z", client }],
  client_intake_forms: [{ client_id: "client-1", status: "in_progress", created_at: "2026-10-01T00:00:00.000Z" }],
  record_keeping_sterile_items: [
    { id: "lot-1", item_description: "Probe", manufacturer_name: null, expiry_date: "2026-10-30" },
  ],
};

function fakeClient() {
  const builder = (table: string) => {
    const n = (state.calls.get(table) ?? 0) + 1;
    state.calls.set(table, n);
    const settle = () =>
      state.fail === `${table}#${n}`
        ? { data: null, error: { code: "57014", message: "synthetic read failure" }, count: null }
        : { data: ROWS[table] ?? [], error: null, count: (ROWS[table] ?? []).length };
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve().then(settle).then(resolve, reject);
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  return { from: (table: string) => builder(table) };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));

const { getClientsNeedingAttention } = await import("@/lib/dashboard/clients-needing-attention");
const { getMissingRecordsAssistant } = await import("@/lib/dashboard/missing-records-assistant");
const { getExpiringSterileItems } = await import("@/lib/record-keeping/queries");

beforeEach(() => {
  state.fail = null;
  state.calls = new Map();
});

async function readsOf(load: () => Promise<unknown>) {
  state.calls = new Map();
  await load();
  const reads = [...state.calls].flatMap(([t, n]) => Array.from({ length: n }, (_, i) => `${t}#${i + 1}`));
  state.calls = new Map();
  return reads;
}

const LOADERS = [
  {
    name: "clients needing attention",
    load: () => getClientsNeedingAttention("studio-1"),
    message: /^Failed to load clients needing attention$/,
    reads: ["sessions#1", "session_blocks#1"],
  },
  {
    name: "missing-records assistant",
    load: () => getMissingRecordsAssistant("studio-1", "2026-10-24T12:00:00.000Z"),
    message: /^Failed to load missing records$/,
    reads: ["sessions#1", "sessions#2", "session_blocks#1", "appointments#1", "client_intake_forms#1"],
  },
  {
    name: "expiring sterile items",
    load: () => getExpiringSterileItems("studio-1", "2026-10-24"),
    message: /^Failed to load expiring supplies$/,
    reads: ["record_keeping_sterile_items#1"],
  },
];

describe("DAT-002 dashboard panels refuse a failed read instead of showing nothing", () => {
  for (const { name, load, message, reads } of LOADERS) {
    it(`${name}: the fixture runs every read and the control has something to show`, async () => {
      expect((await readsOf(load)).sort()).toEqual([...reads].sort());
      const value = await load();
      expect(Array.isArray(value) ? value : JSON.stringify(value)).not.toEqual([]);
    });

    it.each(reads)(`${name}: a failed %s read refuses with a fixed message`, async (read) => {
      state.fail = read;
      await expect(load()).rejects.toThrow(message);
    });
  }

  it("the control results are not the empty-studio results", async () => {
    const attention = await getClientsNeedingAttention("studio-1");
    const assistant = await getMissingRecordsAssistant("studio-1", "2026-10-24T12:00:00.000Z");
    expect(JSON.stringify(attention)).toContain("client-1");
    expect(JSON.stringify(assistant)).toContain("client-1");
    expect(await getExpiringSterileItems("studio-1", "2026-10-24")).toHaveLength(1);
  });
});
