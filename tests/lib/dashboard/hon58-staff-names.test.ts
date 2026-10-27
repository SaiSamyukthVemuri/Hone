import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-58: the dashboard's two client-naming panels show the DISPLAY name (the
// preferred name when the client has one) and still work on a database that
// does not have the column yet. Synthetic ids and names only.

const state = vi.hoisted(() => ({
  hasColumn: true,
  failFirst: false,
  selects: [] as Array<{ table: string; columns: string }>,
}));

const clientWith = (preferred: string | null) => ({
  id: "client-1", name: "Margaret Nowak", archived_at: null,
  ...(state.hasColumn ? { preferred_name: preferred } : {}),
});

function rows(table: string): unknown[] {
  const client = clientWith("Maggie");
  switch (table) {
    case "sessions":
      return [{
        id: "sess-1", client_id: "client-1", started_at: "2026-10-20T15:00:00.000Z",
        next_session_note: "Recheck the area", aftercare_and_risks_explained_at: null, client,
      }];
    case "appointments":
      return [{ id: "appt-1", client_id: "client-1", starts_at: "2026-10-20T15:00:00.000Z", client }];
    case "session_blocks":
      return [{
        session_id: "sess-1", primary_area: "chin", block_name: null, custom_area_detail: null,
        probe_lot_number: null, caution_for_next_session: true, caution_note: "Watch", reaction_type: null,
        tolerance_rating: null, electrolysis_entries: [],
      }];
    case "client_intake_forms":
      return [{ client_id: "client-1", status: "in_progress", created_at: "2026-10-01T00:00:00.000Z" }];
    default:
      return [];
  }
}

function fakeClient() {
  return {
    from(table: string) {
      let columns = "";
      const settle = () => {
        if (columns.includes("client:clients(")) {
          const asked = columns.includes("preferred_name");
          if (state.failFirst && asked) return { data: null, error: { code: "57014", message: "synthetic timeout" } };
          if (asked && !state.hasColumn) {
            return { data: null, error: { code: "42703", message: "column clients_1.preferred_name does not exist" } };
          }
        }
        return { data: rows(table), error: null };
      };
      const proxy: unknown = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve().then(settle).then(resolve, reject);
          }
          if (prop === "select") {
            return (c: string) => { columns = c; state.selects.push({ table, columns: c }); return proxy; };
          }
          return () => proxy;
        },
      });
      return proxy;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));

const { getClientsNeedingAttention } = await import("@/lib/dashboard/clients-needing-attention");
const { getMissingRecordsAssistant } = await import("@/lib/dashboard/missing-records-assistant");

beforeEach(() => {
  state.hasColumn = true;
  state.failFirst = false;
  state.selects = [];
});

const clientReads = () => state.selects.filter((s) => s.columns.includes("client:clients("));

describe("clients needing attention", () => {
  it("shows the preferred name and asks the database for it", async () => {
    const out = await getClientsNeedingAttention("studio-1");
    expect(JSON.stringify(out)).toContain("Maggie");
    expect(JSON.stringify(out)).not.toContain("Margaret Nowak");
    expect(clientReads()[0].columns).toContain("preferred_name");
  });

  it("before 0258: retries once without the column and shows the stored name", async () => {
    state.hasColumn = false;
    const out = await getClientsNeedingAttention("studio-1");
    expect(JSON.stringify(out)).toContain("Margaret Nowak");
    const reads = clientReads();
    expect(reads).toHaveLength(2);
    expect(reads[0].columns).toContain("preferred_name");
    expect(reads[1].columns).not.toContain("preferred_name");
  });

  it("a real failure still refuses and is not retried", async () => {
    state.failFirst = true;
    await expect(getClientsNeedingAttention("studio-1")).rejects.toThrow(/^Failed to load clients needing attention$/);
    expect(clientReads()).toHaveLength(1);
  });
});

describe("missing-records assistant", () => {
  const NOW = "2026-10-24T12:00:00.000Z";

  it("shows the preferred name on both of its client-joined reads", async () => {
    const out = await getMissingRecordsAssistant("studio-1", NOW);
    expect(JSON.stringify(out)).toContain("Maggie");
    expect(JSON.stringify(out)).not.toContain("Margaret Nowak");
    const reads = clientReads();
    expect(reads).toHaveLength(2);
    for (const r of reads) expect(r.columns).toContain("preferred_name");
  });

  it("before 0258: each read retries once without the column and the stored name shows", async () => {
    state.hasColumn = false;
    const out = await getMissingRecordsAssistant("studio-1", NOW);
    expect(JSON.stringify(out)).toContain("Margaret Nowak");
    const reads = clientReads();
    expect(reads).toHaveLength(4);
    expect(reads.filter((r) => r.columns.includes("preferred_name"))).toHaveLength(2);
  });

  it("a real failure still refuses with the fixed message and is not retried", async () => {
    state.failFirst = true;
    await expect(getMissingRecordsAssistant("studio-1", NOW)).rejects.toThrow(/^Failed to load missing records$/);
    expect(clientReads()).toHaveLength(1);
  });
});
