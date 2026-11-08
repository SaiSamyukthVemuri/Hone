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
// The loader: bounded (Insurance B2). Step 1 reads only clients with a submitted
// form; step 2 reads the rows of just those clients, chunked. A failure or a
// ceiling REFUSES so the caller can show "unavailable" for this count only.
// ---------------------------------------------------------------------------

type DbRow = TodayIntakeRow & { id: string; deleted_at: string | null };

function fakeSupabase(
  intakes: DbRow[],
  clients: Array<{ id: string; name: string }>,
  opts: { failStep?: 1 | 2 | "names" } = {},
) {
  const calls = {
    intakeReads: [] as Array<{ status?: unknown; inClientIds?: string[]; range?: [number, number] }>,
    notDeleted: 0,
  };
  const from = (table: string) => {
    const f: { eq: Record<string, unknown>; ids?: string[]; range?: [number, number]; deleted?: boolean } = { eq: {} };
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.order = self;
    b.eq = (c: string, v: unknown) => ((f.eq[c] = v), b);
    b.is = () => ((f.deleted = true), b);
    b.in = (_c: string, ids: string[]) => ((f.ids = ids), b);
    b.range = (a: number, z: number) => ((f.range = [a, z]), b);
    b.then = (resolve: (v: unknown) => unknown) => {
      if (table === "client_intake_forms") {
        const step = f.ids ? 2 : 1;
        calls.intakeReads.push({ status: f.eq.status, inClientIds: f.ids, range: f.range });
        if (f.deleted) calls.notDeleted += 1;
        if (opts.failStep === step) return resolve({ data: null, error: { message: "x" } });
        let rows = intakes.filter((r) => r.deleted_at === null);
        if (f.eq.status !== undefined) rows = rows.filter((r) => r.status === f.eq.status);
        if (f.ids) rows = rows.filter((r) => f.ids!.includes(r.client_id));
        rows = rows.sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
        const [a, z] = f.range ?? [0, rows.length];
        return resolve({ data: rows.slice(a, z + 1), error: null });
      }
      if (opts.failStep === "names") return resolve({ data: null, error: { message: "x" } });
      return resolve({ data: clients.filter((c) => f.ids?.includes(c.id)), error: null });
    };
    return b;
  };
  return { client: { from } as never, calls };
}

const dbRow = (id: string, client_id: string, status: TodayIntakeRow["status"], created_at: string, deleted_at: string | null = null): DbRow => ({
  id,
  client_id,
  status,
  created_at,
  deleted_at,
});

describe("getIntakesAwaitingReview (bounded)", () => {
  it("applies the newest-row rule across both steps and ignores deleted rows", async () => {
    const { client, calls } = fakeSupabase(
      [
        dbRow("1", "a", "submitted", "2026-10-01T10:00:00Z"),
        // a deleted newer in-progress reissue must NOT hide the live submitted one
        dbRow("2", "a", "in_progress", "2026-10-05T10:00:00Z", "2026-10-06T00:00:00Z"),
        // b: older submitted, newer LIVE in-progress -> not counted
        dbRow("3", "b", "submitted", "2026-10-02T10:00:00Z"),
        dbRow("4", "b", "in_progress", "2026-10-06T10:00:00Z"),
      ],
      [{ id: "a", name: "Client A" }, { id: "b", name: "Client B" }],
    );
    const out = await getIntakesAwaitingReview(client, "studio-1");
    expect(out).toEqual([{ clientId: "a", clientName: "Client A", submittedAt: "2026-10-01T10:00:00Z" }]);
    expect(calls.notDeleted).toBe(calls.intakeReads.length);
  });

  it("never reads clients that have no submitted form (size follows submitted forms, not history)", async () => {
    const history: DbRow[] = Array.from({ length: 3000 }, (_, i) => dbRow(`r${i}`, `old${i}`, "reviewed", new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()));
    const { client, calls } = fakeSupabase([...history, dbRow("s", "a", "submitted", "2026-10-01T10:00:00Z")], [{ id: "a", name: "Client A" }]);
    const out = await getIntakesAwaitingReview(client, "studio-1");
    expect(out.map((r) => r.clientId)).toEqual(["a"]);
    // Step 1 asked for submitted only; step 2 asked for just the one candidate.
    expect(calls.intakeReads[0].status).toBe("submitted");
    expect(calls.intakeReads[1].inClientIds).toEqual(["a"]);
    expect(calls.intakeReads).toHaveLength(2);
  });

  it("chunks the per-client read and pages past 1000 submitted forms", async () => {
    const many = Array.from({ length: 1250 }, (_, i) => dbRow(`r${i}`, `c${i}`, "submitted", new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString()));
    const { client, calls } = fakeSupabase(many, many.map((r) => ({ id: r.client_id, name: r.client_id })));
    const out = await getIntakesAwaitingReview(client, "studio-1");
    expect(out).toHaveLength(1250);
    const step1 = calls.intakeReads.filter((c) => !c.inClientIds);
    expect(step1.map((c) => c.range![0])).toEqual([0, 1000]);
    const step2 = calls.intakeReads.filter((c) => c.inClientIds);
    expect(Math.max(...step2.map((c) => c.inClientIds!.length))).toBeLessThanOrEqual(100);
  });

  it.each([1, 2, "names"] as const)("a failed step (%s) refuses with the fixed message, so the caller can say 'unavailable'", async (failStep) => {
    const { client } = fakeSupabase([dbRow("1", "a", "submitted", "2026-10-01T10:00:00Z")], [{ id: "a", name: "Client A" }], { failStep });
    await expect(getIntakesAwaitingReview(client, "studio-1")).rejects.toThrow("Failed to count intakes awaiting review");
  });

  it("refuses past the page ceiling rather than undercount", async () => {
    const endless = Array.from({ length: 20_001 }, (_, i) => dbRow(`r${i}`, `c${i}`, "submitted", new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString()));
    const { client } = fakeSupabase(endless, []);
    await expect(getIntakesAwaitingReview(client, "studio-1")).rejects.toThrow("Failed to count intakes awaiting review");
  });
});
