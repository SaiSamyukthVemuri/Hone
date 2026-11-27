import "server-only";
import { resolveStudioPlatform } from "@/lib/stripe/studio-platform";
import { resolveStripePublishableKey, type PublishableKeyResolution } from "@/lib/stripe/publishable-key";

// HON-90. The publishable key for a STUDIO: the key of the platform that owns its connected account, resolved from the studio's own
// verified jurisdiction row. A studio whose platform cannot be resolved has no key (the portal's calm "not available" state), never the
// Canadian one.
export async function resolveStudioPublishableKey(studioId: string): Promise<PublishableKeyResolution> {
  const route = await resolveStudioPlatform(studioId, "existing_account");
  if (!route.ok) return { ok: false, reason: "missing" };
  return resolveStripePublishableKey(route.platform);
}

export async function studioPublishableKeyOk(studioId: string): Promise<boolean> {
  return (await resolveStudioPublishableKey(studioId)).ok;
}
