import type { MachineMode, MachineProfile } from "./profile-contract";

export type UnsupportedMode = { key: string; label: string; reason: string };

/**
 * The modes a model HAS but Hone cannot chart yet, each with the reason. Shown beside the picker so an uncertain mode is visibly
 * unsupported rather than silently missing. Never invents a value or range: the reason is the profile's own capture hold or the open
 * question that names the mode, in the profile's words.
 */
export function unsupportedModes(profile: MachineProfile): UnsupportedMode[] {
  return profile.modes
    .filter((m) => m.availability !== "active")
    .map((m) => ({ key: m.key, label: m.nativeLabel, reason: reasonFor(profile, m) }));
}

function reasonFor(profile: MachineProfile, mode: MachineMode): string {
  if (mode.captureHold) return mode.captureHold;
  const q = profile.openQuestions.find((x) => x.blocks.some((t) => t === "*" || t === mode.key || t.startsWith(`${mode.key}.`)));
  if (q) return q.question;
  return "Not supported yet: this mode has not been confirmed for charting.";
}
