import { PostHog } from "posthog-node";

// Per-request PostHog client for Next.js server-side use.
// Next.js route handlers and server actions are short-lived; each invocation
// must await posthog.flush() before returning so the queued event is sent
// before the process context is torn down.
export function getPostHogClient(): PostHog {
  return new PostHog(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
}
