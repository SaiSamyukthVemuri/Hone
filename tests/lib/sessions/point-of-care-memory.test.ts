import { describe, expect, it } from "vitest";
import {
  BLOCKLESS_LASER_COPY,
  BLOCKLESS_LEGACY_ENTRIES_COPY,
  blocklessTreatmentCopy,
  buildPointOfCareMemory,
  noteExcerpt,
  toClinicalSummaryBlocks,
  type PointOfCareBlock,
  type PointOfCareEntry,
} from "@/lib/sessions/point-of-care-memory";

// Behavioural pins for the point-of-care "Last treatment" view model.
//
// The fields under test are exactly the ones Chloe could not see while
// treating: machine frequency, the probe LOT she must match, numbing, hairs,
// and the mode-valid machine readings. Removing any of them from the builder
// must red a test here, the negative controls are recorded in the PR.

function entry(over: Partial<PointOfCareEntry> = {}): PointOfCareEntry {
  return {
    created_at: "2026-01-01T10:00:00Z",
    deleted_at: null,
    mode: null,
    ...over,
  };
}

function block(over: Partial<PointOfCareBlock> = {}): PointOfCareBlock {
  return {
    id: "b1",
    sort_order: 1,
    ...over,
  };
}

function build(blocks: PointOfCareBlock[], over: Record<string, unknown> = {}) {
  return buildPointOfCareMemory({
    session: {
      id: "s-prev",
      started_at: "2026-01-01T10:00:00Z",
      modality: "electrolysis",
    },
    blocks,
    ...over,
  });
}

describe("the memory fields that were missing", () => {
  const full = build([
    block({
      machine_frequency: "13.56 MHz",
      probe_label: "Ballet F3",
      probe_lot_number: " A12 ",
      probe_lot_confirmed: true,
      numbing_status: "used",
      numbing_notes: "Emla 30 min before",
      minutes_performed: 15,
      mode: "blend",
      apilus_modality: "Picoblend",
      energy_level: 14,
      entries: [entry({ mode: "blend", hairs_treated: 40 })],
    }),
  ]);

  it("carries the machine frequency", () => {
    expect(full.areas[0].frequency).toBe("13.56 MHz");
  });

  it("carries the probe AND its frozen lot snapshot, with the confirmed marker", () => {
    expect(full.areas[0].probeLine).toBe("Ballet F3 · Lot #A12 (confirmed)");
  });

  it("marks an unconfirmed lot without the marker", () => {
    const m = build([
      block({ probe_label: "Ballet F3", probe_lot_number: "A12", probe_lot_confirmed: false }),
    ]);
    expect(m.areas[0].probeLine).toBe("Ballet F3 · Lot #A12");
  });

  it("falls back to legacy probe type + size when there is no probe label", () => {
    const m = build([
      block({ probe_type: "Insulated", probe_size: "F3", probe_lot_number: "L9" }),
    ]);
    expect(m.areas[0].probeLine).toBe("Insulated · F3 · Lot #L9");
  });

  it("carries numbing status, and its note only when numbing was USED", () => {
    expect(full.areas[0].numbing).toEqual({
      label: "Numbing used",
      note: "Emla 30 min before",
    });
    const none = build([
      block({ numbing_status: "none", numbing_notes: "should not surface" }),
    ]);
    expect(none.areas[0].numbing).toEqual({ label: "No numbing used", note: null });
    const notRecorded = build([block({ numbing_status: null })]);
    expect(notRecorded.areas[0].numbing).toBeNull();
  });

  it("carries hairs treated", () => {
    expect(full.areas[0].hairs).toBe(40);
    expect(full.totalHairs).toBe(40);
  });

  it("carries minutes performed", () => {
    expect(full.areas[0].minutes).toBe(15);
    expect(full.totalMinutes).toBe(15);
  });

  it("carries mode and the CANONICAL Apilus modality label", () => {
    expect(full.areas[0].modeLabel).toBe("Blend");
    // The shared label map, not the raw storage key, toBeTruthy() here would
    // have passed on an unmapped value falling through apilusModalityLabel.
    expect(full.areas[0].modalityLabel).toBe("PicoBlend");
  });

  it("carries tolerance in the same format as the compact summary", () => {
    const m = build([block({ tolerance_rating: 3 })]);
    expect(m.areas[0].toleranceLine).toBe("3/5 - Moderate discomfort");
  });

  it("carries the unified response across the legacy field AND the live passes", () => {
    const m = build([
      block({
        // Legacy single-select column plus a reaction chip on a live pass:
        // the unified helper must retain BOTH, never collapse to one.
        reaction_type: "mild_redness",
        entries: [entry({ observation_chips: ["Swelling"] })],
      }),
    ]);
    expect(m.areas[0].responseLine).toBe("Mild redness, Swelling");
  });

  it("carries the caution as a watch line prefixed with its area", () => {
    const m = build([
      block({
        primary_area: "Chin",
        caution_for_next_session: true,
        caution_note: "Start lower",
      }),
    ]);
    expect(m.watchLines).toEqual(["Chin: Start lower"]);
  });

  it("a caution FLAG with no note still produces a watch line", () => {
    const m = build([
      block({ primary_area: "Chin", caution_for_next_session: true }),
    ]);
    expect(m.watchLines).toEqual(["Chin: flagged to watch."]);
  });

  it("does NOT truncate a long reaction note (the compact summary drops >140 chars)", () => {
    const long = "x".repeat(400);
    const m = build([block({ reaction_notes: long })]);
    expect(m.areas[0].responseNote).toBe(long);
  });
});

describe("structured areas and laterality", () => {
  it("shows every treated area with its laterality, never only the first", () => {
    const m = build([
      block({
        primary_area: "Cheek",
        side: "left",
        structured_areas: [
          { area: "Cheek", laterality: "left" },
          { area: "Sideburn", laterality: "right" },
        ],
      }),
    ]);
    expect(m.areas[0].areaLabel).toBe("Left Cheek · Right Sideburn");
    expect(m.areaHeadline).toBe("Left Cheek · Right Sideburn");
  });

  it("falls back to the legacy primary_area + side when there are no structured rows", () => {
    const m = build([block({ primary_area: "Upper lip", side: "center" })]);
    expect(m.areas[0].areaLabel).toBe("Midline Upper lip");
  });

  it("falls back to the block name, then to a positional label", () => {
    expect(build([block({ block_name: "Neckline" })]).areas[0].areaLabel).toBe(
      "Neckline",
    );
    expect(build([block({})]).areas[0].areaLabel).toBe("Treatment area 1");
  });

  it("dedupes the session headline across blocks that share an area", () => {
    const m = build([
      block({
        id: "b1",
        sort_order: 1,
        structured_areas: [{ area: "Chin", laterality: "not_applicable" }],
      }),
      block({
        id: "b2",
        sort_order: 2,
        structured_areas: [
          { area: "Chin", laterality: "not_applicable" },
          { area: "Neck", laterality: "bilateral" },
        ],
      }),
    ]);
    expect(m.areaHeadline).toBe("Chin · Bilateral Neck");
  });
});

describe("mode gating: the first read surface in the app to apply it", () => {
  it("a THERMOLYSIS block never shows stale galvanic readings", () => {
    const m = build([
      block({
        mode: "thermo",
        energy_level: 12,
        entries: [
          entry({
            mode: "thermo",
            thermolysis_duration_seconds: 0.733,
            thermolysis_intensity_percent: 40,
            // Stale off-mode values left behind by an earlier mode.
            galvanic_ma: 1.2,
            galvanic_duration_seconds: 8,
            units_of_lye: 30,
          }),
        ],
      }),
    ]);
    const fields = m.areas[0].readings.map((r) => r.field);
    expect(fields).not.toContain("galvanicMa");
    expect(fields).not.toContain("galvanicDurationSeconds");
    expect(fields).not.toContain("unitsOfLye");
    expect(fields).toContain("thermolysisDurationSeconds");
  });

  it("a GALVANIC block shows no thermolysis readings, no energy level and no modality", () => {
    const m = build([
      block({
        mode: "galv",
        energy_level: 12,
        apilus_modality: "Picoblend",
        entries: [
          entry({
            mode: "galv",
            units_of_lye: 30,
            galvanic_ma: 1.2,
            thermolysis_intensity_percent: 40,
            thermolysis_duration_seconds: 0.5,
          }),
        ],
      }),
    ]);
    const fields = m.areas[0].readings.map((r) => r.field);
    expect(fields).not.toContain("thermolysisIntensityPercent");
    expect(fields).not.toContain("thermolysisDurationSeconds");
    expect(fields).not.toContain("energyLevel");
    expect(m.areas[0].energyLevel).toBeNull();
    expect(m.areas[0].modalityLabel).toBeNull();
    expect(fields).toContain("unitsOfLye");
    expect(fields).toContain("galvanicMa");
  });

  it("a BLEND block shows both groups, in machine order", () => {
    const m = build([
      block({
        mode: "blend",
        energy_level: 14,
        entries: [
          entry({
            mode: "blend",
            units_of_lye: 30,
            galvanic_duration_seconds: 8,
            galvanic_ma: 1.2,
            thermolysis_duration_seconds: 0.733,
            thermolysis_intensity_percent: 40,
            pulse_count: 1,
          }),
        ],
      }),
    ]);
    expect(m.areas[0].readings.map((r) => r.field)).toEqual([
      "energyLevel",
      "unitsOfLye",
      "galvanicDurationSeconds",
      "galvanicMa",
      "thermolysisDurationSeconds",
      "thermolysisIntensityPercent",
      "pulseCount",
    ]);
  });

  it("resolves the mode from the canonical pass when the block has none", () => {
    const m = build([
      block({
        mode: null,
        entries: [entry({ mode: "thermo", thermolysis_intensity_percent: 40 })],
      }),
    ]);
    expect(m.areas[0].readings.map((r) => r.field)).toContain(
      "thermolysisIntensityPercent",
    );
  });

  it("still shows the BLOCK-level energy level when the mode is unknown", () => {
    // A block can be saved with no mode (the form's mode chip toggles off and
    // the action coerces the empty value to null). Energy level is block-level
    // and valid in every non-galvanic mode, so suppressing it rendered
    // "Setup not recorded" over a block that plainly had one.
    const m = build([
      block({ mode: null, energy_level: 14, entries: [entry({ mode: null })] }),
    ]);
    const fields = m.areas[0].readings.map((r) => r.field);
    expect(fields).toEqual(["energyLevel"]);
    expect(m.areas[0].readings[0].value).toBe("EL 14");
  });

  it("shows no ENTRY readings when the mode is unknown, never a guess", () => {
    const m = build([
      block({ mode: null, entries: [entry({ thermolysis_intensity_percent: 40 })] }),
    ]);
    expect(m.areas[0].readings).toEqual([]);
  });
});

describe("reading precision and the retired input", () => {
  it("shows the EXACT stored 3-decimal thermolysis duration (PicoBlend 0.733s)", () => {
    const m = build([
      block({
        mode: "thermo",
        entries: [entry({ mode: "thermo", thermolysis_duration_seconds: 0.733 })],
      }),
    ]);
    const reading = m.areas[0].readings.find(
      (r) => r.field === "thermolysisDurationSeconds",
    );
    expect(reading?.value).toBe("0.733 seconds");
    expect(reading?.value).not.toBe("0.73 seconds");
    expect(reading?.value).not.toBe("0 seconds");
  });

  it("coerces a PostgREST numeric delivered as a string", () => {
    const m = build([
      block({
        mode: "thermo",
        entries: [
          entry({
            mode: "thermo",
            thermolysis_duration_seconds: "0.733",
            thermolysis_intensity_percent: "40",
          }),
        ],
      }),
    ]);
    const values = m.areas[0].readings.map((r) => r.value);
    expect(values).toContain("0.733 seconds");
    expect(values).toContain("40%");
  });

  it("NEVER surfaces galvanic_intensity_percent: the retired input", () => {
    const m = build([
      block({
        mode: "blend",
        entries: [
          entry({
            mode: "blend",
            galvanic_ma: 1.2,
            // A historical row still carrying the retired column.
            ...({ galvanic_intensity_percent: 55 } as Record<string, unknown>),
          }),
        ],
      }),
    ]);
    const serialized = JSON.stringify(m.areas[0].readings);
    expect(serialized).not.toMatch(/galvanicIntensity/i);
    expect(serialized).not.toMatch(/55/);
  });

  it("shows pulse delay only when more than one pulse was charted", () => {
    const single = build([
      block({
        mode: "thermo",
        entries: [entry({ mode: "thermo", pulse_count: 1, pulse_delay_seconds: 0.5 })],
      }),
    ]);
    expect(single.areas[0].readings.map((r) => r.field)).not.toContain("pulseDelay");

    const multi = build([
      block({
        mode: "thermo",
        entries: [entry({ mode: "thermo", pulse_count: 3, pulse_delay_seconds: 0.5 })],
      }),
    ]);
    const delay = multi.areas[0].readings.find((r) => r.field === "pulseDelay");
    expect(delay?.value).toBe("0.50s delay");
  });
});

describe("multiple passes", () => {
  it("takes block-level setup from the CANONICAL (earliest live) pass, not an arbitrary one", () => {
    const m = build([
      block({
        mode: "thermo",
        entries: [
          entry({
            created_at: "2026-01-01T10:30:00Z",
            mode: "thermo",
            thermolysis_intensity_percent: 99,
          }),
          entry({
            created_at: "2026-01-01T10:00:00Z",
            mode: "thermo",
            thermolysis_intensity_percent: 40,
          }),
        ],
      }),
    ]);
    expect(
      m.areas[0].readings.find((r) => r.field === "thermolysisIntensityPercent")
        ?.value,
    ).toBe("40%");
  });

  it("SUMS hairs across every live pass and makes the pass count visible", () => {
    const m = build([
      block({
        entries: [
          entry({ created_at: "2026-01-01T10:00:00Z", hairs_treated: 40 }),
          entry({ created_at: "2026-01-01T10:30:00Z", hairs_treated: 25 }),
        ],
      }),
    ]);
    expect(m.areas[0].hairs).toBe(65);
    expect(m.areas[0].passCount).toBe(2);
  });

  it("EXCLUDES a soft-deleted pass from hairs, from the count and from the canonical pick", () => {
    const m = build([
      block({
        mode: "thermo",
        entries: [
          entry({
            created_at: "2026-01-01T09:00:00Z",
            deleted_at: "2026-01-01T09:05:00Z",
            mode: "thermo",
            hairs_treated: 1000,
            thermolysis_intensity_percent: 99,
          }),
          entry({
            created_at: "2026-01-01T10:00:00Z",
            mode: "thermo",
            hairs_treated: 40,
            thermolysis_intensity_percent: 40,
          }),
        ],
      }),
    ]);
    expect(m.areas[0].hairs).toBe(40);
    expect(m.areas[0].passCount).toBe(1);
    expect(
      m.areas[0].readings.find((r) => r.field === "thermolysisIntensityPercent")
        ?.value,
    ).toBe("40%");
  });

  it("does not double-count: minutes are block-level and counted once regardless of pass count", () => {
    const m = build([
      block({
        minutes_performed: 15,
        entries: [
          entry({ created_at: "2026-01-01T10:00:00Z" }),
          entry({ created_at: "2026-01-01T10:30:00Z" }),
          entry({ created_at: "2026-01-01T11:00:00Z" }),
        ],
      }),
    ]);
    expect(m.areas[0].minutes).toBe(15);
    expect(m.totalMinutes).toBe(15);
  });

  it("a soft-deleted pass's reaction chips never resurface in the response", () => {
    const m = build([
      block({
        entries: [
          entry({
            deleted_at: "2026-01-02T00:00:00Z",
            observation_chips: ["Swelling"],
          }),
        ],
      }),
    ]);
    expect(m.areas[0].responseLine).toBeNull();
  });
});

describe("the plan is never shown twice", () => {
  it("omits its own plan line when the host page already renders that exact text", () => {
    const m = build([block({})], {
      session: {
        id: "s-prev",
        started_at: "2026-01-01T10:00:00Z",
        modality: "electrolysis",
        next_session_note: "Try a lower EL",
      },
      planAlreadyShown: "Try a lower EL",
    });
    expect(m.plan).toBeNull();
  });

  it("keeps its plan line when the page is showing a DIFFERENT note", () => {
    const m = build([block({})], {
      session: {
        id: "s-prev",
        started_at: "2026-01-01T10:00:00Z",
        modality: "electrolysis",
        next_session_note: "Try a lower EL",
      },
      planAlreadyShown: "Something else entirely",
    });
    expect(m.plan).toBe("Try a lower EL");
  });

  it("keeps its plan line when the page is showing nothing", () => {
    const m = build([block({})], {
      session: {
        id: "s-prev",
        started_at: "2026-01-01T10:00:00Z",
        modality: "electrolysis",
        next_session_note: "Try a lower EL",
      },
    });
    expect(m.plan).toBe("Try a lower EL");
  });
});

describe("a charted visit with NO settings blocks (laser / pre-block legacy)", () => {
  // A LASER visit charts into laser_entries and never creates a session_block;
  // pre-0019 electrolysis charted straight into entries. Both qualify as
  // "charted", so the card must not present them as "nothing was recorded".
  const laser = buildPointOfCareMemory({
    session: {
      id: "s-laser",
      started_at: "2026-01-01T10:00:00Z",
      modality: "laser",
      next_session_note: "Recheck the patch test",
    },
    blocks: [],
  });

  it("produces no areas and no headline, the card branches on this", () => {
    expect(laser.areas).toEqual([]);
    expect(laser.areaHeadline).toBeNull();
  });

  it("still carries the session-level memory that DOES exist", () => {
    expect(laser.modality).toBe("laser");
    expect(laser.sessionId).toBe("s-laser");
    expect(laser.plan).toBe("Recheck the patch test");
  });

  it("reports nothing rather than zero for the block-derived totals", () => {
    expect(laser.totalMinutes).toBeNull();
    expect(laser.totalHairs).toBeNull();
    expect(laser.watchLines).toEqual([]);
  });
});

describe("blockless charted visits get a truthful line, never an empty shell", () => {
  const blockless = (over: Record<string, unknown>) =>
    buildPointOfCareMemory({
      session: {
        id: "s-prev",
        started_at: "2026-01-01T10:00:00Z",
        modality: "electrolysis",
      },
      blocks: [],
      ...over,
    });

  it("a LASER visit says it was charted as laser passes", () => {
    const m = blockless({
      session: {
        id: "s-laser",
        started_at: "2026-01-01T10:00:00Z",
        modality: "laser",
      },
    });
    expect(m.blocklessNote).toBe(BLOCKLESS_LASER_COPY);
    expect(m.blocklessNote).toMatch(/charted as laser passes/i);
  });

  it("a LEGACY entry-only electrolysis visit says so", () => {
    const m = blockless({ hasLiveElectrolysisEntries: true });
    expect(m.blocklessNote).toBe(BLOCKLESS_LEGACY_ENTRIES_COPY);
    expect(m.blocklessNote).toMatch(
      /legacy treatment entries without settings blocks/i,
    );
  });

  it("neither line ever claims the area was unrecorded", () => {
    for (const copy of [BLOCKLESS_LASER_COPY, BLOCKLESS_LEGACY_ENTRIES_COPY]) {
      expect(copy).not.toMatch(/not recorded/i);
      expect(copy).toMatch(/Open the full chart to review what was recorded/);
    }
  });

  it("a visit WITH blocks never carries the fallback line", () => {
    const m = build([block({ primary_area: "Chin" })]);
    expect(m.blocklessNote).toBeNull();
    expect(m.areas).toHaveLength(1);
  });

  it("the plan still surfaces on a blockless visit", () => {
    const m = blockless({
      session: {
        id: "s-laser",
        started_at: "2026-01-01T10:00:00Z",
        modality: "laser",
        next_session_note: "Recheck the patch test",
      },
    });
    expect(m.plan).toBe("Recheck the patch test");
  });

  it("the pure copy helper is the single source both surfaces call", () => {
    expect(
      blocklessTreatmentCopy({ modality: "laser", hasLiveElectrolysisEntries: false }),
    ).toBe(BLOCKLESS_LASER_COPY);
    expect(
      blocklessTreatmentCopy({ modality: "LASER ", hasLiveElectrolysisEntries: false }),
    ).toBe(BLOCKLESS_LASER_COPY);
    expect(
      blocklessTreatmentCopy({
        modality: "electrolysis",
        hasLiveElectrolysisEntries: true,
      }),
    ).toBe(BLOCKLESS_LEGACY_ENTRIES_COPY);
    // Modality wins over entries, so a laser row is never mislabelled legacy.
    expect(
      blocklessTreatmentCopy({ modality: "laser", hasLiveElectrolysisEntries: true }),
    ).toBe(BLOCKLESS_LASER_COPY);
    // Nothing to say: the caller renders the ordinary summary.
    expect(
      blocklessTreatmentCopy({
        modality: "electrolysis",
        hasLiveElectrolysisEntries: false,
      }),
    ).toBeNull();
    expect(
      blocklessTreatmentCopy({ modality: null, hasLiveElectrolysisEntries: false }),
    ).toBeNull();
  });
});

describe("supersededByEmptySession", () => {
  it("is FALSE when the selected treatment IS the newest candidate", () => {
    const m = build([block({})]);
    expect(m.supersededByEmptySession).toBe(false);
  });

  it("is TRUE only when the caller says a newer uncharted session exists", () => {
    const m = build([block({})], { supersededByEmptySession: true });
    expect(m.supersededByEmptySession).toBe(true);
  });

  it("never invents the flag from a truthy non-boolean", () => {
    const m = build([block({})], {
      supersededByEmptySession: "yes" as unknown as boolean,
    });
    expect(m.supersededByEmptySession).toBe(false);
  });
});

describe("clinical note context", () => {
  it("returns a short excerpt and reports that more exists, never the whole body", () => {
    const body = "word ".repeat(200).trim();
    const cut = noteExcerpt(body, 60);
    expect(cut?.truncated).toBe(true);
    expect(cut!.excerpt.length).toBeLessThanOrEqual(61);
    expect(cut!.excerpt.endsWith("…")).toBe(true);
    expect(cut!.excerpt.length).toBeLessThan(body.length);
  });

  it("returns the note whole when it is already short, with no ellipsis", () => {
    expect(noteExcerpt("Short note", 60)).toEqual({
      excerpt: "Short note",
      truncated: false,
    });
  });

  it("treats an empty or whitespace-only body as no note", () => {
    expect(noteExcerpt("   \n  ")).toBeNull();
    expect(noteExcerpt(null)).toBeNull();
  });

  it("carries both note kinds into the view model", () => {
    const m = build([block({})], {
      consultationNote: {
        occurredAt: "2026-01-01T00:00:00Z",
        body: "Goals discussed",
        authorName: "Chloe",
        total: 3,
      },
      skinHairNote: {
        occurredAt: "2026-02-01T00:00:00Z",
        body: "Fitzpatrick III, coarse",
        total: 1,
      },
    });
    expect(m.consultationNote?.excerpt).toBe("Goals discussed");
    expect(m.consultationNote?.total).toBe(3);
    expect(m.skinHairNote?.excerpt).toBe("Fitzpatrick III, coarse");
  });

  it("renders no note context when there is none", () => {
    const m = build([block({})]);
    expect(m.consultationNote).toBeNull();
    expect(m.skinHairNote).toBeNull();
  });
});

describe("block ordering and totals", () => {
  it("orders treatment areas by sort_order", () => {
    const m = build([
      block({ id: "b2", sort_order: 2, primary_area: "Neck" }),
      block({ id: "b1", sort_order: 1, primary_area: "Chin" }),
    ]);
    expect(m.areas.map((a) => a.areaLabel)).toEqual(["Chin", "Neck"]);
  });

  it("totals minutes and hairs across every area", () => {
    const m = build([
      block({
        id: "b1",
        sort_order: 1,
        minutes_performed: 15,
        entries: [entry({ hairs_treated: 40 })],
      }),
      block({
        id: "b2",
        sort_order: 2,
        minutes_performed: 10,
        entries: [entry({ hairs_treated: 12 })],
      }),
    ]);
    expect(m.totalMinutes).toBe(25);
    expect(m.totalHairs).toBe(52);
  });

  it("reports nothing rather than 0 when nothing was recorded", () => {
    const m = build([block({})]);
    expect(m.totalMinutes).toBeNull();
    expect(m.totalHairs).toBeNull();
    expect(m.areas[0].minutes).toBeNull();
    expect(m.areas[0].hairs).toBeNull();
  });
});

describe("toClinicalSummaryBlocks adapter", () => {
  it("feeds the compact summary from the SAME rows, with live chips only", () => {
    const [adapted] = toClinicalSummaryBlocks([
      block({
        primary_area: "Chin",
        side: "left",
        minutes_performed: "15",
        energy_level: "14",
        entries: [
          entry({ observation_chips: ["Swelling"] }),
          entry({ deleted_at: "x", observation_chips: ["Blanching"] }),
        ],
      }),
    ]);
    expect(adapted.primary_area).toBe("Chin");
    expect(adapted.minutes_performed).toBe(15);
    expect(adapted.energy_level).toBe(14);
    expect(adapted.observation_chips_list).toEqual([["Swelling"]]);
    expect(adapted.caution_for_next_session).toBe(false);
  });
});
