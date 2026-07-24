import { describe, expect, it } from "vitest";
import {
  buildTreatmentIntelligence,
  type IntelligenceSessionInput,
  type IntelligenceBlockInput,
} from "@/lib/sessions/treatment-intelligence";

// Section-5 metric invariants proven with the REAL charted / treatment-time
// derivation (buildTreatmentIntelligence drives the "charted" flag and the
// overall minutes on the client profile). The whole-session copy is contained
// and writes NO blocks (see whole-session-copy-contained.test.ts), so the
// destination session it leaves is empty. Here we prove that an empty session:
//   * is NOT charted;
//   * contributes 0 (null) treatment minutes;
// and that those numbers change ONLY once a real block exists (is saved). The
// "prefill persists nothing until Save" half is proven end-to-end by the 390px
// browser spec (block count 1 before Save, 2 after); this file proves the
// underlying charted/minutes DERIVATION those states map to.

function session(id: string, over: Partial<IntelligenceSessionInput> = {}): IntelligenceSessionInput {
  return {
    id,
    started_at: "2026-06-01T10:00:00Z",
    next_session_note: null,
    electrolysis_entries: [],
    laser_entries: [],
    ...over,
  };
}
function block(sessionId: string, over: Partial<IntelligenceBlockInput> = {}): IntelligenceBlockInput {
  return {
    session_id: sessionId,
    primary_area: "Chin",
    block_name: null,
    mode: "thermo",
    apilus_modality: null,
    energy_level: 40,
    machine_frequency: "13.56 MHz",
    probe_label: "Ballet F3",
    minutes_performed: 15,
    tolerance_rating: null,
    reaction_type: null,
    caution_for_next_session: false,
    caution_note: null,
    entry_hairs: [],
    ...over,
  };
}

describe("the empty destination the contained copy leaves does not read as performed", () => {
  it("an empty session (no blocks, no entries) is NOT charted and has 0 minutes", () => {
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [session("dest")],
      blocks: [],
    });
    expect(out.charted).toBe(false);
    expect(out.overall.chartedSessions).toBe(0);
    expect(out.overall.minutes).toBeNull();
  });

  it("a session WITH a real saved block is charted and adds ONLY that block's minutes", () => {
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [session("dest")],
      blocks: [block("dest", { minutes_performed: 15 })],
    });
    expect(out.charted).toBe(true);
    expect(out.overall.chartedSessions).toBe(1);
    expect(out.overall.minutes).toBe(15);
  });

  it("an empty destination alongside a real prior session adds nothing to the totals", () => {
    // Prior session with a saved 12-minute block + today's EMPTY destination.
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [
        session("dest", { started_at: "2026-06-08T10:00:00Z" }),
        session("prior", { started_at: "2026-06-01T10:00:00Z" }),
      ],
      blocks: [block("prior", { minutes_performed: 12 })],
    });
    // Only the prior real work counts; the empty destination contributes 0.
    expect(out.overall.chartedSessions).toBe(1);
    expect(out.overall.minutes).toBe(12);
  });
});
