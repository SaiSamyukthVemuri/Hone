import { describe, expect, it } from "vitest";
import { MANUAL_CHOICES_PER_PERSON, loadManualBookingChoices } from "@/lib/waitlist/manual-booking-choices";

type Q = { table: string; limit?: number; client?: string };
function fakeDb(opts: { clients?: unknown; appts?: Record<string, unknown>; boom?: boolean }) {
  const calls: Q[] = [];
  const db = {
    from(table: string) {
      const q: Q = { table };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "neq", "gte", "order"]) b[m] = (...a: unknown[]) => { if (m === "eq" && a[0] === "client_id") q.client = String(a[1]); return b; };
      b.limit = (n: number) => { q.limit = n; calls.push(q); return Promise.resolve(opts.appts ? { data: opts.appts[q.client ?? ""] ?? [], error: null } : { data: null, error: { message: "x" } }); };
      b.then = (res: (v: unknown) => unknown) => { calls.push(q); if (opts.boom) throw new Error("synthetic"); return Promise.resolve(opts.clients ?? { data: null, error: { message: "x" } }).then(res); };
      return b;
    },
  };
  return { db: db as never, calls };
}
const lab = (s: string, h = "") => `at ${s}${h ? ` · ${h}` : ""}`;

describe("loadManualBookingChoices", () => {
  it("offers every appointment of every client sharing the entry's email, case-folded, with no 10-row cap", async () => {
    const appts = Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, starts_at: `2026-12-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z` }));
    const { db, calls } = fakeDb({ clients: { data: [{ id: "c1", normalized_email: "p@example.test" }, { id: "c2", normalized_email: "p@example.test" }], error: null }, appts: { c1: appts, c2: [{ id: "b1", starts_at: "2026-12-30T10:00:00Z" }] } });
    const r = await loadManualBookingChoices(db, "s", [{ id: "e1", email: " P@Example.test " }], lab);
    expect(r.get("e1")?.length).toBe(26);
    expect(calls.filter((c) => c.limit).every((c) => c.limit === MANUAL_CHOICES_PER_PERSON)).toBe(true);
    expect(MANUAL_CHOICES_PER_PERSON).toBeGreaterThan(10);
  });
  it("an entry whose email matches no client has no choices", async () => {
    const { db } = fakeDb({ clients: { data: [], error: null }, appts: {} });
    expect((await loadManualBookingChoices(db, "s", [{ id: "e1", email: "x@example.test" }], lab)).size).toBe(0);
  });
  it("an unreadable client read offers nothing", async () => {
    const { db } = fakeDb({ appts: {} });
    expect((await loadManualBookingChoices(db, "s", [{ id: "e1", email: "x@example.test" }], lab)).size).toBe(0);
  });
  it("a thrown read offers nothing, and a blank email is skipped without a read", async () => {
    const { db, calls } = fakeDb({ boom: true });
    expect((await loadManualBookingChoices(db, "s", [{ id: "e1", email: "x@example.test" }], lab)).size).toBe(0);
    const f = fakeDb({});
    expect((await loadManualBookingChoices(f.db, "s", [{ id: "e1", email: "  " }], lab)).size).toBe(0);
    expect(f.calls.length).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("appointmentHint", () => {
  it("is the service name and the practitioner's initials, so a parent's and a child's appointments differ", async () => {
    const { appointmentHint } = await import("@/lib/waitlist/manual-booking-choices");
    expect(appointmentHint({ name: "Laser" }, { display_name: "Jane Doe" })).toBe("Laser · JD");
    expect(appointmentHint([{ name: "Electrolysis" }], [{ display_name: "sam v lee" }])).toBe("Electrolysis · SV");
    expect(appointmentHint(null, { display_name: "Jane Doe" })).toBe("JD");
    expect(appointmentHint(undefined, undefined)).toBe("");
    expect(appointmentHint({ name: 5 }, { display_name: 7 })).toBe("");
  });
});
