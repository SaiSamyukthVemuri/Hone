import "server-only";

import { loadClientSelfServicePolicy } from "@/lib/booking/client-self-service-policy-store";

// HON-47. Whether a studio currently offers client portal access, for the paths
// that run BEFORE a portal session exists: sending or requesting a magic link,
// and verifying one. (Once a session exists, lib/portal/session.ts enforces the
// same flag.) FAIL CLOSED: an unreadable policy is "not allowed", never access.
// client_portal_enabled is the held 0252 column: absent on today's schema, and
// absent means allowed, so this changes nothing until an owner can turn it off.
export type PortalAccess =
  | { allowed: true; studioName: string | null }
  | { allowed: false; studioName: string | null };

export async function studioPortalAccess(
  admin: unknown,
  studioId: string,
): Promise<PortalAccess> {
  const read = await loadClientSelfServicePolicy(admin, studioId);
  if (!read.ok) return { allowed: false, studioName: null };
  return { allowed: read.policy.portal, studioName: read.studioName };
}
