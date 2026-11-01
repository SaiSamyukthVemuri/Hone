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
// The loader: deleted rows are excluded in the query, and the read pages past
// PostgREST's 1000-row cap rather than undercount.
// ---------------------------------------------------------------------------

type DbRow = TodayIntakeRow & { deleted_at: string | null };

function fakeSupabase(intakes: DbRow[], clients: Array<{ id: string; name: string }>) {
  const calls = { ranges: [] as Array<[number, number]>, isDeleted: [] as unknown[] };
  const from = (table: string) => {
    const state: { range?: [number, number]; ids?: string[] } = {};
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.order = chain;
    builder.is = (_col: string, val: unknown) => {
      calls.isDeleted.push(val);
      return builder;
    };
    builder.in = (_col: string, ids: string[]) => {
      state.ids = ids;
      return builder;
    };
    builder.range = (a: number, b: number) => {
      state.range = [a, b];
      calls.ranges.push([a, b]);
      return builder;
    };
    builder.then = (resolve: (v: unknown) => unknown) => {
      if (table === "client_intake_forms") {
        const live = intakes
          .filter((r) => r.deleted_at === null)
          .sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
        const [a, b] = state.range ?? [0, live.length];
        return resolve({ data: live.slice(a, b + 1), error: null });
      }
      return resolve({
        data: clients.filter((c) => state.ids?.includes(c.id)),
        error: null,
      });
    };
    return builder;
  };
  return { client: { from } as never, calls };
}

describe("getIntakesAwaitingReview", () => {
  it("ignores deleted rows: a deleted newer form does not hide the live submitted one", async () => {
    const { client, calls } = fakeSupabase(
      [
        { client_id: "a", status: "submitted", created_at: "2026-10-01T10:00:00Z", deleted_at: null },
        { client_id: "a", status: "in_progress", created_at: "2026-10-05T10:00:00Z", deleted_at: "2026-10-06T00:00:00Z" },
      ],
      [{ id: "a", name: "Client A" }],
    );
    const out = await getIntakesAwaitingReview(client, "studio-1");
    expect(out).toEqual([
      { clientId: "a", clientName: "Client A", submittedAt: "2026-10-01T10:00:00Z" },
    ]);
    // The query itself asks for non-deleted rows only.
    expect(calls.isDeleted).toContain(null);
  });

  it("pages past the 1000-row cap instead of undercounting", async () => {
    const many: DbRow[] = Array.from({ length: 1500 }, (_, i) => ({
      client_id: `c${i}`,
      status: "submitted" as const,
      created_at: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
      deleted_at: null,
    }));
    const { client, calls } = fakeSupabase(many, []);
    const out = await getIntakesAwaitingReview(client, "studio-1");
    expect(out).toHaveLength(1500);
    expect(calls.ranges.map((r) => r[0])).toEqual([0, 1000]);
  });

  it("refuses (throws) rather than return a silently truncated count", async () => {
    const endless: DbRow[] = Array.from({ length: 20_001 }, (_, i) => ({
      client_id: `c${i}`,
      status: "submitted" as const,
      created_at: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
      deleted_at: null,
    }));
    const { client } = fakeSupabase(endless, []);
    await expect(getIntakesAwaitingReview(client, "studio-1")).rejects.toThrow(
      "Failed to count intakes awaiting review",
    );
  });
});
