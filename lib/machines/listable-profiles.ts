import { activeModes, type MachineProfile } from "./profile-contract";

/**
 * An owner is shown a model only if registering it can succeed: every ACTIVE mode must have a published contract at the profile's
 * current version. `registerMachineAction` enforces the same rule; this keeps the settings list from offering a model that then
 * refuses ("never expose an unfinished control"). `publishedModes` is null when the read failed, which lists nothing (fail closed).
 */
export function listableProfiles(
  active: readonly MachineProfile[],
  publishedModes: (profile: MachineProfile) => readonly string[] | null,
): MachineProfile[] {
  return active.filter((p) => {
    const published = publishedModes(p);
    if (!published) return false;
    const wanted = activeModes(p).map((m) => m.key);
    return wanted.length > 0 && wanted.every((k) => published.includes(k));
  });
}
