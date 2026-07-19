// Safe server-side analytics dispatch (P1/P2-ANALYTICS-03 + Correction 2).
//
// Server actions, the auth callback, and the Stripe webhook must never let
// analytics latency or failure affect a committed product operation. Before
// this module they awaited `posthog.flush()` inline after commit; posthog-node
// returns the un-caught send promise, so a PostHog outage could delay/fail a
// committed charge, refund, booking or sign-in, or 500 the webhook and trigger
// Stripe retries.
//
// Guarantees:
//   * product success NEVER depends on analytics — nothing here throws into a
//     caller; every failure mode is caught;
//   * dispatch runs AFTER the response via Next's stable `after()` (caught
//     fire-and-forget fallback when out of request scope);
//   * bounded execution time (DISPATCH_TIMEOUT_MS race);
//   * distinctIds are opaque, UUID-validated actors (lib/analytics/ids.ts) —
//     an email/phone/token/free-text id fails closed (event dropped) and is
//     never logged;
//   * event properties are ALLOWLISTED — unknown keys are dropped, never sent;
//   * `identify` carries the opaque id and, optionally, a validated coarse role
//     enum only.
//
// Design: best-effort bounded post-commit dispatch (framework `after()`), NOT a
// durable outbox — product analytics is tolerable-loss and a queue would add
// write amplification to clinical paths for no product benefit.

import { after } from "next/server";
import { getPostHogClient } from "@/lib/posthog-server";
import {
  resolveDistinctId,
  validateRole,
  type AnalyticsActor,
} from "@/lib/analytics/ids";

// Every property a server-side event may carry. Adding a key here is a
// privacy-review event: coarse, non-clinical, non-identifying values only.
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

function warnNameOnly(fields: Record<string, string | undefined>): void {
  // Name-only ops signal; never includes an id, value, or payload content.
  console.warn(JSON.stringify(fields));
}

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
      warnNameOnly({
        event: "analytics_property_dropped",
        analyticsEvent: event,
        property: key,
      });
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
        warnNameOnly({
          event: "analytics_dispatch_failed",
          analyticsEvent: label,
          reason: err instanceof Error ? err.name : "unknown",
        });
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DISPATCH_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    warnNameOnly({
      event: "analytics_dispatch_failed",
      analyticsEvent: label,
      reason: err instanceof Error ? err.name : "unknown",
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Schedule work post-response; never let scheduling itself throw. */
function schedule(work: () => Promise<void>): void {
  try {
    after(work);
  } catch {
    // Out of request scope (or after() unavailable): caught fire-and-forget.
    void work();
  }
}

/**
 * Fire a product analytics event from the server. Non-blocking, bounded, never
 * throws, never affects the caller's result. The actor's id is UUID-validated
 * inside the post-response work — a non-UUID id drops the event (no value
 * logged).
 */
export function captureServerEvent(args: {
  actor: AnalyticsActor;
  event: string;
  properties?: ServerEventProperties;
}): void {
  const properties = allowlistProperties(args.properties, args.event);
  schedule(async () => {
    const distinctId = resolveDistinctId(args.actor);
    if (distinctId === null) {
      warnNameOnly({
        event: "analytics_actor_rejected",
        actorKind: args.actor.kind,
        analyticsEvent: args.event,
      });
      return;
    }
    await boundedDispatch(args.event, (client) =>
      client.capture({ distinctId, event: args.event, properties }),
    );
  });
}

/**
 * Identify a user by opaque UUID only, optionally with a validated coarse role
 * enum. No other person properties are accepted; email/name/etc. cannot be
 * attached. Non-blocking, bounded, never throws.
 */
export function identifyServerUser(args: { id: string; role?: string }): void {
  schedule(async () => {
    const distinctId = resolveDistinctId({ kind: "user", id: args.id });
    if (distinctId === null) {
      warnNameOnly({
        event: "analytics_actor_rejected",
        actorKind: "user",
        analyticsEvent: "$identify",
      });
      return;
    }
    const role = validateRole(args.role);
    await boundedDispatch("$identify", (client) =>
      client.identify({
        distinctId,
        ...(role ? { properties: { role } } : {}),
      }),
    );
  });
}
