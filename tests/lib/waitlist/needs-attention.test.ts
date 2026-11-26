import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ATTENTION_SHOW_LIMIT, loadNeedsAttention } from "@/lib/waitlist/needs-attention";

// A chainable fake: every builder method returns the builder, awaiting it yields
// the canned result for the table, and the select list is recorded.
function fakeDb(
  tables: Record<string, { data: unknown; count?: number | null; error?: unknown }>,
  selects: string[] = [],
): SupabaseClient {
  return {
    from(table: string) {
      const result = { error: null, ...tables[table] };
      const b: any = {
        select(cols: string) { selects.push(`${table}:${cols}`); return b; },
        eq() { return b; }, in() { return b; }, not() { return b; },
        order() { return b; }, limit() { return b; },
        then(res: (v: unknown) => unknown) { return Promise.resolve(result).then(res); },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const entry = (id: string) => ({ id, name: `N-${id}` });

describe("loadNeedsAttention", () => {
  it("counts ALL invited entries with a redeemed invitation, in the given order", async () => {
    const db = fakeDb({
      new_client_waitlist_entries: { data: [entry("a"), entry("b"), entry("c")], count: 3 },
      new_client_waitlist_invitations: { data: [{ entry_id: "c" }, { entry_id: "a" }] },
    });
    const r = await loadNeedsAttention(db, "s");
    expect(r).toEqual({ kind: "ok", total: 2, shown: [entry("a"), entry("c")] });
  });

  it("reports the true total when more than the shown limit are affected", async () => {
    const many = Array.from({ length: ATTENTION_SHOW_LIMIT + 5 }, (_, i) => entry(`e${i}`));
    const db = fakeDb({
      new_client_waitlist_entries: { data: many, count: many.length },
      new_client_waitlist_invitations: { data: many.map((m) => ({ entry_id: m.id })) },
    });
    const r = await loadNeedsAttention(db, "s");
    expect(r.kind === "ok" && r.total).toBe(ATTENTION_SHOW_LIMIT + 5);
    expect(r.kind === "ok" && r.shown.length).toBe(ATTENTION_SHOW_LIMIT);
  });

  it("is unknown, never an empty list, when a read fails", async () => {
    const db = fakeDb({
      new_client_waitlist_entries: { data: [entry("a")], count: 1 },
      new_client_waitlist_invitations: { data: null, error: { code: "x" } },
    });
    expect(await loadNeedsAttention(db, "s")).toEqual({ kind: "unknown" });
  });

  it("reads only ids, names and the redeemed marker: never a response text or reason", async () => {
    const selects: string[] = [];
    await loadNeedsAttention(
      fakeDb({
        new_client_waitlist_entries: { data: [entry("a")], count: 1 },
        new_client_waitlist_invitations: { data: [] },
      }, selects),
      "s",
    );
    expect(selects).toEqual([
      "new_client_waitlist_entries:id,name",
      "new_client_waitlist_invitations:entry_id",
    ]);
  });

  it("is unknown when the server cut the response below the true count (max_rows)", async () => {
    // The request asked for 1,001 rows but the server returned 1,000 of 1,500.
    const cut = Array.from({ length: 1000 }, (_, i) => entry(`e${i}`));
    const db = fakeDb({
      new_client_waitlist_entries: { data: cut, count: 1500 },
      new_client_waitlist_invitations: { data: [] },
    });
    expect(await loadNeedsAttention(db, "s")).toEqual({ kind: "unknown" });
  });

  it("is unknown when the exact count is missing, never assumed complete", async () => {
    const db = fakeDb({
      new_client_waitlist_entries: { data: [entry("a")], count: null },
      new_client_waitlist_invitations: { data: [] },
    });
    expect(await loadNeedsAttention(db, "s")).toEqual({ kind: "unknown" });
  });
});
