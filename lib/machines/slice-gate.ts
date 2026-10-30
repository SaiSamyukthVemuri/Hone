/**
 * HON-8 23 Nov slice gate: Senior/Junior 3G create/save/reload/next-visit with ONLY the fields the manufacturer sources agree on
 * (OPS ruling 2026-10-27). Pure checks over profile definitions; nothing here reads a database or changes what a practitioner sees.
 *
 * ROUTINE-CAPTURE BUDGET. The routine path asks for the machine's native fields only, at most ROUTINE_REQUIRED_INPUT_BUDGET required
 * inputs per setting group (one mode, with its stages). Optional fields (for example the displayed program identifier) never count:
 * they are conditional detail. A mode above the budget must make the excess optional or conditional rather than raise the number.
 */
import { modeFields, type MachineMode, type MachineProfile } from "./profile-contract";

export const ROUTINE_REQUIRED_INPUT_BUDGET = 6;

/** Required inputs a practitioner must supply to save one setting group of this mode (stages included). */
export function routineRequiredInputs(mode: MachineMode): number {
  return modeFields(mode).filter(({ field }) => !field.optional).length;
}

export type BudgetViolation = { profileId: string; modeKey: string; required: number };

export function budgetViolations(profiles: readonly MachineProfile[], budget = ROUTINE_REQUIRED_INPUT_BUDGET): BudgetViolation[] {
  return profiles.flatMap((p) => p.modes
    .map((m) => ({ profileId: p.profileId, modeKey: m.key, required: routineRequiredInputs(m) }))
    .filter((v) => v.required > budget));
}

export type SliceViolation = { profileId: string; modeKey: string; reason: string };

/**
 * A mode may be OFFERED in the slice only if everything it asks for is manufacturer-documented and uncontested:
 * no capture hold, no field with an unverified aspect, no open question naming it (or '*', or the frequency), every field's evidence
 * resolvable on the profile, and no ENFORCED range (a disputed bound must stay a note, never a validation that rejects a real value).
 */
export function sliceViolations(profile: MachineProfile): SliceViolation[] {
  const out: SliceViolation[] = [];
  const evidenceIds = new Set(profile.evidence.map((e) => e.id));
  const blocked = (key: string) => profile.openQuestions.some((q) => q.blocks.some((t) => t === "*" || t === "@frequency" || t === key || t.startsWith(`${key}.`)));
  for (const mode of profile.modes) {
    const add = (reason: string) => out.push({ profileId: profile.profileId, modeKey: mode.key, reason });
    if (mode.captureHold) add("capture hold");
    if (blocked(mode.key)) add("open question blocks it");
    if (mode.verification !== "manufacturer-documented") add(`mode verification is ${mode.verification}`);
    for (const { field } of modeFields(mode)) {
      if (field.unverified?.length) add(`${field.key}: unverified ${field.unverified.join(",")}`);
      if (field.verification !== "manufacturer-documented") add(`${field.key}: verification ${field.verification}`);
      if (field.ranges?.length) add(`${field.key}: enforces a range`);
      if (!field.evidence.length || field.evidence.some((id) => !evidenceIds.has(id))) add(`${field.key}: evidence missing`);
    }
  }
  return out;
}
