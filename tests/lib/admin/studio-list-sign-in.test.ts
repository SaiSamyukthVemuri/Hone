import { describe, expect, it, vi } from "vitest";
import { loadStudioListSignIns } from "@/lib/admin/studio-list-sign-in";
import { loadAccountSignIns, STAFF_LOOKUP_TIMEOUT_MS } from "@/lib/admin/staff-sign-in";

const older = "2026-10-10T12:00:00Z";
const newer = "2026-11-10T12:00:00Z";
type Member = { id: string; studio_id: string; user_id: string | null; active: boolean };
const member = (id: string, studio_id: string, user_id: string | null, active = true): Member => ({ id, studio_id, user_id, active });
type Query = { table: string; studioIds: string[]; after?: string };

function fixture(options: {
  practitioners?: Member[];
  studio_receptionists?: Member[];
  accounts?: Record<string, string | null>;
  serverCap?: number;
  fail?: (query: Query) => boolean;
} = {}) {
  const queries: Query[] = [];
  const getUserById = vi.fn(async (id: string) => {
    const last = options.accounts?.[id];
    return last === undefined ? { error: "failed" } : { data: { user: { last_sign_in_at: last } } };
  });
  const client = {
    from(table: "practitioners" | "studio_receptionists") {
      const read: Query = { table, studioIds: [] };
      let activeOnly = false;
      let linkedOnly = false;
      let limit = Infinity;
      const query = {
        select(columns: string, options: unknown) {
          expect(columns).toBe("id, studio_id, user_id");
          expect(options).toEqual({ count: "exact" });
          return query;
        },
        in(column: string, ids: string[]) {
          expect(column).toBe("studio_id");
          read.studioIds = ids;
          return query;
        },
        eq(column: string, value: unknown) {
          expect([column, value]).toEqual(["active", true]);
          activeOnly = true;
          return query;
        },
        not(column: string, op: string, value: unknown) {
          expect([column, op, value]).toEqual(["user_id", "is", null]);
          linkedOnly = true;
          return query;
        },
        order(column: string) {
          expect(column).toBe("id");
          return query;
        },
        limit(max: number) {
          limit = max;
          return query;
        },
        gt(column: string, id: string) {
          expect(column).toBe("id");
          read.after = id;
          return query;
        },
        then(resolve: (result: unknown) => void) {
          queries.push(read);
          if (options.fail?.(read)) return resolve({ error: "failed", data: null, count: null });
          const rows = (options[table] ?? [])
            .filter((row) => read.studioIds.includes(row.studio_id) && (!activeOnly || row.active) && (!linkedOnly || row.user_id !== null) && (!read.after || row.id > read.after))
            .sort((a, b) => a.id.localeCompare(b.id));
          resolve({ data: rows.slice(0, Math.min(limit, options.serverCap ?? 500)), count: rows.length, error: null });
        },
      };
      return query;
    },
    auth: { admin: { getUserById } },
  };
  return { client: client as never, getUserById, queries };
}

describe("Studios list last sign-in", () => {
  it("uses every active account, pages past a small API cap, and looks up shared staff once across roles and studios", async () => {
    const f = fixture({
      practitioners: [
        member("01", "a", "older"), member("02", "a", "shared"), member("03", "b", "shared"),
        member("04", "a", "inactive", false), member("05", "c", null), member("06", "d", "never"),
        member("07", "elsewhere", "outside"),
      ],
      studio_receptionists: [member("08", "a", "shared"), member("09", "b", "newest")],
      accounts: { older, shared: newer, newest: "2026-11-14T12:00:00Z", never: null },
      serverCap: 1,
    });
    const result = await loadStudioListSignIns(f.client, ["a", "b", "c", "d"]);
    expect(Object.fromEntries(result)).toEqual({
      a: { state: "signed_in", at: newer },
      b: { state: "signed_in", at: "2026-11-14T12:00:00Z" },
      c: { state: "no_active_accounts" },
      d: { state: "never_signed_in" },
    });
    expect(f.getUserById.mock.calls.map(([id]) => id).sort()).toEqual(["never", "newest", "older", "shared"]);
    expect(f.queries.some((q) => q.after)).toBe(true);
  });

  it("keeps a complete studio's time but shows unknown when any of a studio's account timestamps is unavailable", async () => {
    const f = fixture({
      practitioners: [member("01", "a", "fine"), member("02", "b", "fine"), member("03", "c", "invalid")],
      studio_receptionists: [member("04", "a", "failed")],
      accounts: { fine: older, invalid: "invalid" },
    });
    expect(Object.fromEntries(await loadStudioListSignIns(f.client, ["a", "b", "c"]))).toEqual({
      a: { state: "unknown" }, b: { state: "signed_in", at: older }, c: { state: "unknown" },
    });
  });

  it("discards an incomplete page sequence and isolates a failed membership batch from other studios", async () => {
    const ids = Array.from({ length: 51 }, (_, index) => String(index));
    const f = fixture({
      practitioners: [member("01", "0", "first"), member("02", "0", "second"), member("03", "50", "ok")],
      serverCap: 1, accounts: { first: newer, second: older, ok: older },
      fail: (read) => read.table === "practitioners" && read.after === "01",
    });
    const result = await loadStudioListSignIns(f.client, ids);
    expect(result.get("0")).toEqual({ state: "unknown" });
    expect(result.get("50")).toEqual({ state: "signed_in", at: older });
    expect(f.getUserById.mock.calls).toEqual([["ok"]]);
  });

  it("makes no calls for an empty list", async () => {
    const f = fixture();
    expect((await loadStudioListSignIns(f.client, [])).size).toBe(0);
    expect(f.queries).toEqual([]);
    expect(f.getUserById).not.toHaveBeenCalled();
  });

  it("keeps the auth concurrency bound even when the SDK request outlives the timeout", async () => {
    vi.useFakeTimers();
    try {
      const getUserById = vi.fn(() => new Promise(() => {}));
      const admin = { auth: { admin: { getUserById } } } as never;
      const pending = loadAccountSignIns(admin, Array.from({ length: 20 }, (_, index) => String(index)));
      expect(getUserById).toHaveBeenCalledTimes(8);
      await vi.advanceTimersByTimeAsync(STAFF_LOOKUP_TIMEOUT_MS + 1);
      const found = await pending;
      expect(getUserById).toHaveBeenCalledTimes(8);
      expect([...found.values()]).toEqual(Array(8).fill({ state: "unknown" }));
    } finally {
      vi.useRealTimers();
    }
  });
});
