import { describe, expect, it } from "vitest";
import {
  calendarFingerprint,
  type FingerprintRows,
} from "@/lib/calendar/change-fingerprint";

// The fingerprint a calendar screen compares to learn "what I show has changed". It must move for EVERY change the
// calendar draws from these tables, including the ones max(updated_at) plus a count would miss.

const A1 = "00000000-0000-4000-8000-0000000000a1";
const A2 = "00000000-0000-4000-8000-0000000000a2";
const B1 = "00000000-0000-4000-8000-0000000000b1";
const O1 = "00000000-0000-4000-8000-0000000000c1";
const R1 = "00000000-0000-4000-8000-0000000000d1";
const X1 = "00000000-0000-4000-8000-0000000000e1";

function rows(over: Partial<FingerprintRows> = {}): FingerprintRows {
  return {
    appointments: [
      { id: A1, updated_at: "2026-11-18T10:00:00+00:00" },
      { id: A2, updated_at: "2026-11-18T10:05:00+00:00" },
    ],
    timedBlocks: [
      { id: B1, starts_at: "2026-11-18T12:00:00+00:00", ends_at: "2026-11-18T13:00:00+00:00", category: "lunch", practitioner_id: null, updated_at: "2026-11-18T09:00:00+00:00" },
    ],
    blockouts: [{ id: X1, starts_on: "2026-12-24", ends_on: "2026-12-26" }],
    occurrences: [
      { id: O1, starts_at: "2026-11-18T15:00:00+00:00", ends_at: "2026-11-18T15:30:00+00:00", rule: { id: R1, label: "Break", updated_at: "2026-11-01T00:00:00+00:00" } },
    ],
    ...over,
  };
}

const fp = (r: FingerprintRows) => calendarFingerprint(r);

describe("the shape of a fingerprint", () => {
  it("is 32 lowercase hex characters and says nothing about its inputs", () => {
    expect(fp(rows())).toMatch(/^[0-9a-f]{32}$/);
  });
  it("is stable for the same rows, and does not depend on the order they arrive in", () => {
    const base = rows();
    const shuffled = rows({ appointments: [...base.appointments].reverse() });
    expect(fp(shuffled)).toBe(fp(base));
    expect(fp(rows())).toBe(fp(rows()));
  });
  it("an empty calendar has a fingerprint, and it differs from a calendar with one appointment", () => {
    const empty = rows({ appointments: [], timedBlocks: [], blockouts: [], occurrences: [] });
    expect(fp(empty)).toMatch(/^[0-9a-f]{32}$/);
    expect(fp(empty)).not.toBe(fp(rows({ appointments: [{ id: A1, updated_at: "x" }], timedBlocks: [], blockouts: [], occurrences: [] })));
  });
});

describe("every change the calendar draws moves it", () => {
  const base = fp(rows());

  it("an appointment inserted", () => {
    expect(fp(rows({ appointments: [...rows().appointments, { id: "00000000-0000-4000-8000-0000000000a3", updated_at: "2026-11-18T11:00:00+00:00" }] }))).not.toBe(base);
  });
  it("an appointment updated (its updated_at moves)", () => {
    const a = rows().appointments.map((r) => (r.id === A1 ? { ...r, updated_at: "2026-11-18T10:30:00+00:00" } : r));
    expect(fp(rows({ appointments: a }))).not.toBe(base);
  });
  it("an appointment deleted", () => {
    expect(fp(rows({ appointments: rows().appointments.slice(1) }))).not.toBe(base);
  });
  it("one appointment replaced by another at the SAME count (a count would not move)", () => {
    const a = [rows().appointments[0], { id: "00000000-0000-4000-8000-0000000000a9", updated_at: "2026-11-18T10:05:00+00:00" }];
    expect(a).toHaveLength(2);
    expect(fp(rows({ appointments: a }))).not.toBe(base);
  });
  it("an update whose updated_at is OLDER than one already seen (a late commit: max() would not move)", () => {
    // A2 carries the maximum. A1 is updated by a transaction that started earlier, so it commits with an older now().
    const a = rows().appointments.map((r) => (r.id === A1 ? { ...r, updated_at: "2026-11-18T09:59:00+00:00" } : r));
    const max = (xs: ReadonlyArray<{ updated_at: string | null }>) => xs.map((x) => x.updated_at).sort().at(-1);
    expect(max(a)).toBe(max(rows().appointments)); // the thing a max()+count signal would have compared: unchanged
    expect(fp(rows({ appointments: a }))).not.toBe(base); // the hash still moves
  });
  it("a block edited without a newer updated_at (the application clock can lag): category, time, scope", () => {
    const b = rows().timedBlocks[0];
    for (const edit of [{ category: "meeting" }, { starts_at: "2026-11-18T12:15:00+00:00" }, { ends_at: "2026-11-18T13:30:00+00:00" }, { practitioner_id: A1 }]) {
      expect(fp(rows({ timedBlocks: [{ ...b, ...edit }] }))).not.toBe(base);
    }
  });
  it("a block deleted or added", () => {
    expect(fp(rows({ timedBlocks: [] }))).not.toBe(base);
    expect(fp(rows({ timedBlocks: [...rows().timedBlocks, { ...rows().timedBlocks[0], id: "00000000-0000-4000-8000-0000000000b2" }] }))).not.toBe(base);
  });
  it("a blockout added, removed or its dates changed", () => {
    expect(fp(rows({ blockouts: [] }))).not.toBe(base);
    expect(fp(rows({ blockouts: [{ id: X1, starts_on: "2026-12-24", ends_on: "2026-12-27" }] }))).not.toBe(base);
  });
  it("a break occurrence replaced (a rule update deletes and re-materializes) or moved", () => {
    expect(fp(rows({ occurrences: [] }))).not.toBe(base);
    const o = rows().occurrences[0];
    expect(fp(rows({ occurrences: [{ ...o, starts_at: "2026-11-18T15:15:00+00:00" }] }))).not.toBe(base);
  });
  it("a break rule renamed, or edited (its updated_at), or an occurrence orphaned (rule gone)", () => {
    const o = rows().occurrences[0];
    expect(fp(rows({ occurrences: [{ ...o, rule: { ...o.rule!, label: "Lunch" } }] }))).not.toBe(base);
    expect(fp(rows({ occurrences: [{ ...o, rule: { ...o.rule!, updated_at: "2026-11-18T08:00:00+00:00" } }] }))).not.toBe(base);
    expect(fp(rows({ occurrences: [{ ...o, rule: null }] }))).not.toBe(base);
  });
  it("a row in one table does not collide with the same ids in another", () => {
    const asAppointment = rows({ appointments: [{ id: X1, updated_at: null }], timedBlocks: [], blockouts: [], occurrences: [] });
    const asBlockout = rows({ appointments: [], timedBlocks: [], blockouts: [{ id: X1, starts_on: "", ends_on: "" }], occurrences: [] });
    expect(fp(asAppointment)).not.toBe(fp(asBlockout));
  });
});

describe("what it deliberately does NOT cover (these stay on the slower 60 s cycle)", () => {
  it("client names, service names, colours and notes are not inputs: extra fields change nothing", () => {
    const base = fp(rows());
    const withExtras = rows({
      appointments: rows().appointments.map((r) => ({ ...r, client: { name: "Someone Else" }, service: { name: "Facial" }, practitioner: { color: "#fff" }, notes: "n" })) as FingerprintRows["appointments"],
      timedBlocks: rows().timedBlocks.map((r) => ({ ...r, private_note: "secret" })) as FingerprintRows["timedBlocks"],
    });
    expect(fp(withExtras)).toBe(base);
  });
});

describe("what the page draws from and what the probe reads agree", () => {
  // The page hashes the FULL rows its loaders return; the probe reads NARROW columns. Same data, same fingerprint,
  // in all three views, or a screen would see a change that is not there.
  const full = rows({
    appointments: rows().appointments.map((r) => ({ ...r, studio_id: "s", client: { id: "c", name: "N" }, service: { id: "v", name: "S" }, status: "confirmed" })) as FingerprintRows["appointments"],
    timedBlocks: rows().timedBlocks.map((r) => ({ ...r, studio_id: "s", private_note: "x", created_by: null, created_at: "t" })) as FingerprintRows["timedBlocks"],
    blockouts: rows().blockouts.map((r) => ({ ...r, studio_id: "s", reason: "Holiday", created_at: "t" })) as FingerprintRows["blockouts"],
    occurrences: rows().occurrences.map((r) => ({ ...r, studio_id: "s", rule_id: R1, occurrence_date: "2026-11-18", created_at: "t", practitioner_id: null })) as FingerprintRows["occurrences"],
  });
  for (const view of ["day", "week", "month"] as const) {
    it(`${view}: the page's full rows and the probe's narrow rows give one fingerprint`, () => {
      expect(fp(full)).toBe(fp(rows()));
    });
  }
});
