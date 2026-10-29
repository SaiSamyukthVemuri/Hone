/** Exact-model v2 contracts. Historical v1 entries remain in catalogue.ts.
 * Manufacturer-documented, never physical-device-confirmed. Activation stays held.
 */
import type { EvidenceRef, MachineField, MachineMode, MachineProfile, OpenQuestion } from "./profile-contract";

const seniorUrl = "https://academiedectro.com/wp-content/uploads/2021/04/mu_senior-3G_6080-0000349_en20.pdf";
const juniorUrl = "https://academiedectro.com/wp-content/uploads/2021/04/mu_junior_3G_6080-0000345_20EN.pdf";

function source(model: "senior" | "junior", pages: string): EvidenceRef {
  return {
    id: `${model}-3g-native-${pages.replace(/\W/g, "-")}`,
    kind: "manufacturer-manual", url: model === "senior" ? seniorUrl : juniorUrl,
    locator: model === "senior"
      ? `6080-0000349 en20, copyright 2016, printed pp. ${pages}; SHA256 5c22462d9ebfe6987b76bf458f085e07e3dde0cf63d027a47da29364653f195a`
      : `6080-0000345 20EN / 201020, copyright 2016, printed pp. ${pages}; SHA256 0de4cc165aeff183437e371b5188453a950b907bf8c8487b3b618bf623f171e4`,
    consultedOn: "2026-10-19",
    establishes: "The named model's screen labels, native units, displayed precision and editable operating controls on these pages.",
    doesNotEstablish: "Installed-unit firmware, physical-device confirmation, therapeutic defaults or undisputed hardware limits.",
  };
}
const sThermo = source("senior", "14–16");
const sBlend = source("senior", "18–22");
const sSpec = source("senior", "36");
const jThermo = source("junior", "15–16");
const jBlend = source("junior", "17–20");
const jSpec = source("junior", "31");

function field(key: string, nativeLabel: string, quantity: MachineField["quantity"], unit: MachineField["unit"], decimals: number, evidence: EvidenceRef): MachineField {
  return { key, nativeLabel, quantity, unit, decimals, optional: false,
    expectedSource: "practitioner-entered", editable: true,
    verification: "manufacturer-documented", evidence: [evidence.id] };
}
const hf = (precision: number, evidence: EvidenceRef): MachineField[] => [
  field("hf_pulse_time", "H.F. time", "duration", "s", precision, evidence),
  field("hf_intensity", "H.F. intensity", "intensity", "%", 0, evidence),
  field("pulse_count", "Pulse", "count", "count", 0, evidence),
];
const glv = (evidence: EvidenceRef): MachineField[] => [
  field("galvanic_time", "Glv time", "duration", "s", 0, evidence),
  field("galvanic_current", "Glv mA", "current", "mA", 2, evidence),
];
function mode(key: string, nativeLabel: string, family: MachineMode["family"], fields: MachineField[], evidence: EvidenceRef): MachineMode {
  return { key, nativeLabel, family, fields, stages: [], availability: "blocked",
    verification: "manufacturer-documented", evidence: [evidence.id] };
}
const startingCurrentHold = "The starting-current choice cannot yet be recorded here. Recording this mode is pending until that choice can be kept with its readings.";
const cap = (evidence: EvidenceRef) => ({
  ...field("max_hf", "MAX HF", "intensity", "%", 0, evidence),
  note: "The configured maximum H.F. intensity, not a measurement of continuous H.F. intensity. No value is prefilled.",
});

function senior(): MachineProfile {
  const multiplex = mode("multiplex", "MultiPlex", "thermolysis", [], sThermo);
  multiplex.stages = [
    { key: "slow_thermolysis", nativeLabel: "Warming H.F.", fields: [
      field("warming_time", "H.F. warming time", "duration", "s", 1, sThermo),
      field("warming_intensity", "H.F. warming intensity", "intensity", "%", 0, sThermo),
    ], note: "Warming is high frequency even though the Glv key selects these controls." },
    { key: "snap", nativeLabel: "MicroFlash pulse", fields: hf(3, sThermo) },
  ];
  const pulsing = mode("blend", "Blend", "blend", [...hf(2, sBlend), ...glv(sBlend)], sBlend);
  pulsing.captureHold = startingCurrentHold;
  const omni = mode("omniblend", "OmniBlend", "blend", [...glv(sBlend), cap(sBlend)], sBlend);
  omni.captureHold = startingCurrentHold;
  omni.fields.find((f) => f.key === "max_hf")!.note += " Operating instructions p20 say 19%; specification p36 says 29%. The maximum remains disputed and is not enforced.";
  const multi = mode("multiblend", "MultiBlend", "blend", [...glv(sBlend), cap(sBlend)], sBlend);
  multi.captureHold = startingCurrentHold;
  multi.stages = [{ key: "final_component", nativeLabel: "Final MicroFlash pulse", fields: [
    field("final_pulse_time", "H.F. time", "duration", "s", 3, sBlend),
    field("final_pulse_intensity", "H.F. intensity", "intensity", "%", 0, sBlend),
  ] }];
  return {
    profileId: "dectro-apilus:senior-3g", version: 2, family: "Dectro/Apilus",
    manufacturer: "Dectro", model: "Senior 3G", verification: "manufacturer-documented",
    availability: "blocked", availabilityReason: "Native v2 contract implemented from the matching manual; profile activation remains held pending review and operator authorization.",
    frequency: { kind: "fixed", mhz: 13.56, verification: "manufacturer-documented", evidence: [sSpec.id] },
    evidence: [sThermo, sBlend, sSpec],
    modes: [mode("flash", "Thermo Flash", "thermolysis", hf(2, sThermo), sThermo),
      mode("microflash", "MicroFlash", "thermolysis", hf(3, sThermo), sThermo), multiplex,
      pulsing, omni, multi, mode("electrolysis", "Electrolysis", "galvanic", glv(sSpec), sSpec)],
    // The disputed bound is a field note, not a hold on unrelated native units.
    openQuestions: [],
  };
}

function junior(): MachineProfile {
  const thermo = mode("thermolysis", "Thermolysis", "thermolysis", hf(1, jThermo), jThermo);
  thermo.fields[0].unverified = ["decimals"];
  thermo.fields[0].note = "Screen p15 shows tenths; English prose/specification also states hundredths. This mode is pending: no rounding, conversion or firmware-specific hard increment is assumed.";
  const pulsing = mode("blend", "Blend", "blend", [...hf(2, jBlend), ...glv(jBlend)], jBlend);
  pulsing.captureHold = startingCurrentHold;
  const omni = mode("omniblend", "OmniBlend", "blend", [...glv(jBlend), cap(jBlend)], jBlend);
  omni.captureHold = "Starting-current behavior is unresolved: p20 allows changing it but p31 states galvanic-first. No inherited Senior order selector or assumed order is recorded.";
  const electrolysis = mode("electrolysis", "Electrolysis", "galvanic", glv(jThermo), jThermo);
  electrolysis.fields[1].note = "Operating instructions p16 say 0.99 mA; specification p31 says 1.99 mA. No maximum is selected or enforced.";
  const precision: OpenQuestion = {
    id: "junior-3g-thermolysis-precision", question: "Which native Thermolysis time precision applies to the installed Junior 3G firmware?",
    resolvedBy: "Junior 3G firmware identification plus a Thermolysis settings-screen photo showing the time digits and observed adjustment increment; distinguish Flash Thermo from Thermolysis.",
    blocks: ["thermolysis.hf_pulse_time"],
  };
  return {
    profileId: "dectro-apilus:junior-3g", version: 2, family: "Dectro/Apilus",
    manufacturer: "Dectro", model: "Junior 3G", verification: "manufacturer-documented",
    availability: "blocked", availabilityReason: "Native v2 contract implemented from the matching manual; profile activation remains held pending review and operator authorization.",
    frequency: { kind: "fixed", mhz: 13.56, verification: "manufacturer-documented", evidence: [jSpec.id] },
    evidence: [jThermo, jBlend, jSpec], openQuestions: [precision],
    modes: [thermo, mode("flash", "Flash Thermo", "thermolysis", hf(2, jThermo), jThermo), pulsing, omni, electrolysis],
  };
}

export const APILUS_3G_PROFILES: readonly MachineProfile[] = [senior(), junior()];

/** Additive v3 retains v1/v2 exactly: a text/choice contract is a new version. */
export const APILUS_3G_TEXT_PROFILES: readonly MachineProfile[] = APILUS_3G_PROFILES.map((original, index) => {
  const p = structuredClone(original);
  p.version = 3;
  p.availabilityReason = "Native text/choice v3 implemented; 0237 DB/browser proof, physical acceptance and Sam's activation authority remain separate gates.";
  const seniorModel = index === 0;
  const context = source(seniorModel ? "senior" : "junior", seniorModel ? "22–25" : "20, 23");
  context.id += "-text";
  p.evidence.push(context);
  for (const m of p.modes) {
    // Optional identifier is transcribed, never inferred from current/area or
    // coerced to a number. It does not assert the preset's underlying values.
    m.fields.push({ ...field("program_identifier", "Program", "preset-identifier", "none", 0, context),
      valueKind: "text", optional: true,
      note: "Record the displayed program identifier exactly, including leading zeroes or text; blank records no observation. No preset values are inferred." });
    if ((seniorModel && ["blend", "omniblend", "multiblend"].includes(m.key)) || (!seniorModel && m.key === "blend")) {
      m.fields.push({ ...field("starting_current", seniorModel ? "Glv Hf" : "Glv hf", "configuration", "none", 0, context),
        valueKind: "choice", choices: seniorModel ? ["Glv Hf", "Hf Glv"] : ["Glv hf", "Hf Glv"],
        note: "Native starting-current configuration, not numeric dose or an instruction to actuate a device." });
      delete m.captureHold;
    }
    // Junior OmniBlend's contradictory ordering and Thermolysis precision stay
    // narrow held questions; no inherited Senior selector is added to either.
  }
  return p;
});
