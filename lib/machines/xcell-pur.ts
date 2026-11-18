/**
 * Dectro Apilus xCell Pur, MultiPlex only. LANDS BLOCKED (HON-71, linked to HON-8).
 *
 * Why a new profile and not a new version of `dectro-apilus:xcell`: that entry is the id of the existing charting workflow (the legacy
 * selector, the saved treatment areas) and is pinned unchanged by tests/lib/machines/xcell-unchanged-guard.test.ts. Nothing here edits it,
 * and nothing here registers this unit as a Senior or Junior 3G or borrows either contract.
 *
 * What this records and what it does not establish:
 *   * The field set comes from ONE photo of the practitioner's own unit's MultiPlex screen, with the practitioner's confirmed readings, plus
 *     Dectro's product page. No xCell Pur manual has been read (the only copy the catalogue cites is an older xCell edition), and no
 *     software version is known. So every field is `pending-evidence`, the profile is blocked, the mode is blocked, and the plan refuses it.
 *   * Exact values, no rounding: `decimals` is the number of decimal places the screen shows. A value with more digits is refused, never
 *     rounded. The precision rests on one sample, which is why the open question below holds the three decimal-bearing fields until a
 *     second screen photo confirms it.
 *   * EL is a displayed value. Nothing here calculates it, checks it against the other readings, or defaults it. UL is optional and a blank
 *     UL stores no reading at all (never 0). Neither is the ST 350's UL nor the 5HD's UE.
 *   * No range or bound is enforced: none is evidenced for this unit.
 *   * The screen marks each panel and field with an icon and a unit, not a text label. The labels below are the practitioner's words for
 *     them; only "MultiPlex", "EL" and "UL" are text on the screen.
 *
 * Unblocking is a separate, reviewed step: the manual (edition and the software version it covers), the frequency, a second photo, and
 * then publication under a new owner token. See the open questions and the slice gate (tests/lib/machines/apilus-3g-first-slice.test.ts).
 */
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
    // The manual is unread, so the specific claims are located-but-not-readable, not documented.
    verification: "pending-evidence",
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
      unverified: ["editability"],
      evidence: [PHOTO.id, PAGE.id],
      note: "The machine's own displayed energy level, recorded exactly as shown. Hone never calculates, checks, defaults or converts it, and it is not the ST 350's UL or the 5HD's UE.",
    }),
    field("displayed_ul", "UL", "energy-display", "device-display", 0, {
      optional: true,
      expectedSource: "machine-displayed",
      unverified: ["editability"],
      evidence: [PHOTO.id, PAGE.id],
      note: "Shown as '--' on the photographed MultiPlex screen. A blank UL stores no reading: never 0, never a default. It is not the ST 350's UL or the 5HD's UE.",
    }),
  ],
  stages: [slow, flash],
  // Identity documented by the manufacturer's page; the fields beneath are not yet documented.
  availability: "blocked",
  verification: "manufacturer-documented",
  evidence: [PAGE.id, PHOTO.id],
};

const manualAndSoftware: OpenQuestion = {
  id: "xcell-pur-manual-and-software",
  question:
    "Which xCell Pur manual edition covers the practitioner's unit, and which software version does the unit run? No xCell Pur manual has been read.",
  resolvedBy:
    "A photo of the unit's version or about screen and its rating label, plus the manual's cover and back page (part number, edition) and its MultiPlex pages.",
  blocks: ["*"],
};

const frequency: OpenQuestion = {
  id: "xcell-pur-multiplex-frequency",
  question:
    "Which RF frequency applies to the xCell Pur's MultiPlex pulse? The manufacturer's page lists PicoFlash and MeloFlash and its comparison chart lists both 13.56 and 27.12 MHz, but which applies to this mode on this model is not established.",
  resolvedBy: "The matching manual edition or a screen that shows the frequency.",
  blocks: ["@frequency"],
};

const precision: OpenQuestion = {
  id: "xcell-pur-multiplex-display-precision",
  question:
    "Does the unit always display two decimals on the slow duration and the interval and three on the flash duration, or does the digit count vary with the value?",
  resolvedBy:
    "A second MultiPlex screen photo with different values (for example 1.80 s, 0.040 s, 0.50 s and a pulse count of 1).",
  blocks: ["slow_thermolysis.slow_thermolysis_duration", "snap.snap_duration", "snap.snap_interval"],
};

function xcellPur(): MachineProfile {
  return {
    profileId: XCELL_PUR_PROFILE_ID,
    version: 1,
    family: "Dectro/Apilus",
    manufacturer: "Dectro",
    model: "xCell Pur",
    availability: "blocked",
    availabilityReason:
      "MultiPlex-only first contract from one screen photo and the manufacturer's product page. The manual, the software version and the frequency are not established, so the profile and its mode stay blocked and nothing is published.",
    verification: "manufacturer-documented",
    frequency: {
      kind: "unverified",
      note: "The RF frequency of this model's MultiPlex pulse is not established; no frequency is claimed.",
    },
    modes: [multiplex],
    evidence: [PAGE, PHOTO],
    openQuestions: [manualAndSoftware, frequency, precision],
  };
}

export const XCELL_PUR_PROFILES: readonly MachineProfile[] = [xcellPur()];
