import { beforeEach, describe, expect, it, vi } from "vitest";

// DAT-002 follow-up (Privacy PEER-1087 N1): the /records and /records/print
// loaders discarded the `error` of their reads, so a failed read rendered as
// "no records" — on a printed compliance log, an empty log. Each now refuses
// with a fixed message (the #981 pattern), which the route error boundary
// renders as "could not load". Every read of every loader is failed in turn,
// against a fixture where all of them run. Synthetic ids only.

const state = vi.hoisted(() => ({ fail: null as string | null, calls: new Map<string, number>() }));

const ROWS: Record<string, unknown[]> = {
  record_keeping_sterile_items: [{ id: "item-1", lot_number: "LOT-1", date_purchased: "2026-10-01" }],
  record_keeping_disinfectants: [{ id: "dis-1", date_prepared: "2026-10-01" }],
  record_keeping_exposure_incidents: [{ id: "inc-1", incident_date: "2026-10-01" }],
  session_blocks: [
    {
      id: "block-1", session_id: "sess-1", primary_area: "chin", side: null, block_name: null,
      sort_order: 0, probe_label: null, machine_frequency: null, probe_lot_number: "LOT-1",
      session: {
        id: "sess-1", started_at: "2026-10-02T15:00:00.000Z", modality: "electrolysis",
        client_id: "client-1", aftercare_and_risks_explained_at: null,
        performed_by_practitioner_id: "prac-1", practitioner_id: "prac-1",
        client: { id: "client-1", name: "Client A" },
      },
    },
  ],
  practitioners: [{ id: "prac-1", display_name: "Practitioner A", email: "prac@example.test" }],
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

const {
  getSterileItemRecords,
  getDisinfectantRecords,
  getExposureIncidentRecords,
  getLotTraceability,
} = await import("@/lib/record-keeping/queries");

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
    name: "sterile item records",
    load: () => getSterileItemRecords("studio-1"),
    message: /^Failed to load sterile item records$/,
    reads: ["record_keeping_sterile_items#1"],
  },
  {
    name: "disinfectant records",
    load: () => getDisinfectantRecords("studio-1"),
    message: /^Failed to load disinfectant records$/,
    reads: ["record_keeping_disinfectants#1"],
  },
  {
    name: "exposure incident records",
    load: () => getExposureIncidentRecords("studio-1"),
    message: /^Failed to load exposure incident records$/,
    reads: ["record_keeping_exposure_incidents#1"],
  },
  {
    name: "lot traceability",
    load: () => getLotTraceability("studio-1", "LOT-1"),
    message: /^Failed to load lot traceability$/,
    reads: ["record_keeping_sterile_items#1", "session_blocks#1", "practitioners#1"],
  },
];

describe("DAT-002 follow-up: /records loaders refuse a failed read", () => {
  for (const loader of LOADERS) {
    it(`${loader.name}: the fixture runs every read and returns records`, async () => {
      const reads = await readsOf(loader.load);
      for (const read of loader.reads) expect(reads).toContain(read);
      const value = await loader.load();
      expect(value).not.toBeNull();
      expect(JSON.stringify(value)).not.toBe("[]");
    });

    for (const read of loader.reads) {
      it(`${loader.name}: a failed ${read} refuses with a fixed message, not an empty result`, async () => {
        state.fail = read;
        await expect(loader.load()).rejects.toThrow(loader.message);
      });
    }
  }
});
