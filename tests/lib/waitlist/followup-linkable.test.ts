import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadLinkableAppointments } from "@/lib/waitlist/followup-linkable";
import type { FollowUpRow } from "@/lib/waitlist/followups-owner";

// A fake that honours only the filters the helper uses, and records the column each `in` filtered on.
const STUDIO = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-09T12:00:00.000Z");

function fake(tables: Record<string, Array<Record<string, unknown>>>) {
  const inCols: Array<[string, string]> = [];
  const inSizes: Array<[string, number]> = [];
  const db = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
        neq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] !== v)), q),
        gte: (c: string, v: string) => ((rows = rows.filter((r) => String(r[c]) >= v)), q),
        in: (c: string, vs: unknown[]) => (inCols.push([table, c]), inSizes.push([table, vs.length]), (rows = rows.filter((r) => vs.includes(r[c]))), q),
        order: () => q,
        limit: () => q,
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
      };
      return q;
    },
  };
  return { db: db as unknown as SupabaseClient, inCols, inSizes };
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

describe("every displayed open follow-up is linkable, not just the first 20", () => {
  const many = (n: number) => {
    const entries: Array<Record<string, unknown>> = [];
    const clients: Array<Record<string, unknown>> = [];
    const appointments: Array<Record<string, unknown>> = [];
    const rows: FollowUpRow[] = [];
    for (let i = 0; i < n; i += 1) {
      entries.push({ id: `e${i}`, studio_id: STUDIO, email: `Person${i}@Example.TEST` });
      clients.push({ id: `c${i}`, studio_id: STUDIO, normalized_email: `person${i}@example.test` });
      appointments.push({ id: `a${i}`, studio_id: STUDIO, client_id: `c${i}`, starts_at: "2026-11-12T15:00:00.000Z", status: "scheduled" });
      rows.push(row({ followupId: `f${i}`, entryId: `e${i}`, invitationId: `i${i}` }));
    }
    return { rows, w: fake({ new_client_waitlist_entries: entries, clients, appointments }) };
  };
  it("25 open responses: the 25th gets its Link booking control", async () => {
    const { rows, w } = many(25);
    const out = await loadLinkableAppointments(w.db, STUDIO, rows, "UTC", NOW);
    expect(out.size).toBe(25);
    expect(out.get("f24")?.[0].id).toBe("a24");
  });
  it("120 open responses: all are linkable, and no id list is longer than 50", async () => {
    const { rows, w } = many(120);
    const out = await loadLinkableAppointments(w.db, STUDIO, rows, "UTC", NOW);
    expect(out.size).toBe(120);
    expect(out.get("f119")?.[0].id).toBe("a119");
    expect(Math.max(...w.inSizes.map(([, n]) => n))).toBeLessThanOrEqual(50);
  });
  it("a person with several upcoming appointments never hides another person's candidates", async () => {
    const { rows, w } = many(3);
    const extra = Array.from({ length: 30 }, (_, k) => ({ id: `x${k}`, studio_id: STUDIO, client_id: "c0", starts_at: `2026-11-1${(k % 9) + 1}T09:00:00.000Z`, status: "scheduled" }));
    const w2 = fake({
      new_client_waitlist_entries: [0, 1, 2].map((i) => ({ id: `e${i}`, studio_id: STUDIO, email: `person${i}@example.test` })),
      clients: [0, 1, 2].map((i) => ({ id: `c${i}`, studio_id: STUDIO, normalized_email: `person${i}@example.test` })),
      appointments: [...extra, { id: "a2", studio_id: STUDIO, client_id: "c2", starts_at: "2026-11-30T09:00:00.000Z", status: "scheduled" }],
    });
    void w;
    const out = await loadLinkableAppointments(w2.db, STUDIO, rows, "UTC", NOW);
    expect(out.get("f2")?.[0].id).toBe("a2");
  });
});
