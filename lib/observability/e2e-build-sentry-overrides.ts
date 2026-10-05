// SENTRY-E2E-NOISE-02 (Codex P2 at de43cb15). A local browser lane's
// `next build` must not create releases or upload source maps in the
// operational Sentry project.
//
// The lane's network guard (e2e/helpers/sentry-egress-guard.cjs) cannot stop
// that: release creation and upload are performed by the NATIVE sentry-cli
// binary, which no Node preload can intercept. Blanking SENTRY_AUTH_TOKEN in
// the lane's environment does not hold either, because the build plugin reads
// `.env.sentry-build-plugin` and applies it OVER process.env before it reads
// the token. What does hold is an explicit option: the plugin resolves
// `userOptions.authToken ?? process.env.SENTRY_AUTH_TOKEN`, so an empty token
// passed through withSentryConfig outranks both, and with no token the plugin
// creates no release and uploads nothing.
//
// The trigger is NOT an environment variable, which a deployment could carry
// by mistake. It is the mark the guard sets on its own process when it arms -
// and the guard refuses to start at all in a runtime carrying any deployed
// signal, so the mark cannot exist in a deployed build. Everywhere else this
// returns no override, leaving a deployed build's options exactly as before.
//
// Node-safe on purpose (no "server-only"): next.config.ts imports it.

/** The key e2e/helpers/sentry-egress-guard.cjs marks its process with. */
export const SENTRY_EGRESS_GUARD_MARK = Symbol.for("hone.e2e.sentryEgressGuard");

/** True only inside a process where the lane's Sentry egress guard armed. */
export function isSentryEgressGuardArmed(scope: object = globalThis): boolean {
  const mark: unknown = (scope as Record<symbol, unknown>)[SENTRY_EGRESS_GUARD_MARK];
  return (
    typeof mark === "object" &&
    mark !== null &&
    (mark as { active?: unknown }).active === true
  );
}

/** withSentryConfig options for a local browser-lane build; none for any other. */
export function localE2eBuildSentryOverrides(scope: object = globalThis): {
  authToken?: string;
} {
  return isSentryEgressGuardArmed(scope) ? { authToken: "" } : {};
}
