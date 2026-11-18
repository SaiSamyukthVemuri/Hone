/**
 * How a machine's name is DISPLAYED. Labels only: no profile id, saved record, setting or history is read or changed here.
 *
 * Two xCell workflows exist side by side and must read differently everywhere a practitioner sees them (Sam's naming decision,
 * 18 Nov 2026): the existing charting (the legacy entry `dectro-apilus:xcell`) and the structured, native xCell Pur profile.
 * The legacy entry itself is NOT edited: its label is derived from it plus a suffix, so its catalogue bytes stay pinned.
 */
import type { MachineProfile } from "./profile-contract";

export const XCELL_PUR_PROFILE_ID_FOR_LABEL = "dectro-apilus:xcell-pur";
export const LEGACY_WORKFLOW_SUFFIX = " — existing charting";
export const NATIVE_XCELL_PUR_LABEL = "Apilus xCell Pur — structured charting";
/** Names the workflow that holds an area's saved readings, so a refusal says which one it means. */
export const LEGACY_WORKFLOW_NAME = `Dectro xCell${LEGACY_WORKFLOW_SUFFIX}`;

/** The legacy workflow's selector label, from its own catalogue fields plus the suffix. */
export function legacyWorkflowLabel(parts: { manufacturer: string; model: string; variant?: string }): string {
  return [parts.manufacturer, parts.model, parts.variant].filter((p): p is string => Boolean(p)).join(" ") + LEGACY_WORKFLOW_SUFFIX;
}

/** A profile's display name. Every profile keeps its existing "<manufacturer> <model> (<variant>)" form except the native xCell Pur. */
export function machineDisplayName(profile: Pick<MachineProfile, "profileId" | "manufacturer" | "model" | "variant">): string {
  if (profile.profileId === XCELL_PUR_PROFILE_ID_FOR_LABEL) return NATIVE_XCELL_PUR_LABEL;
  return `${profile.manufacturer} ${profile.model}${profile.variant ? ` (${profile.variant})` : ""}`;
}
