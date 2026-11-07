import type { ProfileReadOptions } from "@/lib/clients/profile-pricing";

// "See published service prices and booking fees" (Sam, 7 Nov 2026). Owners always see the published service
// price. Staff see it only while the studio's control is ON (default ON, any owner can turn it off). With it
// OFF the service read names no price column, so no price or booking fee is in the staff member's HTML, RSC
// or API payload. It controls PUBLISHED prices only: a client's own price, a session price, payments and card
// data stay owner-only and are never read through this function (DN-11; see getClientById).
//
// THE SEAM. The permission engine (0287) is not live, so there is no stored value to read yet. Until it is,
// `staffMaySeePublishedServicePrices` answers the default, ON. When the key exists this is the ONE function
// to change; every caller already passes through `publishedServicePriceReads`.
export async function staffMaySeePublishedServicePrices(studioId: string): Promise<boolean> {
  void studioId; // the engine key is per studio; the default does not depend on it
  return true;
}

/** The read options for any surface that shows a studio's published service prices. */
export async function publishedServicePriceReads(
  studioId: string,
  isOwner: boolean,
  // Injected only by tests, to prove the OFF branch before the engine can store it.
  read: (studioId: string) => Promise<boolean> = staffMaySeePublishedServicePrices,
): Promise<ProfileReadOptions> {
  if (isOwner) return { includePrices: true };
  return { includePrices: await read(studioId) };
}
