import { describe, expect, it } from "vitest";
import {
  getIntakesAwaitingReview,
  selectClientsAwaitingIntakeReview,
} from "@/lib/dashboard/intakes-awaiting-review";
import type { TodayIntakeRow } from "@/lib/dashboard/today-intake";

// R3: the ONE sanctioned metric change of the dashboard redesign. A client counts
// as "intake awaiting review" when their NEWEST non-deleted intake row is
// `submitted`; the old rule counted every `submitted` row. All data synthetic.

const row = (
  client_id: string,
  status: TodayIntakeRow["status"],
  created_at: string,
): TodayIntakeRow => ({ client_id, status, created_at });

// What the dashboard counted BEFORE R3: every non-deleted submitted row.
function legacyCount(rows: ReadonlyArray<TodayIntakeRow>): number {
  return rows.filter((r) => r.status === "submitted").length;
}

describe("selectClientsAwaitingIntakeReview (R3 newest-intake rule)", () => {
  it("an older submitted form with a NEWER in-progress reissue is NOT counted", () => {
    const rows = [
      row("a", "submitted", "2026-10-01T10:00:00Z"),
      row("a", "in_progress", "2026-10-05T10:00:00Z"),
    ];
    expect(selectClientsAwaitingIntakeReview(rows)).toEqual([]);
  });

  it("an older reviewed form with a NEWER submitted reissue IS counted", () => {
    const rows = [
      row("a", "reviewed", "2026-10-01T10:00:00Z"),
      row("a", "submitted", "2026-10-05T10:00:00Z"),
    ];
    expect(selectClientsAwaitingIntakeReview(rows)).toEqual([
      { clientId: "a", submittedAt: "2026-10-05T10:00:00Z" },
    ]);
  });

  it("two clients are judged independently and returned newest first", () => {
    const rows = [
      row("a", "submitted", "2026-10-02T10:00:00Z"),
      row("b", "submitted", "2026-10-09T10:00:00Z"),
      row("c", "reviewed", "2026-10-10T10:00:00Z"),
    ];
    expect(selectClientsAwaitingIntakeReview(rows).map((r) => r.clientId)).toEqual([
      "b",
      "a",
    ]);
  });

  it("row order in the input does not change the answer", () => {
    const rows = [
      row("a", "in_progress", "2026-10-05T10:00:00Z"),
      row("a", "submitted", "2026-10-01T10:00:00Z"),
    ];
    expect(selectClientsAwaitingIntakeReview(rows)).toEqual([]);
    expect(selectClientsAwaitingIntakeReview([...rows].reverse())).toEqual([]);
  });

  it("before/after on ONE fixture (numbers quoted to Insurance)", () => {
    const rows = [
      // a: older submitted, newer reissue in progress -> was counted, now is not
      row("a", "submitted", "2026-10-01T10:00:00Z"),
      row("a", "in_progress", "2026-10-05T10:00:00Z"),
      // b: two submitted rows, newest submitted -> counted twice before, once now
      row("b", "submitted", "2026-10-02T10:00:00Z"),
      row("b", "submitted", "2026-10-06T10:00:00Z"),
      // c: reviewed then reissued and submitted -> counted both before and now
      row("c", "reviewed", "2026-10-03T10:00:00Z"),
      row("c", "submitted", "2026-10-07T10:00:00Z"),
      // d: reviewed only -> never counted
      row("d", "reviewed", "2026-10-04T10:00:00Z"),
    ];
    expect(legacyCount(rows)).toBe(4);
    expect(selectClientsAwaitingIntakeReview(rows)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The loader reads the 0334 STATUS PROJECTION (the newest non-deleted form per client, status and created_at only), never client_intake_forms
// itself, whose SELECT policy now needs clin.view_intake. The projection's own newest-row rule is proved against a database in
// tests/db/clin-read-enforcement-intake-consent.db.test.ts; here the fake emulates it. A failure or the ceiling REFUSES so the caller can show
// "unavailable" for this count only.
// ---------------------------------------------------------------------------

function fakeSupabase(
  projection: TodayIntakeRow[],
  clients: Array<{ id: string; name: string }>,
  opts: { failStep?: "rpc" | "names" } = {},
) {
  const calls = { rpc: [] as Array<{ fn: string; args: Record<string, unknown>; range: [number, number] }>, tables: [] as string[] };
  const rpc = (fn: string, args: Record<string, unknown>) => ({
    range: async (a: number, z: number) => {
      calls.rpc.push({ fn, args, range: [a, z] });
      if (opts.failStep === "rpc") return { data: null, error: { message: "x" } };
      return { data: projection.slice(a, z + 1), error: null };
    },
  });
  const from = (table: string) => {
    calls.tables.push(table);
    let ids: string[] | undefined;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.eq = () => b;
    b.is = () => b;
    b.in = (_c: string, v: string[]) => ((ids = v), b);
    b.range = () => b;
    b.then = (resolve: (v: unknown) => unknown) => {
      if (opts.failStep === "names") return resolve({ data: null, error: { message: "x" } });
      return resolve({ data: clients.filter((c) => ids?.includes(c.id)), error: null });
    };
    return b;
  };
  return { client: { from, rpc } as never, calls };
}

describe("getIntakesAwaitingReview (status projection)", () => {
  it("lists only clients whose projected current status is submitted, with the projected created_at", async () => {
    const { client } = fakeSupabase(
      [row("a", "submitted", "2026-10-01T10:00:00Z"), row("b", "in_progress", "2026-10-06T10:00:00Z"), row("c", "reviewed", "2026-10-03T10:00:00Z")],
      [{ id: "a", name: "Client A" }, { id: "b", name: "Client B" }],
    );
    expect(await getIntakesAwaitingReview(client, "studio-1")).toEqual([{ clientId: "a", clientName: "Client A", submittedAt: "2026-10-01T10:00:00Z" }]);
  });

  it("reads through the projection only, never client_intake_forms, and asks for the whole studio", async () => {
    const { client, calls } = fakeSupabase([row("a", "submitted", "2026-10-01T10:00:00Z")], [{ id: "a", name: "Client A" }]);
    await getIntakesAwaitingReview(client, "studio-1");
    expect(calls.rpc).toEqual([{ fn: "intake_status_for_clients", args: { p_studio_id: "studio-1", p_client_ids: null }, range: [0, 999] }]);
    expect(calls.tables).not.toContain("client_intake_forms");
  });

  it("a viewer the projection returns nothing for gets an empty list (the page decides restricted before it calls this)", async () => {
    const { client } = fakeSupabase([], []);
    expect(await getIntakesAwaitingReview(client, "studio-1")).toEqual([]);
  });

  it("pages past 1000 clients", async () => {
    const many = Array.from({ length: 1250 }, (_, i) => row(`c${i}`, "submitted", new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString()));
    const { client, calls } = fakeSupabase(many, many.map((r) => ({ id: r.client_id, name: r.client_id })));
    expect(await getIntakesAwaitingReview(client, "studio-1")).toHaveLength(1250);
    expect(calls.rpc.map((c) => c.range[0])).toEqual([0, 1000]);
  });

  it.each(["rpc", "names"] as const)("a failed step (%s) refuses with the fixed message, so the caller can say 'unavailable'", async (failStep) => {
    const { client } = fakeSupabase([row("a", "submitted", "2026-10-01T10:00:00Z")], [{ id: "a", name: "Client A" }], { failStep });
    await expect(getIntakesAwaitingReview(client, "studio-1")).rejects.toThrow("Failed to count intakes awaiting review");
  });

  it("refuses past the page ceiling rather than undercount", async () => {
    const endless = Array.from({ length: 50_001 }, (_, i) => row(`c${i}`, "submitted", new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString()));
    const { client } = fakeSupabase(endless, []);
    await expect(getIntakesAwaitingReview(client, "studio-1")).rejects.toThrow("Failed to count intakes awaiting review");
  });
});
