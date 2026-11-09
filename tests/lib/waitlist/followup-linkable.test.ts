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
  const limits: Array<[string, number]> = [];
  const db = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const orders: Array<[string, boolean]> = [];
      let cap = Infinity;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
        neq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] !== v)), q),
        gte: (c: string, v: string) => ((rows = rows.filter((r) => String(r[c]) >= v)), q),
        in: (c: string, vs: unknown[]) => (inCols.push([table, c]), inSizes.push([table, vs.length]), (rows = rows.filter((r) => vs.includes(r[c]))), q),
        order: (c: string, o?: { ascending?: boolean }) => (orders.push([c, o?.ascending !== false]), q),
        limit: (n: number) => (limits.push([table, n]), (cap = n), q),
        then: (res: (v: unknown) => unknown) => {
          const sorted = [...rows].sort((a, b) => {
            for (const [c, asc] of orders) {
              const d = String(a[c]).localeCompare(String(b[c]));
              if (d !== 0) return asc ? d : -d;
            }
            return 0;
          });
          return Promise.resolve({ data: sorted.slice(0, cap), error: null }).then(res);
        },
      };
      return q;
    },
  };
  return { db: db as unknown as SupabaseClient, inCols, inSizes, limits };
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
      appointments: [{ id: "a1", studio_id: STUDIO, client_id: "c1", starts_at: "2026-11-12T15:00:00.000Z", created_at: "2026-11-01T09:00:00.000Z", status: "scheduled" }],
    });

  it("offers the link for a client whose stored email is mixed case, by matching normalized_email", async () => {
    const w = world("pat@example.test");
    const out = await loadLinkableAppointments(w.db, STUDIO, [row()], "UTC", NOW);
    expect(out.get("f1")?.items).toHaveLength(1);
    expect(out.get("f1")?.items[0].id).toBe("a1");
    expect(w.inCols).toContainEqual(["clients", "normalized_email"]);
    expect(w.inCols).not.toContainEqual(["clients", "email"]);
  });
  it("offers nothing for a different person, and nothing for a non-open row", async () => {
    expect((await loadLinkableAppointments(world("someone@else.test").db, STUDIO, [row()], "UTC", NOW)).size).toBe(0);
    expect((await loadLinkableAppointments(world("pat@example.test").db, STUDIO, [row({ status: "handled" })], "UTC", NOW)).size).toBe(0);
  });
  it("labels carry a date and time only", async () => {
    const out = await loadLinkableAppointments(world("pat@example.test").db, STUDIO, [row()], "UTC", NOW);
    expect(out.get("f1")?.items[0].label).toMatch(/Nov 12/);
    expect(out.get("f1")?.items[0].label).not.toMatch(/pat|example|Synthetic/i);
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
      appointments.push({ id: `a${i}`, studio_id: STUDIO, client_id: `c${i}`, starts_at: "2026-11-12T15:00:00.000Z", created_at: "2026-11-01T09:00:00.000Z", status: "scheduled" });
      rows.push(row({ followupId: `f${i}`, entryId: `e${i}`, invitationId: `i${i}` }));
    }
    return { rows, w: fake({ new_client_waitlist_entries: entries, clients, appointments }) };
  };
  it("25 open responses: the 25th gets its Link booking control", async () => {
    const { rows, w } = many(25);
    const out = await loadLinkableAppointments(w.db, STUDIO, rows, "UTC", NOW);
    expect(out.size).toBe(25);
    expect(out.get("f24")?.items[0].id).toBe("a24");
  });
  it("120 open responses: all are linkable, and no id list is longer than 50", async () => {
    const { rows, w } = many(120);
    const out = await loadLinkableAppointments(w.db, STUDIO, rows, "UTC", NOW);
    expect(out.size).toBe(120);
    expect(out.get("f119")?.items[0].id).toBe("a119");
    expect(Math.max(...w.inSizes.map(([, n]) => n))).toBeLessThanOrEqual(50);
  });
  it("a person with several upcoming appointments never hides another person's candidates", async () => {
    const { rows, w } = many(3);
    const extra = Array.from({ length: 30 }, (_, k) => ({ id: `x${k}`, studio_id: STUDIO, client_id: "c0", starts_at: `2026-11-1${(k % 9) + 1}T09:00:00.000Z`, created_at: `2026-11-02T09:${String(k).padStart(2, "0")}:00.000Z`, status: "scheduled" }));
    const w2 = fake({
      new_client_waitlist_entries: [0, 1, 2].map((i) => ({ id: `e${i}`, studio_id: STUDIO, email: `person${i}@example.test` })),
      clients: [0, 1, 2].map((i) => ({ id: `c${i}`, studio_id: STUDIO, normalized_email: `person${i}@example.test` })),
      appointments: [...extra, { id: "a2", studio_id: STUDIO, client_id: "c2", starts_at: "2026-11-30T09:00:00.000Z", created_at: "2026-11-01T09:00:00.000Z", status: "scheduled" }],
    });
    void w;
    const out = await loadLinkableAppointments(w2.db, STUDIO, rows, "UTC", NOW);
    expect(out.get("f2")?.items[0].id).toBe("a2");
    // person 0 is bounded to the cap and told there are more; person 2 is not
    expect(out.get("f0")?.items).toHaveLength(10);
    expect(out.get("f0")?.more).toBe(true);
    expect(out.get("f2")?.more).toBe(false);
  });
});

describe("the booking just made is always offered (Codex P2, contract step 6)", () => {
  const person = (appointments: Array<Record<string, unknown>>) =>
    fake({
      new_client_waitlist_entries: [{ id: "e1", studio_id: STUDIO, email: "pat@example.test" }],
      clients: [{ id: "c1", studio_id: STUDIO, normalized_email: "pat@example.test" }],
      appointments,
    });
  const appt = (id: string, startsDay: number, createdIso: string) => ({
    id, studio_id: STUDIO, client_id: "c1", starts_at: `2026-11-${String(startsDay).padStart(2, "0")}T10:00:00.000Z`, created_at: createdIso, status: "scheduled",
  });
  it("6 older appointments that start EARLIER plus 1 just created that starts LATER: the new one is offered", async () => {
    const older = Array.from({ length: 6 }, (_, i) => appt(`old${i}`, 10 + i, `2026-10-0${i + 1}T09:00:00.000Z`));
    const w = person([...older, appt("just-made", 28, "2026-11-09T11:59:00.000Z")]);
    const out = await loadLinkableAppointments(w.db, STUDIO, [row()], "UTC", NOW);
    const ids = out.get("f1")?.items.map((a) => a.id);
    expect(ids).toContain("just-made");
    expect(ids?.[0]).toBe("just-made"); // most recently booked first
    expect(out.get("f1")?.more).toBe(false);
  });
  it("the per-person bound holds: at most 10 shown, one extra row read to know there are more, and the note is raised", async () => {
    const lots = Array.from({ length: 14 }, (_, i) => appt(`a${String(i).padStart(2, "0")}`, 12 + (i % 15), `2026-10-${String(i + 1).padStart(2, "0")}T09:00:00.000Z`));
    const w = person([...lots, appt("just-made", 29, "2026-11-09T11:59:00.000Z")]);
    const out = await loadLinkableAppointments(w.db, STUDIO, [row()], "UTC", NOW);
    expect(out.get("f1")?.items).toHaveLength(10);
    expect(out.get("f1")?.items[0].id).toBe("just-made");
    expect(out.get("f1")?.more).toBe(true);
    expect(w.limits.filter(([t]) => t === "appointments")).toEqual([["appointments", 11]]);
  });
  it("exactly 10 eligible appointments: all shown, no 'more' note", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => appt(`t${i}`, 12 + i, `2026-10-${String(i + 1).padStart(2, "0")}T09:00:00.000Z`));
    const out = await loadLinkableAppointments(person(ten).db, STUDIO, [row()], "UTC", NOW);
    expect(out.get("f1")?.items).toHaveLength(10);
    expect(out.get("f1")?.more).toBe(false);
  });
  it("the read asks the database for newest-booked first, then by id, never by start time", async () => {
    const src = (await import("node:fs")).readFileSync("lib/waitlist/followup-linkable.ts", "utf8");
    expect(src).toContain('.order("created_at", { ascending: false })');
    expect(src).not.toContain('.order("starts_at"');
  });
});
