/**
 * MPX-01 — the versioned machine profile contract.
 *
 * WHAT THIS FILE IS. The type-level contract for describing an electrolysis
 * machine's ACTUAL operating screen: which fields it shows, under what native
 * label, in what unit, at what precision, and on whose authority. It carries no
 * profile data (see `./catalogue`) and touches no schema — MPX-01 is explicitly
 * a no-migration slice, and MPX-02 derives storage from a FROZEN contract, not
 * the reverse.
 *
 * WHY A CONTRACT COMES FIRST. The repository already stores electrolysis
 * readings (`ApilusModality`, `MachineFrequency`, `galvanic_ma`, pulse
 * count/delay, probe setup — migrations 0042/0102/0166 and later). What it does
 * NOT have is a statement of which machine those numbers came from, what the
 * machine called them, or whether anyone verified that the machine has that
 * field at all. A modality LABEL is not a model-specific field contract: the
 * existing `ApilusModality` union lists eleven names, and `Multiplex` being one
 * of them says nothing about which Apilus units offer MultiPlex. Junior 3G, for
 * one, must not inherit it.
 *
 * THE THREE RULES THAT SHAPE EVERY TYPE HERE
 *
 * 1. EVIDENCE IS PER FIELD AND PER MODEL, NEVER PER FAMILY. "All Apilus" and
 *    "all Evolutions" are not a finite verified inventory. A profile whose
 *    manual we have not read stays individually blocked while verified work
 *    proceeds around it, so `verification` lives on the profile AND on each
 *    field, and a blocked profile is still describable.
 *
 * 2. GUIDANCE IS NOT A HARDWARE BOUND. A recommended protocol, a published
 *    specification range and a verified hardware-enforced limit are three
 *    different claims, and only the third may ever refuse a practitioner's
 *    input. Manual min/max wording and conflicting specification tables do not
 *    authorize blocking. See `ConstraintClass`.
 *
 * 3. A RECORDED OBSERVATION IS NEVER DESTROYED. No clamping, no silent
 *    rounding, no unit conversion, no normalisation into a common "dose". A
 *    value outside a documented range is returned as recorded, carrying a
 *    neutral discrepancy note. See `./validate-reading`.
 *
 * NOT IN SCOPE, DELIBERATELY: device connection or actuation, recommended
 * settings, body-area recipes, therapeutic dose comparison, and any claim of
 * manufacturer approval or equipment safety certification. This is
 * practitioner-entered treatment documentation.
 */

// ---------------------------------------------------------------------------
// Evidence and verification
// ---------------------------------------------------------------------------

/**
 * A target in `OpenQuestion.blocks` that is not a field key.
 *
 * `"*"` holds the whole profile. `"@frequency"` holds the profile-level
 * `FrequencyContract`, which is deliberately NOT a field — a model with one
 * fixed RF frequency has no frequency control to render. Introduced after the
 * integrity guard caught two questions blocking a field key `frequency` that
 * never existed, so they were holding nothing at all.
 */
export type ProfileLevelBlock = "*" | "@frequency";

/**
 * How well-established a profile or field is. Ordered from weakest to
 * strongest; nothing in this module ranks them numerically, because the only
 * decision that depends on the ranking is activation, and that is explicit.
 */
export type VerificationState =
  /** Named by a practitioner or product note, with no source material read. */
  | "unverified"
  /** Source material exists and was located, but the specific claim is not yet readable (e.g. a 403 manual). */
  | "pending-evidence"
  /** Manufacturer or manufacturer-authored material read and recorded below. */
  | "manufacturer-documented"
  /** Documented AND confirmed against the studio's physical unit. */
  | "device-confirmed";

/**
 * Whether a profile may be offered to practitioners as a verified named
 * choice. Separate from `VerificationState` because activation is a reviewed
 * product decision, not an automatic consequence of having read a PDF.
 */
export type ProfileAvailability =
  /** Offered in the picker. */
  | "active"
  /** Described here, deliberately NOT offered: evidence incomplete for this exact model. */
  | "blocked"
  /** Kept so historical rows still render, never offered for new capture. */
  | "legacy-only";

/** One piece of source material, with what it does and does not establish. */
export type EvidenceRef = {
  /** Stable key referenced by fields and modes. */
  id: string;
  /** What kind of document this is — a brochure is not a manual. */
  kind:
    | "manufacturer-manual"
    | "manufacturer-authored-manual-mirror"
    | "manufacturer-brochure"
    | "manufacturer-product-page"
    | "manufacturer-comparison-matrix"
    | "designer-first-hand-account"
    | "practitioner-report"
    | "studio-device-photo";
  /** Where it was read. Mirrors are identified as mirrors by `kind`. */
  url?: string;
  /** Page or screen locator, where the source has one. */
  locator?: string;
  /** ISO date the source was last consulted. */
  consultedOn: string;
  /** What this source actually supports. One sentence, no inference. */
  establishes: string;
  /**
   * What it does NOT support, where that has caused trouble before. A brochure
   * establishing a model's existence is not evidence of its numeric bounds.
   */
  doesNotEstablish?: string;
};

/** An open question that must be answered before a claim can harden. */
export type OpenQuestion = {
  id: string;
  question: string;
  /** What would resolve it — a specific manual page, a screen photo, a confirmation. */
  resolvedBy: string;
  /**
   * What stays soft until this is answered: a field key, a `mode.field` or
   * `stage.field` key, or a `ProfileLevelBlock` sentinel. A target naming
   * nothing real holds nothing, which is worse than no question at all — the
   * integrity guard rejects that.
   */
  blocks: Array<string | ProfileLevelBlock>;
};

// ---------------------------------------------------------------------------
// Values: missing, zero and not-applicable are three different things
// ---------------------------------------------------------------------------

/**
 * Why a field has no number. Collapsing these into `null` is the specific
 * defect this type exists to prevent: a galvanic field that is NOT APPLICABLE
 * to a thermolysis-only pass means something different from one the
 * practitioner left blank, and both differ from a genuine recorded zero — which
 * on at least one machine family is a real setting, not an absence. A zero
 * `repeat` can mean one emitted wave.
 */
export type AbsenceReason =
  /** The field applies and was simply not filled in. */
  | "not-recorded"
  /** The field does not exist for this profile/mode combination. */
  | "not-applicable"
  /** The machine displayed it but the practitioner could not read it. */
  | "not-legible";

/** A recorded number, or a reasoned absence. Never a bare `null`. */
export type ReadingValue =
  | { kind: "value"; value: number }
  | { kind: "absent"; reason: AbsenceReason };

/** Who or what produced a number. Four different epistemic statuses. */
export type ObservationSource =
  /** The practitioner set it on the machine and typed it here. */
  | "practitioner-entered"
  /** Read off the machine's own display. */
  | "machine-displayed"
  /** The machine calculated it from other settings; not independently set. */
  | "device-computed"
  /** A practitioner's after-the-fact estimate. Honest, and weaker. */
  | "estimated";

// ---------------------------------------------------------------------------
// Constraints — the distinction that keeps a validator honest
// ---------------------------------------------------------------------------

/**
 * The authority behind a numeric range. ONLY `hardware-enforced` may refuse
 * input, and only with matching exact-model/version evidence.
 *
 * This exists because the sources genuinely conflict. One unit's product copy
 * and its specification table disagree about an intensity limit; a practitioner
 * reports adjusting her own unit beyond its presets. A validator that treated
 * published wording as a hardware bound would refuse a true observation — which
 * is a clinical record defect, not a safety feature.
 */
export type ConstraintClass =
  /** A protocol suggestion. Advisory only; never shown as an error. */
  | "recommended-protocol"
  /** Printed in a specification or manual. Advisory; may raise a discrepancy note. */
  | "published-specification"
  /** The machine physically cannot be set outside this. May refuse input. */
  | "hardware-enforced";

/** A documented range. Open at either end — many sources give only one side. */
export type NumericRange = {
  min?: number;
  max?: number;
  /** Smallest increment the machine's control actually moves in, where verified. */
  step?: number;
  class: ConstraintClass;
  /** Which `EvidenceRef.id` supports this range. */
  evidence: string;
  /**
   * Set when sources disagree about this range. A constraint carrying this is
   * never enforced, whatever its class — the disagreement is the finding.
   */
  discrepancy?: string;
};

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** What a field measures, in the machine's own terms. */
export type FieldQuantity =
  | "current"
  | "duration"
  | "intensity"
  | "frequency"
  | "count"
  | "percentage"
  | "energy-display"
  | "preset-identifier";

/**
 * A unit as the MACHINE displays it. Deliberately a closed list of native
 * units rather than a normalised SI set: `µA` is not `mA`, and converting GEMM
 * microamps into milliamps to share a column with Apilus readings would destroy
 * the native precision that makes the record reproducible.
 *
 * `device-display` covers a machine's own unitless energy scale — the 5HD's
 * `UE` and the ST 350's `UL` are each that machine's display, and renaming one
 * to the other is forbidden.
 */
export type NativeUnit =
  | "µA"
  | "mA"
  | "s"
  | "ms"
  | "min"
  | "%"
  | "MHz"
  | "count"
  | "device-display"
  | "none";

/**
 * An aspect of a field that its evidence does NOT establish, even though the
 * field is otherwise documented.
 *
 * WHY THIS EXISTS. A single `verification` per field turned out to be too
 * coarse, and the ST 350 review is what exposed it: its manual establishes that
 * the native display uses `time`, `HF %`, `galvanic mA` and `UL` — four labels
 * and their units, and nothing else. The decimal precision and the editability
 * of each one were INFERRED while the fields still claimed
 * `manufacturer-documented`, so the activation gate could not see the gap. That
 * is precisely the "do not invent bounds" rule leaking in through a softer
 * door: an invented precision silently truncates or pads a real reading.
 *
 * A non-optional field listing any aspect here cannot be part of an active
 * mode. See `catalogueIntegrity`.
 */
export type UnverifiedAspect = "label" | "unit" | "decimals" | "editability";

/** One field on one machine's operating screen. */
export type MachineField = {
  /** Stable key for storage. Never a generic `number_1` / `duration_2`. */
  key: string;
  /** The label the MACHINE uses, verbatim. Not our paraphrase. */
  nativeLabel: string;
  quantity: FieldQuantity;
  unit: NativeUnit;
  /**
   * Decimal places the machine actually displays. Preserved on storage and
   * render; a machine showing `1.1 s` must not be stored as an integer second.
   */
  decimals: number;
  /** Required to make a pass meaningful, or genuinely optional. */
  optional: boolean;
  /** Whether the practitioner sets this or the machine derives it. */
  expectedSource: ObservationSource;
  /** Can the practitioner change it on the machine? */
  editable: boolean;
  /** Documented ranges. Several, because classes differ and sources differ. */
  ranges?: NumericRange[];
  /** Per-field evidence, so a weak field cannot hide inside a strong profile. */
  verification: VerificationState;
  /**
   * Aspects this field's evidence does NOT cover. Empty or absent means
   * `verification` genuinely covers the label, unit, precision and editability
   * together. Anything listed here keeps the field out of an active mode.
   */
  unverified?: UnverifiedAspect[];
  /** `EvidenceRef.id`s establishing that this field exists with this label/unit. */
  evidence: string[];
  /** Short note for reviewers — conflicts, history, naming traps. */
  note?: string;
};

// ---------------------------------------------------------------------------
// Stages and channels
// ---------------------------------------------------------------------------

/**
 * A named part of a single pass that carries its OWN readings.
 *
 * MultiPlex is the reason this exists: the machine presents a slow-thermolysis
 * warming component and a snap/fast-pulse component with separate settings, and
 * flattening them into one intensity/duration pair loses the setup a
 * practitioner needs next visit. MultiBlend likewise shows a distinct final
 * component. A stage is not a repetition and not a channel.
 */
export type ModeStage = {
  key: string;
  /** The machine's name for this component. */
  nativeLabel: string;
  fields: MachineField[];
  note?: string;
};

/**
 * An independently controlled output. Used by the multiple-needle galvanic
 * family, where current and duration can differ per probe.
 *
 * THIS IS NOT A PROBE-HOLDER OUTLET. Several Apilus units have more than one
 * holder socket without offering independent simultaneous channels, and
 * treating a socket as a channel would invent capability. Nor is a channel a
 * pulse count or a hair count.
 *
 * `associationRequired: false` is the practitioner ruling: a setup saves without
 * sixteen mandatory rows, and channel identity is recorded only when the
 * workflow actually confirms which probe is which.
 */
export type ChannelStructure = {
  /** How many independently controlled outputs the model has, where verified. */
  count: number;
  /** The machine's word for one of them. */
  nativeLabel: string;
  /** Must a reading name its channel? Normally no. */
  associationRequired: boolean;
  /**
   * Whether distinct settings groups are supported when probes differ. A simple
   * form must never label a per-probe setting as a global control.
   */
  supportsDistinctSettingGroups: boolean;
  verification: VerificationState;
  evidence: string[];
  note?: string;
};

// ---------------------------------------------------------------------------
// Modes and profiles
// ---------------------------------------------------------------------------

/** One selectable operating mode on one model. */
export type MachineMode = {
  /** A documented control cannot yet be captured faithfully. Blocks activation/publication. */
  captureHold?: string;
  key: string;
  /** The mode name as the machine shows it. */
  nativeLabel: string;
  /** Broad treatment family, for filtering only — never for inferring fields. */
  family: "thermolysis" | "galvanic" | "blend" | "adjunct";
  /** Readings that belong to the mode as a whole. */
  fields: MachineField[];
  /** Components with their own readings. Empty for single-stage modes. */
  stages: ModeStage[];
  /**
   * Set when this mode is only present if a physical option is installed. The
   * profile describes the model; the studio's device records what it actually
   * has.
   */
  requiresInstalledOption?: string;
  availability: ProfileAvailability;
  verification: VerificationState;
  evidence: string[];
  note?: string;
};

/**
 * Frequency is profile information on most models and a practitioner choice on
 * a few. Exposing a selector where the model has a single fixed frequency
 * invents a control.
 *
 * NOTE: the repository's existing `MachineFrequency` DB type admits only
 * `13.56 MHz` and `27.12 MHz`. Source material supports 6.78 MHz on applicable
 * Silhouet-Tone models and three RF frequencies on one Evolution unit, so the
 * catalogue records MHz numbers directly here. Widening the stored type is
 * MPX-02's work, under its own census and migration; nothing in this slice
 * edits it. RF frequency is unrelated to mains power frequency.
 */
export type FrequencyContract =
  | { kind: "fixed"; mhz: number; verification: VerificationState; evidence: string[] }
  | {
      kind: "selectable";
      mhz: number[];
      verification: VerificationState;
      evidence: string[];
    }
  | { kind: "not-applicable" }
  | { kind: "unverified"; note: string };

/** The curated families. A new manufacturer is a deliberate review, not a PR. */
export type ManufacturerFamily =
  | "Dectro/Apilus"
  | "Silhouet-Tone"
  | "Permanence/GEMM-16"
  /**
   * SYNTHETIC FIXTURES, which are not a manufacturer and must not borrow one.
   *
   * The demo profiles previously declared `Permanence/GEMM-16`, because this
   * vocabulary was closed to real families and something had to be chosen.
   * That put a false claim in a shipped fixture: a synthetic single-probe
   * model is not of the GEMM-16 family in any sense, and `family` is exactly
   * the field a reader would trust to tell them what a profile IS.
   *
   * Safe to add because nothing reads `profile.family` - it is descriptive
   * only; `mode.family` is a different field and is unaffected.
   */
  | "Synthetic/Demo";

/**
 * One exact model at one contract version.
 *
 * `version` is the CONTRACT's version, not the machine's firmware. It increments
 * when a field label, unit, precision, stage structure or constraint class
 * changes, and a historical reading always renders against the version it was
 * captured under — which is why this is part of the identity rather than
 * metadata.
 */
export type MachineProfile = {
  /** Stable identity: `<family-slug>:<model-slug>`. Never reused. */
  profileId: string;
  version: number;
  family: ManufacturerFamily;
  manufacturer: string;
  /** The exact model, as the manufacturer writes it. */
  model: string;
  /** A distinguishing variant kept separate until equivalence is verified. */
  variant?: string;
  availability: ProfileAvailability;
  verification: VerificationState;
  frequency: FrequencyContract;
  modes: MachineMode[];
  /** Present only for independently controlled multi-output models. */
  channels?: ChannelStructure;
  evidence: EvidenceRef[];
  openQuestions: OpenQuestion[];
  /** Why this profile is blocked or legacy-only, when it is. */
  availabilityReason?: string;
};

// ---------------------------------------------------------------------------
// Lookup helpers — pure, no I/O
// ---------------------------------------------------------------------------

export function findMode(
  profile: MachineProfile,
  modeKey: string,
): MachineMode | undefined {
  return profile.modes.find((m) => m.key === modeKey);
}

/**
 * Every field a mode can carry, mode-level and stage-level together, each
 * tagged with the stage it came from so a caller can render the machine's own
 * grouping rather than one flat list.
 */
export function modeFields(
  mode: MachineMode,
): Array<{ field: MachineField; stageKey: string | null }> {
  return [
    ...mode.fields.map((field) => ({ field, stageKey: null })),
    ...mode.stages.flatMap((stage) =>
      stage.fields.map((field) => ({ field, stageKey: stage.key })),
    ),
  ];
}

/** Look up one field within a mode, searching its stages too. */
export function findField(
  mode: MachineMode,
  fieldKey: string,
  stageKey?: string | null,
): MachineField | undefined {
  const match = modeFields(mode).find(
    ({ field, stageKey: s }) =>
      field.key === fieldKey &&
      (stageKey === undefined || (s ?? null) === (stageKey ?? null)),
  );
  return match?.field;
}

/**
 * The profiles a practitioner may actually choose. Everything else stays in the
 * catalogue — described, auditable, and not offered.
 *
 * ONE ENTRY PER MODEL: ITS CURRENT CONTRACT (Codex, #855 4305243747). Filtering
 * on availability alone returned every active version of a model, and retaining
 * v1 beside v2 is now the whole point of versioned identity — so the picker
 * offered v1 as a choice while `validateReading` refuses new capture against it
 * with `superseded_profile_version`. An option guaranteed to fail is worse than
 * an absent one: she picks it, enters a full set of readings, and is refused at
 * save for a reason she cannot act on.
 *
 * THE TEST IS THE HIGHEST VERSION'S availability, not "the highest ACTIVE
 * version", and the difference is not academic. New capture resolves through
 * `profileById`, which is the highest version REGARDLESS of availability. So if
 * v2 is blocked and v1 is active, v1 is still unrecordable — offering it would
 * reproduce exactly this defect one case over. Every entry returned here can
 * therefore actually be recorded against, which is the property worth having.
 */
/**
 * The HIGHEST version held for each profile id.
 *
 * ONE DEFINITION OF "CURRENT", shared by selection and by display (Codex,
 * #860 4307914917). Selection wants the current version AND only if it is
 * active; a display surface wants the current version WHATEVER its
 * availability, because labelling a historical reading against a blocked or
 * legacy profile is precisely its job. Those are two filters over one rule,
 * and the rule lives here.
 */
function highestByProfileId(
  profiles: readonly MachineProfile[],
): Map<string, MachineProfile> {
  const current = new Map<string, MachineProfile>();
  for (const p of profiles) {
    const held = current.get(p.profileId);
    if (!held || p.version > held.version) current.set(p.profileId, p);
  }
  return current;
}

/**
 * The current version for selection and catalogue policy, regardless of availability.
 * Historical rendering uses recordedProfile instead: current labels must never
 * replace a retained historical contract's labels.
 */
export function currentProfile(
  profiles: readonly MachineProfile[],
  profileId: string,
): MachineProfile | undefined {
  return highestByProfileId(profiles).get(profileId);
}

/** Historical labels resolve against their exact immutable version, never today's. */
export function recordedProfile(
  profiles: readonly MachineProfile[], profileId: string, version: number,
): MachineProfile | undefined {
  return profiles.find((p) => p.profileId === profileId && p.version === version);
}

export function activeProfiles(
  profiles: readonly MachineProfile[],
): MachineProfile[] {
  return [...highestByProfileId(profiles).values()].filter(
    (p) => p.availability === "active",
  );
}

/** Modes offered for a profile: active profile, active mode. */
export function activeModes(profile: MachineProfile): MachineMode[] {
  return profile.availability === "active"
    ? profile.modes.filter((m) => m.availability === "active")
    : [];
}
