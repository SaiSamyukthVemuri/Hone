import type { MachineProfile } from "./profile-contract";
import { XCELL_PUR_PROFILE_ID } from "./xcell-pur";

/**
 * ONE xCell, ONE NAME (HON-71). The studio has a single xCell. The xCell Pur contract is how its MultiPlex mode is stored, not a second
 * machine, so every user-facing place that names a model shows it as the studio's existing xCell. The contract's own identity
 * (`dectro-apilus:xcell-pur`, its evidence entries and product-page citation) is unchanged and may still say Pur where it cites the
 * manufacturer's page: that is provenance, not a selectable machine.
 */
export const XCELL_ONE_CHOICE_LABEL = "Dectro xCell";

type Named = Pick<MachineProfile, "profileId" | "manufacturer" | "model" | "variant">;

/** The model's name as a person sees it: manufacturer, model and variant, with the xCell Pur shown as the studio's xCell. */
export function machineModelLabel(p: Named): string {
  if (p.profileId === XCELL_PUR_PROFILE_ID) return XCELL_ONE_CHOICE_LABEL;
  return `${p.manufacturer} ${p.model}${p.variant ? ` (${p.variant})` : ""}`;
}

/**
 * Models an owner may register by hand, from `profiles` (the caller passes only models whose contract is PUBLISHED, so an unpublished xCell
 * Pur stays hidden). The xCell Pur is the studio's one xCell (HON-71): it is offered, under the label "Dectro xCell", only to a studio on the
 * rollout allowlist (`xcellAllowed`) and only while the studio has no live unit of it, so a second registration is never offered.
 * `registerMachineAction` enforces the allowlist and refuses a duplicate as well.
 */
export function registrableProfiles<T extends Pick<MachineProfile, "profileId">>(
  profiles: readonly T[],
  liveUnits: ReadonlyArray<{ profileId: string }>,
  xcellAllowed: boolean,
): T[] {
  const hasXcellUnit = liveUnits.some((u) => u.profileId === XCELL_PUR_PROFILE_ID);
  return profiles.filter((p) => !(p.profileId === XCELL_PUR_PROFILE_ID && (hasXcellUnit || !xcellAllowed)));
}
