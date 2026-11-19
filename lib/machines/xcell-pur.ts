/**
 * Dectro Apilus xCell Pur, MultiPlex only (HON-71, linked to HON-8). ENABLED on device-observed evidence.
 *
 * Why a new profile and not a new version of `dectro-apilus:xcell`: that entry is the id of the existing charting workflow (the legacy
 * selector, the saved treatment areas) and is pinned unchanged by tests/lib/machines/xcell-unchanged-guard.test.ts. Nothing here edits it,
 * and nothing here registers this unit as a Senior or Junior 3G or borrows either contract.
 *
 * WHAT THE EVIDENCE IS, AND ITS LIMIT. The field set is DEVICE-OBSERVED: one photo of the practitioner's own unit's MultiPlex screen
 * (taken 2026-11-16, readings confirmed by the practitioner 2026-11-18). That is `device-confirmed`, not manufacturer-documented. The
 * RF frequency (fixed 27.12 MHz) comes from Dectro's published Cross Reference Chart (edition en26) plus the product page: the chart
 * ticks 27.12 MHz and not 13.56 MHz for this model and defines PicoFlash as 27.12 MHz. It is a chart, NOT the manual, and it does not
 * print a separate frequency for the slow-thermolysis component. No xCell Pur manual has been read and the software version is unknown:
 * the contract is "device-observed, version unknown", and a later firmware that changes a field is a NEW contract version, never an edit.
 *
 * Rules, each the least assumption the photo allows (nothing rounded, nothing calculated, no invented bound):
 *   * `decimals` is the MOST places the screen was seen to show (2 / 0 / 3 / 0 / 2). A value with fewer places is accepted; more is
 *     refused, never rounded. The precision rests on one sample.
 *   * No range or bound is enforced: none is evidenced.
 *   * `snap_interval` is optional ALWAYS: whether it shows at a pulse count of 1 is not established, so there is no count/interval rule.
 *   * `snap_count` is required: it is on the screen as '2 X'. A single pulse is entered as 1.
 *   * EL is a displayed number: nothing calculates it, checks it against the other readings, or defaults it. Optional.
 *   * UL is optional TEXT exactly as displayed: no populated UL has ever been seen, so no format or precision is assumed. A blank UL
 *     stores no reading at all (never 0). Neither EL nor UL is the ST 350's UL or the 5HD's UE.
 *   * The screen marks each panel and field with an icon and a unit, not a text label. The labels below are the practitioner's words for
 *     them; only "MultiPlex", "EL" and "UL" are text on the screen.
 *
 * Publication to the hosted catalogue is a separate, reviewed, per-change authorised step under an owner token.
 */
import { sliceViolations } from "./slice-gate";
import type { EvidenceRef, MachineField, MachineMode, MachineProfile, ModeStage, OpenQuestion } from "./profile-contract";

export const XCELL_PUR_PROFILE_ID = "dectro-apilus:xcell-pur";

const PAGE: EvidenceRef = {
  id: "xcell-pur-dectro-product-page",
  kind: "manufacturer-product-page",
  url: "https://www.dectro.com/en/apilus-xcell-pur-01-0600",
  locator: "Apilus xCell Pur, product code 01-0600; technical specifications and the MultiPlex description",
  consultedOn: "2026-11-18",
  establishes:
    "That the model is named xCell Pur; it has a colour touch screen; its thermolysis functions are PicoFlash, MeloFlash, MultiPlex and (optional) Synchro; it displays U.L. and E.L.; MultiPlex is slow thermolysis followed by an ultrarapid PicoFlash pulse.",
  doesNotEstablish:
    "Any field label, native unit, display precision, bound, software version or manual edition, or which RF frequency the MultiPlex pulse uses.",
};

const PHOTO: EvidenceRef = {
  id: "xcell-pur-multiplex-screen-photo",
  kind: "studio-device-photo",
  locator:
    "Photo of the practitioner's own unit's MultiPlex screen, taken 2026-11-16 (the screen's own clock), readings confirmed by the practitioner 2026-11-18",
  consultedOn: "2026-11-18",
  establishes:
    "On that one unit, at those values: slow thermolysis 1.82 s and 11 %; flash thermolysis 0.043 s, 76 % and 2 pulses; an interval of 0.50 s between flash pulses; a displayed EL of 717; a UL shown as '--'; the unit of every field and the number of decimals displayed.",
  doesNotEstablish:
    "The software or firmware version, the manual edition, any bound, whether the number of displayed decimals is fixed or varies with the value, whether the interval is shown when the pulse count is 1, or what the counter, timer, probe/area/program indicators or the 'Enabled' indicator mean.",
};

const CHART: EvidenceRef = {
  id: "xcell-pur-dectro-cross-reference-chart-en26",
  kind: "manufacturer-comparison-matrix",
  url: "https://www.dectro.com/img/product/description/tableau-comparatif_11x17_en26.pdf",
  locator:
    "Dectro 'Cross Reference Chart' (Apilus), 11x17 PDF, edition en26, xCell Pur column: Frequency block, the thermolysis rows and 'Key to calculate U.L.' / 'Key to calculate eL'",
  consultedOn: "2026-11-18",
  establishes:
    "For the xCell Pur column: 27.12 MHz is ticked and 13.56 MHz is not; PicoFlash and MeloFlash (defined as 27.12 MHz) are ticked and MicroFlash, Flash and Thermolysis (13.56 MHz) are not; MultiPlex (slow thermolysis plus a MicroFlash or PicoFlash pulse) is ticked, so on this model its pulse is PicoFlash; U.L. and eL are keys the unit calculates.",
  doesNotEstablish:
    "A sentence stating the MultiPlex frequency, a separate frequency for the slow-thermolysis component, any field label, unit, precision or bound, or the software version. It is a chart, not the user manual.",
};

function field(
  key: string,
  nativeLabel: string,
  quantity: MachineField["quantity"],
  unit: MachineField["unit"],
  decimals: number,
  extra: Partial<MachineField> = {},
): MachineField {
  return {
    key, nativeLabel, quantity, unit, decimals,
    optional: false,
    expectedSource: "practitioner-entered",
    editable: true,
    // Observed on the practitioner's own unit's screen (the manual is unread), so device-confirmed, never manufacturer-documented.
    verification: "device-confirmed",
    evidence: [PHOTO.id],
    ...extra,
  };
}

const slow: ModeStage = {
  key: "slow_thermolysis",
  nativeLabel: "Slow thermolysis",
  note: "The warming component. Shown as the blue panel with a waveform symbol; the text label is the practitioner's wording, not on-screen text. Must stay separate from the flash component.",
  fields: [
    field("slow_thermolysis_duration", "Duration", "duration", "s", 2),
    field("slow_thermolysis_intensity", "Intensity", "intensity", "%", 0),
  ],
};

const flash: ModeStage = {
  // The key `snap` is the vocabulary the existing xCell entry already uses for this component; it is never renamed once published.
  key: "snap",
  nativeLabel: "Flash thermolysis",
  note: "The pulse component. Shown as the green panel with a lightning symbol; the text label is the practitioner's wording, not on-screen text. The manufacturer's page calls this pulse PicoFlash, but the screen as photographed does not, so no PicoFlash wording and no frequency is asserted here.",
  fields: [
    field("snap_duration", "Duration", "duration", "s", 3),
    field("snap_intensity", "Intensity", "intensity", "%", 0),
    field("snap_count", "Pulse count", "count", "count", 0, {
      note: "The screen shows a pulse-train symbol and '2 X' with no text label.",
    }),
    field("snap_interval", "Interval between flash pulses", "duration", "s", 2, {
      optional: true,
      note: "Shown in the screen header with a clock-pulse symbol. Optional: it is not established that it appears when the pulse count is 1 (the existing charting records a delay between pulses only when there are several).",
    }),
  ],
};

const multiplex: MachineMode = {
  key: "multiplex",
  nativeLabel: "MultiPlex",
  family: "thermolysis",
  // Mode-level readings come first, then the stages in declared order: slow, then flash.
  fields: [
    field("displayed_el", "EL", "energy-display", "device-display", 0, {
      optional: true,
      expectedSource: "machine-displayed",
      editable: false,
      evidence: [PHOTO.id, PAGE.id, CHART.id],
      note: "The machine's own displayed energy level, recorded exactly as shown. Hone never calculates, checks, defaults or converts it, and it is not the ST 350's UL or the 5HD's UE. Dectro's chart lists eL as a value the unit calculates.",
    }),
    field("displayed_ul", "UL", "energy-display", "none", 0, {
      optional: true,
      valueKind: "text",
      expectedSource: "machine-displayed",
      editable: false,
      evidence: [PHOTO.id, PAGE.id, CHART.id],
      note: "Recorded as text exactly as displayed: it shows '--' on the photographed screen and no populated UL has been seen, so no number format is assumed. A blank UL stores no reading: never 0, never a default. It is not the ST 350's UL or the 5HD's UE.",
    }),
  ],
  stages: [slow, flash],
  // Identity documented by the manufacturer's page; the fields beneath are device-observed. Activation is the slice gate's decision.
  availability: "blocked",
  verification: "manufacturer-documented",
  evidence: [PAGE.id, PHOTO.id, CHART.id],
};

/**
 * RECORDED LIMITS, not open questions: the catalogue's integrity rule says an open question must block something real, and none of these
 * blocks anything because the least-assumption rule in the header already covers it without inventing a value. Each names the OPTIONAL
 * evidence that would remove the limit. They are kept as data so a test and the evidence note can read them.
 */
type RecordedLimit = Pick<OpenQuestion, "id" | "question" | "resolvedBy">;

const softwareVersion: RecordedLimit = {
  id: "xcell-pur-software-version",
  question:
    "Which software version does the practitioner's unit run, and which xCell Pur manual edition covers it? Neither is known: the contract is device-observed on one unit, version unknown.",
  resolvedBy: "A photo of the unit's version or about screen; the manual's cover and back page (part number, edition) and its MultiPlex pages.",
};

const frequency: RecordedLimit = {
  id: "xcell-pur-multiplex-frequency",
  question:
    "Dectro's Cross Reference Chart (en26) ticks 27.12 MHz and not 13.56 MHz for the xCell Pur, and its MultiPlex pulse is PicoFlash (27.12 MHz). It is a chart, not the manual: it prints no sentence stating the MultiPlex frequency and no separate frequency for the slow-thermolysis component.",
  resolvedBy: "The matching manual edition, or a screen that shows the frequency.",
};

const precision: RecordedLimit = {
  id: "xcell-pur-multiplex-display-precision",
  question:
    "The maximum decimals (2 on the slow duration and the interval, 3 on the flash duration, 0 elsewhere) rest on one screen. Does the unit always display that many places, and is the pulse count or interval shown at a count of 1? A finer reading is refused, never rounded.",
  resolvedBy:
    "A second MultiPlex screen photo with different values (for example 1.80 s, 0.040 s, 0.50 s and a pulse count of 1).",
};

const ulFormat: RecordedLimit = {
  id: "xcell-pur-ul-populated-format",
  question: "What does a populated UL look like? Only the blank '--' has been seen, so UL is stored as text exactly as displayed.",
  resolvedBy: "A MultiPlex screen where UL shows a value.",
};

export const XCELL_PUR_RECORDED_LIMITS: readonly RecordedLimit[] = [softwareVersion, frequency, precision, ulFormat];

function xcellPur(): MachineProfile {
  return {
    profileId: XCELL_PUR_PROFILE_ID,
    version: 1,
    family: "Dectro/Apilus",
    manufacturer: "Dectro",
    model: "xCell Pur",
    availability: "blocked",
    availabilityReason:
      "MultiPlex-only contract, device-observed on one unit (software version unknown), with the frequency from the manufacturer's published chart. Not a manual-documented contract.",
    verification: "manufacturer-documented",
    frequency: { kind: "fixed", mhz: 27.12, verification: "manufacturer-documented", evidence: [CHART.id, PAGE.id] },
    modes: [multiplex],
    evidence: [PAGE, PHOTO, CHART],
    openQuestions: [],
  };
}

/**
 * ENABLEMENT (HON-71). A closed allow-list, like FIRST_SLICE_ACTIVE_MODES for the 3G models: the mode is offered only if it is named
 * here AND the slice gate passes it. For THIS profile the gate is asked to accept `device-confirmed` fields (the practitioner's own
 * unit's screen, option B); every 3G profile keeps the strict manufacturer-documented rule, which is not loosened. The gate still
 * refuses a hold, an unverified aspect, an open question that blocks, an enforced range, unresolvable evidence, or an unevidenced frequency.
 */
export const XCELL_PUR_ACTIVE_MODES: readonly string[] = ["multiplex"];

/** Activates only the named modes the slice gate passes. It can add; it can never override a hold. */
export function applyXcellPurSlice(p: MachineProfile, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  const refused = new Set(sliceViolations(p, { acceptDeviceConfirmed: true }).map((v) => v.modeKey));
  for (const m of p.modes) if (allow.has(m.key) && !refused.has(m.key)) m.availability = "active";
}

function enabled(): MachineProfile {
  const p = xcellPur();
  applyXcellPurSlice(p, XCELL_PUR_ACTIVE_MODES);
  // The profile is offered only when at least one mode passed the gate. An active profile whose frequency or fields are unevidenced
  // would break the catalogue's integrity invariants, so the profile stays blocked until then.
  if (p.modes.some((m) => m.availability === "active")) {
    p.availability = "active";
    p.availabilityReason = "MultiPlex enabled on device-observed evidence (the practitioner's own unit, software version unknown); the frequency is from Dectro's published chart. The slice gate passes the mode.";
  }
  return p;
}

export const XCELL_PUR_PROFILES: readonly MachineProfile[] = [enabled()];
