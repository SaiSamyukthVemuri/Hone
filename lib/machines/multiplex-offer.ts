import { catalogueForRuntime } from "./synthetic-profile";
import { currentProfile } from "./profile-contract";
import { publishedModesFor, type MachineDb } from "./machine-queries";
import { listUnspecifiedMachines } from "./unspecified-machine";
import { xcellMultiplexRoute } from "./xcell-route";
import { XCELL_PUR_PROFILE_ID } from "./xcell-pur";

/**
 * WHETHER THE CHART OFFERS MULTIPLEX TO THIS STUDIO (HON-119), read on the server with the page, so the pill is on screen from the first visit
 * and no extra request is made while charting. The same rule as the machine panel's own route (`xcellMultiplexRoute`), minus the registered
 * unit the panel resolves when it opens: here only the placeholder route matters. A failed read offers nothing.
 */
export async function loadMultiplexOffer(db: MachineDb, studioId: string): Promise<{ deviceId: string } | null> {
  try {
    const catalogue = [...catalogueForRuntime()];
    const profile = currentProfile(catalogue, XCELL_PUR_PROFILE_ID);
    if (!profile) return null;
    const published = await publishedModesFor(db, profile.profileId, profile.version);
    if (!published.ok) return null;
    const placeholders = await listUnspecifiedMachines(db, studioId);
    const route = xcellMultiplexRoute({
      legacyOffered: false,
      registeredUnitAllowed: false,
      catalogue,
      devices: [],
      unspecifiedUnits: placeholders.ok ? placeholders.value : [],
      studioId,
      publishedModes: published.value,
    });
    return route ? { deviceId: route.deviceId } : null;
  } catch {
    return null;
  }
}
