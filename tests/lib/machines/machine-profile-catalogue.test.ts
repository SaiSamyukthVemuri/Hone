import { describe, expect, it } from "vitest";

import {
  MACHINE_CATALOGUE,
  activationReadiness,
  catalogueIntegrity,
  openEvidenceChecklist,
  profileById,
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

  it("preserves precision finer than the contract instead of rounding it", () => {
    const r = validateReading(
      bench({ fieldKey: "secs", value: { kind: "value", value: 1.234 } }),
      { catalogue: FIXTURE_CATALOGUE },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recorded).toEqual({ kind: "value", value: 1.234 });
    expect(r.notes.map((n) => n.code)).toContain("precision_beyond_contract");
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
    // A question whose `blocks` names a typo holds nothing, which is worse than
    // no question at all: the gate would pass while the gap remained.
    for (const p of MACHINE_CATALOGUE) {
      const keys = new Set(
        p.modes.flatMap((m) => modeFields(m).map(({ field }) => field.key)),
      );
      for (const q of p.openQuestions) {
        for (const b of q.blocks) {
          // "*" holds the whole profile; "@"-prefixed targets are
          // profile-level (e.g. the FrequencyContract), not field keys.
          if (b === "*" || b.startsWith("@")) continue;
          const bare = b.includes(".") ? b.split(".").pop()! : b;
          expect(keys, `${p.profileId}: question ${q.id} blocks unknown '${b}'`).toContain(
            bare,
          );
        }
      }
    }
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
