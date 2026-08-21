import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  memoryFromCanonicalVisit,
  summariseVisit,
} from "@/lib/sessions/history/visit-summary";
import type { HistoricalVisitSummary } from "@/lib/sessions/history/visit-summary";
import type { HistoricalVisitDetail } from "@/lib/sessions/history/visit-detail";

const ROOT = path.resolve(__dirname, "../../../..");

const SESSION = {
  id: "s1",
  started_at: "2026-03-12T14:00:00.000000+00:00",
  modality: "electrolysis",
  session_notes: null,
  next_session_note: null,
};

const detail = (over: Partial<HistoricalVisitDetail> = {}): HistoricalVisitDetail => ({
  sessionId: "s1",
  blocks: [],
  orphanEntries: [],
  laserEntries: [],
  ...over,
});

const block = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    primary_area: "Chin",
    side: "midline",
    minutes_performed: 30,
    structured_areas: [{ area: "Chin", laterality: "midline" }],
    entries: [{ created_at: "2026-03-12T14:05:00Z", deleted_at: null, mode: "blend", hairs_treated: 65 }],
    ...over,
  }) as never;

/** Narrow a summary to its visit variant, failing loudly otherwise. */
function visitOf(summary: HistoricalVisitSummary) {
  if (summary.kind !== "visit") throw new Error(`expected a visit, got ${summary.kind}`);
  return summary;
}

const run = (over: Partial<Parameters<typeof summariseVisit>[0]> = {}) =>
  summariseVisit({
    session: SESSION,
    detail: detail(),
    complete: true,
    hasLiveElectrolysisEntries: false,
    supersededByUnchartedVisit: false,
    ...over,
  });

// ---------------------------------------------------------------------------

describe("every treatment channel is a VARIANT, so none can be described as another", () => {
  it("a settings-charted visit reports its areas and totals", () => {
    const { summary } = run({ detail: detail({ blocks: [block("b1")] }) });
    expect(summary.kind).toBe("visit");
    const t = visitOf(summary).treatment;
    if (t.kind !== "charted-areas") throw new Error("expected charted areas");
    expect(t.kind).toBe("charted-areas");
    expect(t.headline).toContain("Chin");
    // `hairs_treated` reaching the model at all is the P1-B fix arriving here.
    expect(t.totalHairs).toBe(65);
  });

  it("a LEGACY entry-only visit is its own variant — never 'no charted areas'", () => {
    // THE FALSE ABSENCE, CLOSED. This visit recorded two passes with no settings
    // block, which is genuinely charted treatment.
    const { summary } = run({
      detail: detail({
        orphanEntries: [
          { id: "e1", block_id: null, deleted_at: null, area: "Chin", comments: "went well" },
          { id: "e2", block_id: null, deleted_at: null, area: "Lip", comments: null },
        ],
      }),
      hasLiveElectrolysisEntries: true,
    });
    expect(summary.kind).toBe("visit");
    expect(visitOf(summary).treatment).toEqual({
      kind: "legacy-entry-only",
      passCount: 2,
    });
  });

  it("a LASER visit keeps its narrative — the only narrative it has", () => {
    const { summary } = run({
      detail: detail({
        laserEntries: [
          { id: "l1", deleted_at: null, zone: "Upper lip", observation_notes: "Zone cleared well." },
          { id: "l2", deleted_at: null, zone: "Chin", observation_notes: null },
        ],
      }),
      session: { ...SESSION, modality: "laser" },
    });
    const t = visitOf(summary).treatment;
    if (t.kind !== "laser") throw new Error("expected laser");
    expect(t.passCount).toBe(2);
    expect(t.narrative).toEqual(["Zone cleared well."]);
  });

  it("blocks win over legacy passes when a visit has both", () => {
    const { summary } = run({
      detail: detail({
        blocks: [block("b1")],
        orphanEntries: [{ id: "e1", block_id: null, deleted_at: null }],
      }),
    });
    expect(visitOf(summary).treatment.kind).toBe("charted-areas");
  });
});

describe("incompleteness is never rendered as a sparse visit", () => {
  it("an INCOMPLETE record yields evidence-unavailable, not a partial visit", () => {
    // Rendering a subset of a visit's areas as though it were the whole visit is
    // a false claim of completeness.
    const { summary, memory } = run({ detail: detail({ blocks: [block("b1")] }), complete: false });
    expect(summary).toEqual({ kind: "evidence-unavailable", reason: "incomplete" });
    expect(memory).toBeNull();
  });

  it("a COMPLETE record that came back empty is unavailable, never 'recorded nothing'", () => {
    // The authority said charted; the record is empty. Both cannot be true.
    const { summary } = run({ detail: detail() });
    expect(summary).toEqual({ kind: "evidence-unavailable", reason: "incomplete" });
  });
});

describe("the superseded claim reaches the model", () => {
  it("true is carried through to the built memory", () => {
    // The line that vanished: "Most recent charted treatment. A newer session
    // has no treatment details yet."
    const memory = memoryFromCanonicalVisit({
      session: SESSION,
      detail: detail({ blocks: [block("b1")] }),
      hasLiveElectrolysisEntries: false,
      supersededByUnchartedVisit: true,
    });
    expect(memory.supersededByEmptySession).toBe(true);
  });

  it("and false stays false", () => {
    const memory = memoryFromCanonicalVisit({
      session: SESSION,
      detail: detail({ blocks: [block("b1")] }),
      hasLiveElectrolysisEntries: false,
      supersededByUnchartedVisit: false,
    });
    expect(memory.supersededByEmptySession).toBe(false);
  });

  it("the summary carries it too", () => {
    const { summary } = run({
      detail: detail({ blocks: [block("b1")] }),
      supersededByUnchartedVisit: true,
    });
    expect(visitOf(summary).supersededByUnchartedVisit).toBe(true);
  });
});

describe("omission is a COMPILE error at the only permitted call site", () => {
  it("the builder is reached through the required-parameter adapter ONLY", () => {
    // THE P1-A REGRESSION GUARD. `AppointmentPrepMemoryInput` marks its four
    // evidence channels optional, so omitting them is not a type error — which
    // is exactly how two independent call sites dropped all four. This module is
    // the one place in the historical authority allowed to call the builder, and
    // its own signature makes every channel mandatory.
    const src = readFileSync(path.join(ROOT, "lib/sessions/history/visit-summary.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect((code.match(/buildAppointmentPrepMemory\(/g) ?? []).length).toBe(1);
    for (const channel of [
      "laserEntries:",
      "electrolysisEntries:",
      "hasLiveElectrolysisEntries:",
      "supersededByEmptySession:",
    ]) {
      expect(code, `${channel} not supplied`).toContain(channel);
    }
  });

  it("no OTHER module in the historical authority calls the builder", () => {
    const dir = path.join(ROOT, "lib/sessions/history");
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const file of readdirSync(dir)) {
      if (file === "visit-summary.ts" || !file.endsWith(".ts")) continue;
      const src = readFileSync(path.join(dir, file), "utf8");
      expect(src, `${file} builds prep memory itself`).not.toContain(
        "buildAppointmentPrepMemory",
      );
    }
  });

  it("the adapter's own parameters are REQUIRED, not optional", () => {
    const src = readFileSync(path.join(ROOT, "lib/sessions/history/visit-summary.ts"), "utf8");
    const sig = src.slice(
      src.indexOf("export function memoryFromCanonicalVisit"),
      src.indexOf("): AppointmentPrepMemory"),
    );
    for (const p of ["session:", "detail:", "hasLiveElectrolysisEntries:", "supersededByUnchartedVisit:"]) {
      expect(sig).toContain(p);
      expect(sig, `${p} is optional`).not.toContain(p.replace(":", "?:"));
    }
  });
});

describe("the projection stays small enough to cross the RSC boundary", () => {
  it("a visit summary carries no block, entry or note collection", () => {
    const { summary } = run({ detail: detail({ blocks: [block("b1")] }) });
    const text = JSON.stringify(summary);
    for (const leaked of ["probe_lot_number", "reaction_notes", "caution_note", "entries", "structured_areas"]) {
      expect(text, `${leaked} crossed to the browser`).not.toContain(leaked);
    }
  });
});
