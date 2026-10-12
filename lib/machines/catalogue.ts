/**
 * MPX-01 — the curated machine profile catalogue.
 *
 * SCOPE OF TRUTH IN THIS FILE. Every field label, unit and structure below is
 * traceable to an `EvidenceRef` recorded beside it. Where a source establishes
 * only that a model EXISTS, that is all the profile claims; the fields stay
 * `pending-evidence` and the profile stays `blocked`. Nothing here is inferred
 * from a sibling model, a family name, marketing copy or a rounded legacy
 * figure.
 *
 * WHY EVERY PROFILE IS CURRENTLY `blocked`. #829's own position is that "full
 * runtime support and exact Fett inventory remain unverified", and activation
 * requires exact-model evidence plus review. No manual in the source ledger
 * yields a verified numeric operating bound, and several yield conflicting
 * ones. `catalogueIntegrity()` enforces the activation rule mechanically, so a
 * profile flips to `active` exactly when its evidence lands — not when someone
 * edits a status by hand. An empty active set is the honest current state, and
 * the integrity test pins it as a measurement rather than an aspiration.
 *
 * THE 15/17-PAGE RESEARCH REFERENCE IS NOT ON THIS HOST. #829 cites it and
 * instructs: read available local copies, do not invent quotations if
 * unavailable. A search on 2026-10-12 covered the repository at `6c5eac80`,
 * every other worktree, `docs/14_AI_HANDOFF.md` (240 KB, ZERO machine
 * mentions), all 157 entries of `/srv/hone/handoffs`, its only source pack
 * (`2026-09-17`: four files, canonical roadmap at v1_15), the `/home/sam/hone`
 * checkout, and GitHub. No October 7 pack and no v1.25 document exists
 * anywhere, and #829's body carries no non-manufacturer link.
 *
 * Note that in the v1_15 roadmap, section 7 is "PR Lifecycle, Scope Budgets,
 * Review and Stop Laws" -- not machine fields. So #829's "v1.25 handoff
 * (section 7)" either refers to a differently-numbered document or the
 * numbering moved; either way the pointer cannot be resolved from what is here,
 * and guessing which section was meant would be the invented quotation the
 * issue forbids.
 *
 * Accordingly NOTHING below is attributed to it; every claim traces to a URL in
 * #829's own source ledger or to the practitioner report recorded in
 * `docs/roadmap/CANONICAL_ROADMAP.md` section 14.3 -- that half of the pointer
 * DID resolve. When the document lands, its numeric tables are what unblock the
 * ranges deliberately absent here.
 *
 * ACTIVATION REVIEW, 2026-10-12. ST 350 was reviewed as the closest candidate
 * and is NOT ready. It passed the original gate -- four non-optional fields
 * documented, its one question blocking only the optional `repeat` -- but the
 * manual mirror establishes four LABELS and their units and nothing more. The
 * decimal precision, the editability of each field and the machine's own mode
 * names had all been inferred while the fields claimed
 * `manufacturer-documented`. The 5HD carried the identical gap. Both now
 * declare it through `MachineField.unverified`, both gained precision and
 * mode-name questions, and the gate grew two limbs so it can see such gaps: a
 * required field's unverified aspects, and a mode's own identity.
 * `activationReadiness()` reports the verdict per profile.
 *
 * NO NUMERIC RANGE IS ENFORCED ANYWHERE IN THIS CATALOGUE. Not one source in
 * the ledger establishes a hardware-enforced bound for an exact model and
 * version. Ranges therefore appear only as `published-specification` or carry a
 * `discrepancy`, and `validateReading` refuses on neither.
 */

import type { EvidenceRef, MachineProfile, OpenQuestion } from "./profile-contract";

// ---------------------------------------------------------------------------
// Shared evidence — the source ledger from #829, by family
// ---------------------------------------------------------------------------

const APILUS_COMPARISON: EvidenceRef = {
  id: "dectro-comparison-2024",
  kind: "manufacturer-comparison-matrix",
  url: "https://www.dectro.com/medias/tableau-comparatif_8-5x11_en24.pdf",
  consultedOn: "2026-10-11",
  establishes:
    "Which current Apilus models exist and which modes/options each one offers.",
  doesNotEstablish:
    "Numeric operating bounds, firmware behaviour, or which options a particular physical unit has installed.",
};

const APILUS_SENIOR_MANUAL: EvidenceRef = {
  id: "dectro-senior-3g-manual",
  kind: "manufacturer-authored-manual-mirror",
  url: "https://academiedectro.com/wp-content/uploads/2021/04/mu_senior-3G_6080-0000349_en20.pdf",
  locator: "pp. 14–22, 36",
  consultedOn: "2026-10-11",
  establishes: "Senior 3G operating instructions and specification table.",
  doesNotEstablish:
    "A consistent RF frequency or OmniBlend intensity limit — the product copy, the operating instructions and the specification table disagree. See open question senior-3g-conflicts.",
};

const APILUS_XCELL_MANUAL: EvidenceRef = {
  id: "dectro-xcell-manual",
  kind: "manufacturer-authored-manual-mirror",
  url: "https://www.manualslib.com/manual/1616719/Apilus-Xcell.html",
  locator: "esp. p. 49",
  consultedOn: "2026-10-11",
  establishes: "An older xCell edition's documented fields and blend tables.",
  doesNotEstablish:
    "Applicability to current Pur/Pro firmware. Old-edition bounds must not silently become universal current limits.",
};

const CHLOE_FIELD_SCOPE: EvidenceRef = {
  id: "practitioner-multiplex-field-scope",
  kind: "practitioner-report",
  consultedOn: "2026-09-07",
  establishes:
    "The MultiPlex field set a practitioner actually needs recorded: slow thermolysis duration and intensity, snap duration and intensity, snap count, probe series/gauge, and the Apilus preset number. Recorded as the accepted MPX-01 scope in docs/roadmap/CANONICAL_ROADMAP.md §14.3.",
  doesNotEstablish:
    "Native units, display precision or numeric bounds for any exact model.",
};

const ST250_BROCHURE: EvidenceRef = {
  id: "silhouettone-st250-brochure",
  kind: "manufacturer-brochure",
  url: "https://www.aielectrology.com/pdf/st-250-brochure.pdf",
  consultedOn: "2026-10-11",
  establishes: "That the ST 250 exists as a distinct Silhouet-Tone model.",
  doesNotEstablish:
    "Its exact frequency, its full named mode list, or any numeric operating bound. The historic operating-manual URL returned 403.",
};

const EVO_5HD_MANUAL: EvidenceRef = {
  id: "silhouettone-5hd-manual",
  kind: "manufacturer-manual",
  url: "https://images.universalcompanies.com/User_Manual/SLT100-User_Manual.pdf",
  consultedOn: "2026-10-11",
  establishes:
    "That the Evolution 5HD's native operating display uses the labels T, UE and MAX.",
  doesNotEstablish:
    "That UE is interchangeable with another model's UL display, or any dose equivalence between the two.",
};

const EVO_7HD_SPEC: EvidenceRef = {
  id: "silhouettone-7hd-spec",
  kind: "manufacturer-product-page",
  url: "https://silhouet-tone.ch/en/equipment/electrolysis/evolution-7-hd-2/",
  consultedOn: "2026-10-11",
  establishes: "That the Evolution 7HD exists, via a regional brand specification.",
  doesNotEstablish: "Its operating-screen field labels, units or bounds.",
};

const EVO_ST350_MANUAL: EvidenceRef = {
  id: "silhouettone-st350-manual",
  kind: "manufacturer-authored-manual-mirror",
  url: "https://www.manualslib.com/manual/3565010/Silhouet-Tone-Evolution-St-350.html",
  locator: "US rev01, pp. 17–19 / 32",
  consultedOn: "2026-10-11",
  establishes:
    "That the Evolution ST 350's native display uses time, HF %, galvanic mA and UL.",
  doesNotEstablish:
    "Its repeat-setting upper bound — the wording needs confirmation. See open question st350-repeat-bound.",
};

const EVO_XHD_PAGE: EvidenceRef = {
  id: "silhouettone-xhd-page",
  kind: "manufacturer-product-page",
  url: "https://silhouettone.com/en/evolution-xhd-2/",
  consultedOn: "2026-10-11",
  establishes:
    "That the Evolution XHD exists and advertises three selectable RF frequencies.",
  doesNotEstablish:
    "Which three values, or its operating-screen labels, units and bounds.",
};

const GEMM_PRODUCT: EvidenceRef = {
  id: "gemm16-product",
  kind: "manufacturer-product-page",
  url: "https://www.gemm16.com/gemm-16",
  consultedOn: "2026-10-11",
  establishes:
    "That the GEMM-16 is a multiple-needle galvanic machine and that a manual is supplied with it.",
  doesNotEstablish:
    "Any timer unit, limit or step — the supplied manual was not read. Also establishes nothing about total dose or per-channel settings, which must not be inferred from marketing.",
};

const GEMM_DESIGNER: EvidenceRef = {
  id: "gemm16-designer-account",
  kind: "designer-first-hand-account",
  url: "https://www.genesysdesign.com.au/electrolysis-hair-removal-permanence-case-study",
  consultedOn: "2026-10-11",
  establishes:
    "That current and duration are adjusted for EACH probe independently, i.e. the channels are independently controlled rather than sharing one global control.",
  doesNotEstablish:
    "The timer's unit, its limits, or the number of channels a given regional variant exposes.",
};

// ---------------------------------------------------------------------------
// Open questions — each one holds specific fields soft
// ---------------------------------------------------------------------------

const Q_SENIOR_CONFLICTS: OpenQuestion = {
  id: "senior-3g-conflicts",
  question:
    "Senior 3G: the product copy states an RF frequency inconsistent with the manual, and the operating instructions disagree with the specification table about an OmniBlend intensity limit. Which is correct for the physical unit?",
  resolvedBy:
    "Matching hardware plus the manual edition for that unit's firmware; a settings-screen photo showing the frequency and the OmniBlend scale.",
  // The OmniBlend half names no field on purpose: OmniBlend is not modelled for
  // this profile yet, so there is nothing to hold. Encoding it as a field key
  // would make this question LOOK like it guards something it does not.
  blocks: ["@frequency"],
};

const Q_XCELL_FIRMWARE: OpenQuestion = {
  id: "xcell-firmware-applicability",
  question:
    "xCell: does the older manual's blend-duration table apply to current Pur/Pro firmware, and which advanced options are installed on the studio's unit?",
  resolvedBy:
    "The firmware version from the unit's own screen, plus the matching manual edition and the installed-option list.",
  blocks: ["multiblend.final_component_duration", "multiplex.snap_duration"],
};

const Q_APILUS_1_1S: OpenQuestion = {
  id: "apilus-historic-1-1s",
  question:
    "What does the historic '1.1s' reading denote — a slow-thermolysis duration, a total pass duration, or a machine-computed value? It appears in existing records without a unit contract.",
  resolvedBy:
    "Practitioner confirmation against the machine screen that produced it, with the model and modality identified.",
  blocks: ["multiplex.slow_thermolysis_duration"],
};

const Q_ST250_EVERYTHING: OpenQuestion = {
  id: "st250-operating-contract",
  question:
    "ST 250: what are its exact RF frequency, its full named mode list, and its displayed field labels, units and precision?",
  resolvedBy:
    "The exact older model manual, or a settings-screen photograph containing no client data. The historic manual URL returns 403; ST 350 material must not be substituted.",
  blocks: ["*"],
};

const Q_ST350_REPEAT: OpenQuestion = {
  id: "st350-repeat-bound",
  question:
    "ST 350: what is the repeat setting's upper bound, and is a zero repeat one emitted wave or none?",
  resolvedBy: "Confirmation against the matching manual revision and the machine.",
  blocks: ["repeat"],
};

/**
 * Raised by the 2026-10-12 activation review. The manual mirror establishes
 * four LABELS and their units; it does not say how many decimals the machine
 * shows for any of them, nor which the practitioner can change.
 */
const Q_ST350_PRECISION: OpenQuestion = {
  id: "st350-display-precision",
  question:
    "ST 350: how many decimal places does the display show for time, HF %, galvanic mA and UL, and which of the four are practitioner-adjustable rather than machine-computed?",
  resolvedBy:
    "The manual pages that show the operating screen at a readable resolution, or a settings-screen photograph of the studio's unit containing no client data.",
  blocks: ["time", "hf_percent", "galvanic_ma", "ul"],
};

const Q_ST350_MODE_NAMES: OpenQuestion = {
  id: "st350-mode-names",
  question:
    "ST 350: what are the machine's own mode names, and does the display present one combined screen or one per mode? The current single mode is a placeholder, not the machine's word.",
  resolvedBy:
    "The manual's mode-selection pages, or a photograph of the mode selector.",
  blocks: ["*"],
};

/** The same gap, found in the same review, on the 5HD. */
const Q_5HD_PRECISION: OpenQuestion = {
  id: "5hd-display-precision",
  question:
    "Evolution 5HD: what are the units and decimal precision behind the native T, UE and MAX labels, and what is MAX — a ceiling, a peak reading or a mode indicator?",
  resolvedBy:
    "The manual pages showing the operating screen, or a settings-screen photograph.",
  blocks: ["t", "ue", "max"],
};

const Q_5HD_MODE_NAMES: OpenQuestion = {
  id: "5hd-mode-names",
  question:
    "Evolution 5HD: what are the machine's own mode names? The current single mode is a placeholder.",
  resolvedBy: "The manual's mode-selection pages, or a photograph of the selector.",
  blocks: ["*"],
};

const Q_XHD_FREQUENCIES: OpenQuestion = {
  id: "xhd-frequency-values",
  question:
    "XHD: which three RF frequencies are selectable? The product page advertises three without naming them.",
  resolvedBy: "The XHD manual or its frequency-selection screen.",
  blocks: ["@frequency"],
};

const Q_GEMM_TIMER: OpenQuestion = {
  id: "gemm-timer-unit",
  question:
    "GEMM-16: what unit, limits and step does the per-probe timer use? Seconds and minutes are both plausible and the difference changes every stored duration.",
  resolvedBy:
    "The manual supplied with the studio's machine, or a photograph of the timer display.",
  blocks: ["duration"],
};

const Q_GEMM_VARIANTS: OpenQuestion = {
  id: "gemm-variant-equivalence",
  question:
    "Are the US GEMM-16 and the GEMM-16 Beauty electrically and operationally equivalent, including channel count?",
  resolvedBy: "Manufacturer confirmation or matched manuals for both variants.",
  blocks: ["*"],
};

// ---------------------------------------------------------------------------
// Dectro / Apilus
// ---------------------------------------------------------------------------

/**
 * The practitioner-named MultiPlex stage structure. Two components with their
 * OWN readings, which is the entire reason `ModeStage` exists: the machine
 * presents a slow-thermolysis warming phase and a snap/fast-pulse phase, and a
 * single intensity/duration pair cannot reproduce the setup next visit.
 *
 * Units are `pending-evidence` throughout. The practitioner report names the
 * FIELDS; it does not establish whether the machine displays seconds or
 * milliseconds, nor at what precision — and the unresolved historic "1.1s"
 * reading is exactly the ambiguity that makes guessing unacceptable here.
 */
const APILUS_MULTIPLEX_STAGES = [
  {
    key: "slow_thermolysis",
    nativeLabel: "Slow thermolysis",
    note: "The warming component. Must stay separate from the snap component.",
    fields: [
      {
        key: "slow_thermolysis_duration",
        nativeLabel: "Duration",
        quantity: "duration" as const,
        unit: "s" as const,
        decimals: 1,
        optional: false,
        expectedSource: "practitioner-entered" as const,
        editable: true,
        verification: "pending-evidence" as const,
        evidence: [CHLOE_FIELD_SCOPE.id],
        note: "Unit and precision unconfirmed; the historic '1.1s' reading may or may not be this field. One decimal is carried so an existing value survives a round trip without being truncated, NOT as a verified display precision.",
      },
      {
        key: "slow_thermolysis_intensity",
        nativeLabel: "Intensity",
        quantity: "intensity" as const,
        unit: "device-display" as const,
        decimals: 0,
        optional: false,
        expectedSource: "practitioner-entered" as const,
        editable: true,
        verification: "pending-evidence" as const,
        evidence: [CHLOE_FIELD_SCOPE.id],
        note: "The machine's own intensity scale. Not a percentage and not convertible to one.",
      },
    ],
  },
  {
    key: "snap",
    nativeLabel: "Snap",
    note: "The fast-pulse component.",
    fields: [
      {
        key: "snap_duration",
        nativeLabel: "Duration",
        quantity: "duration" as const,
        unit: "ms" as const,
        decimals: 0,
        optional: false,
        expectedSource: "practitioner-entered" as const,
        editable: true,
        verification: "pending-evidence" as const,
        // The practitioner report names this field; no manual read so far
        // establishes its unit for any exact model, so it cites only that.
        evidence: [CHLOE_FIELD_SCOPE.id],
        note: "Milliseconds is the plausible native unit for a snap and is NOT confirmed. On xCell specifically this is additionally held by xcell-firmware-applicability.",
      },
      {
        key: "snap_intensity",
        nativeLabel: "Intensity",
        quantity: "intensity" as const,
        unit: "device-display" as const,
        decimals: 0,
        optional: false,
        expectedSource: "practitioner-entered" as const,
        editable: true,
        verification: "pending-evidence" as const,
        evidence: [CHLOE_FIELD_SCOPE.id],
      },
      {
        key: "snap_count",
        nativeLabel: "Snaps",
        quantity: "count" as const,
        unit: "count" as const,
        decimals: 0,
        optional: false,
        expectedSource: "practitioner-entered" as const,
        editable: true,
        verification: "pending-evidence" as const,
        evidence: [CHLOE_FIELD_SCOPE.id],
        note: "A count of snaps in one pass. NOT a channel count and NOT hairs treated.",
      },
    ],
  },
];

/** Fields the practitioner records regardless of Apilus modality. */
const APILUS_COMMON_FIELDS = [
  {
    key: "preset_number",
    nativeLabel: "Preset",
    quantity: "preset-identifier" as const,
    unit: "none" as const,
    decimals: 0,
    optional: true,
    expectedSource: "practitioner-entered" as const,
    editable: true,
    verification: "pending-evidence" as const,
    evidence: [CHLOE_FIELD_SCOPE.id],
    note: "The preset IDENTIFIER only. A preset is not a reading: the practitioner records the actual adjusted values alongside it, because a preset number does not establish what the machine was set to. Preset labels are verified separately from any underlying values.",
  },
];

/**
 * Builds one Apilus profile.
 *
 * `modes` is explicit rather than derived from the family, and that is the
 * point: a model gets a mode only when a source read for THAT model documents
 * it. `"identity-only"` is the honest shape for a unit whose existence and
 * option list are documented but whose operating screen nobody has seen — it
 * cannot borrow the xCell manual's fields, which is precisely the defect this
 * signature now makes unexpressible.
 */
function apilus(
  model: string,
  opts: {
    modes: "identity-only" | Array<"multiplex" | "multiblend">;
    evidence: EvidenceRef[];
    openQuestions: OpenQuestion[];
    availabilityReason: string;
    note?: string;
  },
): MachineProfile {
  const wanted = opts.modes === "identity-only" ? [] : opts.modes;
  return {
    profileId: `dectro-apilus:${model.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    version: 1,
    family: "Dectro/Apilus",
    manufacturer: "Dectro",
    model,
    availability: "blocked",
    availabilityReason: opts.availabilityReason,
    verification: "manufacturer-documented",
    // 13.56 and 27.12 MHz are the values the repository already stores
    // (`MachineFrequency`). Which applies to WHICH model is a comparison-matrix
    // question, and for Senior 3G the sources conflict outright, so no model
    // here claims a fixed frequency.
    frequency: {
      kind: "unverified",
      note: "Per-model RF frequency not established for this unit. The stored MachineFrequency type admits 13.56 and 27.12 MHz; 6.78 MHz applies to applicable Silhouet-Tone models, not to Apilus. RF frequency is unrelated to mains power frequency.",
    },
    modes: [
      ...(wanted.includes("multiplex")
        ? [
            {
              key: "multiplex",
              nativeLabel: "MultiPlex",
              family: "thermolysis" as const,
              fields: APILUS_COMMON_FIELDS,
              stages: APILUS_MULTIPLEX_STAGES,
              availability: "blocked" as const,
              verification: "pending-evidence" as const,
              evidence: [CHLOE_FIELD_SCOPE.id, APILUS_COMPARISON.id],
              note: "Two-stage structure is practitioner-confirmed; units and precision are not.",
            },
          ]
        : []),
      ...(wanted.includes("multiblend")
        ? [{
        key: "multiblend",
        nativeLabel: "MultiBlend",
        family: "blend" as const,
        fields: APILUS_COMMON_FIELDS,
        stages: [
          {
            key: "final_component",
            nativeLabel: "Final component",
            note: "Displayed separately by the machine; preserved as its own stage rather than folded into the blend totals.",
            fields: [
              {
                key: "final_component_duration",
                nativeLabel: "Duration",
                quantity: "duration" as const,
                unit: "s" as const,
                decimals: 1,
                optional: true,
                expectedSource: "machine-displayed" as const,
                editable: false,
                verification: "pending-evidence" as const,
                evidence: [APILUS_XCELL_MANUAL.id],
                note: "Blocked by xcell-firmware-applicability: the blend-duration table is from an older manual edition.",
              },
            ],
          },
        ],
        availability: "blocked" as const,
        verification: "pending-evidence" as const,
        evidence: [APILUS_XCELL_MANUAL.id],
      }]
        : []),
    ],
    // Deliberately NO `channels`. Several Apilus units have more than one
    // probe-holder outlet; an outlet is not an independently controlled
    // simultaneous channel, and modelling it as one would invent capability.
    evidence: opts.evidence,
    openQuestions: opts.openQuestions,
  };
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const MACHINE_CATALOGUE: readonly MachineProfile[] = [
  apilus("xCell", {
    modes: ["multiplex", "multiblend"],
    evidence: [APILUS_COMPARISON, APILUS_XCELL_MANUAL, CHLOE_FIELD_SCOPE],
    openQuestions: [Q_XCELL_FIRMWARE, Q_APILUS_1_1S],
    availabilityReason:
      "Field structure is practitioner-confirmed but native units, precision and the current-firmware blend table are not. Pur and Pro advanced options must additionally reflect the physical unit's installed capabilities.",
  }),
  apilus("Senior 3G", {
    // MultiPlex only. The MultiBlend final-component field is documented in the
    // xCell manual alone, and a field read for one model is not evidence for
    // another — so it is not carried here.
    modes: ["multiplex"],
    evidence: [APILUS_COMPARISON, APILUS_SENIOR_MANUAL, CHLOE_FIELD_SCOPE],
    openQuestions: [Q_SENIOR_CONFLICTS, Q_APILUS_1_1S],
    availabilityReason:
      "Sources conflict on both the RF frequency and an OmniBlend intensity limit. The conflicting validator is withheld rather than guessed; the conflict itself is the recorded finding.",
  }),
  apilus("Junior 3G", {
    // IDENTITY ONLY, and deliberately so on two counts. The comparison matrix
    // is the authority on which models offer which modes, and Junior 3G must
    // not inherit MultiPlex from its family — that absence is the assertion.
    // Nor may it borrow the xCell manual's MultiBlend field: no operating
    // screen has been read for this unit at all.
    modes: "identity-only",
    evidence: [APILUS_COMPARISON],
    openQuestions: [],
    availabilityReason:
      "Mode availability is documented by the comparison matrix, but no operating-screen labels, units or precision have been read for this model.",
  }),
  {
    profileId: "dectro-apilus:platinum",
    version: 1,
    family: "Dectro/Apilus",
    manufacturer: "Dectro",
    model: "Platinum",
    variant: "Platinum / Platinum Pure",
    availability: "legacy-only",
    availabilityReason:
      "Only limited historical material was reviewed. Kept so existing records still render with their original meaning; never offered for new capture. Legacy observations and their verification status are preserved as recorded.",
    verification: "unverified",
    frequency: {
      kind: "unverified",
      note: "Not established. A precise model frequency must never be assigned from rounded legacy marketing copy or from another model's manual.",
    },
    modes: [],
    evidence: [],
    openQuestions: [],
  },

  // -- Silhouet-Tone ----------------------------------------------------------
  {
    profileId: "silhouettone:st-250",
    version: 1,
    family: "Silhouet-Tone",
    manufacturer: "Silhouet-Tone",
    model: "ST 250",
    availability: "blocked",
    availabilityReason:
      "Identity only. A manufacturer-authored brochure confirms the model exists; the historic operating manual returns 403, so frequency, mode list and every numeric bound are unverified. ST 350 material must not be substituted — they are separate contracts.",
    verification: "pending-evidence",
    frequency: { kind: "unverified", note: "Exact frequency unverified." },
    modes: [],
    evidence: [ST250_BROCHURE],
    openQuestions: [Q_ST250_EVERYTHING],
  },
  {
    profileId: "silhouettone:evolution-5hd",
    version: 1,
    family: "Silhouet-Tone",
    manufacturer: "Silhouet-Tone",
    model: "Evolution 5HD",
    availability: "blocked",
    availabilityReason:
      "Native display LABELS are documented; their units, decimal precision and editability are not, the machine's own mode names have not been read, and no numeric bound is verified. Recorded by the 2026-10-12 activation review alongside the ST 350.",
    verification: "manufacturer-documented",
    frequency: {
      kind: "unverified",
      note: "6.78 MHz is source-backed for applicable Silhouet-Tone models; whether it applies to this one is unconfirmed.",
    },
    modes: [
      {
        key: "native",
        // PLACEHOLDER — see st350-mode-names for the same gap. The 5HD's own
        // mode names have not been read either.
        nativeLabel: "Treatment",
        family: "thermolysis",
        stages: [],
        availability: "blocked",
        verification: "pending-evidence",
        evidence: [EVO_5HD_MANUAL.id],
        fields: [
          {
            key: "t",
            nativeLabel: "T",
            quantity: "duration",
            unit: "device-display",
            decimals: 1,
            optional: false,
            expectedSource: "machine-displayed",
            editable: true,
            verification: "pending-evidence",
            unverified: ["decimals", "editability"],
            evidence: [EVO_5HD_MANUAL.id],
            note: "The manual establishes the LABEL 'T'. Its unit is not established, so the native display is preserved rather than assumed to be seconds.",
          },
          {
            key: "ue",
            nativeLabel: "UE",
            quantity: "energy-display",
            unit: "device-display",
            decimals: 0,
            optional: false,
            expectedSource: "machine-displayed",
            editable: true,
            verification: "manufacturer-documented",
            unverified: ["decimals", "editability"],
            evidence: [EVO_5HD_MANUAL.id],
            note: "This machine's own energy display. It is NOT the ST 350's UL: do not rename, equate or normalise the two into a common dose.",
          },
          {
            key: "max",
            nativeLabel: "MAX",
            quantity: "energy-display",
            unit: "device-display",
            decimals: 0,
            optional: true,
            expectedSource: "device-computed",
            editable: false,
            verification: "pending-evidence",
            unverified: ["decimals", "editability"],
            evidence: [EVO_5HD_MANUAL.id],
            note: "Appears on the native display; whether it is a ceiling, a peak reading or a mode indicator is unconfirmed.",
          },
        ],
      },
    ],
    evidence: [EVO_5HD_MANUAL],
    openQuestions: [Q_5HD_PRECISION, Q_5HD_MODE_NAMES],
  },
  {
    profileId: "silhouettone:evolution-7hd",
    version: 1,
    family: "Silhouet-Tone",
    manufacturer: "Silhouet-Tone",
    model: "Evolution 7HD",
    availability: "blocked",
    availabilityReason:
      "Identity only, from a regional brand specification. A separate contract from 5HD, ST 350 and XHD; none of their fields transfer.",
    verification: "pending-evidence",
    frequency: { kind: "unverified", note: "Not established for this model." },
    modes: [],
    evidence: [EVO_7HD_SPEC],
    openQuestions: [],
  },
  {
    profileId: "silhouettone:evolution-st-350",
    version: 1,
    family: "Silhouet-Tone",
    manufacturer: "Silhouet-Tone",
    model: "Evolution ST 350",
    availability: "blocked",
    availabilityReason:
      "The manual mirror establishes four native display LABELS and their units — and nothing more. The 2026-10-12 activation review found decimal precision, editability and the machine's own mode names all unestablished, so the profile passes no activation gate yet. The repeat upper bound is separately unconfirmed and no hardware-enforced bound is verified.",
    verification: "manufacturer-documented",
    frequency: {
      kind: "unverified",
      note: "6.78 MHz is source-backed for applicable Silhouet-Tone models; applicability here is unconfirmed.",
    },
    modes: [
      {
        key: "native",
        // PLACEHOLDER, not the machine's word. The manual mirror read so far
        // does not give the ST 350's own mode names, so this mode's identity is
        // pending evidence and the gate keeps it out of the picker. See
        // st350-mode-names.
        nativeLabel: "Treatment",
        family: "blend",
        stages: [],
        availability: "blocked",
        verification: "pending-evidence",
        note: "Single combined screen is an assumption; the machine may present one mode per screen.",
        evidence: [EVO_ST350_MANUAL.id],
        fields: [
          {
            key: "time",
            nativeLabel: "Time",
            quantity: "duration",
            unit: "s",
            decimals: 1,
            optional: false,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "manufacturer-documented",
            unverified: ["decimals", "editability"],
            evidence: [EVO_ST350_MANUAL.id],
          },
          {
            key: "hf_percent",
            nativeLabel: "HF %",
            quantity: "percentage",
            unit: "%",
            decimals: 0,
            optional: false,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "manufacturer-documented",
            unverified: ["decimals", "editability"],
            evidence: [EVO_ST350_MANUAL.id],
            note: "A percentage of this machine's high-frequency output. Not an absolute energy and not comparable across models.",
          },
          {
            key: "galvanic_ma",
            nativeLabel: "Galvanic mA",
            quantity: "current",
            unit: "mA",
            decimals: 2,
            optional: false,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "manufacturer-documented",
            unverified: ["decimals", "editability"],
            evidence: [EVO_ST350_MANUAL.id],
            note: "Milliamps here, microamps on the GEMM-16. Never convert between them to share a column. The retired legacy galvanic_intensity_percent must never be reinterpreted as a current in either unit.",
          },
          {
            key: "ul",
            nativeLabel: "UL",
            quantity: "energy-display",
            unit: "device-display",
            decimals: 0,
            optional: false,
            expectedSource: "machine-displayed",
            editable: true,
            verification: "manufacturer-documented",
            unverified: ["decimals", "editability"],
            evidence: [EVO_ST350_MANUAL.id],
            note: "This machine's units-of-lye display, preserved where actually entered. It is NOT the 5HD's UE.",
          },
          {
            key: "repeat",
            nativeLabel: "Repeat",
            quantity: "count",
            unit: "count",
            decimals: 0,
            optional: true,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "pending-evidence",
            evidence: [EVO_ST350_MANUAL.id],
            note: "Stored as the NATIVE setting. A zero repeat can mean one emitted wave, so any interpreted wave count is a separate, version-specific derivation and never overwrites this value.",
          },
        ],
      },
    ],
    evidence: [EVO_ST350_MANUAL],
    openQuestions: [Q_ST350_REPEAT, Q_ST350_PRECISION, Q_ST350_MODE_NAMES],
  },
  {
    profileId: "silhouettone:evolution-xhd",
    version: 1,
    family: "Silhouet-Tone",
    manufacturer: "Silhouet-Tone",
    model: "Evolution XHD",
    availability: "blocked",
    availabilityReason:
      "Three selectable RF frequencies are advertised but not named, and no operating-screen field has been read.",
    verification: "pending-evidence",
    frequency: {
      kind: "unverified",
      note: "Three selectable RF frequencies are advertised; the values are not published. Selection must not be exposed until they are known.",
    },
    modes: [],
    evidence: [EVO_XHD_PAGE],
    openQuestions: [Q_XHD_FREQUENCIES],
  },

  // -- Permanence / GEMM-16 ---------------------------------------------------
  {
    profileId: "permanence-gemm:gemm-16",
    version: 1,
    family: "Permanence/GEMM-16",
    manufacturer: "Permanence",
    model: "GEMM-16",
    variant: "US",
    availability: "blocked",
    availabilityReason:
      "Current is documented in microamps and per-probe independent control is established first-hand, but the timer's unit, limits and step require the supplied manual. Duration is half of the core chart, so the profile cannot activate without it.",
    verification: "manufacturer-documented",
    frequency: { kind: "not-applicable" },
    channels: {
      count: 16,
      nativeLabel: "Channel",
      // The practitioner ruling: a setup saves without sixteen mandatory rows.
      associationRequired: false,
      supportsDistinctSettingGroups: true,
      verification: "manufacturer-documented",
      evidence: [GEMM_DESIGNER.id, GEMM_PRODUCT.id],
      note: "Independently controlled galvanic channels, per the designer's first-hand account of adjusting current and duration for each probe. A channel is not a pulse count and not a hair treated. No rotating-probe position, status LED or 16-row tracker is required; channel association is optional and workflow-confirmed.",
    },
    modes: [
      {
        key: "galvanic",
        nativeLabel: "Galvanic",
        family: "galvanic",
        stages: [],
        availability: "blocked",
        verification: "manufacturer-documented",
        evidence: [GEMM_DESIGNER.id, GEMM_PRODUCT.id],
        note: "The core chart is current plus duration. Where probes share a setup it is recorded once; where they differ, separate setting groups are preserved rather than one value falsely labelled global.",
        fields: [
          {
            key: "current",
            nativeLabel: "Current",
            quantity: "current",
            unit: "µA",
            decimals: 0,
            optional: false,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "manufacturer-documented",
            evidence: [GEMM_DESIGNER.id, GEMM_PRODUCT.id],
            note: "Microamps natively. Not milliamps, and never converted into the ST 350's mA column.",
          },
          {
            key: "duration",
            nativeLabel: "Time",
            quantity: "duration",
            unit: "s",
            decimals: 0,
            optional: false,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "pending-evidence",
            evidence: [GEMM_DESIGNER.id],
            note: "Blocked by gemm-timer-unit: seconds and minutes are both plausible and the choice changes every stored value. The reviewer's approximate five-to-six minutes per hair is guidance from one practitioner — never a default, never a bound.",
          },
        ],
      },
    ],
    evidence: [GEMM_PRODUCT, GEMM_DESIGNER],
    openQuestions: [Q_GEMM_TIMER, Q_GEMM_VARIANTS],
  },
  {
    profileId: "permanence-gemm:gemm-16-beauty",
    version: 1,
    family: "Permanence/GEMM-16",
    manufacturer: "Permanence",
    model: "GEMM-16",
    variant: "Beauty",
    availability: "blocked",
    availabilityReason:
      "A DISTINCT identity from the US GEMM-16 until equivalence is verified. Sharing the US profile would assert an equivalence no source establishes.",
    verification: "pending-evidence",
    frequency: { kind: "not-applicable" },
    modes: [],
    evidence: [GEMM_PRODUCT],
    openQuestions: [Q_GEMM_VARIANTS],
  },
];

// ---------------------------------------------------------------------------
// Integrity — the activation rule, enforced rather than asserted by hand
// ---------------------------------------------------------------------------

export type IntegrityViolation = { profileId: string; problem: string };

/**
 * The invariants that keep this catalogue honest. Run as a test, so a future
 * edit that activates a profile on incomplete evidence fails there and not in a
 * treatment room.
 *
 * A profile or mode may be `active` ONLY when every required field is at least
 * `manufacturer-documented` and no open question blocks it. That is the whole
 * activation gate, and it is deliberately mechanical: status is derived from
 * evidence, never typed in independently of it.
 */
export function catalogueIntegrity(
  profiles: readonly MachineProfile[] = MACHINE_CATALOGUE,
): IntegrityViolation[] {
  const out: IntegrityViolation[] = [];
  const seen = new Set<string>();

  for (const p of profiles) {
    if (seen.has(p.profileId)) {
      out.push({ profileId: p.profileId, problem: "duplicate profileId" });
    }
    seen.add(p.profileId);

    const evidenceIds = new Set(p.evidence.map((e) => e.id));
    const blockedKeys = new Set(p.openQuestions.flatMap((q) => q.blocks));
    const blocksEverything = blockedKeys.has("*");

    if (p.availability !== "active" && !p.availabilityReason) {
      out.push({
        profileId: p.profileId,
        problem: `availability '${p.availability}' states no reason`,
      });
    }

    for (const mode of p.modes) {
      const fields = [
        ...mode.fields.map((f) => ({ f, stage: null as string | null })),
        ...mode.stages.flatMap((s) => s.fields.map((f) => ({ f, stage: s.key }))),
      ];

      for (const { f, stage } of fields) {
        for (const id of f.evidence) {
          if (!evidenceIds.has(id)) {
            out.push({
              profileId: p.profileId,
              problem: `field ${mode.key}.${f.key} cites unknown evidence '${id}'`,
            });
          }
        }
        if (f.evidence.length === 0) {
          out.push({
            profileId: p.profileId,
            problem: `field ${mode.key}.${f.key} cites no evidence at all`,
          });
        }
        // A range may only refuse input when it is hardware-enforced AND
        // undisputed. Anything else is advisory by construction.
        for (const r of f.ranges ?? []) {
          if (r.class === "hardware-enforced" && r.discrepancy) {
            out.push({
              profileId: p.profileId,
              problem: `field ${mode.key}.${f.key} claims a hardware-enforced bound while sources disagree`,
            });
          }
          if (!evidenceIds.has(r.evidence)) {
            out.push({
              profileId: p.profileId,
              problem: `field ${mode.key}.${f.key} range cites unknown evidence '${r.evidence}'`,
            });
          }
        }

        const qualifies =
          f.verification === "manufacturer-documented" ||
          f.verification === "device-confirmed";
        const held =
          blocksEverything ||
          blockedKeys.has(f.key) ||
          blockedKeys.has(`${mode.key}.${f.key}`) ||
          (stage ? blockedKeys.has(`${stage}.${f.key}`) : false);
        const gaps = f.unverified ?? [];

        if (
          mode.availability === "active" &&
          !f.optional &&
          (!qualifies || held || gaps.length > 0)
        ) {
          out.push({
            profileId: p.profileId,
            problem: `mode ${mode.key} is active but required field ${f.key} is ${
              held
                ? "held by an open question"
                : gaps.length > 0
                  ? `missing evidence for its ${gaps.join(", ")}`
                  : f.verification
            }`,
          });
        }
      }

      // The mode's OWN name must be source-backed before it is offered. A mode
      // whose label we constructed cannot satisfy "display the actual machine
      // and mode labels", however well evidenced its fields are — the ST 350
      // review found exactly that, with a placeholder "Treatment" sitting on a
      // mode marked documented.
      const modeQualifies =
        mode.verification === "manufacturer-documented" ||
        mode.verification === "device-confirmed";
      if (mode.availability === "active" && !modeQualifies) {
        out.push({
          profileId: p.profileId,
          problem: `mode ${mode.key} is active but its own identity is ${mode.verification}`,
        });
      }

      if (p.availability !== "active" && mode.availability === "active") {
        out.push({
          profileId: p.profileId,
          problem: `mode ${mode.key} is active inside a non-active profile`,
        });
      }
    }

    if (p.availability === "active" && blocksEverything) {
      out.push({
        profileId: p.profileId,
        problem: "profile is active while an open question blocks everything",
      });
    }
  }

  return out;
}

/**
 * Would this profile pass the activation gate if someone flipped it to
 * `active` right now, and if not, exactly what is missing?
 *
 * This is the policy review in executable form. `catalogueIntegrity` answers
 * "is the catalogue self-consistent as written"; this answers "is this model
 * READY", which is the question a reviewer actually asks. It never activates
 * anything — activation stays a deliberate edit plus review.
 */
export function activationReadiness(
  profile: MachineProfile,
): { ready: boolean; blockers: string[] } {
  const candidate: MachineProfile = {
    ...profile,
    availability: "active",
    modes: profile.modes.map((m) => ({ ...m, availability: "active" as const })),
  };
  // Reuse the real gate rather than restating it, so the two can never drift.
  const blockers = catalogueIntegrity([candidate]).map((v) => v.problem);
  return { ready: blockers.length === 0 && profile.modes.length > 0, blockers };
}

/** Profiles by id, for render-time lookup of a historical reading's profile. */
export function profileById(
  profileId: string,
  profiles: readonly MachineProfile[] = MACHINE_CATALOGUE,
): MachineProfile | undefined {
  return profiles.find((p) => p.profileId === profileId);
}

/** Every unresolved question across the catalogue, for the evidence checklist. */
export function openEvidenceChecklist(
  profiles: readonly MachineProfile[] = MACHINE_CATALOGUE,
): Array<{ profileId: string; model: string; question: OpenQuestion }> {
  return profiles.flatMap((p) =>
    p.openQuestions.map((question) => ({
      profileId: p.profileId,
      model: p.variant ? `${p.model} (${p.variant})` : p.model,
      question,
    })),
  );
}
