import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
// MUST stay the first Next import: it is what Next's own server bootstrap runs
// before any request exists. Without it Next's request storage is an inert stub
// that throws on use, and nothing below would be Next's real behaviour.
import "next/dist/server/node-environment-baseline";
import { after } from "next/server";
import { cookies, headers } from "next/headers";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { createWorkStore } from "next/dist/server/async-storage/work-store";
import { createRequestStoreForRender } from "next/dist/server/async-storage/request-store";

// SENTRY-AFTER-01. Sentry recorded `Route ... used "cookies" inside
// "after(...)"` from ordinary authenticated pages and from the (app) layout,
// although no page reads cookies inside an after() callback.
//
// The cause is the CALLBACK form of after(). Registering a callback enrols the
// request's own work-unit store, and when the HTTP response closes Next sets
// that SHARED store's phase to "after" before running the callbacks. A
// response closes early whenever the client goes away mid-render, the render
// keeps going, and every cookies()/headers() it makes from then on throws.
// app/(app)/layout.tsx calls identifyServerUser() on every authenticated
// render, and Server Actions call captureServerEvent() before Next re-renders
// the revalidated page in the same request, so both armed it.
//
// Everything here is Next's real machinery: its after(), cookies() and
// headers(), its own store factories, and onClose/waitUntil wired the way its
// app-page handler wires them (next/dist/build/templates/app-page.js:
// `onClose: (cb) => res.on('close', cb)`). The CONTROL cases reproduce the
// production error first, so the cases asserting its absence cannot pass
// vacuously. Reaching into next/dist is deliberate: if a Next upgrade breaks
// these imports, re-prove the after() semantics rather than drop the test.

const captureMock = vi.fn();
const identifyMock = vi.fn();

vi.mock("@/lib/posthog-server", () => ({
  getPostHogClient: () => ({
    capture: captureMock,
    identify: identifyMock,
    flush: async () => {},
  }),
}));

import { captureServerEvent, identifyServerUser } from "@/lib/analytics/server";

const UID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const SESSION_COOKIE_NAME = "sb-test-auth-token";
const SESSION_COOKIE_VALUE = "opaque-session";

type RequestStoreArgs = Parameters<typeof createRequestStoreForRender>;

const opened: Array<{ settle(): Promise<void> }> = [];

/** One authenticated request to `route`, wired as Next wires a real one. */
function openRequest(route: string) {
  // Stands in for the node ServerResponse; only its "close" event matters.
  const response = new EventEmitter();
  const keptAlive: Array<Promise<unknown>> = [];
  const workStore = createWorkStore({
    page: `/(app)${route}/page`,
    renderOpts: {
      waitUntil: (promise) => {
        keptAlive.push(promise);
      },
      onClose: (callback) => {
        response.on("close", callback);
      },
      onAfterTaskError: () => {},
      supportsDynamicResponse: true,
      experimental: {
        isRoutePPREnabled: false,
        cacheComponents: false,
        authInterrupts: false,
      },
    },
    isPrefetchRequest: false,
    buildId: "test",
    previouslyRevalidatedTags: [],
  });
  const requestStore = createRequestStoreForRender(
    {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${SESSION_COOKIE_VALUE}` },
    } as unknown as RequestStoreArgs[0],
    undefined,
    { pathname: route },
    {},
    { tags: [], expirationsByCacheKind: new Map() } as unknown as RequestStoreArgs[4],
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    null,
  );
  const request = {
    route,
    requestStore,
    keptAlive,
    run<T>(fn: () => T): T {
      return workAsyncStorage.run(workStore, () =>
        workUnitAsyncStorage.run(requestStore, fn),
      );
    },
    /** How many subscribers the response's "close" event has. */
    closeSubscribers: () => response.listenerCount("close"),
    /** The client goes away while the render is still running. */
    async clientGoesAway(): Promise<void> {
      response.emit("close");
      // Next reacts on a later tick; let it.
      await new Promise((resolve) => setImmediate(resolve));
    },
    /** Every response closes eventually; a failed assertion must not skip it. */
    async settle(): Promise<void> {
      response.emit("close");
      await Promise.all(keptAlive);
    },
  };
  opened.push(request);
  return request;
}

/** What the rest of a render does after analytics was scheduled. */
async function readRequest(): Promise<{ session?: string; cookieHeader: string | null }> {
  const jar = await cookies();
  const requestHeaders = await headers();
  return {
    session: jar.get(SESSION_COOKIE_NAME)?.value,
    cookieHeader: requestHeaders.get("cookie"),
  };
}

beforeEach(() => {
  captureMock.mockReset();
  identifyMock.mockReset();
});

afterEach(async () => {
  // Every scheduled dispatch settles inside the test that started it.
  for (const request of opened.splice(0)) await request.settle();
});

// An authenticated page render registers analytics in the "render" phase. A
// Server Action registers it in the "action" phase, then Next switches the SAME
// store to "render" (executeActionAndPrepareForRender in
// next/dist/server/app-render/action-handler.js) and re-renders the
// revalidated page.
const SCENARIOS = [
  {
    name: "an authenticated page render",
    route: "/dashboard",
    registerIn: "render" as const,
    schedule: () => identifyServerUser({ id: UID, role: "owner" }),
  },
  {
    name: "a Server Action that re-renders its revalidated page",
    route: "/clients/[id]/sessions/[sessionId]",
    registerIn: "action" as const,
    schedule: () =>
      captureServerEvent({
        actor: { kind: "user", id: UID },
        event: "payment_charge_executed",
        properties: { studio_id: SID },
      }),
  },
];

describe.each(SCENARIOS)("SENTRY-AFTER-01: $name", (scenario) => {
  it("CONTROL: a callback handed to after() makes the rest of the request unreadable once the client goes away", async () => {
    const request = openRequest(scenario.route);
    request.requestStore.phase = scenario.registerIn;
    await request.run(async () => {
      after(async () => {});
    });
    request.requestStore.phase = "render";

    await request.run(async () => {
      await request.clientGoesAway();

      expect(request.requestStore.phase).toBe("after");
      expect(() => cookies()).toThrow(
        `Route ${scenario.route} used "cookies" inside "after(...)"`,
      );
      expect(() => headers()).toThrow(
        `Route ${scenario.route} used "headers" inside "after(...)"`,
      );
    });
  });

  it("analytics leaves the request readable after the client goes away", async () => {
    const request = openRequest(scenario.route);
    request.requestStore.phase = scenario.registerIn;
    await request.run(async () => {
      scenario.schedule();
    });
    request.requestStore.phase = "render";

    await request.run(async () => {
      await request.clientGoesAway();

      await expect(readRequest()).resolves.toEqual({
        session: SESSION_COOKIE_VALUE,
        cookieHeader: `${SESSION_COOKIE_NAME}=${SESSION_COOKIE_VALUE}`,
      });
      expect(request.requestStore.phase).toBe("render");
    });

    // Why: nothing waits on the response closing, so Next has nothing to run
    // there and no reason to move the request into the after phase.
    expect(request.closeSubscribers()).toBe(0);
  });
});

describe("SENTRY-AFTER-01: the dispatch itself is unchanged", () => {
  it("runs off the caller's synchronous path, kept alive by after(), and still sends", async () => {
    const request = openRequest("/dashboard");
    await request.run(async () => {
      identifyServerUser({ id: UID, role: "owner" });
      captureServerEvent({
        actor: { kind: "user", id: UID },
        event: "client_created",
        properties: { studio_id: SID, client_name: "dropped by the allowlist" },
      });
      // Nothing reached PostHog on the caller's path.
      expect(identifyMock).not.toHaveBeenCalled();
      expect(captureMock).not.toHaveBeenCalled();
    });

    // One waitUntil per dispatch keeps the invocation alive until it settles,
    // and the dispatch does not wait for the response to close.
    expect(request.keptAlive).toHaveLength(2);
    expect(request.closeSubscribers()).toBe(0);
    await Promise.all(request.keptAlive);

    expect(identifyMock).toHaveBeenCalledTimes(1);
    expect(identifyMock).toHaveBeenCalledWith({
      distinctId: UID,
      properties: { role: "owner" },
    });
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: UID,
      event: "client_created",
      properties: { studio_id: SID },
    });
  });

  it("outside any request scope it never throws and the work still runs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Next's real after() refuses here ("called outside a request scope").
      expect(() => identifyServerUser({ id: UID })).not.toThrow();
      await vi.waitFor(() => expect(identifyMock).toHaveBeenCalledTimes(1));
      expect(identifyMock).toHaveBeenCalledWith({ distinctId: UID });
    } finally {
      warn.mockRestore();
    }
  });
});
