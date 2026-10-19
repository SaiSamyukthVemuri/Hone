/** Deployment publication, never a practitioner command or an activation gate. */
import { catalogueIntegrity, MACHINE_CATALOGUE, profileById } from "./catalogue";
import { modeFields, type MachineProfile, type VerificationState } from "./profile-contract";

export type Publication = {
  p_machine_profile_id: string;
  p_machine_profile_version: number;
  p_mode_key: string;
  p_channels_max: number | null;
  p_requires_installed_option: string | null;
  p_fields: Array<{
    stage_key: string;
    field_key: string;
    native_unit: string;
    decimals: number;
    quantity: string;
    optional: boolean;
  }>;
};
export type PublicationPlan = {
  publish: Publication[];
  skipped: Array<{ profileId: string; version: number; mode: string | null; reasons: string[] }>;
};
const verified = (v: VerificationState) =>
  v === "manufacturer-documented" || v === "device-confirmed";

/** All fields, including optional ones, must be verified. Never publish a partial mode. */
export function planContractPublication(
  catalogue: readonly MachineProfile[] = MACHINE_CATALOGUE,
): PublicationPlan {
  const plan: PublicationPlan = { publish: [], skipped: [] };
  for (const p of catalogue) {
    const profileReasons: string[] = [];
    if (p.availability !== "active") profileReasons.push(`profile is ${p.availability}: ${p.availabilityReason ?? "not approved for capture"}`);
    if (!verified(p.verification)) profileReasons.push(`profile identity is ${p.verification}`);
    if (p.frequency.kind === "unverified") profileReasons.push(`frequency is unverified: ${p.frequency.note}`);
    if (profileById(p.profileId, catalogue)?.version !== p.version) profileReasons.push("superseded version; historical contracts are not newly published");
    if (p.channels?.associationRequired) profileReasons.push("0223 cannot enforce required channel association; a separate database change is required");
    // Reuse the canonical integrity gate; it checks identity, frequency,
    // evidence references and required-field holds. Do not promote blocked modes.
    profileReasons.push(...catalogueIntegrity([p]).map((v) => v.problem));
    const duplicates = catalogue.filter((v) => v.profileId === p.profileId && v.version === p.version);
    if (duplicates.length !== 1) profileReasons.push("duplicate profile/version identity");
    const held = new Set(p.openQuestions.flatMap((q) => q.blocks));
    if (held.has("*") || held.has("@frequency")) profileReasons.push("profile or frequency is held by an open question");
    if (p.modes.length === 0) {
      plan.skipped.push({ profileId: p.profileId, version: p.version, mode: null, reasons: [...profileReasons, "no verified modes described"] });
    }
    for (const mode of p.modes) {
      const reasons = [...profileReasons];
      if (mode.availability !== "active") reasons.push(`mode is ${mode.availability}`);
      if (!verified(mode.verification)) reasons.push(`mode identity is ${mode.verification}`);
      const fields = modeFields(mode);
      if (fields.length === 0) reasons.push("mode has no fields");
      for (const { field: f, stageKey } of fields) {
        if (!verified(f.verification) || f.unverified?.length) reasons.push(`field ${stageKey ?? ""}.${f.key} lacks complete evidence (${f.verification}; ${(f.unverified ?? []).join(", ")})`);
        if (held.has("*") || held.has(f.key) || held.has(`${mode.key}.${f.key}`) || (stageKey && held.has(`${stageKey}.${f.key}`))) reasons.push(`field ${f.key} is held by an open question`);
        if (!Number.isInteger(f.decimals) || f.decimals < 0 || f.decimals > 6) reasons.push(`field ${f.key} precision cannot be represented by 0223`);
      }
      if (reasons.length) {
        plan.skipped.push({ profileId: p.profileId, version: p.version, mode: mode.key, reasons: [...new Set(reasons)] });
        continue;
      }
      plan.publish.push({
        p_machine_profile_id: p.profileId,
        p_machine_profile_version: p.version,
        p_mode_key: mode.key,
        p_channels_max: p.channels?.count ?? null,
        p_requires_installed_option: mode.requiresInstalledOption ?? null,
        p_fields: fields.map(({ field: f, stageKey }) => ({
          stage_key: stageKey ?? "", field_key: f.key, native_unit: f.unit,
          decimals: f.decimals, quantity: f.quantity, optional: f.optional,
        })),
      });
    }
  }
  return plan;
}

/** RPC owns immutable equality and privilege enforcement, including no-op replay. */
export async function publishContracts(
  plan: PublicationPlan,
  publish: (contract: Publication) => Promise<number>,
): Promise<Array<{ profileId: string; version: number; mode: string; inserted: number }>> {
  const results = [];
  for (const contract of plan.publish) {
    const inserted = await publish(contract); // Stop at first refusal; never retry uncertain writes.
    if (!Number.isInteger(inserted) || (inserted !== 0 && inserted !== contract.p_fields.length)) throw new Error("Invalid publication receipt; inspect the target before retrying.");
    results.push({ profileId: contract.p_machine_profile_id, version: contract.p_machine_profile_version, mode: contract.p_mode_key, inserted });
  }
  return results;
}
