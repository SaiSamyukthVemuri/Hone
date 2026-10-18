import { describe, expect, it } from "vitest";

import {
  MACHINE_CATALOGUE,
  activationReadiness,
  catalogueIntegrity,
  openEvidenceChecklist,
  profileById,
  profileAtVersion,
} from "@/lib/machines/catalogue";
import {
  activeModes,
  activeProfiles,
  findField,
  findMode,
  modeFields,
  type MachineProfile,
} from "@/lib/machines/profile-contract";
import {
  carryForwardCompatibility,
  validateReading,
} from "@/lib/machines/validate-reading";

// ===========================================================================
// MPX-01 — the versioned machine profile contract and curated catalogue.
//
// WHAT THIS FILE PROVES, AND WHAT IT CANNOT. These are pure typed structures;
// there is no schema and no migration in this slice, so nothing here proves
// storage or rendering. What it does prove is the set of claims the catalogue is
// allowed to make: that no profile is offered on incomplete evidence, that no
// numeric bound refuses input without exact-model hardware evidence, that a
// recorded observation survives validation unchanged, and that the traps #829
// names individually — Junior 3G inheriting MultiPlex, UE renamed to UL, ST 350
// standing in for ST 250, microamps sharing a column with milliamps — are each
// absent by assertion rather than by good intentions.
// ===========================================================================

/**
 * A synthetic profile. The shipped catalogue deliberately contains no
 * hardware-enforced bound and no active mode, so the code paths for both would
 * be unreachable — and an unreachable refusal path is an untested one. This
 * fixture is the only place in these tests where a bound is enforced, and it is
 * clearly not a real machine.
 */
const FIXTURE: MachineProfile = {
  profileId: "fixture:bench",
  version: 3,
  family: "Dectro/Apilus",
  manufacturer: "Fixture",
  model: "Bench",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "fixed", mhz: 13.56, verification: "device-confirmed", evidence: ["f"] },
  evidence: [
    {
      id: "f",
      kind: "studio-device-photo",
      consultedOn: "2026-10-11",
      establishes: "A synthetic bench unit used only to exercise refusal paths.",
    },
  ],
  openQuestions: [],
  channels: {
    count: 4,
    nativeLabel: "Channel",
    associationRequired: false,
    supportsDistinctSettingGroups: true,
    verification: "device-confirmed",
    evidence: ["f"],
  },
  modes: [
    {
      key: "bench",
      nativeLabel: "Bench",
      family: "thermolysis",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["f"],
      stages: [],
      fields: [
        {
          key: "hard",
          nativeLabel: "Hard",
          quantity: "intensity",
          unit: "device-display",
          decimals: 1,
          optional: false,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["f"],
          ranges: [
            { max: 10, class: "hardware-enforced", evidence: "f" },
          ],
        },
        {
          key: "published",
          nativeLabel: "Published",
          quantity: "intensity",
          unit: "device-display",
          decimals: 0,
          optional: true,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["f"],
          ranges: [{ max: 5, class: "published-specification", evidence: "f" }],
        },
        {
          key: "disputed",
          nativeLabel: "Disputed",
          quantity: "intensity",
          unit: "device-display",
          decimals: 0,
          optional: true,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["f"],
          ranges: [
            {
              max: 5,
              class: "hardware-enforced",
              evidence: "f",
              discrepancy: "the manual and the specification table disagree",
            },
          ],
        },
        {
          key: "secs",
          nativeLabel: "Seconds",
          quantity: "duration",
          unit: "s",
          decimals: 1,
          optional: true,
          expectedSource: "practitioner-entered",
          editable: true,
          verification: "device-confirmed",
          evidence: ["f"],
        },
        {
          key: "computed",
          nativeLabel: "Computed",
          quantity: "energy-display",
          unit: "device-display",
          decimals: 0,
          optional: true,
          expectedSource: "device-computed",
          editable: false,
          verification: "device-confirmed",
          evidence: ["f"],
        },
      ],
    },
  ],
};

const FIXTURE_CATALOGUE = [FIXTURE];
const bench = (over: Record<string, unknown> = {}) => ({
  profileId: "fixture:bench",
  version: 3,
  modeKey: "bench",
  fieldKey: "hard",
  source: "practitioner-entered" as const,
  value: { kind: "value" as const, value: 1 },
  ...over,
});

// ---------------------------------------------------------------------------

describe("the catalogue is internally consistent", () => {
  it("passes every integrity invariant", () => {
    // The activation gate, duplicate ids, dangling evidence references and
    // hardware bounds claimed over a source disagreement — all mechanical.
    expect(catalogueIntegrity()).toEqual([]);
  });

  it("catches an activation that outruns its evidence", () => {
    // Non-vacuity for the gate above: flipping one profile active while an
    // open question still blocks its fields must be caught.
    const tampered = MACHINE_CATALOGUE.map((p) =>
      p.profileId === "permanence-gemm:gemm-16"
        ? {
            ...p,
            availability: "active" as const,
            modes: p.modes.map((m) => ({ ...m, availability: "active" as const })),
          }
        : p,
    );
    const violations = catalogueIntegrity(tampered);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((v) => v.problem).join(" ")).toContain("duration");
  });

  it("gives every non-offered profile a stated reason", () => {
    for (const p of MACHINE_CATALOGUE) {
      if (p.availability !== "active") {
        expect(p.availabilityReason, `${p.profileId} is silent about why`).toBeTruthy();
      }
    }
  });

  it("every field cites evidence that exists on its own profile", () => {
    for (const p of MACHINE_CATALOGUE) {
      const ids = new Set(p.evidence.map((e) => e.id));
      for (const m of p.modes) {
        for (const { field } of modeFields(m)) {
          expect(field.evidence.length, `${p.profileId}.${field.key}`).toBeGreaterThan(0);
          for (const id of field.evidence) expect(ids).toContain(id);
        }
      }
    }
  });
});

describe("nothing is offered that is not yet verified", () => {
  it("offers no profile at all right now, and says so honestly", () => {
    // A MEASUREMENT, not an aspiration: #829's own position is that full
    // runtime support and the exact studio inventory remain unverified. When a
    // manual lands, this number changes and the integrity gate above is what
    // permits it.
    expect(activeProfiles(MACHINE_CATALOGUE)).toEqual([]);
  });

  it("offers no mode through a blocked profile", () => {
    for (const p of MACHINE_CATALOGUE) {
      expect(activeModes(p), `${p.profileId} leaked a mode`).toEqual([]);
    }
  });

  it("claims no hardware-enforced bound anywhere in the shipped catalogue", () => {
    // Not one source in #829's ledger establishes a hardware limit for an exact
    // model and version, so not one may be enforced. This is the assertion that
    // stops a manual's printed min/max becoming a blocking validator.
    const enforced = MACHINE_CATALOGUE.flatMap((p) =>
      p.modes.flatMap((m) =>
        modeFields(m).flatMap(({ field }) =>
          (field.ranges ?? [])
            .filter((r) => r.class === "hardware-enforced")
            .map(() => `${p.profileId}.${field.key}`),
        ),
      ),
    );
    expect(enforced).toEqual([]);
  });

  it("keeps an evidence checklist a human can actually chase", () => {
    const checklist = openEvidenceChecklist();
    expect(checklist.length).toBeGreaterThan(0);
    for (const row of checklist) {
      expect(row.question.resolvedBy.length).toBeGreaterThan(10);
      expect(row.question.blocks.length).toBeGreaterThan(0);
    }
    // The ST 250's manual is the one that 403'd, so everything about it is held.
    expect(
      checklist.find((r) => r.profileId === "silhouettone:st-250")?.question.blocks,
    ).toEqual(["*"]);
  });
});

describe("the traps #829 names are absent by assertion", () => {
  it("Junior 3G does not inherit MultiPlex from its family", () => {
    const junior = profileById("dectro-apilus:junior-3g")!;
    // Identity only: no operating screen has been read for this unit, so it
    // claims no mode at all — and in particular not MultiPlex.
    expect(junior.modes).toEqual([]);
    // The sibling that DOES carry MultiPlex is what makes that absence a real
    // distinction rather than an empty catalogue entry.
    expect(profileById("dectro-apilus:xcell")!.modes.map((m) => m.key)).toContain(
      "multiplex",
    );
  });

  it("no profile carries a field whose only source was read for another model", () => {
    // The MultiBlend final-component duration comes from the xCell manual, so
    // xCell is the only profile entitled to it. This is the generalised form of
    // the Junior 3G trap: evidence does not travel along a family name.
    const carriers = MACHINE_CATALOGUE.filter((p) =>
      p.modes.some((m) => m.stages.some((s) => s.key === "final_component")),
    ).map((p) => p.profileId);
    expect(carriers).toEqual(["dectro-apilus:xcell"]);
  });

  it("the 5HD's UE and the ST 350's UL stay separate displays", () => {
    const ue = findField(findMode(profileById("silhouettone:evolution-5hd")!, "native")!, "ue")!;
    const ul = findField(findMode(profileById("silhouettone:evolution-st-350")!, "native")!, "ul")!;
    expect(ue.nativeLabel).toBe("UE");
    expect(ul.nativeLabel).toBe("UL");
    // Neither machine carries the other's label, and neither is normalised into
    // a shared dose unit.
    expect(ue.nativeLabel).not.toBe(ul.nativeLabel);
    expect(ue.unit).toBe("device-display");
    expect(ul.unit).toBe("device-display");
  });

  it("the ST 250 borrows nothing from the ST 350", () => {
    const st250 = profileById("silhouettone:st-250")!;
    expect(st250.modes).toEqual([]);
    expect(st250.frequency.kind).toBe("unverified");
  });

  it("GEMM microamps never share a unit with ST 350 milliamps", () => {
    const gemm = findField(
      findMode(profileById("permanence-gemm:gemm-16")!, "galvanic")!,
      "current",
    )!;
    const st350 = findField(
      findMode(profileById("silhouettone:evolution-st-350")!, "native")!,
      "galvanic_ma",
    )!;
    expect(gemm.unit).toBe("µA");
    expect(st350.unit).toBe("mA");
  });

  it("no Apilus profile models a probe-holder outlet as a channel", () => {
    for (const p of MACHINE_CATALOGUE) {
      if (p.family === "Dectro/Apilus") {
        expect(p.channels, `${p.profileId} invented channels`).toBeUndefined();
      }
    }
  });

  it("the two GEMM variants keep distinct identities", () => {
    const us = profileById("permanence-gemm:gemm-16")!;
    const beauty = profileById("permanence-gemm:gemm-16-beauty")!;
    expect(us.profileId).not.toBe(beauty.profileId);
    expect(beauty.availabilityReason).toMatch(/equivalence/i);
  });
});

describe("MultiPlex round-trips as two stages, not one flattened pair", () => {
  it("keeps slow thermolysis and snap readings separate", () => {
    const mode = findMode(profileById("dectro-apilus:xcell")!, "multiplex")!;
    expect(mode.stages.map((s) => s.key)).toEqual(["slow_thermolysis", "snap"]);

    const byStage = modeFields(mode).filter((f) => f.stageKey !== null);
    // Both stages carry their own duration and intensity — the same field KEY
    // would have collided had they been flattened.
    expect(byStage.filter(({ field }) => field.quantity === "duration")).toHaveLength(2);
    expect(byStage.filter(({ field }) => field.quantity === "intensity")).toHaveLength(2);
    expect(findField(mode, "snap_count", "snap")).toBeTruthy();
  });

  it("a stage field is not reachable at mode level or from the wrong stage", () => {
    const mode = findMode(profileById("dectro-apilus:xcell")!, "multiplex")!;
    expect(findField(mode, "snap_duration", null)).toBeUndefined();
    expect(findField(mode, "snap_duration", "slow_thermolysis")).toBeUndefined();
    expect(findField(mode, "snap_duration", "snap")).toBeTruthy();
  });

  it("MultiBlend keeps its separately displayed final component", () => {
    const mode = findMode(profileById("dectro-apilus:xcell")!, "multiblend")!;
    expect(mode.stages.map((s) => s.key)).toEqual(["final_component"]);
  });
});

describe("GEMM channel semantics", () => {
  const gemm = () => profileById("permanence-gemm:gemm-16")!;

  it("saves a setup without sixteen mandatory rows", () => {
    expect(gemm().channels!.associationRequired).toBe(false);
  });

  it("preserves two different settings groups when probes differ", () => {
    expect(gemm().channels!.supportsDistinctSettingGroups).toBe(true);
  });

  it("records independently controlled channels, not a pulse or hair count", () => {
    const ch = gemm().channels!;
    expect(ch.count).toBe(16);
    expect(ch.nativeLabel).toBe("Channel");
    expect(ch.note).toMatch(/not a pulse count/i);
  });

  it("the core chart is current plus duration and nothing more", () => {
    const mode = findMode(gemm(), "galvanic")!;
    const required = modeFields(mode)
      .filter(({ field }) => !field.optional)
      .map(({ field }) => field.key)
      .sort();
    expect(required).toEqual(["current", "duration"]);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("a recorded observation is never destroyed", () => {
  it("returns a value beyond a PUBLISHED range exactly as submitted", () => {
    const r = validateReading(
      bench({ fieldKey: "published", value: { kind: "value", value: 9 } }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recorded).toEqual({ kind: "value", value: 9 });
    expect(r.notes.map((n) => n.code)).toContain("outside_published_specification");
  });

  it("a DISPUTED hardware range never refuses, however it is classified", () => {
    // The Senior 3G shape: the sources disagree, so the disagreement is the
    // finding and the reading stands.
    const r = validateReading(
      bench({ fieldKey: "disputed", value: { kind: "value", value: 99 } }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recorded).toEqual({ kind: "value", value: 99 });
    expect(r.notes.map((n) => n.code)).toContain("documentation_discrepancy");
  });

  it("REFUSES precision finer than the contract, rather than promising to keep it", () => {
    // THIS ASSERTED THE OPPOSITE, and the old expectation is why the finding
    // existed (Codex, #860 4289974660): the validator returned ok with a
    // `precision_beyond_contract` NOTE whose message read "Stored exactly as
    // entered". 0223's recording command refuses the same value
    // (`scale(v_value) > v_decimals`), so that promise could never be kept -
    // app and database disagreed and the app's half was the one talking to
    // the practitioner.
    //
    // REFUSING IS THE SIDE THAT SURVIVES, for a reason one layer on from the
    // disagreement: a reading row stores the CONTRACT's `decimals` beside the
    // value, so persisting 1.234 against a 2-decimal contract would store a
    // row that disagrees with itself, and a renderer formatting by `decimals`
    // would show 1.23. Relaxing the database would not have preserved her
    // reading - it would have hidden a digit later and more quietly.
    const r = validateReading(
      bench({ fieldKey: "secs", value: { kind: "value", value: 1.234 } }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("precision_beyond_contract");
    // IT STILL DOES NOT ROUND, which was the true half of the original rule:
    // it says what it saw and asks her to read the machine again.
    expect(r.message).toContain("1.234");
    expect(r.message).toMatch(/not rounded for you/i);
  });

  it("accepts a value AT the contract's precision, so the refusal is not a ban on decimals", () => {
    // Without this the assertion above would pass for a validator that
    // refused every fractional value.
    const r = validateReading(
      bench({ fieldKey: "secs", value: { kind: "value", value: 1.2 } }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recorded).toEqual({ kind: "value", value: 1.2 });
  });

  it("treats a recorded zero as a value, not an absence", () => {
    const r = validateReading(
      bench({ fieldKey: "secs", value: { kind: "value", value: 0 } }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recorded).toEqual({ kind: "value", value: 0 });
    // A zero setting can be meaningful on its own terms, so nothing flags it.
    expect(r.notes.map((n) => n.code)).not.toContain("precision_beyond_contract");
  });

  it("keeps the three absences distinct", () => {
    const notRecorded = validateReading(
      bench({ fieldKey: "secs", value: { kind: "absent", reason: "not-recorded" } }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(notRecorded.ok).toBe(true);
    if (notRecorded.ok) {
      expect(notRecorded.recorded).toEqual({ kind: "absent", reason: "not-recorded" });
      expect(notRecorded.notes).toEqual([]);
    }

    // `not-applicable` on a field the mode genuinely has is a contradiction,
    // flagged but still recorded as given.
    const notApplicable = validateReading(
      bench({ fieldKey: "secs", value: { kind: "absent", reason: "not-applicable" } }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(notApplicable.ok).toBe(true);
    if (notApplicable.ok) {
      expect(notApplicable.notes.map((n) => n.code)).toContain(
        "absence_reason_contradicts_contract",
      );
    }
  });

  it("flags a provenance mismatch without discarding the reading", () => {
    const r = validateReading(
      bench({
        fieldKey: "computed",
        source: "practitioner-entered",
        value: { kind: "value", value: 4 },
      }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notes.map((n) => n.code)).toContain("provenance_mismatch");
  });
});

describe("validation refuses exactly what it should", () => {
  it("refuses a verified hardware limit", () => {
    const r = validateReading(
      bench({ fieldKey: "hard", value: { kind: "value", value: 11 } }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("outside_hardware_limit");
  });

  it("accepts the same field at its limit", () => {
    const r = validateReading(
      bench({ fieldKey: "hard", value: { kind: "value", value: 10 } }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(r.ok).toBe(true);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("refuses malformed input: %s", (_label, value) => {
    const r = validateReading(bench({ fieldKey: "secs", value: { kind: "value", value } }), {
      catalogue: FIXTURE_CATALOGUE,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("malformed_value");
  });

  it("refuses a negative duration as malformed, not as a bound", () => {
    const r = validateReading(
      bench({ fieldKey: "secs", value: { kind: "value", value: -1 } }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("malformed_value");
      expect(r.message).toMatch(/not a documented bound/i);
    }
  });

  it("refuses a field borrowed from another mode or machine", () => {
    const wrongMode = validateReading(bench({ fieldKey: "ue" }), {
      catalogue: FIXTURE_CATALOGUE,
    });
    expect(wrongMode.ok).toBe(false);
    if (!wrongMode.ok) expect(wrongMode.code).toBe("unknown_field");

    // version 1 matches the ST 250's contract, so the version gate passes and
    // this reaches the check actually under test.
    const wrongProfile = validateReading(
      bench({ profileId: "silhouettone:st-250", version: 1 }),
      { catalogue: MACHINE_CATALOGUE, allowNonOffered: true },
    );
    expect(wrongProfile.ok).toBe(false);
    if (!wrongProfile.ok) expect(wrongProfile.code).toBe("unknown_mode");
  });

  it("refuses an unknown profile rather than guessing a family default", () => {
    const r = validateReading(bench({ profileId: "acme:whatever" }), {
      catalogue: FIXTURE_CATALOGUE,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_profile");
  });

  it("refuses new capture against a blocked profile, but allows historical re-read", () => {
    const capture = validateReading({
      profileId: "silhouettone:evolution-st-350",
      version: 1,
      modeKey: "native",
      fieldKey: "ul",
      source: "machine-displayed",
      value: { kind: "value", value: 12 },
    });
    expect(capture.ok).toBe(false);
    if (!capture.ok) expect(capture.code).toBe("profile_not_offered");

    // Legacy rendering must survive a profile being blocked later — this is the
    // "unchanged legacy rendering" acceptance case at contract level.
    const historical = validateReading(
      {
        profileId: "silhouettone:evolution-st-350",
        version: 1,
        modeKey: "native",
        fieldKey: "ul",
        source: "machine-displayed",
        value: { kind: "value", value: 12 },
      },
      { allowNonOffered: true },
    );
    expect(historical.ok).toBe(true);
    if (historical.ok) expect(historical.recorded).toEqual({ kind: "value", value: 12 });
  });

  it("refuses a stale contract version", () => {
    const r = validateReading(bench({ version: 2 }), { catalogue: FIXTURE_CATALOGUE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("stale_profile_version");
  });

  it("refuses a channel on a machine that has none, and an out-of-range one", () => {
    const noChannels = validateReading(
      {
        profileId: "dectro-apilus:xcell",
        version: 1,
        modeKey: "multiplex",
        stageKey: "snap",
        fieldKey: "snap_count",
        source: "practitioner-entered",
        value: { kind: "value", value: 2 },
        channel: 1,
      },
      { allowNonOffered: true },
    );
    expect(noChannels.ok).toBe(false);
    if (!noChannels.ok) {
      expect(noChannels.code).toBe("channel_not_supported");
      expect(noChannels.message).toMatch(/probe-holder outlet is not a channel/i);
    }

    const tooHigh = validateReading(bench({ fieldKey: "secs", channel: 5 }), {
      catalogue: FIXTURE_CATALOGUE,
    });
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.code).toBe("channel_out_of_range");
  });

  it("surfaces a pending-evidence field as a note on an otherwise valid reading", () => {
    const r = validateReading(
      {
        profileId: "permanence-gemm:gemm-16",
        version: 1,
        modeKey: "galvanic",
        fieldKey: "duration",
        source: "practitioner-entered",
        value: { kind: "value", value: 300 },
      },
      { allowNonOffered: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notes.map((n) => n.code)).toContain("field_evidence_pending");
  });
});

describe("carry-forward is a proposal that clears on incompatibility", () => {
  const at = (profileId: string, version: number, modeKey: string) => ({
    profileId,
    version,
    modeKey,
  });

  it("carries within the same profile, version and mode", () => {
    expect(
      carryForwardCompatibility(
        at("dectro-apilus:xcell", 1, "multiplex"),
        at("dectro-apilus:xcell", 1, "multiplex"),
      ),
    ).toEqual({ carry: true });
  });

  it("clears on a different machine", () => {
    const r = carryForwardCompatibility(
      at("dectro-apilus:xcell", 1, "multiplex"),
      at("silhouettone:evolution-st-350", 1, "native"),
    );
    expect(r.carry).toBe(false);
    if (!r.carry) expect(r.reason).toBe("profile");
  });

  it("clears on a mode change", () => {
    const r = carryForwardCompatibility(
      at("dectro-apilus:xcell", 1, "multiplex"),
      at("dectro-apilus:xcell", 1, "multiblend"),
    );
    expect(r.carry).toBe(false);
    if (!r.carry) expect(r.reason).toBe("mode");
  });

  it("clears on a contract version change rather than converting units", () => {
    const r = carryForwardCompatibility(
      at("dectro-apilus:xcell", 1, "multiplex"),
      at("dectro-apilus:xcell", 2, "multiplex"),
    );
    expect(r.carry).toBe(false);
    if (!r.carry) {
      expect(r.reason).toBe("version");
      expect(r.message).toMatch(/stay on their own version untouched/i);
    }
  });

  it("deciding not to carry forward changes no historical value", () => {
    // The structural guarantee: compatibility is a pure predicate over
    // identities. It receives no readings and therefore cannot rewrite one.
    const before = JSON.stringify(MACHINE_CATALOGUE);
    carryForwardCompatibility(
      at("dectro-apilus:xcell", 1, "multiplex"),
      at("permanence-gemm:gemm-16", 1, "galvanic"),
    );
    expect(JSON.stringify(MACHINE_CATALOGUE)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The activation policy review, 2026-10-12
// ---------------------------------------------------------------------------

describe("activation readiness is derived, and no model passes it yet", () => {
  it("no catalogue profile is ready to become selectable", () => {
    const ready = MACHINE_CATALOGUE.filter((p) => activationReadiness(p).ready).map(
      (p) => p.profileId,
    );
    expect(ready).toEqual([]);
  });

  it("ST 350 — the closest candidate — is NOT ready, and says exactly why", () => {
    // It passes the ORIGINAL gate: four non-optional fields documented, and its
    // repeat question blocks only the optional field. The 2026-10-12 review
    // found that gate too coarse. The manual mirror establishes four LABELS and
    // their units; the decimal precision, the editability and the machine's own
    // mode names were inferred. These blockers are that finding, mechanised.
    const review = activationReadiness(profileById("silhouettone:evolution-st-350")!);
    expect(review.ready).toBe(false);

    const all = review.blockers.join(" | ");
    // All four display fields are held. Two independent mechanisms now cover
    // them — the precision question and the per-field unverified aspects — and
    // the gate reports whichever it reaches first. Both must be cleared.
    for (const key of ["time", "hf_percent", "galvanic_ma", "ul"]) {
      expect(all, `${key} should be held`).toContain(key);
    }
    expect(
      profileById("silhouettone:evolution-st-350")!.modes[0]!.fields.every(
        (f) => f.optional || (f.unverified ?? []).length > 0,
      ),
      "every required ST 350 field should declare its evidence gap",
    ).toBe(true);
    // And the mode's own identity is a placeholder, not the machine's word.
    expect(all).toMatch(/its own identity is pending-evidence/);
  });

  it("5HD carries the identical gap, found in the same review", () => {
    const review = activationReadiness(profileById("silhouettone:evolution-5hd")!);
    expect(review.ready).toBe(false);
    const all = review.blockers.join(" | ");
    for (const key of ["t", "ue"]) expect(all).toContain(key);
    expect(all).toMatch(/its own identity is pending-evidence/);
  });

  it("a profile with no modes at all is never 'ready' by vacuous default", () => {
    // ST 250 claims no modes. An empty required-field set must not pass a gate
    // that only looks for violations.
    const review = activationReadiness(profileById("silhouettone:st-250")!);
    expect(review.ready).toBe(false);
  });

  it("records the precision and mode-name questions against both models", () => {
    const ids = (profileId: string) =>
      profileById(profileId)!.openQuestions.map((q) => q.id);
    expect(ids("silhouettone:evolution-st-350")).toEqual([
      "st350-repeat-bound",
      "st350-display-precision",
      "st350-mode-names",
    ]);
    expect(ids("silhouettone:evolution-5hd")).toEqual([
      "5hd-display-precision",
      "5hd-mode-names",
    ]);
  });

  it("every open question blocks a field that actually exists, or everything", () => {
    // ASK THE REAL GUARD, do not restate it (Codex, #855 4305019844). The
    // previous version of this test reimplemented the rule and then stripped
    // the qualifier off a target before checking it existed — so
    // `wrong-mode.duration` passed whenever `duration` existed under ANY
    // mode, and `@frequncy` passed because anything `@`-prefixed was skipped
    // outright. It agreed with a guard that did not enforce the rule, which
    // is the only way both could be wrong at once.
    expect(
      catalogueIntegrity(MACHINE_CATALOGUE)
        .filter((v) => v.problem.includes("blocks"))
        .map((v) => `${v.profileId}: ${v.problem}`),
    ).toEqual([]);
  });
});

// ===========================================================================
// MPX-01 — the four findings from the 82b5f0fb review
// ===========================================================================

describe("the integrity guard rejects a question that holds nothing", () => {
  // THE DEFECT (Codex, #855 4305019844). `OpenQuestion.blocks` has always
  // documented this — "A target naming nothing real holds nothing, which is
  // worse than no question at all — the integrity guard rejects that" — and
  // the guard did not implement it. The consequence is not a cosmetic one:
  // `activationReadiness` reuses this guard, so an unresolved question that
  // named nothing real let a profile be approved as READY.
  const base = (): MachineProfile => ({
    profileId: "fixture:blockers",
    version: 1,
    family: "Silhouet-Tone",
    manufacturer: "Fixture",
    model: "Blockers",
    availability: "blocked",
    availabilityReason: "a fixture, never offered",
    verification: "device-confirmed",
    frequency: { kind: "not-applicable" },
    evidence: [
      {
        id: "fx",
        kind: "studio-device-photo",
        consultedOn: "2026-10-18",
        establishes: "Nothing about a real machine.",
      },
    ],
    openQuestions: [],
    modes: [
      {
        key: "m",
        nativeLabel: "M",
        family: "thermolysis",
        availability: "blocked",
        verification: "device-confirmed",
        evidence: ["fx"],
        stages: [
          {
            key: "st",
            nativeLabel: "St",
            fields: [
              {
                key: "staged",
                nativeLabel: "Staged",
                quantity: "duration",
                unit: "s",
                decimals: 1,
                optional: false,
                expectedSource: "practitioner-entered",
                editable: true,
                verification: "device-confirmed",
                evidence: ["fx"],
              },
            ],
          },
        ],
        fields: [
          {
            key: "duration",
            nativeLabel: "Duration",
            quantity: "duration",
            unit: "s",
            decimals: 1,
            optional: false,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "device-confirmed",
            evidence: ["fx"],
          },
        ],
      },
    ],
  });

  const withBlocks = (...blocks: string[]): MachineProfile => ({
    ...base(),
    openQuestions: [
      { id: "q1", question: "?", resolvedBy: "a manual page", blocks },
    ],
  });

  const problems = (p: MachineProfile) =>
    catalogueIntegrity([p]).map((v) => v.problem);

  it("rejects a MISSPELLED QUALIFIER even when the bare field exists", () => {
    // The exact case the old test could not see: `duration` is a real field
    // under mode `m`, but there is no mode `wrong-mode`.
    expect(problems(withBlocks("wrong-mode.duration"))).toContain(
      "open question 'q1' blocks 'wrong-mode.duration', which names no field, mode.field, stage.field or profile-level sentinel",
    );
  });

  it("rejects a misspelled profile-level sentinel", () => {
    expect(
      problems(withBlocks("@frequncy")).some((x) => x.includes("@frequncy")),
      "an '@'-prefixed typo was treated as a valid profile-level target",
    ).toBe(true);
  });

  it("rejects a question that blocks nothing at all", () => {
    expect(problems(withBlocks())).toContain(
      "open question 'q1' blocks nothing at all",
    );
  });

  it("CONTROL: each of the four legitimate target shapes is accepted", () => {
    for (const target of ["duration", "m.duration", "st.staged", "*"]) {
      expect(
        problems(withBlocks(target)).filter((x) => x.includes("blocks")),
        `the legitimate target '${target}' was rejected`,
      ).toEqual([]);
    }
  });

  it("CONTROL: the base fixture is otherwise clean, so nothing above passes by accident", () => {
    expect(problems(base())).toEqual([]);
  });
});

describe("a repeated structural key is an integrity violation, not array order", () => {
  // THE DEFECT (Codex, #855 4305019857). Lookup is `.find()`, so the later
  // contract is UNREACHABLE and whichever entry comes first decides the
  // labels, units and limits a practitioner sees.
  const base = (): MachineProfile => ({
    profileId: "fixture:dupes",
    version: 1,
    family: "Silhouet-Tone",
    manufacturer: "Fixture",
    model: "Dupes",
    availability: "blocked",
    availabilityReason: "a fixture, never offered",
    verification: "device-confirmed",
    frequency: { kind: "not-applicable" },
    evidence: [
      {
        id: "fx",
        kind: "studio-device-photo",
        consultedOn: "2026-10-18",
        establishes: "Nothing about a real machine.",
      },
    ],
    openQuestions: [],
    modes: [],
  });

  const field = (key: string) => ({
    key,
    nativeLabel: key,
    quantity: "duration" as const,
    unit: "s" as const,
    decimals: 1,
    optional: false,
    expectedSource: "practitioner-entered" as const,
    editable: true,
    verification: "device-confirmed" as const,
    evidence: ["fx"],
  });

  const mode = (key: string, fields: string[], stages: Array<[string, string[]]> = []) => ({
    key,
    nativeLabel: key,
    family: "thermolysis" as const,
    availability: "blocked" as const,
    verification: "device-confirmed" as const,
    evidence: ["fx"],
    fields: fields.map(field),
    stages: stages.map(([sk, fs]) => ({
      key: sk,
      nativeLabel: sk,
      fields: fs.map(field),
    })),
  });

  const problems = (modes: MachineProfile["modes"]) =>
    catalogueIntegrity([{ ...base(), modes }]).map((v) => v.problem);

  it("catches a repeated MODE key", () => {
    expect(problems([mode("m", ["a"]), mode("m", ["b"])])).toContain(
      "duplicate mode key 'm'",
    );
  });

  it("catches a repeated STAGE key within one mode", () => {
    expect(
      problems([mode("m", ["a"], [["st", ["x"]], ["st", ["y"]]])]),
    ).toContain("mode m has duplicate stage key 'st'");
  });

  it("catches a repeated FIELD key at mode level", () => {
    expect(problems([mode("m", ["a", "a"])])).toContain(
      "mode m has duplicate field key 'a'",
    );
  });

  it("catches a repeated FIELD key within one stage", () => {
    expect(problems([mode("m", ["a"], [["st", ["x", "x"]]])])).toContain(
      "mode m stage st has duplicate field key 'x'",
    );
  });

  it("CONTROL: the SAME field key in two different stages is legitimate", () => {
    // Field lookup is keyed on (mode, stageKey, fieldKey), and a MultiPlex
    // mode genuinely carries its own duration per stage. A rule scoped any
    // wider than the lookup's own key would reject honest profiles.
    expect(
      problems([mode("m", [], [["slow", ["duration"]], ["snap", ["duration"]]])]),
    ).toEqual([]);
  });

  it("CONTROL: the same mode key in two different PROFILES is legitimate", () => {
    expect(
      catalogueIntegrity([
        { ...base(), modes: [mode("native", ["a"])] },
        { ...base(), profileId: "fixture:dupes-2", modes: [mode("native", ["a"])] },
      ]).map((v) => v.problem),
    ).toEqual([]);
  });
});

describe("evidence is validated everywhere it is cited, not only on fields", () => {
  // THE DEFECT (Codex, #855 4305019848). The membership and non-empty checks
  // lived inline in the field loop, so a mode, a channel structure or a
  // frequency could cite an id absent from the profile's own ledger — or cite
  // nothing — and still be reported as documented.
  const base = (): MachineProfile => ({
    profileId: "fixture:evidence",
    version: 1,
    family: "Silhouet-Tone",
    manufacturer: "Fixture",
    model: "Evidence",
    availability: "blocked",
    availabilityReason: "a fixture, never offered",
    verification: "device-confirmed",
    frequency: { kind: "not-applicable" },
    evidence: [
      {
        id: "fx",
        kind: "studio-device-photo",
        consultedOn: "2026-10-18",
        establishes: "Nothing about a real machine.",
      },
    ],
    openQuestions: [],
    modes: [
      {
        key: "m",
        nativeLabel: "M",
        family: "thermolysis",
        availability: "blocked",
        verification: "device-confirmed",
        evidence: ["fx"],
        stages: [],
        fields: [
          {
            key: "d",
            nativeLabel: "D",
            quantity: "duration",
            unit: "s",
            decimals: 1,
            optional: false,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "device-confirmed",
            evidence: ["fx"],
          },
        ],
      },
    ],
  });

  const problems = (over: Partial<MachineProfile>) =>
    catalogueIntegrity([{ ...base(), ...over }]).map((v) => v.problem);

  it("catches a MODE citing evidence the profile does not carry", () => {
    const b = base();
    expect(
      problems({ modes: [{ ...b.modes[0]!, evidence: ["nope"] }] }),
    ).toContain("mode m cites unknown evidence 'nope'");
  });

  it("catches a MODE citing no evidence at all", () => {
    const b = base();
    expect(problems({ modes: [{ ...b.modes[0]!, evidence: [] }] })).toContain(
      "mode m cites no evidence at all",
    );
  });

  it("catches a CHANNEL STRUCTURE citing unknown evidence", () => {
    expect(
      problems({
        channels: {
          count: 2,
          nativeLabel: "Channel",
          associationRequired: false,
          supportsDistinctSettingGroups: false,
          verification: "device-confirmed",
          evidence: ["nope"],
        },
      }),
    ).toContain("channel structure cites unknown evidence 'nope'");
  });

  it("catches a FIXED FREQUENCY citing unknown evidence", () => {
    expect(
      problems({
        frequency: {
          kind: "fixed",
          mhz: 13.56,
          verification: "device-confirmed",
          evidence: ["nope"],
        },
      }),
    ).toContain("frequency (fixed) cites unknown evidence 'nope'");
  });

  it("catches a SELECTABLE FREQUENCY citing nothing at all", () => {
    expect(
      problems({
        frequency: {
          kind: "selectable",
          mhz: [13.56, 27.12],
          verification: "device-confirmed",
          evidence: [],
        },
      }),
    ).toContain("frequency (selectable) cites no evidence at all");
  });

  it("CONTROL: a not-applicable frequency cites nothing and that is correct", () => {
    // It has no evidence array at all; demanding one would invent a source
    // for the absence of a control.
    expect(problems({})).toEqual([]);
  });
});

describe("the two new gate limbs bite", () => {
  /** An otherwise perfect, fully evidenced, active single-field profile. */
  const perfect = (): MachineProfile => ({
    profileId: "fixture:perfect",
    version: 1,
    family: "Silhouet-Tone",
    manufacturer: "Fixture",
    model: "Perfect",
    availability: "active",
    verification: "device-confirmed",
    frequency: { kind: "not-applicable" },
    evidence: [
      {
        id: "p",
        kind: "studio-device-photo",
        consultedOn: "2026-10-12",
        establishes: "A synthetic fully evidenced unit.",
      },
    ],
    openQuestions: [],
    modes: [
      {
        key: "m",
        nativeLabel: "M",
        family: "thermolysis",
        availability: "active",
        verification: "device-confirmed",
        evidence: ["p"],
        stages: [],
        fields: [
          {
            key: "f",
            nativeLabel: "F",
            quantity: "duration",
            unit: "s",
            decimals: 1,
            optional: false,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "device-confirmed",
            evidence: ["p"],
          },
        ],
      },
    ],
  });

  it("the control passes, so the limbs below are not passing by accident", () => {
    expect(catalogueIntegrity([perfect()])).toEqual([]);
    expect(activationReadiness(perfect()).ready).toBe(true);
  });

  it("an unverified ASPECT on a required field blocks activation", () => {
    const p = perfect();
    p.modes[0]!.fields[0]!.unverified = ["decimals"];
    const problems = catalogueIntegrity([p]).map((v) => v.problem).join(" ");
    expect(problems).toContain("missing evidence for its decimals");
  });

  it("an unverified aspect on an OPTIONAL field does not block", () => {
    const p = perfect();
    p.modes[0]!.fields[0]!.optional = true;
    p.modes[0]!.fields[0]!.unverified = ["decimals"];
    expect(catalogueIntegrity([p])).toEqual([]);
  });

  it("a mode whose own identity is unverified blocks activation", () => {
    const p = perfect();
    p.modes[0]!.verification = "pending-evidence";
    const problems = catalogueIntegrity([p]).map((v) => v.problem).join(" ");
    expect(problems).toContain("its own identity is pending-evidence");
  });
});

// ===========================================================================
// MPX-01 — the five findings from the f4dface3 review
// ===========================================================================

describe("a reading validates against the version it was CAPTURED under", () => {
  // THE P1 (Codex, #855 4304921305). The lookup resolved by profileId alone
  // and then refused the reading for not matching whatever version the
  // catalogue currently held — with a message promising the opposite:
  // "a historical reading keeps rendering against the version it was
  // captured under". The duplicate-profileId rule also made holding v1 beside
  // v2 impossible, so there was no arrangement in which the promise held.
  const V1: MachineProfile = {
    profileId: "fixture:versioned",
    version: 1,
    // Any curated family; nothing under test reads it. NOT a real machine.
    family: "Dectro/Apilus",
    manufacturer: "Fixture",
    model: "Versioned",
    availability: "active",
    verification: "device-confirmed",
    frequency: { kind: "not-applicable" },
    evidence: [
      {
        id: "fx",
        kind: "studio-device-photo",
        consultedOn: "2026-10-17",
        establishes: "Nothing about a real machine; it carries two versions.",
      },
    ],
    openQuestions: [],
    modes: [
      {
        key: "m",
        nativeLabel: "M",
        family: "thermolysis",
        availability: "active",
        verification: "device-confirmed",
        evidence: ["fx"],
        stages: [],
        fields: [
          {
            key: "current",
            nativeLabel: "Current",
            quantity: "current",
            unit: "mA",
            decimals: 1,
            optional: false,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "device-confirmed",
            evidence: ["fx"],
          },
        ],
      },
    ],
  };

  // SAME id, LATER version, DIFFERENT precision — which is why a v1 reading
  // must not be validated against it.
  const V2: MachineProfile = {
    ...V1,
    version: 2,
    modes: [
      {
        ...V1.modes[0]!,
        fields: [{ ...V1.modes[0]!.fields[0]!, decimals: 2 }],
      },
    ],
  };

  const BOTH = [V1, V2];

  // `historical` is the caller saying this is not new capture — a reading
  // already on the record being re-rendered or re-validated.
  const read = (version: number, value: number, historical = false) =>
    validateReading(
      {
        profileId: "fixture:versioned",
        version,
        modeKey: "m",
        fieldKey: "current",
        source: "practitioner-entered",
        value: { kind: "value", value },
      },
      { catalogue: BOTH, allowNonOffered: historical },
    );

  it("renders a HISTORICAL v1 reading while the catalogue also carries v2", () => {
    // Before the P1 fix this returned `stale_profile_version`, making every
    // historical reading invalid the moment a contract was republished. This
    // is the path that defect broke, and it is the historical one — the first
    // version of this test asserted it on the NEW-CAPTURE path instead, which
    // is how it came to assert the very thing 4305019839 then reported.
    const out = read(1, 1.2, true);
    expect(out.ok, "a historical v1 reading was refused against a catalogue holding v1").toBe(
      true,
    );
  });

  it("validates it against v1's precision, not v2's", () => {
    // The point of resolving the captured version: v1 allows 1 decimal and v2
    // allows 2, so the SAME value of 1.25 is beyond contract under v1 and
    // exactly within it under v2. That asymmetry is the whole proof — it can
    // only hold if the version a reading was captured under is the one being
    // applied to it.
    //
    // THIS IS THE MERGE RESOLUTION BETWEEN THE TWO STACKED BRANCHES, and the
    // compiler decided it. On #855 `precision_beyond_contract` is a NOTE, so
    // the version of this test written there asserts `ok` with the code among
    // `notes`. #860 promoted it to a REFUSAL (4289974660), because the app was
    // promising "stored exactly as entered" for a value 0223's recording
    // command refuses outright. An attempt to write this agnostically — "a
    // refusal OR a note" — does not typecheck on this branch: TS2367, because
    // `precision_beyond_contract` is no longer a member of `NoteCode` and the
    // note half is unreachable. So the refusal form is the only honest one
    // here, and the classification is additionally pinned on its own terms
    // further up this file where `r.code` is asserted directly.
    //
    // ASSERTED UNCONDITIONALLY. The first version of this test wrapped its
    // assertions in `if (out.ok)`, so it passed by SKIP the moment the reading
    // was refused for any reason — which is exactly what happened when the
    // superseded-version gate landed: the refusal satisfied the test rather
    // than failing it.
    const v1 = read(1, 1.25, true);
    expect(v1.ok, "1.25 is beyond v1's 1-decimal contract").toBe(false);
    if (v1.ok) throw new Error("expected a refusal");
    expect(
      v1.code,
      "v1's 1-decimal contract was not the one applied",
    ).toBe("precision_beyond_contract");

    // The same value under v2 is exactly within contract and is accepted
    // outright. Under v1's contract this call would be refused, so acceptance
    // here is what proves v2's own contract was applied to a v2 reading.
    expect(
      read(2, 1.25).ok,
      "v2 allows 2 decimals and must accept 1.25",
    ).toBe(true);
  });

  it("REFUSES NEW CAPTURE against a superseded version, naming both", () => {
    // THE DEFECT (Codex, #855 4305019839). Retaining v1 beside v2 is the
    // whole point of versioned identity, and it opened this: a stale client
    // posting version 1 was validated against v1's laxer precision and stored
    // as a NEW reading under a contract that is no longer current.
    // `stale_profile_version` cannot catch it — that fires only when the
    // version is ABSENT.
    const out = read(1, 1.2);
    expect(out.ok, "new capture was accepted against the superseded v1").toBe(
      false,
    );
    if (out.ok) throw new Error("expected a refusal");
    expect(out.code).toBe("superseded_profile_version");
    // The message must name the current version, or she cannot act on it.
    expect(out.message).toContain("version 2");
  });

  it("CONTROL: new capture against the CURRENT version is accepted", () => {
    expect(read(2, 1.2).ok).toBe(true);
  });

  it("CONTROL: with only v1 in the catalogue, v1 IS current and new capture works", () => {
    // The gate compares against the highest version present, so a catalogue
    // that has not republished anything must be unaffected.
    const only = validateReading(
      {
        profileId: "fixture:versioned",
        version: 1,
        modeKey: "m",
        fieldKey: "current",
        source: "practitioner-entered",
        value: { kind: "value", value: 1.2 },
      },
      { catalogue: [V1] },
    );
    expect(only.ok).toBe(true);
  });

  it("two versions of one id are NOT an integrity duplicate", () => {
    expect(
      catalogueIntegrity(BOTH).filter((v) => v.problem.includes("duplicate")),
      "keeping v1 beside v2 was reported as a duplicate, which is what forced the replacement",
    ).toEqual([]);
  });

  it("but two entries at the SAME version still are", () => {
    expect(
      catalogueIntegrity([V1, { ...V1 }]).map((v) => v.problem),
    ).toContain("duplicate profileId at version 1");
  });

  it("a version the catalogue does not carry is refused, and says which it has", () => {
    const out = read(99, 1.2);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("stale_profile_version");
      expect(out.message).toMatch(/no contract for version 99/i);
    }
  });

  it("an unknown model is still a different refusal from an unknown version", () => {
    const out = validateReading(
      {
        profileId: "fixture:nope",
        version: 1,
        modeKey: "m",
        fieldKey: "current",
        source: "practitioner-entered",
        value: { kind: "value", value: 1 },
      },
      { catalogue: BOTH },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("unknown_profile");
  });

  it("profileById resolves the CURRENT version, explicitly", () => {
    // Not array order: with several versions present "the profile for this
    // id" can only mean the current one, and new capture resolves here.
    expect(profileById("fixture:versioned", BOTH)!.version).toBe(2);
    expect(profileById("fixture:versioned", [V2, V1])!.version).toBe(2);
    expect(profileAtVersion("fixture:versioned", 1, BOTH)!.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The other four findings from the f4dface3 review. Each fixture is local:
// these are rules about the contract, and borrowing the real catalogue would
// make the test depend on a profile someone may legitimately change.
// ---------------------------------------------------------------------------
const FX_EVIDENCE = [
  {
    id: "fx",
    kind: "studio-device-photo" as const,
    consultedOn: "2026-10-17",
    establishes: "Nothing about a real machine.",
  },
];

function fxField(over: Record<string, unknown> = {}) {
  return {
    key: "current",
    nativeLabel: "Current",
    quantity: "current" as const,
    unit: "mA" as const,
    decimals: 1,
    optional: false,
    expectedSource: "practitioner-entered" as const,
    editable: true,
    verification: "device-confirmed" as const,
    evidence: ["fx"],
    ...over,
  };
}

function fxProfile(over: Record<string, unknown> = {}): MachineProfile {
  return {
    profileId: "fixture:rules",
    version: 1,
    // Any curated family; nothing under test reads it. NOT a real machine.
    family: "Dectro/Apilus",
    manufacturer: "Fixture",
    model: "Rules",
    availability: "active",
    verification: "device-confirmed",
    frequency: { kind: "not-applicable" },
    evidence: FX_EVIDENCE,
    openQuestions: [],
    modes: [
      {
        key: "m",
        nativeLabel: "M",
        family: "thermolysis",
        availability: "active",
        verification: "device-confirmed",
        evidence: ["fx"],
        stages: [],
        fields: [fxField()],
      },
    ],
    ...over,
  } as MachineProfile;
}

const fxRead = (profile: MachineProfile, over: Record<string, unknown> = {}) =>
  validateReading(
    {
      profileId: profile.profileId,
      version: profile.version,
      modeKey: "m",
      fieldKey: "current",
      source: "practitioner-entered",
      value: { kind: "value", value: 1.2 },
      ...over,
    } as never,
    { catalogue: [profile] },
  );

describe("a BLOCKED mode is not offered for new capture", () => {
  // Codex #855 4304921312. `activeModes` hid it from the picker; validation
  // checked only the PROFILE's availability, so a stale client or a direct
  // action call could record against a mode the catalogue says is not ready.
  const blockedMode = fxProfile({
    modes: [
      {
        key: "m",
        nativeLabel: "M",
        family: "thermolysis",
        availability: "blocked",
        availabilityReason: "units unconfirmed",
        verification: "device-confirmed",
        evidence: ["fx"],
        stages: [],
        fields: [fxField()],
      },
    ],
  });

  it("is refused", () => {
    const out = fxRead(blockedMode);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("mode_not_offered");
  });

  it("but a HISTORICAL reading against it still renders", () => {
    // `allowNonOffered` is the caller saying this is not new capture. A mode
    // blocked after the fact must not invalidate what was already recorded.
    const out = validateReading(
      {
        profileId: "fixture:rules",
        version: 1,
        modeKey: "m",
        fieldKey: "current",
        source: "practitioner-entered",
        value: { kind: "value", value: 1.2 },
      },
      { catalogue: [blockedMode], allowNonOffered: true },
    );
    expect(out.ok, "a historical reading was invalidated by a later block").toBe(
      true,
    );
  });
});

describe("a MANDATORY channel association cannot be omitted", () => {
  // Codex #855 4304921322. Every channel check sat inside
  // `input.channel != null`, so a contract declaring the association
  // mandatory accepted a reading that named no channel at all.
  const needsChannel = fxProfile({
    channels: {
      count: 4,
      nativeLabel: "Channel",
      associationRequired: true,
      supportsDistinctSettingGroups: true,
      verification: "device-confirmed",
      evidence: ["fx"],
    },
  });

  it("is refused when no channel is given", () => {
    const out = fxRead(needsChannel);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("channel_required");
  });

  it("is accepted when one is", () => {
    expect(fxRead(needsChannel, { channel: 2 }).ok).toBe(true);
  });

  it("CONTROL: a profile that does NOT require it is unaffected", () => {
    const optional = fxProfile({
      channels: {
        count: 4,
        nativeLabel: "Channel",
        associationRequired: false,
        supportsDistinctSettingGroups: true,
        verification: "device-confirmed",
        evidence: ["fx"],
      },
    });
    expect(fxRead(optional).ok).toBe(true);
  });

  it("CONTROL: an ABSENT reading is not forced to name a channel", () => {
    // "Not recorded" is a fact about a field, not a setting on a probe.
    // Demanding a channel for it would make absence unrecordable.
    const out = fxRead(needsChannel, {
      value: { kind: "absent", reason: "not-recorded" },
    });
    expect(out.ok).toBe(true);
  });
});

describe('the "@frequency" blocker holds activation', () => {
  // Codex #855 4304921316. The profile-level gate tested only "*", so a
  // profile whose frequency contract is explicitly held could be activated
  // once its fields and mode identity were documented. `ProfileLevelBlock`
  // declares this value; honouring it is what makes the declaration mean
  // anything. Two live open questions use it.
  const heldFrequency = fxProfile({
    frequency: { kind: "unverified", note: "sources conflict" },
    openQuestions: [
      {
        id: "freq",
        question: "Which RF frequency applies to this unit?",
        resolvedBy: "A settings-screen photograph.",
        blocks: ["@frequency"],
      },
    ],
  });

  it("an ACTIVE profile with a held frequency is an integrity violation", () => {
    expect(
      catalogueIntegrity([heldFrequency]).map((v) => v.problem),
    ).toContain(
      "profile is active while an open question holds its frequency contract",
    );
  });

  it("CONTROL: the same question on a BLOCKED profile is fine", () => {
    const blocked = fxProfile({
      availability: "blocked",
      availabilityReason: "frequency unresolved",
      frequency: { kind: "unverified", note: "sources conflict" },
      openQuestions: heldFrequency.openQuestions,
      modes: [
        {
          ...fxProfile().modes[0]!,
          availability: "blocked",
          availabilityReason: "frequency unresolved",
        },
      ],
    });
    expect(
      catalogueIntegrity([blocked]).map((v) => v.problem),
    ).not.toContain(
      "profile is active while an open question holds its frequency contract",
    );
  });

  it("CONTROL: an active profile with no blockers is still clean", () => {
    expect(catalogueIntegrity([fxProfile()])).toEqual([]);
  });
});

describe("carry-forward verifies the target against the catalogue", () => {
  // Codex #855 4304921325. The checks compared the two INPUTS with each
  // other, so a pair agreeing on a version and mode that do not exist
  // authorised carrying readings into a contract nobody has. Agreement
  // between two untrusted inputs is not verification.
  const target = fxProfile();
  const at = (version: number, modeKey: string) => ({
    profileId: "fixture:rules",
    version,
    modeKey,
  });

  it("refuses a version the catalogue has never heard of", () => {
    const r = carryForwardCompatibility(at(99, "m"), at(99, "m"), [target]);
    expect(r.carry).toBe(false);
    if (!r.carry) expect(r.reason).toBe("version");
  });

  it("refuses a mode that does not exist on the model", () => {
    const r = carryForwardCompatibility(
      at(1, "missing"),
      at(1, "missing"),
      [target],
    );
    expect(r.carry).toBe(false);
    if (!r.carry) expect(r.reason).toBe("mode");
  });

  it("CONTROL: a real, matching target still carries", () => {
    expect(carryForwardCompatibility(at(1, "m"), at(1, "m"), [target]).carry).toBe(
      true,
    );
  });
});

// ===========================================================================
// MPX-01 — the four findings from the 10de30e4 review
// ===========================================================================

/** A complete, fully evidenced single-field profile, blocked by default. */
function base(over: Partial<MachineProfile> = {}): MachineProfile {
  return {
    profileId: "fixture:round2",
    version: 1,
    family: "Silhouet-Tone",
    manufacturer: "Fixture",
    model: "Round2",
    availability: "blocked",
    availabilityReason: "a fixture, never offered",
    verification: "device-confirmed",
    frequency: { kind: "not-applicable" },
    evidence: [
      {
        id: "fx",
        kind: "studio-device-photo",
        consultedOn: "2026-10-18",
        establishes: "Nothing about a real machine.",
      },
    ],
    openQuestions: [],
    modes: [
      {
        key: "m",
        nativeLabel: "M",
        family: "thermolysis",
        availability: "blocked",
        verification: "device-confirmed",
        evidence: ["fx"],
        stages: [],
        fields: [
          {
            key: "current",
            nativeLabel: "Current",
            quantity: "current",
            unit: "mA",
            decimals: 1,
            optional: false,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "device-confirmed",
            evidence: ["fx"],
          },
        ],
      },
    ],
    ...over,
  };
}

/** The same profile, offered. */
const offered = (over: Partial<MachineProfile> = {}): MachineProfile => {
  const b = base(over);
  return {
    ...b,
    availability: "active",
    availabilityReason: undefined,
    modes: b.modes.map((m) => ({
      ...m,
      availability: "active" as const,
      availabilityReason: undefined,
    })),
  };
};

const problems = (ps: MachineProfile[]) =>
  catalogueIntegrity(ps).map((v) => v.problem);

describe("the picker never offers a contract that cannot be recorded against", () => {
  // THE DEFECT (Codex, #855 4305243747). Retaining v1 beside v2 is the point
  // of versioned identity, and `activeProfiles` filtered on availability
  // alone — so it offered v1 while `validateReading` refuses new capture
  // against it with `superseded_profile_version`. She picks it, enters a full
  // set of readings, and is refused at save for a reason she cannot act on.
  const v1 = offered();
  const v2 = offered({ version: 2 });

  const canRecord = (prof: MachineProfile, catalogue: MachineProfile[]) =>
    validateReading(
      {
        profileId: prof.profileId,
        version: prof.version,
        modeKey: "m",
        fieldKey: "current",
        source: "practitioner-entered",
        value: { kind: "value", value: 1.2 },
      },
      { catalogue },
    ).ok;

  it("offers ONE entry per model — its current contract", () => {
    const offeredNow = activeProfiles([v1, v2]);
    expect(offeredNow.map((p) => p.version)).toEqual([2]);
  });

  it("and EVERY entry it offers can actually be recorded against", () => {
    // The property worth having, asserted as the composition rather than as a
    // restatement of the filter. An offered option that cannot be saved is
    // worse than an absent one.
    const catalogue = [v1, v2];
    for (const prof of activeProfiles(catalogue)) {
      expect(
        canRecord(prof, catalogue),
        `${prof.profileId}@${prof.version} was offered but cannot be recorded against`,
      ).toBe(true);
    }
  });

  it("CONTROL: the version it dropped really is unrecordable", () => {
    // Without this the test above would also pass if `activeProfiles` were
    // simply returning everything and every version happened to be valid.
    expect(canRecord(v1, [v1, v2])).toBe(false);
  });

  it("offers NOTHING when the current version is not active, even if an older one is", () => {
    // THE CASE A "HIGHEST ACTIVE VERSION" RULE WOULD HAVE MISSED. New capture
    // resolves through `profileById`, which is the highest version REGARDLESS
    // of availability — so with v2 blocked, v1 is unrecordable too, and
    // offering it would reproduce the same defect one case over.
    const blockedV2 = base({ version: 2 });
    expect(activeProfiles([v1, blockedV2])).toEqual([]);
    expect(canRecord(v1, [v1, blockedV2])).toBe(false);
  });

  it("CONTROL: a single active version is still offered", () => {
    expect(activeProfiles([v1]).map((p) => p.version)).toEqual([1]);
    expect(canRecord(v1, [v1])).toBe(true);
  });

  it("CONTROL: two different models are both offered", () => {
    const other = offered({ profileId: "fixture:round2-other" });
    expect(activeProfiles([v1, other]).map((p) => p.profileId).sort()).toEqual([
      "fixture:round2",
      "fixture:round2-other",
    ]);
  });
});

describe("an active profile's own identity must be source-backed", () => {
  // THE DEFECT (Codex, #855 4305243749). Every gate inspected the modes and
  // the fields; the PROFILE's own `verification` was never consulted, so a
  // model whose identity is explicitly unverified could be offered as a
  // verified named choice. `active` means "verified named choice" or nothing.
  for (const weak of ["unverified", "pending-evidence"] as const) {
    it(`rejects an active profile whose identity is ${weak}`, () => {
      expect(problems([offered({ verification: weak })])).toContain(
        `profile is active but its own identity is ${weak}`,
      );
    });
  }

  for (const strong of ["manufacturer-documented", "device-confirmed"] as const) {
    it(`CONTROL: ${strong} qualifies`, () => {
      expect(problems([offered({ verification: strong })])).toEqual([]);
    });
  }

  it("and a BLOCKED profile with a weak identity is fine — it is not offered", () => {
    expect(problems([base({ verification: "unverified" })])).toEqual([]);
  });
});

describe("an active profile with no modes is an integrity violation", () => {
  // THE DEFECT (Codex, #855 4305243750). There is no `modeKey` any reading
  // could name, so every capture is refused with `unknown_mode` — offered and
  // unusable. It was caught only by an extra boolean inside
  // `activationReadiness`, which left `blockers` EMPTY so readiness could not
  // say why, while `catalogueIntegrity` would have accepted the same profile
  // if someone set `availability` to active by hand.
  it("the integrity gate rejects it", () => {
    expect(problems([offered({ modes: [] })])).toContain(
      "profile is active but carries no modes at all",
    );
  });

  it("and readiness now EXPLAINS it instead of just saying no", () => {
    const r = activationReadiness(base({ modes: [] }));
    expect(r.ready).toBe(false);
    expect(
      r.blockers,
      "readiness refused with an empty blocker list, which cannot be acted on",
    ).toContain("profile is active but carries no modes at all");
  });

  it("so both paths agree, which is what the extra boolean prevented", () => {
    // `ready` is derived purely from the blockers now. A profile the gate
    // accepts is ready; one it rejects is not. There is no second rule to
    // disagree with.
    const r = activationReadiness(base({ modes: [] }));
    expect(r.ready).toBe(r.blockers.length === 0);
  });

  it("CONTROL: a profile WITH a documented mode is ready", () => {
    const r = activationReadiness(base());
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
  });
});

describe("a hardware step is a reachability constraint", () => {
  // THE DEFECT (Codex, #855 4305243752). `step` is documented as "the
  // smallest increment the machine's control actually moves in", so a value
  // inside the bounds but off the step is as unreachable as one past the
  // maximum — a 0..10 control with step 2 accepted 3. Checking only the
  // endpoints made the step decoration.
  const withRange = (range: Record<string, unknown>): MachineProfile => {
    const b = offered();
    return {
      ...b,
      modes: [
        {
          ...b.modes[0]!,
          fields: [{ ...b.modes[0]!.fields[0]!, ranges: [range] as never }],
        },
      ],
    };
  };

  const read = (prof: MachineProfile, value: number) =>
    validateReading(
      {
        profileId: prof.profileId,
        version: prof.version,
        modeKey: "m",
        fieldKey: "current",
        source: "practitioner-entered",
        value: { kind: "value", value },
      },
      { catalogue: [prof] },
    );

  const HARD = {
    min: 0,
    max: 10,
    step: 2,
    class: "hardware-enforced",
    evidence: "fx",
  };

  it("refuses a value between the bounds that the control cannot reach", () => {
    const out = read(withRange(HARD), 3);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.code).toBe("outside_hardware_limit");
    expect(out.message, "the refusal did not name the step").toContain("steps of 2");
  });

  it("CONTROL: an ON-step value inside the bounds is accepted", () => {
    expect(read(withRange(HARD), 4).ok).toBe(true);
    expect(read(withRange(HARD), 0).ok).toBe(true);
    expect(read(withRange(HARD), 10).ok).toBe(true);
  });

  it("counts the step FROM the minimum, not from zero", () => {
    // A 1..9 control moving in 2s reaches 1, 3, 5 — not 2.
    const odd = { ...HARD, min: 1, max: 9 };
    expect(read(withRange(odd), 3).ok).toBe(true);
    expect(read(withRange(odd), 4).ok).toBe(false);
  });

  it("a DECIMAL step accepts a value binary floating point cannot represent", () => {
    // 0.3 / 0.1 is 2.9999999999999996. An exact test would refuse a value the
    // machine obviously reaches, so this is the trap the epsilon exists for.
    const tenths = { min: 0, max: 1, step: 0.1, class: "hardware-enforced", evidence: "fx" };
    expect(read(withRange(tenths), 0.3).ok).toBe(true);
    expect(read(withRange(tenths), 0.7).ok).toBe(true);
  });

  it("and still refuses an off-step value at decimal scale", () => {
    // THE OFF-STEP VALUE MUST BE WITHIN THE FIELD'S PRECISION, or the step is
    // not what refuses it. This is the merge resolution between the two
    // stacked branches: on #855 `precision_beyond_contract` is a NOTE, so a
    // 2-decimal value against a 1-decimal contract reached the step check and
    // 0.35-against-step-0.1 proved enforcement there. On #860 the same code
    // refuses that value for PRECISION (4289974660), so the assertion passed
    // without the step being consulted at all — removing step enforcement
    // entirely left it green, which the negative control caught.
    //
    // A coarser step than the contract's precision gives a value only the step
    // can reject: 0.3 is one decimal, so it is within contract, and off a
    // 0.5 step.
    const halves = { min: 0, max: 1, step: 0.5, class: "hardware-enforced", evidence: "fx" };
    const out = read(withRange(halves), 0.3);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.code).toBe("outside_hardware_limit");
    expect(out.message, "something other than the step refused it").toContain(
      "steps of 0.5",
    );
    // CONTROL: the on-step values at that scale are accepted.
    expect(read(withRange(halves), 0.5).ok).toBe(true);
    expect(read(withRange(halves), 1).ok).toBe(true);
  });

  it("CONTROL: an ADVISORY range's step never refuses", () => {
    // Only a hardware-enforced, undisputed constraint may refuse. A published
    // specification's step is guidance, and refusing on it would reject a true
    // observation — a clinical record defect, not a safety feature.
    const published = { ...HARD, class: "published-specification" };
    expect(read(withRange(published), 3).ok).toBe(true);
  });

  it("CONTROL: a DISPUTED hardware step never refuses", () => {
    const disputed = { ...HARD, discrepancy: "two manuals disagree about the step" };
    expect(read(withRange(disputed), 3).ok).toBe(true);
  });

  it("CONTROL: a range with no step still refuses only outside the bounds", () => {
    const noStep = { min: 0, max: 10, class: "hardware-enforced", evidence: "fx" };
    expect(read(withRange(noStep), 3).ok).toBe(true);
    expect(read(withRange(noStep), 11).ok).toBe(false);
  });
});

// ===========================================================================
// MPX-01 — the three findings from the 568df459 review
// ===========================================================================

describe("every contract's own verification is gated, not just some", () => {
  // THE CLASS, NOT THE INSTANCE (Codex, #855 4305364897). Three rounds found
  // one member each: the profile's identity (4305243749), then its channel
  // structure and its frequency, after the field and mode gates had been
  // there from the start. The rule is written once in the guard now, and this
  // asserts it for each contract that carries a `verification`.
  const CHANNELS = {
    count: 4,
    nativeLabel: "Probe",
    associationRequired: true,
    supportsDistinctSettingGroups: true,
    evidence: ["fx"],
  };

  for (const weak of ["unverified", "pending-evidence"] as const) {
    it(`rejects an active profile whose CHANNEL STRUCTURE is ${weak}`, () => {
      // The count is ENFORCED: `validateReading` refuses a channel above it
      // and requires an association when the contract says so. An unverified
      // structure therefore refuses true observations.
      expect(
        problems([offered({ channels: { ...CHANNELS, verification: weak } })]),
      ).toContain(`profile is active but its channel structure is ${weak}`);
    });

    it(`rejects an active profile whose FIXED FREQUENCY is ${weak}`, () => {
      expect(
        problems([
          offered({
            frequency: { kind: "fixed", mhz: 13.56, verification: weak, evidence: ["fx"] },
          }),
        ]),
      ).toContain(`profile is active but its fixed frequency is ${weak}`);
    });
  }

  it("rejects an active profile whose SELECTABLE frequency is unverified", () => {
    expect(
      problems([
        offered({
          frequency: {
            kind: "selectable",
            mhz: [13.56, 27.12],
            verification: "unverified",
            evidence: ["fx"],
          },
        }),
      ]),
    ).toContain("profile is active but its selectable frequency is unverified");
  });

  it("CONTROL: a documented channel structure and frequency qualify", () => {
    expect(
      problems([
        offered({
          channels: { ...CHANNELS, verification: "device-confirmed" },
          frequency: {
            kind: "fixed",
            mhz: 13.56,
            verification: "manufacturer-documented",
            evidence: ["fx"],
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("CONTROL: a BLOCKED profile's unverified contracts are fine — it is not offered", () => {
    expect(
      problems([base({ channels: { ...CHANNELS, verification: "unverified" } })]),
    ).toEqual([]);
  });

  it("CONTROL: a not-applicable frequency has no verification to gate", () => {
    // Demanding one would invent a source for the absence of a control.
    expect(problems([offered()])).toEqual([]);
  });
});

describe("an active profile must offer a mode she can actually use", () => {
  // THE DEFECT (Codex, #855 4305364901). The no-modes rule tested only that
  // the list was NON-EMPTY, so a profile whose every mode is blocked passed —
  // and `activeProfiles` offered it while `activeModes` returned nothing and
  // `validateReading` refused every possible mode. The same unusable picker,
  // reached by a different route.
  /**
   * An ACTIVE profile carrying modes with exactly these availabilities.
   *
   * Applied AFTER `offered()`, not through it: `offered` maps every mode to
   * active, so passing blocked modes into it produced active ones and the
   * first version of these three tests asserted against a fixture that had
   * quietly repaired the very condition under test.
   */
  const activeWithModes = (
    ...availabilities: Array<"active" | "blocked" | "legacy-only">
  ): MachineProfile => {
    const proto = base().modes[0]!;
    return {
      ...offered(),
      modes: availabilities.map((availability, i) => ({
        ...proto,
        key: `m${i}`,
        availability,
      })),
    };
  };

  it("rejects an active profile whose every mode is blocked", () => {
    expect(problems([activeWithModes("blocked", "blocked")])).toContain(
      "profile is active but none of its modes is",
    );
  });

  it("rejects one whose only mode is legacy-only", () => {
    expect(problems([activeWithModes("legacy-only")])).toContain(
      "profile is active but none of its modes is",
    );
  });

  it("CONTROL: one active mode among blocked ones is enough", () => {
    expect(
      problems([activeWithModes("blocked", "active")]).filter((x) =>
        x.includes("none of its modes"),
      ),
    ).toEqual([]);
  });

  it("CONTROL: no modes AT ALL gets the more specific complaint, not both", () => {
    // Saying both would be noise, and "carries no modes at all" is the one a
    // reviewer can act on.
    const out = problems([offered({ modes: [] })]);
    expect(out).toContain("profile is active but carries no modes at all");
    expect(out).not.toContain("profile is active but none of its modes is");
  });
});

describe("EVERY offered profile has a mode a reading is accepted against", () => {
  // THE PROPERTY, RATHER THAN THE NEXT INSTANCE. Two rounds have now found a
  // different way for the picker to offer something unusable — a superseded
  // version (4305243747) and a profile with no ACTIVE mode (4305364901) —
  // and both were found by review rather than by a test. This asserts the
  // guarantee `activeProfiles` is for, by composition with the validator, so
  // the next route to the same state fails here instead.
  const readAgainst = (prof: MachineProfile, modeKey: string, catalogue: MachineProfile[]) =>
    validateReading(
      {
        profileId: prof.profileId,
        version: prof.version,
        modeKey,
        fieldKey: "current",
        source: "practitioner-entered",
        value: { kind: "value", value: 1.2 },
      },
      { catalogue },
    );

  const usable = (catalogue: MachineProfile[]) =>
    activeProfiles(catalogue).every((prof) =>
      prof.modes.some((m) => readAgainst(prof, m.key, catalogue).ok),
    );

  it("holds for a plain active profile", () => {
    expect(usable([offered()])).toBe(true);
  });

  it("holds when an older version is retained beside the current one", () => {
    expect(usable([offered(), offered({ version: 2 })])).toBe(true);
  });

  it("holds when every mode is blocked, because nothing is offered at all", () => {
    const allBlocked: MachineProfile = {
      ...offered(),
      modes: base().modes.map((m) => ({ ...m, availability: "blocked" as const })),
    };
    // The integrity gate rejects this profile, so it must never be offered —
    // and if it ever were, this property is what would catch it.
    expect(problems([allBlocked])).toContain(
      "profile is active but none of its modes is",
    );
    expect(usable([allBlocked])).toBe(false);
  });

  it("and the real catalogue satisfies it", () => {
    // Vacuous today, because nothing in MACHINE_CATALOGUE is active — which is
    // itself asserted elsewhere. It stops being vacuous the day a model ships,
    // which is exactly when it matters.
    expect(usable([...MACHINE_CATALOGUE])).toBe(true);
  });
});

describe("a malformed numeric range is an integrity violation", () => {
  // THE DEFECT (Codex, #855 4305364906). Each malformed shape fails quietly
  // and differently: an inverted HARDWARE range refuses every value a
  // practitioner could enter, and a nonpositive step is skipped by the step
  // check's own `step > 0` guard, so the contract declares an increment it
  // never enforces.
  const withRange = (range: Record<string, unknown>): MachineProfile => {
    const b = offered();
    return {
      ...b,
      modes: [
        {
          ...b.modes[0]!,
          fields: [{ ...b.modes[0]!.fields[0]!, ranges: [range] as never }],
        },
      ],
    };
  };
  const HARD = { class: "hardware-enforced", evidence: "fx" };

  it("rejects an INVERTED range", () => {
    expect(problems([withRange({ ...HARD, min: 10, max: 2 })])).toContain(
      "field m.current range is malformed: min 10 exceeds max 2",
    );
  });

  it("rejects a non-finite bound", () => {
    expect(
      problems([withRange({ ...HARD, min: Number.POSITIVE_INFINITY, max: 10 })]),
    ).toContain("field m.current range is malformed: min is not finite");
    expect(problems([withRange({ ...HARD, min: 0, max: Number.NaN })])).toContain(
      "field m.current range is malformed: max is not finite",
    );
  });

  it("rejects a nonpositive or non-finite step", () => {
    for (const step of [0, -2]) {
      expect(problems([withRange({ ...HARD, min: 0, max: 10, step })])).toContain(
        `field m.current range is malformed: step ${step} is not a positive increment`,
      );
    }
    expect(
      problems([withRange({ ...HARD, min: 0, max: 10, step: Number.NaN })]),
    ).toContain("field m.current range is malformed: step NaN is not a positive increment");
  });

  it("CONTROL: a well-formed range is clean, including one-sided ones", () => {
    expect(problems([withRange({ ...HARD, min: 0, max: 10, step: 2 })])).toEqual([]);
    expect(problems([withRange({ ...HARD, max: 10 })])).toEqual([]);
    expect(problems([withRange({ ...HARD, min: 0 })])).toEqual([]);
    // min === max is a single reachable setting, not an inversion.
    expect(problems([withRange({ ...HARD, min: 5, max: 5 })])).toEqual([]);
  });

  it("and it is checked for an ADVISORY range too, because the numbers are still wrong", () => {
    expect(
      problems([
        withRange({ class: "published-specification", evidence: "fx", min: 10, max: 2 }),
      ]),
    ).toContain("field m.current range is malformed: min 10 exceeds max 2");
  });
});

// ===========================================================================
// MPX-01 — the two RUNTIME findings from the cfd6fdb8 review
//
// The other three (channel count, frequency values, an active mode with no
// fields) are deferred to a follow-up whose job is the CLASS rather than the
// members: adversarial inputs driving the "every offered profile has a usable
// mode" property above. No data that exists can trigger them — nothing in
// MACHINE_CATALOGUE is active — and both findings below act on every reading
// today.
// ===========================================================================

describe("a step with no evidenced origin is advisory, not enforced", () => {
  // THE DEFECT (Codex, #855 4305466522). The step check read `r.min ?? 0` and
  // so assumed every stepped control starts at zero. A control documented only
  // as `max: 9, step: 2` may expose 1, 3, 5, 7, 9 — and it refused EVERY one.
  // An increment on its own does not establish its phase.
  //
  // Refusing a value the machine can actually produce is the specific failure
  // the range-class design exists to prevent, which `ConstraintClass` states
  // outright: treating published wording as a hardware bound "would refuse a
  // true observation — which is a clinical record defect, not a safety
  // feature". An unenforced step is a gap; a wrongly enforced one falsifies
  // the record.
  const withRange = (range: Record<string, unknown>): MachineProfile => {
    const b = offered();
    return {
      ...b,
      modes: [
        {
          ...b.modes[0]!,
          fields: [{ ...b.modes[0]!.fields[0]!, decimals: 0, ranges: [range] as never }],
        },
      ],
    };
  };

  const read = (prof: MachineProfile, value: number) =>
    validateReading(
      {
        profileId: prof.profileId,
        version: prof.version,
        modeKey: "m",
        fieldKey: "current",
        source: "practitioner-entered",
        value: { kind: "value", value },
      },
      { catalogue: [prof] },
    );

  // The exact contract from the finding: an increment and a ceiling, no origin.
  const NO_ORIGIN = { max: 9, step: 2, class: "hardware-enforced", evidence: "fx" };

  for (const value of [1, 3, 5, 7, 9]) {
    it(`accepts ${value} on a documented max:9 step:2 control`, () => {
      const out = read(withRange(NO_ORIGIN), value);
      expect(
        out.ok,
        `${value} is reachable on a 1,3,5,7,9 control and was refused`,
      ).toBe(true);
    });
  }

  it("and does not refuse the even values either — ADVISORY means no refusal", () => {
    // The honest consequence of an unknown origin: the step cannot refuse in
    // either direction. Asserting only the odd values would leave the rule
    // looking like a phase guess in the other direction.
    for (const value of [2, 4, 6, 8]) {
      expect(read(withRange(NO_ORIGIN), value).ok).toBe(true);
    }
  });

  it("CONTROL: the MAXIMUM is still enforced, so the range is not inert", () => {
    expect(read(withRange(NO_ORIGIN), 11).ok).toBe(false);
  });

  it("CONTROL: WITH an evidenced origin the step still refuses", () => {
    // The enforcement did not go away; it now requires the one fact it needs.
    const anchored = { min: 1, max: 9, step: 2, class: "hardware-enforced", evidence: "fx" };
    expect(read(withRange(anchored), 3).ok).toBe(true);
    const out = read(withRange(anchored), 4);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toContain("steps of 2 from 1");
  });
});

describe("an installed option gates NEW capture only", () => {
  // THE DEFECT (Codex, #855 4305466521). The gate ran unconditionally, and
  // `installedOptions ?? []` means an absent inventory refuses everything — so
  // a stored reading from an option-gated mode stopped rendering when the
  // inventory was unavailable, or when the option was later removed from the
  // machine. The reading was true when it was taken.
  //
  // THE FOURTH GATE `allowNonOffered` GOVERNS. The previous three were
  // enumerated one at a time, which is exactly how this one was missed.
  const gated = (): MachineProfile => {
    const b = offered();
    return {
      ...b,
      modes: [{ ...b.modes[0]!, requiresInstalledOption: "fancy-probe" }],
    };
  };

  const read = (historical: boolean, installedOptions?: string[]) =>
    validateReading(
      {
        profileId: "fixture:round2",
        version: 1,
        modeKey: "m",
        fieldKey: "current",
        source: "practitioner-entered",
        value: { kind: "value", value: 1.2 },
      },
      { catalogue: [gated()], allowNonOffered: historical, installedOptions },
    );

  it("a HISTORICAL reading renders when the inventory is unavailable", () => {
    expect(read(true).ok, "a stored reading stopped rendering").toBe(true);
  });

  it("and renders when the option has since been REMOVED from the device", () => {
    expect(read(true, ["some-other-option"]).ok).toBe(true);
  });

  it("CONTROL: NEW capture is still refused without the option", () => {
    const out = read(false);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.code).toBe("mode_requires_installed_option");
  });

  it("CONTROL: new capture is accepted WITH the option installed", () => {
    expect(read(false, ["fancy-probe"]).ok).toBe(true);
  });
});

describe("readiness assesses the modes being PROPOSED, not every mode", () => {
  // THE DEFECT (Codex, #855 4305466530). `activationReadiness` promoted EVERY
  // mode to active, which contradicted the model the integrity rules now
  // describe: only ONE active mode is required and non-active modes are
  // explicitly permitted to stay. So a profile holding one verified mode
  // beside a deliberately retained one had the retained mode's evidence gaps
  // reported as activation blockers, falsely withholding a model that was
  // ready.
  //
  // THE CANDIDATE SET COMES FROM THE TYPE'S OWN MEANINGS. `blocked` is
  // "deliberately NOT offered: evidence incomplete for this exact model" — a
  // candidate under review. `legacy-only` is "kept so historical rows still
  // render, never offered for new capture" — deliberately never a candidate.

  /** A fully evidenced mode, under a key of its own. */
  const goodMode = (key: string) => {
    const proto = base().modes[0]!;
    return { ...proto, key, availability: "active" as const };
  };

  /** A mode that WOULD produce blockers if it were promoted. */
  const incompleteMode = (
    key: string,
    availability: "blocked" | "legacy-only",
  ) => {
    const proto = base().modes[0]!;
    return {
      ...proto,
      key,
      availability,
      // Its own identity is not source-backed, so promoting it reports a
      // blocker naming this key.
      verification: "unverified" as const,
    };
  };

  it("a LEGACY-ONLY incomplete mode contributes no blockers", () => {
    // The finding, as an assertion. The legacy mode is retained so historical
    // rows still render; it is not being offered, so its gaps are not this
    // activation's business.
    const review = activationReadiness({
      ...base(),
      modes: [goodMode("good"), incompleteMode("old", "legacy-only")],
    });
    expect(
      review.blockers.join(" | "),
      "a deliberately retained mode's gaps blocked a verified model",
    ).not.toContain("old");
    expect(review.ready, "the verified mode could not be offered").toBe(true);
  });

  it("CONTROL: the same mode BLOCKED is a candidate and does contribute", () => {
    // `blocked` means "evidence incomplete", which is exactly what a reviewer
    // is asking about — so it must still be assessed. Without this control the
    // test above would also pass if readiness had simply stopped promoting
    // anything.
    const review = activationReadiness({
      ...base(),
      modes: [incompleteMode("under-review", "blocked")],
    });
    expect(review.blockers.join(" | ")).toContain("under-review");
    expect(review.ready).toBe(false);
  });

  it("CONTROL: a profile whose only mode is legacy-only has nothing to offer", () => {
    const review = activationReadiness({
      ...base(),
      modes: [incompleteMode("old", "legacy-only")],
    });
    expect(review.ready).toBe(false);
    expect(review.blockers).toContain("profile is active but none of its modes is");
  });

  it("and a REAL blocked model still reports its own gaps, unchanged", () => {
    // THE OTHER HALF, pinned explicitly rather than left incidental. Every
    // real model's modes are blocked, so promoting nothing would have stopped
    // the field and mode-identity gates running and readiness would have gone
    // silent about exactly the models under review. This couples that
    // behaviour to the candidate-set rule.
    for (const id of [
      "silhouettone:evolution-st-350",
      "silhouettone:evolution-5hd",
    ]) {
      const review = activationReadiness(profileById(id)!);
      expect(review.ready, `${id} should not be ready`).toBe(false);
      expect(
        review.blockers.length,
        `${id}: readiness went silent about a blocked model`,
      ).toBeGreaterThan(0);
      // And the gaps are the model's OWN fields, not a bare "no active mode".
      expect(
        review.blockers.join(" | "),
        `${id}: readiness stopped naming the field gaps`,
      ).toMatch(/required field|unverified|precision|identity/i);
    }
  });
});
