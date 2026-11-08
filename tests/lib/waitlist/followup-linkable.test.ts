import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadLinkableAppointments } from "@/lib/waitlist/followup-linkable";
import type { FollowUpRow } from "@/lib/waitlist/followups-owner";

// A fake that honours only the filters the helper uses, and records the column each `in` filtered on.
const STUDIO = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-09T12:00:00.000Z");

function fake(tables: Record<string, Array<Record<string, unknown>>>) {
  const inCols: Array<[string, string]> = [];
  const db = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
        neq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] !== v)), q),
        gte: (c: string, v: string) => ((rows = rows.filter((r) => String(r[c]) >= v)), q),
        in: (c: string, vs: unknown[]) => (inCols.push([table, c]), (rows = rows.filter((r) => vs.includes(r[c]))), q),
        order: () => q,
        limit: () => q,
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
      };
      return q;
    },
  };
  return { db: db as unknown as SupabaseClient, inCols };
}

const row = (o: Partial<FollowUpRow> = {}): FollowUpRow => ({
  followupId: "f1", kind: "decline", invitationId: "i1", entryId: "e1", clientName: "Synthetic Person", openedAt: "", status: "open",
  whyNotWork: null, betterTimes: null, answersErasedAt: null, submittedAt: null, closedAt: null, eraseBy: null, ...o,
});

describe("link-booking candidates", () => {
  const world = (clientNormalized: string) =>
    fake({
      new_client_waitlist_entries: [{ id: "e1", studio_id: STUDIO, email: "  Pat@Example.TEST " }],
      // the stored email keeps its original case; normalized_email is the generated, case-folded, trimmed column (0032)
      clients: [{ id: "c1", studio_id: STUDIO, email: "Pat@Example.TEST", normalized_email: clientNormalized }],
      appointments: [{ id: "a1", studio_id: STUDIO, client_id: "c1", starts_at: "2026-11-12T15:00:00.000Z", status: "scheduled" }],
    });

  it("offers the link for a client whose stored email is mixed case, by matching normalized_email", async () => {
    const w = world("pat@example.test");
    const out = await loadLinkableAppointments(w.db, STUDIO, [row()], "UTC", NOW);
    expect(out.get("f1")).toHaveLength(1);
    expect(out.get("f1")?.[0].id).toBe("a1");
    expect(w.inCols).toContainEqual(["clients", "normalized_email"]);
    expect(w.inCols).not.toContainEqual(["clients", "email"]);
  });
  it("offers nothing for a different person, and nothing for a non-open row", async () => {
    expect((await loadLinkableAppointments(world("someone@else.test").db, STUDIO, [row()], "UTC", NOW)).size).toBe(0);
    expect((await loadLinkableAppointments(world("pat@example.test").db, STUDIO, [row({ status: "handled" })], "UTC", NOW)).size).toBe(0);
  });
  it("labels carry a date and time only", async () => {
    const out = await loadLinkableAppointments(world("pat@example.test").db, STUDIO, [row()], "UTC", NOW);
    expect(out.get("f1")?.[0].label).toMatch(/Nov 12/);
    expect(out.get("f1")?.[0].label).not.toMatch(/pat|example|Synthetic/i);
  });
});
