import { APILUS_3G_PROFILES } from "./apilus-3g";
import { modeFields, type MachineProfile } from "./profile-contract";

// Data shared by the existing server-only synthetic gate and browser specs.
// Exporting these definitions does not add them to any runtime catalogue.
const READY_MODES = [
  ["flash", "microflash", "multiplex", "electrolysis"],
  ["flash", "electrolysis"],
] as const;

export const APILUS_3G_NATIVE_FIXTURES: readonly MachineProfile[] = APILUS_3G_PROFILES.map((original, index) => {
  const fixture = structuredClone(original);
  fixture.profileId = `synthetic:native-${original.profileId.split(":")[1]}`;
  fixture.family = "Synthetic/Demo";
  fixture.manufacturer = "Synthetic";
  fixture.model = `${original.model} native-fields fixture`;
  fixture.availability = "active";
  fixture.availabilityReason = "Local synthetic native-field proof only; not real-model activation or physical confirmation.";
  fixture.modes = fixture.modes.filter((mode) => READY_MODES[index].some((key) => key === mode.key));
  for (const mode of fixture.modes) {
    if (mode.captureHold || modeFields(mode).some(({ field }) => field.unverified?.length)) {
      throw new Error(`Native fixture cannot expose held fields: ${original.model}/${mode.key}`);
    }
    mode.availability = "active";
  }
  // The only Junior open question targets Thermolysis, absent from this fixture.
  // Fail closed if a future question touches a retained mode or the profile.
  fixture.openQuestions = fixture.openQuestions.filter((question) => question.blocks.some((target) =>
    target === "*" || target === "@frequency" || fixture.modes.some((mode) => target.startsWith(`${mode.key}.`)),
  ));
  if (fixture.openQuestions.length) throw new Error(`Unresolved native fixture: ${original.model}`);
  return fixture;
});
