import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { summarizeTreatmentTime } from "@/lib/sessions/treatment-time-summary";
import { buildTreatmentIntelligence } from "@/lib/sessions/treatment-intelligence";

// Four blocks, each with a DIFFERENT pair of hairs and minutes (the four-mode acceptance).
type B = { id: string; minutes: number | null; hairs: number };
const four = (): B[] => [
  { id: "a", minutes: 12, hairs: 31 },
  { id: "b", minutes: 9, hairs: 47 },
  { id: "c", minutes: 21, hairs: 58 },
  { id: "d", minutes: 15, hairs: 64 },
];
const sum = (bs: B[]) => bs.reduce((t, b) => t + (b.minutes ?? 0), 0);

type Row = { minutes_performed: number | null; started_at: string | null; ended_at: string | null; deleted_at: string | null };
const timeRows = (bs: B[]): Row[] => bs.map((b) => ({ minutes_performed: b.minutes, started_at: null, ended_at: null, deleted_at: null }));
const pageTotal = (bs: B[]) => timeRows(bs).reduce((s, b) => s + (b.minutes_performed ?? 0), 0); // the profile page's reduce, over CURRENT rows
const intel = (bs: B[], extraEntryHairs: number[] = []) =>
  buildTreatmentIntelligence({
    sessionsNewestFirst: [{ id: "s1", started_at: "2026-11-19T10:00:00Z", record_status: null, electrolysis_entries: [], laser_entries: [] }],
    blocks: bs.map((b, i) => ({
      session_id: "s1", primary_area: `Area ${i}`, block_name: null, mode: "thermo", apilus_modality: null, energy_level: null,
      machine_frequency: null, probe_label: null, minutes_performed: b.minutes, tolerance_rating: null, reaction_type: null,
      caution_for_next_session: false, caution_note: null,
      entry_hairs: i === 0 ? [b.hairs, ...extraEntryHairs] : [b.hairs],
    })),
  });

const totalsOf = (bs: B[], extra: number[] = []) => ({
  summary: summarizeTreatmentTime(timeRows(bs)).recordedMinutes,
  page: pageTotal(bs),
  intelligence: intel(bs, extra).overall.minutes,
});

describe("the visit minutes total always equals the sum of the CURRENT block values (all three readers)", () => {
  it("baseline", () => {
    expect(totalsOf(four())).toEqual({ summary: 57, page: 57, intelligence: 57 });
  });
  it("editing a block's minutes REPLACES the old value: never stale plus new", () => {
    const bs = four();
    bs[1].minutes = 25; // edit 9 -> 25
    expect(sum(bs)).toBe(73);
    expect(totalsOf(bs)).toEqual({ summary: 73, page: 73, intelligence: 73 });
  });
  it("reopening (same rows read again) and a Save visit re-save of unchanged values do not change the total", () => {
    const first = totalsOf(four());
    const reopened = totalsOf(four().map((b) => ({ ...b })));
    const resaved = totalsOf(four().map((b) => ({ ...b, minutes: b.minutes })));
    expect(reopened).toEqual(first);
    expect(resaved).toEqual(first);
  });
  it("an add-pass adds entry hairs but NEVER minutes", () => {
    const withPass = totalsOf(four(), [10, 12]);
    expect(withPass.intelligence).toBe(57);
    expect(withPass.summary).toBe(57);
    expect(intel(four(), [10, 12]).overall.hairs).toBe(31 + 47 + 58 + 64 + 22);
  });
  it("a cleared minutes value drops out of the total instead of lingering", () => {
    const bs = four();
    bs[2].minutes = null;
    expect(totalsOf(bs)).toEqual({ summary: 36, page: 36, intelligence: 36 });
  });
  it("a removed block leaves the time summary", () => {
    const rows = timeRows(four());
    rows[0] = { ...rows[0], deleted_at: "2026-11-19T11:00:00Z" };
    expect(summarizeTreatmentTime(rows).recordedMinutes).toBe(45);
  });
});

describe("the server writes a block's minutes as an ABSOLUTE value (source pin)", () => {
  const src = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts", "utf8");
  it("no read-modify-write of minutes_performed", () => {
    expect(src).not.toMatch(/minutes_performed\s*[:=]\s*[^,\n]*minutes_performed\s*\+/);
    expect(src).not.toMatch(/minutes_performed\s*\+=/);
  });
  it("the profile page's last-visit total is a reduce over the loaded blocks only", () => {
    const page = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
    expect(page).toMatch(/lastTreatmentTotalMinutes = lastTreatmentBlocks\.reduce\(\s*\(sum, b\) => sum \+ \(b\.minutes_performed \?\? 0\),\s*0,?\s*\)/);
  });
});
