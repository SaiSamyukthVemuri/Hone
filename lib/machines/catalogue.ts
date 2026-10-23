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
 * ACTIVATION REMAINS HELD. The manufacturer-documented Senior/Junior 3G v2
 * contracts now live in ./apilus-3g. Their v1 entries below remain unchanged
 * for historical interpretation. Evidence readiness does not lift the explicit
 * operator activation hold. Other models retain their own evidence gaps.
 * `catalogueIntegrity()` checks evidence and capture capability per mode; a
 * disagreement about one bound never authorizes rewriting another contract.
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

import type {
  EvidenceRef,
  MachineProfile,
  OpenQuestion,
  VerificationState,
} from "./profile-contract";
import { APILUS_3G_PROFILES, APILUS_3G_TEXT_PROFILES } from "./apilus-3g";
import { recordedProfile } from "./profile-contract";

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

const Q_GEMM_CURRENT: OpenQuestion = {
  id: "gemm-current-unit",
  question: "GEMM-16 US: what native current unit and display precision does this exact variant use?",
  resolvedBy: "The matching supplied manual or a labelled current-control screen for the US variant.",
  blocks: ["current"],
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
  ...APILUS_3G_PROFILES,
  ...APILUS_3G_TEXT_PROFILES,
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
            note: "Milliamps are documented here; the GEMM-16 native current unit remains pending. Never infer or convert its unit to share a column. The retired legacy galvanic_intensity_percent must never be reinterpreted as a current in either unit.",
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
      "Per-probe independent control is established first-hand. The current unit and precision, regional channel count, and timer unit, limits and step remain pending exact-model evidence; the profile stays blocked.",
    verification: "manufacturer-documented",
    frequency: { kind: "not-applicable" },
    channels: {
      count: 16, // Unevidenced legacy placeholder, never an enforced ceiling.
      nativeLabel: "Channel",
      // The practitioner ruling: a setup saves without sixteen mandatory rows.
      associationRequired: false,
      supportsDistinctSettingGroups: true,
      verification: "pending-evidence",
      evidence: [GEMM_DESIGNER.id, GEMM_PRODUCT.id],
      note: "Independently controlled galvanic channels, per the designer's first-hand account of adjusting current and duration for each probe. The count 16 is an unverified legacy placeholder, not established by either cited source and not enforced. A channel is not a pulse count and not a hair treated. No rotating-probe position, status LED or 16-row tracker is required; channel association is optional and workflow-confirmed.",
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
            unit: "device-display",
            decimals: 0,
            optional: false,
            expectedSource: "practitioner-entered",
            editable: true,
            verification: "pending-evidence",
            unverified: ["unit", "decimals"],
            evidence: [GEMM_DESIGNER.id, GEMM_PRODUCT.id],
            note: "The cited sources do not establish the native current unit or precision. device-display and decimals 0 are storage placeholders, not a microamp/milliamp or display-precision claim; no conversion is inferred.",
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
            unverified: ["unit", "decimals"],
            evidence: [GEMM_DESIGNER.id],
            note: "Blocked by gemm-timer-unit: seconds and minutes are both plausible and the choice changes every stored value. The reviewer's approximate five-to-six minutes per hair is guidance from one practitioner — never a default, never a bound.",
          },
        ],
      },
    ],
    evidence: [GEMM_PRODUCT, GEMM_DESIGNER],
    openQuestions: [Q_GEMM_CURRENT, Q_GEMM_TIMER, Q_GEMM_VARIANTS],
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
    // IDENTITY IS (profileId, VERSION), not profileId (Codex, #855
    // 4304921305). Keyed on the id alone, this rule made it impossible to
    // keep v1 beside v2 — so a republished contract had to REPLACE its
    // predecessor, and every reading captured under the old version stopped
    // validating. Two entries for one id at one version are still a
    // duplicate; two versions of one id are the point.
    const identity = `${p.profileId}@${p.version}`;
    if (seen.has(identity)) {
      out.push({
        profileId: p.profileId,
        problem: `duplicate profileId at version ${p.version}`,
      });
    }
    seen.add(identity);

    const evidenceIds = new Set(p.evidence.map((e) => e.id));
    const blockedKeys = new Set(p.openQuestions.flatMap((q) => q.blocks));
    const blocksEverything = blockedKeys.has("*");

    // EVERY CONTRACT THAT CITES EVIDENCE IS CHECKED THE SAME WAY (Codex, #855
    // 4305019848). This was inline in the field loop and nowhere else, so a
    // mode, a channel structure or a frequency could cite an id that does not
    // exist in the profile's own ledger — or cite nothing at all — and still
    // be reported as documented. One helper now, used by all four surfaces,
    // because a second copy is how the field rule came to be the only one.
    const cites = (what: string, ids: readonly string[]) => {
      for (const id of ids) {
        if (!evidenceIds.has(id)) {
          out.push({
            profileId: p.profileId,
            problem: `${what} cites unknown evidence '${id}'`,
          });
        }
      }
      if (ids.length === 0) {
        out.push({
          profileId: p.profileId,
          problem: `${what} cites no evidence at all`,
        });
      }
    };

    if (p.channels) cites("channel structure", p.channels.evidence);
    if (p.frequency.kind === "fixed" || p.frequency.kind === "selectable") {
      cites(`frequency (${p.frequency.kind})`, p.frequency.evidence);
    }

    // STORAGE IDENTITIES MUST BE UNIQUE WITHIN THEIR OWN SCOPE (Codex, #855
    // 4305019857). Lookup is `.find()` — `findMode` by mode key, and the field
    // search by (mode, stageKey, fieldKey) — so a repeated key makes the later
    // contract UNREACHABLE and array order silently decides which labels,
    // units and limits apply. The scope is exactly the lookup's own key: mode
    // keys per profile, stage keys per mode, and field keys per (mode, stage).
    // A field key shared by two different stages is legitimate and common —
    // MultiPlex stages each carry their own duration — so scoping this any
    // wider would reject honest profiles.
    const modeKeys = new Set<string>();
    for (const mode of p.modes) {
      if (mode.availability === "active" && mode.captureHold) {
        out.push({ profileId: p.profileId, problem: `mode ${mode.key} cannot capture its documented controls: ${mode.captureHold}` });
      }
      if (modeKeys.has(mode.key)) {
        out.push({
          profileId: p.profileId,
          problem: `duplicate mode key '${mode.key}'`,
        });
      }
      modeKeys.add(mode.key);

      const stageKeys = new Set<string>();
      for (const stage of mode.stages) {
        if (stageKeys.has(stage.key)) {
          out.push({
            profileId: p.profileId,
            problem: `mode ${mode.key} has duplicate stage key '${stage.key}'`,
          });
        }
        stageKeys.add(stage.key);
      }

      const scopes = [
        { stage: null as string | null, fields: mode.fields },
        ...mode.stages.map((st) => ({ stage: st.key, fields: st.fields })),
      ];
      for (const scope of scopes) {
        const fieldKeys = new Set<string>();
        for (const f of scope.fields) {
          if (fieldKeys.has(f.key)) {
            out.push({
              profileId: p.profileId,
              problem: `mode ${mode.key}${
                scope.stage ? ` stage ${scope.stage}` : ""
              } has duplicate field key '${f.key}'`,
            });
          }
          fieldKeys.add(f.key);
        }
      }
    }

    // AN OPEN QUESTION THAT NAMES NOTHING REAL HOLDS NOTHING (Codex, #855
    // 4305019844). `OpenQuestion.blocks` documents this rule in its own type
    // — "A target naming nothing real holds nothing, which is worse than no
    // question at all — the integrity guard rejects that" — and the guard did
    // not implement it. A misspelled qualifier such as `wrong-mode.duration`,
    // where `duration` exists under a DIFFERENT mode, matched none of the
    // `held` forms below, so the question silently held nothing and
    // `activationReadiness` approved the profile with the question still open.
    //
    // The accepted forms are enumerated here in the same three shapes `held`
    // tests for, plus the two sentinels. Changing one without the other
    // reintroduces exactly this defect.
    const validTargets = new Set<string>(["*", "@frequency"]);
    for (const mode of p.modes) {
      for (const f of mode.fields) {
        validTargets.add(f.key);
        validTargets.add(`${mode.key}.${f.key}`);
      }
      for (const stage of mode.stages) {
        for (const f of stage.fields) {
          validTargets.add(f.key);
          validTargets.add(`${mode.key}.${f.key}`);
          validTargets.add(`${stage.key}.${f.key}`);
        }
      }
    }
    for (const q of p.openQuestions) {
      for (const target of q.blocks) {
        if (!validTargets.has(target)) {
          out.push({
            profileId: p.profileId,
            problem: `open question '${q.id}' blocks '${target}', which names no field, mode.field, stage.field or profile-level sentinel`,
          });
        }
      }
      if (q.blocks.length === 0) {
        out.push({
          profileId: p.profileId,
          problem: `open question '${q.id}' blocks nothing at all`,
        });
      }
    }

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

      // The mode's own identity is a cited contract too, and was never
      // checked (Codex, #855 4305019848).
      cites(`mode ${mode.key}`, mode.evidence);

      for (const { f, stage } of fields) {
        cites(`field ${mode.key}.${f.key}`, f.evidence);
        const kind = f.valueKind ?? "number";
        if (!["number", "text", "choice"].includes(kind) ||
            (kind !== "number" && (f.unit !== "none" || f.decimals !== 0 || f.ranges?.length)) ||
            (kind === "choice" ? (!f.choices?.length || new Set(f.choices).size !== f.choices.length ||
              f.choices.some((v) => typeof v !== "string" || !v.trim() || [...v].length > 500 || v.includes("\0"))) : !!f.choices?.length)) {
          out.push({ profileId: p.profileId, problem: `field ${mode.key}.${f.key} has malformed text/choice metadata` });
        }

        // A RANGE'S NUMBERS HAVE TO BE A RANGE (Codex, #855 4305364906).
        // Checked for every range regardless of class or availability,
        // because a non-finite bound, an inverted pair or a nonpositive step
        // is a data error rather than a policy question — and each one fails
        // in a different, quiet direction: an inverted HARDWARE range refuses
        // every value a practitioner could enter, while a nonpositive step is
        // skipped by the step check's own `step > 0` guard, so the contract
        // declares an increment it never enforces.
        for (const r of f.ranges ?? []) {
          const bad: string[] = [];
          if (r.min !== undefined && !Number.isFinite(r.min)) bad.push("min is not finite");
          if (r.max !== undefined && !Number.isFinite(r.max)) bad.push("max is not finite");
          if (
            r.min !== undefined &&
            r.max !== undefined &&
            Number.isFinite(r.min) &&
            Number.isFinite(r.max) &&
            r.min > r.max
          ) {
            bad.push(`min ${r.min} exceeds max ${r.max}`);
          }
          if (r.step !== undefined && (!Number.isFinite(r.step) || r.step <= 0)) {
            bad.push(`step ${r.step} is not a positive increment`);
          }
          for (const problem of bad) {
            out.push({
              profileId: p.profileId,
              problem: `field ${mode.key}.${f.key} range is malformed: ${problem}`,
            });
          }
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

    // AN ACTIVE PROFILE'S OWN IDENTITY MUST BE SOURCE-BACKED (Codex, #855
    // 4305243749). Every gate here tested the modes and the fields; the
    // PROFILE's own `verification` was never consulted, so a model whose
    // identity is explicitly `unverified` or `pending-evidence` could be
    // offered as a verified named choice as long as its modes and fields were
    // documented. That is the same defect the mode-identity gate below exists
    // for — the ST 350 review found a placeholder "Treatment" on a mode marked
    // documented — one level up, and `active` means "verified named choice" or
    // it means nothing.
    // SOURCE-BACKED MEANS ONE THING, SO IT IS WRITTEN ONCE. Rounds 3 and 4
    // each found another contract whose own `verification` nobody consulted —
    // the profile's identity (4305243749), then its channel structure and its
    // frequency (4305364897) — after the field and mode gates had been there
    // from the start. Enumerating contracts one review at a time is what made
    // that a series, so this says what "qualifies" means and then names every
    // contract that has to.
    const qualifies = (v: VerificationState) =>
      v === "manufacturer-documented" || v === "device-confirmed";

    if (p.availability === "active") {
      if (!qualifies(p.verification)) {
        out.push({
          profileId: p.profileId,
          problem: `profile is active but its own identity is ${p.verification}`,
        });
      }
      // THE CHANNEL COUNT IS ENFORCED, so an unverified one produces real
      // refusals: `validateReading` rejects a channel above `channels.count`
      // and requires an association when `associationRequired` says so. An
      // unverified structure therefore refuses true observations.
      if (p.channels && !qualifies(p.channels.verification)) {
        out.push({
          profileId: p.profileId,
          problem: `profile is active but its channel structure is ${p.channels.verification}`,
        });
      }
      // The frequency is PRESENTED to the practitioner as fact, and on a few
      // models it is a selectable control, so an unverified value is either a
      // displayed claim nobody checked or an invented choice.
      if (
        (p.frequency.kind === "fixed" || p.frequency.kind === "selectable") &&
        !qualifies(p.frequency.verification)
      ) {
        out.push({
          profileId: p.profileId,
          problem: `profile is active but its ${p.frequency.kind} frequency is ${p.frequency.verification}`,
        });
      }
    }

    // AN ACTIVE PROFILE WITH NO MODES AT ALL (Codex, #855 4305243750). There
    // is no `modeKey` any reading could name, so every capture against it is
    // refused with `unknown_mode` — it is offered and unusable. This was
    // caught only by an extra boolean inside `activationReadiness`, which left
    // its `blockers` EMPTY (so readiness could not say why) and left
    // `catalogueIntegrity` accepting the same profile if someone set
    // `availability` to active by hand. Two paths, two different answers.
    if (p.availability === "active" && p.modes.length === 0) {
      out.push({
        profileId: p.profileId,
        problem: "profile is active but carries no modes at all",
      });
    } else if (
      p.availability === "active" &&
      !p.modes.some((m) => m.availability === "active")
    ) {
      // AN INVENTORY IS NOT AN OFFER (Codex, #855 4305364901). The rule above
      // tested only that the list was non-empty, so a profile whose every
      // mode is `blocked` or `legacy-only` passed — and then `activeProfiles`
      // offered it while `activeModes` returned nothing and `validateReading`
      // refused every possible mode with `mode_not_offered`. That is the same
      // unusable picker the no-modes rule exists to prevent, reached by a
      // different route. `else if` because "no modes at all" is the more
      // specific complaint and saying both would be noise.
      out.push({
        profileId: p.profileId,
        problem: "profile is active but none of its modes is",
      });
    }

    if (p.availability === "active" && blocksEverything) {
      out.push({
        profileId: p.profileId,
        problem: "profile is active while an open question blocks everything",
      });
    }

    // "@frequency" HOLDS ACTIVATION TOO (Codex, #855 4304921316). The gate
    // above tested only "*", so a profile whose FREQUENCY contract is
    // explicitly held could be activated the moment its fields and mode
    // identity were documented — the Senior 3G frequency conflict is exactly
    // such a question, and it is one of two live uses of this sentinel.
    // `ProfileLevelBlock` declares the value; honouring it is what makes the
    // declaration mean anything.
    if (p.availability === "active" && blockedKeys.has("@frequency")) {
      out.push({
        profileId: p.profileId,
        problem:
          "profile is active while an open question holds its frequency contract",
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
  // WHICH MODES ARE ACTUALLY BEING PROPOSED (Codex, #855 4305466530).
  //
  // This promoted EVERY mode, which contradicted the model the integrity
  // rules now describe: only ONE active mode is required, and non-active
  // modes are explicitly permitted to stay. So a profile holding one verified
  // mode beside a deliberately retained one had the retained mode's evidence
  // gaps reported as activation blockers, falsely withholding a model that
  // was ready.
  //
  // THE CANDIDATE SET COMES FROM THE TYPE'S OWN MEANINGS, not from a guess:
  // `blocked` is "deliberately NOT offered: evidence incomplete for this
  // exact model", which is a candidate under review; `legacy-only` is "kept
  // so historical rows still render, never offered for new capture", which is
  // deliberately never a candidate. So the candidates are the ACTIVE modes
  // if any, otherwise the BLOCKED ones, and never the legacy-only ones.
  //
  // Promoting NOTHING would have been the simpler change and a worse one:
  // every real model's modes are blocked today, so the field and mode-identity
  // gates — which only run for an active mode — would stop running, and
  // readiness would stop telling a reviewer why the ST 350 and the 5HD are not
  // ready. That is the only thing it currently tells them.
  const hasActiveMode = profile.modes.some((m) => m.availability === "active");
  const isCandidate = (m: MachineProfile["modes"][number]) =>
    hasActiveMode ? m.availability === "active" : m.availability === "blocked";
  const candidate: MachineProfile = {
    ...profile,
    availability: "active",
    modes: profile.modes.map((m) =>
      isCandidate(m) ? { ...m, availability: "active" as const } : m,
    ),
  };
  // Reuse the real gate rather than restating it, so the two can never drift.
  const blockers = catalogueIntegrity([candidate]).map((v) => v.problem);
  // DERIVED ENTIRELY FROM THE BLOCKERS (Codex, #855 4305243750). The
  // `profile.modes.length > 0` term used to sit here as a second, separate
  // rule — so a profile with no modes was reported `ready: false` with an
  // EMPTY blocker list, which cannot be acted on, while the gate it claims to
  // reuse would have accepted that same profile. The missing-mode condition is
  // an integrity violation now, so this reads it from there and the two paths
  // cannot disagree again.
  return { ready: blockers.length === 0, blockers };
}

/** Profiles by id, for render-time lookup of a historical reading's profile. */
/**
 * The CURRENT contract for a model — its highest catalogue version.
 *
 * WHY "HIGHEST" AND NOT "FIRST" (Codex, #855 4304921305). A profile's
 * identity is (profileId, VERSION): a republished contract is a new version
 * and the old one must survive, because a reading captured under v1 has to
 * keep rendering and validating against v1 for as long as the record exists.
 * With several versions present, "the profile for this id" can only
 * sensibly mean the current one, so this is explicit rather than incidental
 * on array order.
 *
 * NEW capture resolves through here, so it always gets the current contract.
 * A HISTORICAL reading must use `profileAtVersion` with the version it was
 * captured under.
 */
export function profileById(
  profileId: string,
  profiles: readonly MachineProfile[] = MACHINE_CATALOGUE,
): MachineProfile | undefined {
  let best: MachineProfile | undefined;
  for (const p of profiles) {
    if (p.profileId !== profileId) continue;
    if (!best || p.version > best.version) best = p;
  }
  return best;
}

/**
 * The EXACT contract a reading was captured under.
 *
 * THE GUARANTEE THIS EXISTS FOR, which the version-blind lookup broke
 * (Codex, #855 4304921305). `validateReading` refused a v1 reading once the
 * catalogue advanced to v2 — with a message that itself promised "a
 * historical reading keeps rendering against the version it was captured
 * under". The message asserted the guarantee the code contradicted, and the
 * duplicate-profileId integrity rule made holding both versions impossible,
 * so there was no arrangement in which the promise could have been kept.
 *
 * Returns undefined when that version is not in the catalogue at all, which
 * is a different fact from "the model is unknown" and is reported as such.
 */
export function profileAtVersion(
  profileId: string,
  version: number,
  profiles: readonly MachineProfile[] = MACHINE_CATALOGUE,
): MachineProfile | undefined {
  return recordedProfile(profiles, profileId, version);
}

/** Current-version questions only; retained history is not a current evidence blocker. */
export function openEvidenceChecklist(
  profiles: readonly MachineProfile[] = MACHINE_CATALOGUE,
): Array<{ profileId: string; model: string; question: OpenQuestion }> {
  return profiles.filter((p) => profileById(p.profileId, profiles)?.version === p.version).flatMap((p) =>
    p.openQuestions.map((question) => ({
      profileId: p.profileId,
      model: p.variant ? `${p.model} (${p.variant})` : p.model,
      question,
    })),
  );
}
