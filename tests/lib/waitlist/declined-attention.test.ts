import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DECLINED_SHOW_LIMIT, loadDeclinedAttention } from "@/lib/waitlist/declined-attention";
import { statusMeaning } from "@/lib/waitlist/admission-model";

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

const T1 = "2026-11-01T10:00:00.000Z";
const T2 = "2026-11-02T10:00:00.000Z";
const rel = (id: string, released_at: string | null = T1) => ({ id, name: `N-${id}`, released_at });

describe("loadDeclinedAttention", () => {
  it("counts only entries released at the very instant their invitation was declined", async () => {
    const db = fakeDb({
      new_client_waitlist_entries: { data: [rel("a"), rel("b"), rel("c"), rel("d", null)], count: 4 },
      new_client_waitlist_invitations: {
        data: [
          { entry_id: "a", declined_at: T1 }, // released by the decline
          { entry_id: "b", declined_at: T2 }, // declined earlier cycle, set aside later
          { entry_id: "d", declined_at: T1 }, // no released_at to match
        ],
      },
    });
    const r = await loadDeclinedAttention(db, "s");
    expect(r).toEqual({ kind: "ok", total: 1, shown: [{ id: "a", name: "N-a" }], ids: new Set(["a"]) });
  });

  it("reads only ids and names: no invitation or reply text is selected", async () => {
    const selects: string[] = [];
    const db = fakeDb(
      { new_client_waitlist_entries: { data: [rel("a")], count: 1 }, new_client_waitlist_invitations: { data: [] } },
      selects,
    );
    await loadDeclinedAttention(db, "s");
    expect(selects).toEqual(["new_client_waitlist_entries:id,name,released_at", "new_client_waitlist_invitations:entry_id,declined_at"]);
  });

  it("reports the true total beyond the shown limit", async () => {
    const many = Array.from({ length: DECLINED_SHOW_LIMIT + 3 }, (_, i) => rel(`e${i}`));
    const db = fakeDb({
      new_client_waitlist_entries: { data: many, count: many.length },
      new_client_waitlist_invitations: { data: many.map((m) => ({ entry_id: m.id, declined_at: T1 })) },
    });
    const r = await loadDeclinedAttention(db, "s");
    expect(r.kind === "ok" && r.total).toBe(DECLINED_SHOW_LIMIT + 3);
    expect(r.kind === "ok" && r.shown.length).toBe(DECLINED_SHOW_LIMIT);
  });

  it("is unknown, never zero, on a read error or an incomplete count", async () => {
    expect(
      (await loadDeclinedAttention(fakeDb({ new_client_waitlist_entries: { data: null, error: { message: "x" } } }), "s")).kind,
    ).toBe("unknown");
    expect(
      (await loadDeclinedAttention(fakeDb({ new_client_waitlist_entries: { data: [rel("a")], count: 5 } }), "s")).kind,
    ).toBe("unknown");
    expect(
      (
        await loadDeclinedAttention(
          fakeDb({
            new_client_waitlist_entries: { data: [rel("a")], count: 1 },
            new_client_waitlist_invitations: { data: null, error: { message: "x" } },
          }),
          "s",
        )
      ).kind,
    ).toBe("unknown");
  });

  it("ok with zero when nothing is released", async () => {
    const r = await loadDeclinedAttention(fakeDb({ new_client_waitlist_entries: { data: [], count: 0 } }), "s");
    expect(r).toMatchObject({ kind: "ok", total: 0 });
  });
});

describe("statusMeaning for a released entry that declined", () => {
  it("says the times didn’t work and that returning restores the original place", () => {
    const s = statusMeaning("released", { declinedByRecipient: true });
    expect(s).toContain("They said the offered times didn’t work. Return them to the waitlist to restore their original place.");
    expect(s).toContain("different one");
  });
  it("leaves the ordinary released sentence alone otherwise", () => {
    expect(statusMeaning("released", {})).toBe("Off the waitlist for now. Return them to it to put them back in line.");
  });
});
