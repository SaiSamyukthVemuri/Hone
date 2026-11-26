import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { csvCell } from "@/lib/csv";
import { buildPointOfCareMemory, toClinicalSummaryBlocks, type PointOfCareBlock } from "@/lib/sessions/point-of-care-memory";
import { buildTreatmentSetupDraftPatch, type SetupSourceEntry } from "@/lib/sessions/treatment-setup-snapshot";

// A blank pulse count (NULL) is a valid stored value once the pulse-count migration is applied. This pins how each reader treats it, so a reader
// that assumed a non-null count cannot be added unnoticed. The census of readers lives in docs/proposals/pulse-count-null.notes.md.

const entry = (over: Partial<SetupSourceEntry> = {}): SetupSourceEntry => ({
  created_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  mode: "thermo",
  thermolysis_intensity_percent: 30,
  thermolysis_duration_seconds: 2,
  galvanic_ma: null,
  galvanic_duration_seconds: null,
  units_of_lye: null,
  pulse_count: null,
  pulse_delay_seconds: null,
  ...over,
});

describe("copy-from-last: a blank pulse count copies as blank", () => {
  it("a NULL count and delay produce an empty count and an empty delay, not 1", () => {
    const p = buildTreatmentSetupDraftPatch({ mode: "thermo" } as never, entry());
    expect(p.pulseCount).toBe("");
    expect(p.pulseDelay).toBe("");
  });
  it("a stored 1 still copies as 1 and carries no delay; a stored 3 keeps its delay", () => {
    expect(buildTreatmentSetupDraftPatch({ mode: "thermo" } as never, entry({ pulse_count: 1, pulse_delay_seconds: 0.5 })).pulseDelay).toBe("");
    const three = buildTreatmentSetupDraftPatch({ mode: "thermo" } as never, entry({ pulse_count: 3, pulse_delay_seconds: 0.5 }));
    expect(three.pulseCount).toBe("3");
    expect(three.pulseDelay).toBe("0.5");
  });
});

describe("readers guard a NULL count (source contracts)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("the saved-entry row shows a count and a delay only when the count is present", () => {
    const s = read("components/entry-row.tsx");
    // THE RULE, not the spelling: the row reads the count through ONE local (native blocks null it), and shows the delay only when that count is
    // present and above 1, and the count line only when it is present. A NULL count therefore shows neither.
    expect(s).toMatch(/const pulseCount = [^;]*entry\.pulse_count;/);
    expect(s).toMatch(/pulseCount != null\s*&&\s*pulseCount > 1/);
    expect(s).toMatch(/isThermoish && pulseCount != null/);
    expect(s).not.toMatch(/pulseCount\s*(\?\?|\|\|)\s*0\b/);
  });
  it("the point-of-care and clinical summary read the count through the nullable number reader", () => {
    const s = read("lib/sessions/point-of-care-memory.ts");
    expect(s).toMatch(/const pulseCount = num\(canonical\?\.pulse_count\)/);
    expect(s).toMatch(/pulseCount != null\s*\?\s*`\$\{pulseCount\} \$\{pulseCount === 1/);
    expect(s).toMatch(/pulseCount != null && pulseCount > 1 && delay != null/);
  });
  it("the edit forms fall back to the default count for a NULL row (a re-save is a touched count)", () => {
    expect(read("components/log-electrolysis-entry-form.tsx")).toMatch(/e\.pulse_count != null \? String\(e\.pulse_count\) : String\(PULSE_COUNT_DEFAULT\)/);
    expect(read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx")).toMatch(/firstEntry\?\.pulse_count != null/);
  });
  it("the generated database type allows NULL", () => {
    expect(read("lib/types/database.ts")).toMatch(/pulse_count: number \| null;/);
  });
});

describe("every application write path sends a count of at least one (so an Off studio's stored values do not change)", () => {
  const actions = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts", "utf8");
  const simple = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts", "utf8");
  it("entry-writing block commands send the clamped count; the two null senders create no entry (p_with_entry false)", () => {
    expect((actions.match(/p_pulse_count: clampPulseCount\(readings\.pulseCount\)/g) ?? []).length).toBe(2);
    const nulls = [...actions.matchAll(/p_with_entry: (true|false),[\s\S]{0,400}?p_pulse_count: null/g)];
    expect(nulls.length).toBe(2);
    for (const m of nulls) expect(m[1]).toBe("false");
  });
  it("the simplified entry command sends the clamped count", () => {
    expect(simple).toMatch(/p_pulse_count: pulseCount/);
    expect(simple).toMatch(/const pulseCount = clampedPulseCount\(/);
  });
});

describe("a NULL count renders as blank or not recorded, never 0 or null (census rows that were read-only)", () => {
  const blk = (count: number | null): PointOfCareBlock =>
    ({ id: "b1", sort_order: 1, mode: "thermo", entries: [{ created_at: "2026-01-01T10:00:00Z", deleted_at: null, mode: "thermo", thermolysis_intensity_percent: 30, thermolysis_duration_seconds: 2, pulse_count: count, pulse_delay_seconds: null }] }) as PointOfCareBlock;
  const memory = (b: PointOfCareBlock) => buildPointOfCareMemory({ session: { id: "s", started_at: "2026-01-01T10:00:00Z", modality: "electrolysis" }, blocks: [b] });

  it("client page and clinical summary: the point-of-care memory shows no pulse line for a blank count, and still shows it for a stored one", () => {
    const blank = JSON.stringify(memory(blk(null)));
    expect(blank).not.toMatch(/pulse/i);
    expect(blank).not.toMatch(/"null"|\b0 pulses?\b|NaN|undefined/);
    expect(JSON.stringify(memory(blk(3)))).toMatch(/3 pulses/);
    expect(JSON.stringify(memory(blk(1)))).toMatch(/1 pulse\b/);
  });
  it("the clinical summary blocks keep a blank count out of their text", () => {
    expect(JSON.stringify(toClinicalSummaryBlocks([blk(null)]))).not.toMatch(/"null"|\b0 pulses?\b|NaN/);
  });
  it("export: a NULL count is an empty cell, and the entries export still lists the column", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(3)).toBe("3");
    expect(readFileSync("app/(app)/settings/data/actions.ts", "utf8")).toMatch(/duration_seconds, pulse_count, pulse_delay_seconds/);
  });
  it("appointment prep: it no longer reads the pulse count at all (production's prior-treatment card replaced the per-pass comparison), so no blank can become 0 there", () => {
    // The rule that matters: nothing on the prep path turns a blank count into a number. Production removed the per-pass comparison that
    // normalised it, so the guard is that no prep source coerces or defaults the count.
    for (const f of ["lib/sessions/appointment-prep-memory.ts", "components/dashboard-prior-treatment.tsx", "components/appointment-prep-memory-card.tsx"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/pulse_count\s*(\?\?|\|\|)\s*\d/);
      expect(s, f).not.toMatch(/Number\([^)]*pulse_count/);
    }
  });
  it("last-treatment loader: the count is selected and passed through; nothing coerces it to a number or a default", () => {
    const s = readFileSync("lib/sessions/last-treatment-loader.ts", "utf8");
    expect(s).toMatch(/units_of_lye, pulse_count, /);
    expect(s).not.toMatch(/pulse_count\s*(\?\?|\|\|)\s*[01]/);
    expect(s).not.toMatch(/Number\([^)]*pulse_count/);
  });
  it("no reader anywhere defaults a stored count to 0 or 1 or wraps it in Number()", () => {
    for (const f of ["components/entry-row.tsx", "lib/sessions/point-of-care-memory.ts", "lib/sessions/treatment-setup-snapshot.ts", "lib/sessions/appointment-prep-memory.ts"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/pulse_count\s*(\?\?|\|\|)\s*[01]\b/);
      expect(s, f).not.toMatch(/Number\(\s*[\w.?]*pulse_count\s*\)/);
    }
  });
});
