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

// ===========================================================================
// SMS-01 — the invitation text must not change the Invite to book Server
// Action's request (Codex P2 4212846620; the SENTRY-AFTER-01 mechanism).
//
// In Next 15.5 a CALLBACK handed to after() enrols the request's own work-unit
// store. When the HTTP response closes -- the practitioner navigates away
// while the invitation email is still sending -- Next sets that SHARED store's
// phase to "after". The action then returns, revalidates and re-renders, and
// every cookies()/headers() call throws `used "cookies" inside "after(...)"`.
// A started PROMISE is waitUntil only: it keeps the invocation alive and never
// touches the phase.
//
// Everything Next-side here is real: after(), cookies(), headers(), the store
// factories and onClose/waitUntil wired as its app-page handler wires them
// (see tests/lib/analytics/server-after-phase.test.ts). The adapter is the real
// one; its database, session and both channel senders are substituted. The
// CONTROL reproduces the production error first, so the case asserting its
// absence cannot pass vacuously.
// ===========================================================================

const RAW = "r".repeat(64);
const ADMITTED = {
  result: "admitted",
  invitation_id: "inv-1",
  raw_token: RAW,
  delivery_email: "prospect@example.test",
  issued_at: "2026-10-07T12:00:00.000Z",
  expires_at: "2026-10-09T12:00:00.000Z",
};

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc }) }));
const getCurrentPractitionerWithStudio = vi.fn();
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: () => getCurrentPractitionerWithStudio(),
}));
const sessionActor = vi.fn();
vi.mock("@/lib/booking/session-actor", () => ({ sessionActor: () => sessionActor() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.care" }));
const sendWaitlistInvitationEmail = vi.fn();
vi.mock("@/lib/waitlist/delivery/send", () => ({ sendWaitlistInvitationEmail }));
const sendWaitlistInvitationSms = vi.fn();
vi.mock("@/lib/waitlist/delivery/sms", () => ({ sendWaitlistInvitationSms }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: () => Promise.resolve() }));

const { admissionCommandAdapter } = await import("@/lib/waitlist/invite-to-book-adapter");

const invite = () =>
  admissionCommandAdapter.inviteToBook({
    entryId: "11111111-1111-4111-8111-111111111111",
    scope: { serviceId: "svc-1", windowDays: 14, allowedWeekdays: null },
  });

const SESSION_COOKIE_NAME = "sb-test-auth-token";
const SESSION_COOKIE_VALUE = "opaque-session";
const ROUTE = "/waitlist";
type RequestStoreArgs = Parameters<typeof createRequestStoreForRender>;

const opened: Array<{ settle(): Promise<void> }> = [];

/** One authenticated Server Action request, wired as Next wires a real one. */
function openRequest() {
  const response = new EventEmitter();
  const keptAlive: Array<Promise<unknown>> = [];
  const workStore = createWorkStore({
    page: `/(app)${ROUTE}/page`,
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
    { pathname: ROUTE },
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
    requestStore,
    keptAlive,
    run<T>(fn: () => T): T {
      return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
    },
    closeSubscribers: () => response.listenerCount("close"),
    /** The practitioner goes away while the action is still running. */
    async clientGoesAway(): Promise<void> {
      response.emit("close");
      await new Promise((resolve) => setImmediate(resolve));
    },
    async settle(): Promise<void> {
      response.emit("close");
      await Promise.all(keptAlive);
    },
  };
  opened.push(request);
  return request;
}

/** What the rest of the action (revalidate + re-render) does with the request. */
async function readRequest(): Promise<{ session?: string; cookieHeader: string | null }> {
  const jar = await cookies();
  const requestHeaders = await headers();
  return {
    session: jar.get(SESSION_COOKIE_NAME)?.value,
    cookieHeader: requestHeaders.get("cookie"),
  };
}

beforeEach(() => {
  rpc.mockReset();
  getCurrentPractitionerWithStudio.mockReset();
  sessionActor.mockReset();
  sendWaitlistInvitationEmail.mockReset();
  sendWaitlistInvitationSms.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  getCurrentPractitionerWithStudio.mockResolvedValue({
    practitioner: { role: "owner", user_id: "user-1" },
    studio: { id: "studio-1", name: "Willow", timezone: "America/Vancouver", slug: "willow" },
  });
  sessionActor.mockResolvedValue({ studioId: "studio-1", actorUserId: "user-1" });
  rpc.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === "admit_new_client_waitlist_entry"
        ? { data: [ADMITTED], error: null }
        : { data: [{ result: "recorded" }], error: null },
    ),
  );
  sendWaitlistInvitationSms.mockResolvedValue({ state: "accepted" });
});

afterEach(async () => {
  for (const request of opened.splice(0)) await request.settle();
  vi.restoreAllMocks();
});

describe("the invitation text and the Server Action's request phase", () => {
  it("CONTROL: a callback handed to after() makes the action's request unreadable once the client goes away", async () => {
    const request = openRequest();
    request.requestStore.phase = "action";
    await request.run(async () => {
      after(async () => {});
    });
    await request.run(async () => {
      await request.clientGoesAway();
      expect(request.requestStore.phase).toBe("after");
      expect(() => cookies()).toThrow(`Route ${ROUTE} used "cookies" inside "after(...)"`);
    });
  });

  it("the practitioner leaving mid-email leaves the action's request readable, and the text still goes", async () => {
    const request = openRequest();
    request.requestStore.phase = "action";
    let releaseEmail!: () => void;
    sendWaitlistInvitationEmail.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseEmail = () =>
            resolve({ disposition: { delivered: "yes", providerAttempted: true }, log: {} });
        }),
    );

    const pending = request.run(() => invite());
    await vi.waitFor(() => expect(sendWaitlistInvitationEmail).toHaveBeenCalledTimes(1));
    // The email is still sending when the practitioner navigates away.
    await request.run(() => request.clientGoesAway());
    releaseEmail();
    await expect(pending).resolves.toMatchObject({ state: "committed", delivery: "accepted" });

    // inviteToBookAction now revalidates and Next re-renders in the SAME store.
    await request.run(async () => {
      expect(request.requestStore.phase).toBe("action");
      await expect(readRequest()).resolves.toEqual({
        session: SESSION_COOKIE_VALUE,
        cookieHeader: `${SESSION_COOKIE_NAME}=${SESSION_COOKIE_VALUE}`,
      });
    });
    // Nothing waited on the response closing...
    expect(request.closeSubscribers()).toBe(0);
    // ...and the text was kept alive by after() and sent once.
    expect(request.keptAlive).toHaveLength(1);
    await Promise.all(request.keptAlive);
    expect(sendWaitlistInvitationSms).toHaveBeenCalledTimes(1);
    expect(sendWaitlistInvitationSms.mock.calls[0]![0]).toMatchObject({
      invitationId: "inv-1",
      invitationUrl: `https://hone.care/invitation/${RAW}`,
    });
  });
});
