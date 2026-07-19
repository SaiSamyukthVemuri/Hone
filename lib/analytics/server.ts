// Safe server-side analytics dispatch (P1/P2-ANALYTICS-03).
//
// Before this module, server actions, the auth callback, and the Stripe
// webhook called `posthog.capture(...)` followed by `await posthog.flush()`
// INLINE in the request path, after the primary operation had committed.
// posthog-node's `flush()` returns its underlying send promise to the caller
// (only the internal waitUntil copy attaches `.catch`), so a PostHog outage
// could: delay a committed payment response for the full retry window, make a
// committed operation appear failed, or 500 the Stripe webhook and trigger
// provider retries — all for telemetry.
//
// Properties of this wrapper:
//   * product success NEVER depends on analytics success — nothing here throws;
//   * dispatch runs AFTER the response via Next's stable `after()` (falls back
//     to a caught fire-and-forget promise if `after()` is unavailable);
//   * bounded execution time (DISPATCH_TIMEOUT_MS race);
//   * event properties are ALLOWLISTED — only approved coarse, non-clinical
//     keys leave the process; unknown keys are dropped, never sent;
//   * `identify` carries the opaque distinctId only — properties are not
//     accepted at the type level;
//   * repeated failures surface via a safe console signal (event name only,
//     no payload contents) that Sentry breadcrumbs/ops can observe without
//     recording clinical data.
//
// Design choice: best-effort bounded post-commit dispatch (framework
// `after()`), NOT a durable analytics outbox. Product analytics is tolerable
// to lose on a crashed instance; a durable queue for it would add write
// amplification to clinical request paths for no product benefit. Revisit
// only if an analytics event ever becomes business-critical.

import { after } from "next/server";
import { getPostHogClient } from "@/lib/posthog-server";

// Every property a server-side event may carry. Adding a key here is a
// privacy-review event: keys must be coarse, non-clinical, non-identifying
// (opaque ids and enums only — never names, notes, tokens, emails, phones).
const ALLOWED_EVENT_PROPERTIES = new Set([
  "studio_id",
  "modality",
  "is_new_session",
  "source",
  "provider",
  "livemode",
]);

const DISPATCH_TIMEOUT_MS = 2000;

type ServerEventProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

function allowlistProperties(
  properties: ServerEventProperties | undefined,
  event: string,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value === undefined) continue;
    if (ALLOWED_EVENT_PROPERTIES.has(key)) {
      out[key] = value;
    } else {
      // Dropped, never sent. Name-only signal; no values logged.
      console.warn(
        JSON.stringify({
          event: "analytics_property_dropped",
          analyticsEvent: event,
          property: key,
        }),
      );
    }
  }
  return out;
}

async function boundedDispatch(
  label: string,
  send: (client: ReturnType<typeof getPostHogClient>) => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = getPostHogClient();
    send(client);
    await Promise.race([
      client.flush().catch((err: unknown) => {
        console.warn(
          JSON.stringify({
            event: "analytics_dispatch_failed",
            analyticsEvent: label,
            reason: err instanceof Error ? err.name : "unknown",
          }),
        );
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DISPATCH_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "analytics_dispatch_failed",
        analyticsEvent: label,
        reason: err instanceof Error ? err.name : "unknown",
      }),
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Schedule work post-response; never let scheduling itself throw. */
function schedule(label: string, work: () => Promise<void>): void {
  try {
    after(work);
  } catch {
    // Outside a request scope (or after() unavailable): best-effort inline
    // fire-and-forget. The promise is caught inside `work`; void it so an
    // unhandled rejection is impossible.
    void work();
  }
}

/**
 * Fire a product analytics event from the server. Non-blocking, bounded,
 * never throws, never affects the caller's result.
 */
export function captureServerEvent(args: {
  distinctId: string;
  event: string;
  properties?: ServerEventProperties;
}): void {
  const properties = allowlistProperties(args.properties, args.event);
  schedule(args.event, () =>
    boundedDispatch(args.event, (client) =>
      client.capture({
        distinctId: args.distinctId,
        event: args.event,
        properties,
      }),
    ),
  );
}

/**
 * Identify a user by opaque id ONLY. Person properties are deliberately not
 * accepted — attaching email/name/etc. to the PostHog person profile is a
 * privacy-review event and must go through a code change here.
 */
export function identifyServerUser(args: { distinctId: string }): void {
  schedule("$identify", () =>
    boundedDispatch("$identify", (client) =>
      client.identify({ distinctId: args.distinctId }),
    ),
  );
}
