// Apply the same minimum response time to public login and old-link recovery.
// A missing account/link should not be distinguishable by an immediate reply.
const MIN_PORTAL_LOGIN_RESPONSE_MS = 900;

export async function waitUntilMinimumElapsed(startedAt: number): Promise<void> {
  const remaining = MIN_PORTAL_LOGIN_RESPONSE_MS - (Date.now() - startedAt);
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}
