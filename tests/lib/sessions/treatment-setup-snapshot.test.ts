import { describe, expect, it } from "vitest";
import {
  BLOCK_SETUP_FIELDS,
  buildTreatmentSetupDraftPatch,
  firstLiveEntry,
  type SetupSourceBlock,
  type SetupSourceEntry,
} from "@/lib/sessions/treatment-setup-snapshot";

const block = (over: Partial<SetupSourceBlock> = {}): SetupSourceBlock => ({
  mode: "thermo",
  apilus_modality: "OmniBlend",
  energy_level: 42,
  machine_frequency: "13.56 MHz",
  probe_key: "ballet-f3",
  ...over,
});

// A source row as it actually arrives from the database: it still CARRIES
// minutes_performed (ordinary charting reads and writes that column). The point
// of the contract is that the copy builder never reads it, so every "minutes are
// not copied" test below must use a source that genuinely has minutes to copy,
// otherwise it would pass vacuously.
const blockWithMinutes = (minutes: number | null = 37) =>
  ({ ...block(), minutes_performed: minutes }) as SetupSourceBlock;

const entry = (over: Partial<SetupSourceEntry> = {}): SetupSourceEntry => ({
  created_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  mode: "thermo",
  thermolysis_intensity_percent: 30,
  thermolysis_duration_seconds: 0.12,
  galvanic_ma: 0.5,
  galvanic_duration_seconds: 8,
  units_of_lye: 25,
  pulse_count: 3,
  pulse_delay_seconds: 0.4,
  ...over,
});

describe("firstLiveEntry: canonical earliest non-deleted", () => {
  it("returns the earliest non-deleted entry by created_at", () => {
    const e = firstLiveEntry([
      entry({ created_at: "2026-01-03T00:00:00Z", thermolysis_intensity_percent: 99 }),
      entry({ created_at: "2026-01-01T00:00:00Z", thermolysis_intensity_percent: 11 }),
      entry({ created_at: "2026-01-02T00:00:00Z", thermolysis_intensity_percent: 55 }),
    ]);
    expect(e?.thermolysis_intensity_percent).toBe(11);
  });
  it("skips soft-deleted entries", () => {
    const e = firstLiveEntry([
      entry({ created_at: "2026-01-01T00:00:00Z", deleted_at: "2026-02-01T00:00:00Z", thermolysis_intensity_percent: 11 }),
      entry({ created_at: "2026-01-02T00:00:00Z", thermolysis_intensity_percent: 55 }),
    ]);
    expect(e?.thermolysis_intensity_percent).toBe(55);
  });
  it("returns null when there is no live entry", () => {
    expect(firstLiveEntry([])).toBeNull();
    expect(firstLiveEntry(null)).toBeNull();
    expect(firstLiveEntry([entry({ deleted_at: "2026-02-01T00:00:00Z" })])).toBeNull();
  });
});

describe("thermolysis source", () => {
  const p = buildTreatmentSetupDraftPatch(block({ mode: "thermo" }), entry({ mode: "thermo" }));
  it("copies block setup + thermolysis readings + pulse + probe + freq", () => {
    expect(p.mode).toBe("thermo");
    expect(p.apilusModality).toBe("OmniBlend");
    expect(p.energyLevel).toBe("42");
    expect(p.machineFrequency).toBe("13.56 MHz");
    expect(p.probeKey).toBe("ballet-f3");
    expect(p.thermolysisIntensityPercent).toBe("30");
    expect(p.thermolysisDurationSeconds).toBe("0.12");
    expect(p.pulseCount).toBe("3");
    expect(p.pulseDelay).toBe("0.4");
  });
  it("clears galvanic + units of lye (invalid for thermolysis)", () => {
    expect(p.galvanicMa).toBe("");
    expect(p.galvanicDurationSeconds).toBe("");
    expect(p.unitsOfLye).toBe("");
  });
});

describe("galvanic source", () => {
  const p = buildTreatmentSetupDraftPatch(block({ mode: "galv" }), entry({ mode: "galv" }));
  it("copies mA, galvanic duration, units of lye, pulse (reusable galvanic setup)", () => {
    expect(p.mode).toBe("galv");
    expect(p.galvanicMa).toBe("0.5");
    expect(p.galvanicDurationSeconds).toBe("8");
    expect(p.unitsOfLye).toBe("25");
    expect(p.pulseCount).toBe("3");
  });
  it("NEVER copies galvanic intensity: retired reading, not in the patch at all", () => {
    // Even from a source whose row still carries a legacy value, the patch has no
    // galvanicIntensityPercent key, so copy-settings can never resurrect it into a
    // new draft. (A richer source row is allowed; it's simply ignored.)
    const withLegacy = buildTreatmentSetupDraftPatch(
      block({ mode: "galv" }),
      { ...entry({ mode: "galv" }), galvanic_intensity_percent: 42 } as never,
    );
    expect(Object.keys(withLegacy)).not.toContain("galvanicIntensityPercent");
    expect("galvanicIntensityPercent" in p).toBe(false);
  });
  it("clears thermolysis readings AND apilus modality + energy (galvanic carries neither)", () => {
    expect(p.thermolysisIntensityPercent).toBe("");
    expect(p.thermolysisDurationSeconds).toBe("");
    expect(p.apilusModality).toBe("");
    expect(p.energyLevel).toBe("");
  });
});

describe("blend source", () => {
  const p = buildTreatmentSetupDraftPatch(block({ mode: "blend" }), entry({ mode: "blend" }));
  it("copies BOTH reading groups + apilus/energy", () => {
    expect(p.mode).toBe("blend");
    expect(p.thermolysisIntensityPercent).toBe("30");
    expect(p.galvanicMa).toBe("0.5");
    expect(p.unitsOfLye).toBe("25");
    expect(p.apilusModality).toBe("OmniBlend");
    expect(p.energyLevel).toBe("42");
  });
});

describe("single-pulse setup must not carry pulse delay", () => {
  it("clears pulseDelay when pulse_count is 1", () => {
    const p = buildTreatmentSetupDraftPatch(block(), entry({ pulse_count: 1, pulse_delay_seconds: 0.4 }));
    expect(p.pulseCount).toBe("1");
    expect(p.pulseDelay).toBe("");
  });
  it("keeps pulseDelay for multi-pulse", () => {
    const p = buildTreatmentSetupDraftPatch(block(), entry({ pulse_count: 2, pulse_delay_seconds: 0.4 }));
    expect(p.pulseDelay).toBe("0.4");
  });
});

// ---------------------------------------------------------------------------
// Minutes performed is an OUTCOME, not reusable setup (Chloe, Session 1C).
//
// The old contract copied it, which silently overwrote destination-specific
// minutes a practitioner had already typed. The fix is STRUCTURAL: the patch
// does not own the key at all. Emitting `minutes: ""` instead would have been
// just as destructive, it would erase her entry rather than replace it.
// ---------------------------------------------------------------------------
describe("minutes performed is never part of the reusable setup patch", () => {
  it("the patch has NO minutes property, even from a source with minutes", () => {
    const p = buildTreatmentSetupDraftPatch(blockWithMinutes(37), entry());
    expect("minutes" in p).toBe(false);
    expect(Object.keys(p)).not.toContain("minutes");
    expect((p as Record<string, unknown>).minutes).toBeUndefined();
  });

  it("BLOCK_SETUP_FIELDS excludes minutes_performed", () => {
    expect(BLOCK_SETUP_FIELDS).not.toContain("minutes_performed");
    // The rest of the block-level setup contract is intact, this must fail
    // because minutes left, not because the list was emptied.
    expect(BLOCK_SETUP_FIELDS).toContain("machine_frequency");
    expect(BLOCK_SETUP_FIELDS).toContain("probe_key");
    expect(BLOCK_SETUP_FIELDS).toContain("mode");
  });

  it("source minutes cannot enter the patch by ANY key spelling", () => {
    const p = buildTreatmentSetupDraftPatch(blockWithMinutes(37), entry());
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("37");
    expect(serialized).not.toContain("minutes");
    expect(serialized).not.toContain("minutes_performed");
  });

  it("applying the patch LEAVES destination minutes exactly as typed", () => {
    // This is the form's real mechanism: setDraft((d) => ({ ...d, ...patch })).
    const destinationDraft = { minutes: "12", machineFrequency: "", probeKey: "" };
    const p = buildTreatmentSetupDraftPatch(blockWithMinutes(37), entry());
    const applied = { ...destinationDraft, ...p };
    expect(applied.minutes).toBe("12"); // not 37, and not cleared
    expect(applied.machineFrequency).toBe("13.56 MHz"); // setup still copied
  });

  it("a fresh blank destination stays blank, the patch never writes a value", () => {
    const freshDraft = { minutes: "" };
    const applied = {
      ...freshDraft,
      ...buildTreatmentSetupDraftPatch(blockWithMinutes(37), entry()),
    };
    expect(applied.minutes).toBe("");
  });

  it("a source with NULL minutes behaves identically (no key either way)", () => {
    const p = buildTreatmentSetupDraftPatch(blockWithMinutes(null), entry());
    expect("minutes" in p).toBe(false);
    expect({ ...{ minutes: "12" }, ...p }.minutes).toBe("12");
  });
});

describe("the reusable patch key set is EXACT", () => {
  // An exact-key assertion, not a subset check: a future outcome field added to
  // the copy builder cannot slip in quietly the way minutes did. Adding a
  // genuinely reusable setup key is a deliberate act that updates this list.
  const EXPECTED_PATCH_KEYS = [
    "apilusModality",
    "energyLevel",
    "galvanicDurationSeconds",
    "galvanicMa",
    "machineFrequency",
    "mode",
    "probeInventoryItemId",
    "probeKey",
    "probeLotConfirmed",
    "probeLotNumber",
    "pulseCount",
    "pulseDelay",
    "thermolysisDurationSeconds",
    "thermolysisIntensityPercent",
    "unitsOfLye",
  ];

  for (const mode of ["thermo", "galv", "blend"] as const) {
    it(`${mode} source produces exactly the reusable setup keys`, () => {
      const p = buildTreatmentSetupDraftPatch(
        { ...blockWithMinutes(37), mode },
        entry({ mode }),
        new Set(["item-1"]),
      );
      expect(Object.keys(p).sort()).toEqual(EXPECTED_PATCH_KEYS);
    });
  }
});

describe("outcome fields are structurally absent from the patch", () => {
  it("the patch object contains only reusable setup keys, no outcome keys", () => {
    const p = buildTreatmentSetupDraftPatch(blockWithMinutes(37), entry());
    const keys = Object.keys(p);
    for (const forbidden of [
      // Minutes performed describes the treatment that already happened.
      "minutes",
      "minutesPerformed",
      "minutes_performed",
      // Retired reading: never a copyable setup key.
      "galvanicIntensityPercent",
      "hairsTreated",
      "comments",
      "observationChips",
      "toleranceRating",
      "reactionType",
      "reactionNotes",
      "cautionForNextSession",
      "cautionNote",
      "numbingStatus",
      // probeLotNumber / probeInventoryItemId / probeLotConfirmed ARE part of
      // the contract now: the lot travels WITH the probe (see the dedicated
      // suite below). Copying a probe without its lot let the destination
      // silently auto-resolve a DIFFERENT lot from unrelated history.
      "primaryArea",
      "side",
      "areas",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// The lot travels WITH the probe (Chloe: a copy must reproduce the exact lot,
// never let it be swapped for an unrelated historical one).
// ---------------------------------------------------------------------------
describe("copied probe lot + inventory link", () => {
  const src = (over: Record<string, unknown> = {}) => ({
    ...block(),
    probe_key: "sterex-gold-two-piece-f3-short",
    probe_lot_number: "  460941  ",
    probe_inventory_item_id: "item-1",
    ...over,
  });

  // ---------------------------------------------------------------------
  // Session 1C: these pin the TRUTH of the lot contract, because the prose
  // used to claim the opposite (a "manually entered destination lot is
  // preserved", and probe_lot_* listed among NEVER-copied fields). The lot IS
  // copied; what is never copied is the CONFIRMATION.
  // ---------------------------------------------------------------------
  it("REPLACES a lot already present on the destination draft, it does not preserve it", () => {
    const destination = {
      probeLotNumber: "DESTINATION-TYPED-BY-HAND",
      probeInventoryItemId: "destination-item",
      probeLotConfirmed: true,
      minutes: "12",
    };
    const applied = {
      ...destination,
      ...buildTreatmentSetupDraftPatch(src(), entry(), new Set(["item-1"])),
    };
    // The lot travels with the probe: the source's lot wins.
    expect(applied.probeLotNumber).toBe("460941");
    expect(applied.probeInventoryItemId).toBe("item-1");
    // ...and the destination's CONFIRMATION is reset, which is the safety.
    expect(applied.probeLotConfirmed).toBe(false);
    // Minutes, an outcome, is still untouched.
    expect(applied.minutes).toBe("12");
  });

  it("the probe itself copies alongside its lot", () => {
    const p = buildTreatmentSetupDraftPatch(src(), entry(), new Set(["item-1"]));
    expect(p.probeKey).toBe("sterex-gold-two-piece-f3-short");
  });

  it("an EXPIRED / ARCHIVED / RECLASSIFIED link is dropped, lot text survives", () => {
    // All three reach the contract identically: "not in the linkable set".
    for (const linkable of [new Set<string>(), new Set(["expired-item"]), new Set(["other-probe-item"])]) {
      const p = buildTreatmentSetupDraftPatch(src(), entry(), linkable);
      expect(p.probeInventoryItemId).toBeNull();
      expect(p.probeLotNumber).toBe("460941");
      expect(p.probeLotConfirmed).toBe(false);
    }
  });

  it("a copied lot is NEVER confirmed, under every linkability outcome", () => {
    for (const linkable of [undefined, new Set<string>(), new Set(["item-1"])]) {
      const p = buildTreatmentSetupDraftPatch(src(), entry(), linkable as never);
      expect(p.probeLotConfirmed).toBe(false);
    }
  });

  it("copying the lot does not disturb destination areas or outcomes", () => {
    const destination = {
      areas: [{ area: "Chin", laterality: "left" }],
      primaryArea: "Chin",
      hairsTreated: "40",
      comments: "went well",
      toleranceRating: "5",
    };
    const applied = {
      ...destination,
      ...buildTreatmentSetupDraftPatch(src(), entry(), new Set(["item-1"])),
    };
    expect(applied.areas).toEqual([{ area: "Chin", laterality: "left" }]);
    expect(applied.primaryArea).toBe("Chin");
    expect(applied.hairsTreated).toBe("40");
    expect(applied.comments).toBe("went well");
    expect(applied.toleranceRating).toBe("5");
  });

  it("copies the lot number EXACTLY (trimmed) and never marks it confirmed", () => {
    const p = buildTreatmentSetupDraftPatch(src(), entry(), new Set(["item-1"]));
    expect(p.probeLotNumber).toBe("460941");
    expect(p.probeLotConfirmed).toBe(false);
  });

  it("keeps the inventory link when the item is still linkable for the copied probe", () => {
    const p = buildTreatmentSetupDraftPatch(src(), entry(), new Set(["item-1"]));
    expect(p.probeInventoryItemId).toBe("item-1");
  });

  it("drops ONLY the link: never the lot text, when the item is no longer linkable", () => {
    // Expired, archived, or reclassified under a different probe: all three
    // reach here as "not in the linkable set".
    const p = buildTreatmentSetupDraftPatch(src(), entry(), new Set(["other-item"]));
    expect(p.probeInventoryItemId).toBeNull();
    expect(p.probeLotNumber).toBe("460941"); // she still sees what she copied
    expect(p.probeLotConfirmed).toBe(false);
  });

  it("drops the link when the caller cannot check inventory (safe default)", () => {
    const p = buildTreatmentSetupDraftPatch(src(), entry());
    expect(p.probeInventoryItemId).toBeNull();
    expect(p.probeLotNumber).toBe("460941");
  });

  it("a source with no lot copies an empty lot and no link", () => {
    const p = buildTreatmentSetupDraftPatch(
      src({ probe_lot_number: null, probe_inventory_item_id: null }),
      entry(),
      new Set(["item-1"]),
    );
    expect(p.probeLotNumber).toBe("");
    expect(p.probeInventoryItemId).toBeNull();
  });

  it("a manual (unlinked) source lot copies as text with no link, even when inventory is empty", () => {
    // The zero-inventory studio shape: nothing is linkable, and the copied lot
    // must still arrive intact.
    const p = buildTreatmentSetupDraftPatch(
      src({ probe_inventory_item_id: null }),
      entry(),
      new Set(),
    );
    expect(p.probeLotNumber).toBe("460941");
    expect(p.probeInventoryItemId).toBeNull();
  });
});
