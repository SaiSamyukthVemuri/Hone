/**
 * THE SEAM FOR THE OWNER'S xCELL SWITCH.
 * The switch is stored by the machine-switches migration, which is not applied anywhere and is still being reviewed. Until its command exists
 * this reports UNAVAILABLE and reads nothing, so every studio keeps exactly the route it has today. It must never be faked: when the migration
 * lands, this one function reads the switch through that command and nothing else in the app changes.
 */
export type XcellModelSwitch = { available: false } | { available: true; enabled: boolean };

export async function readXcellModelSwitch(_studioId: string): Promise<XcellModelSwitch> {
  return { available: false };
}
