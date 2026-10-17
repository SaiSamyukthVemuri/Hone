import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { E2E_APP_ORIGIN } from "./helpers/local-env";
import {
  errorEvents,
  eventTexts,
  markSentryEgress,
  readSentryEgress,
  waitForSentryEgress,
  type EgressRecord,
} from "./helpers/sentry-egress";

// REL-001 / REL-014. The authenticated error boundary, proved against REAL
// thrown route errors on the REAL local stack.
//
// Every case below drives app/(app)/e2e-fault/[case], which lives inside the
// genuine authenticated route group: the same middleware, the same
// app/(app)/layout.tsx shell guard, and the same app/(app)/error.tsx boundary
// that every other authenticated page inherits. The route is fail-closed and
// 404s wherever the server-only HONE_E2E_ROUTE_FAULT marker is absent, which is
// every deployed build.
//
// The canary below is the string the fixture throws. It is shaped like the raw
// PostgREST text that real loaders interpolate into their messages
// (`Failed to load clients: ${error.message}`), so asserting its absence is
// asserting that a raw database error cannot reach a practitioner's screen.
const CANARY = "HONE-LEAK-CANARY-9f3c1d";
const CANARY_CONTEXT = 'relation "clients" does not exist';

// React's fixed replacement for a server error message in a production build.
// The boundary must not render this either: it is framework noise, not copy.
const REACT_ELISION = "The specific message is omitted in production builds";

// SENTRY-E2E-NOISE-02. The unmarked-throw case's message
// (E2E_ROUTE_FAULT_UNMARKED_MESSAGE, which a spec cannot import from the
// server-only module; tests/lib/reliability/e2e-route-fault-guard.test.ts holds
// the two equal). It carries no part of the canary.
const UNMARKED = "Failed to load fault fixture: unmarked harness failure";

// The same-origin tunnel the browser SDK posts to, with the query the SDK
// derives from the production DSN (org, project, region).
const SENTRY_TUNNEL = "/monitoring?o=4511758551941120&p=4511758557839360&r=us";

// THE PREFLIGHT, AND WHY IT GATES THE WHOLE FILE. Every test here raises a
// deliberate fault, and a fault raised while the egress guard is NOT armed goes
// straight to the operational Sentry project - which is the defect this lane
// fixes. So before any of them runs, a harmless probe envelope (an empty client
// report) goes through the real tunnel, and the file proceeds only if the
// guard recorded it. If the guard is ever disarmed, this fails and nothing
// below raises anything; the most that can leak is the empty report.
test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: E2E_APP_ORIGIN });
  try {
    const probe = randomUUID();
    const since = markSentryEgress();
    const envelope = [
      JSON.stringify({ sent_at: new Date().toISOString() }),
      JSON.stringify({ type: "client_report" }),
      JSON.stringify({ timestamp: Date.now() / 1000, discarded_events: [] }),
    ].join("\n");
    const res = await api.post(`${SENTRY_TUNNEL}&hone_probe=${probe}`, {
      data: envelope,
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
    expect(res.status(), "the /monitoring tunnel must answer").toBe(200);
    await waitForSentryEgress(
      (records) => records.find((r) => r.kind === "envelope" && r.path?.includes(probe)),
      { since, timeoutMs: 15_000 },
    );
  } finally {
    await api.dispose();
  }
});

// A browser request straight to sentry.io would bypass the tunnel, and with it
// the guard. The SDK is configured never to do that and the CSP forbids it; this
// makes it a failure rather than an assumption, for every test in the file.
const directSentryRequests: string[] = [];
test.beforeEach(async ({ context }) => {
  directSentryRequests.length = 0;
  await context.route(/^https?:\/\/([^/]+\.)?sentry\.io(\/|$)/i, (route) => {
    directSentryRequests.push(route.request().url());
    return route.abort();
  });
});
test.afterEach(() => {
  expect(directSentryRequests, "the browser contacted sentry.io directly").toEqual([]);
});

function serverEventsCarrying(records: EgressRecord[], text: string) {
  return errorEvents(records).filter(
    (e) => e.item.platform === "node" && eventTexts(e.item).some((t) => t.includes(text)),
  );
}

// Everything the boundary itself owns is addressed THROUGH its testid. The app
// shell also links to /dashboard (the "Hone" wordmark carries
// aria-label="Go to Dashboard"), so an unscoped role query matches two elements
// and is ambiguous by construction.
function boundary(page: Page) {
  return page.getByTestId("route-error-boundary");
}

async function expectContainedErrorUi(page: Page): Promise<void> {
  await expect(boundary(page)).toBeVisible({ timeout: 20_000 });
  await expect(
    boundary(page).getByRole("heading", {
      name: "Something went wrong",
      level: 1,
    }),
  ).toBeVisible();
  await expect(
    boundary(page).getByRole("button", { name: "Try again" }),
  ).toBeVisible();
  await expect(
    boundary(page).getByRole("link", { name: "Go to Dashboard" }),
  ).toBeVisible();
}

// The app shell (sticky header + primary nav) is rendered by
// app/(app)/layout.tsx, which sits OUTSIDE app/(app)/error.tsx. Its presence
// alongside the error card is the positive proof that the failure was contained
// at the (app) boundary and did not escape to global-error.tsx, which replaces
// the whole document and would take the header with it.
async function expectContainedInsideAppShell(page: Page): Promise<void> {
  await expect(page.getByLabel("Go to Dashboard")).toBeVisible();
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Clients" }),
  ).toBeVisible();
}

async function expectNoRawErrorDetail(page: Page): Promise<void> {
  // Scope 1: the WHOLE document. Nothing anywhere on the page may carry the
  // thrown text, a stack frame, or a bundler path.
  const body = await page.locator("body").innerText();
  expect(body).not.toContain(CANARY);
  expect(body).not.toContain(CANARY_CONTEXT);
  expect(body).not.toContain("Failed to load fault fixture");
  expect(body).not.toContain(REACT_ELISION);
  expect(body).not.toMatch(/\bat\s+\w+\s+\(/);
  expect(body).not.toContain(".tsx:");
  expect(body).not.toContain("webpack");
  expect(body).not.toContain("node_modules");

  // Scope 2: the boundary's OWN subtree, for the placeholder checks. A missing
  // reference must produce no line at all, never "Reference: undefined". These
  // are deliberately not asserted against the whole document, because the
  // surrounding app shell is not what this boundary controls.
  const contained = await boundary(page).innerText();
  expect(contained).not.toContain("undefined");
  expect(contained).not.toContain("null");
  expect(contained).not.toContain("NaN");
}

test.describe("authenticated route error containment", () => {
  test("a server-side route throw is contained, leaks nothing, and offers a reference", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    await page.goto("/e2e-fault/server-throw");

    await expectContainedErrorUi(page);
    await expectContainedInsideAppShell(page);
    await expectNoRawErrorDetail(page);

    // DIGEST PRESENT. Next always assigns a digest to a server error, so this
    // case must show a reference, and it must be the digest SHAPE (decimal
    // digits, optional @E<code>) rather than anything free-form.
    const reference = boundary(page).getByTestId("route-error-reference");
    await expect(reference).toBeVisible();
    const text = (await reference.innerText()).trim();
    expect(text).toMatch(/^Reference: [0-9]{1,20}(@E[A-Za-z0-9]{1,16})?$/);
  });

  test("a browser-side throw is contained with the real message withheld and NO reference", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    await page.goto("/e2e-fault/client-throw");

    // The fixture renders on the server, then throws after hydration. Wait for
    // the pre-throw marker so the assertions below cannot pass before the throw
    // has had a chance to happen.
    await expect(page.getByTestId("client-fault-arming")).toHaveCount(0, {
      timeout: 20_000,
    });
    await expectContainedErrorUi(page);
    await expectContainedInsideAppShell(page);

    // THE NON-VACUOUS LEAK PROOF. This error was raised in the browser, so the
    // real message really is on the client (unlike a server error, whose text
    // React elides before it crosses). If the boundary rendered error.message,
    // the canary would be here.
    await expectNoRawErrorDetail(page);

    // DIGEST ABSENT. A browser-raised error has no digest, so the entire
    // reference block must be absent rather than rendered empty.
    await expect(
      boundary(page).getByTestId("route-error-reference"),
    ).toHaveCount(0);
    await expect(boundary(page).getByText(/Reference:/)).toHaveCount(0);
  });

  test("Try again recovers the segment once the underlying failure clears", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    // Keyed per visit, so a Playwright retry gets a fresh token and cannot be
    // served the already-recovered state.
    const token = `retry-${seed.runId}-${process.pid}`;
    await page.goto(`/e2e-fault/once?token=${token}`);

    await expectContainedErrorUi(page);

    await boundary(page).getByRole("button", { name: "Try again" }).click();

    // The segment re-renders from the server and the boundary clears.
    await expect(page.getByTestId("fault-fixture-ok")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("route-error-boundary")).toHaveCount(0);
  });

  test("Go to Dashboard leaves the failed area for a working one", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    await page.goto("/e2e-fault/server-throw");
    await expectContainedErrorUi(page);

    await boundary(page).getByRole("link", { name: "Go to Dashboard" }).click();

    await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
    await expect(page.getByTestId("route-error-boundary")).toHaveCount(0);
  });

  // NEGATIVE CONTROL. Same route, same guard, same boundary, no throw. Without
  // this, every assertion above would also pass against a boundary that
  // rendered unconditionally, and the suite would be proving nothing about the
  // THROW being what triggers containment.
  test("the same fault route renders normally when it does not throw", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    await page.goto("/e2e-fault/ok");

    await expect(page.getByTestId("fault-fixture-ok")).toBeVisible();
    await expect(page.getByTestId("route-error-boundary")).toHaveCount(0);
    await expect(page.getByText(/Something went wrong/)).toHaveCount(0);
  });

  test("a normal authenticated route still renders", async ({ page }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    // A REAL page, whose loader is one of the 78 that throw on a Supabase
    // error (getClientsForStudio). Adding the boundary must not change the
    // healthy path.
    await page.goto("/clients");

    await expect(
      page.getByRole("heading", { name: "Clients", level: 1 }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("route-error-boundary")).toHaveCount(0);
  });
});

test.describe("the boundary does not change authorization semantics", () => {
  test("an anonymous visitor is still sent to /login, never to the error UI", async ({
    page,
  }) => {
    // No login. The middleware gate must win before any boundary can render.
    await page.goto("/e2e-fault/server-throw");

    await page.waitForURL(/\/login/, { timeout: 20_000 });
    await expect(page.getByTestId("route-error-boundary")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Sign in to Hone", level: 1 }),
    ).toBeVisible();
  });

  test("redirect() is not converted into an error screen", async ({ page }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    // redirect() throws internally. If the boundary swallowed Next router
    // errors, an auth redirect would become a generic "try again" screen and
    // the user could never be sent to /login or /no-access again.
    await page.goto("/e2e-fault/redirect");

    await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
    await expect(page.getByTestId("route-error-boundary")).toHaveCount(0);
  });

  test("notFound() stays a 404 and is still distinct from an error", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    const response = await page.goto("/e2e-fault/not-found");

    expect(response?.status()).toBe(404);
    await expect(page.getByTestId("route-error-boundary")).toHaveCount(0);
    await expect(page.getByText(/Something went wrong/)).toHaveCount(0);
  });

  test("the contained error screen renders no studio or client data", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    await page.goto("/e2e-fault/server-throw");
    await expectContainedErrorUi(page);

    // The failed CONTENT area must carry nothing from the studio. The shell
    // around it legitimately still shows the practitioner's own chrome, so this
    // is scoped to the boundary's own subtree.
    const contained = await boundary(page).innerText();
    expect(contained).not.toContain(seed.clientName);
    expect(contained).not.toContain(seed.clientEmail);
    expect(contained).not.toContain(seed.studioName);
    expect(contained).not.toContain(seed.ownerEmail);
    expect(contained).not.toContain(seed.studioId);
  });
});

// SENTRY-E2E-NOISE-02. The faults above, observed where they would leave this
// machine. e2e/helpers/sentry-egress-guard.cjs answers every request this
// lane's server makes to *.sentry.io and records it, so these assertions read
// what the REAL server, the REAL Sentry SDKs and the REAL /monitoring tunnel
// would have sent - not a predicate exercised in isolation.
test.describe("deliberate faults never reach the operational Sentry project", () => {
  test("the server drops the marked fault at runtime, and still delivers an unmarked one", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    // POSITIVE CONTROL. A server throw WITHOUT the canary, on the same route,
    // through the same boundary. SENTRY-NOISE-01 must not suppress it, and its
    // arrival is what proves the server SDK really sends from this runtime -
    // without it, the absence asserted below would prove nothing.
    const start = markSentryEgress();
    await page.goto("/e2e-fault/unmarked-throw");
    await expectContainedErrorUi(page);
    const delivered = await waitForSentryEgress(
      (records) => serverEventsCarrying(records, UNMARKED)[0],
      { since: start },
    );
    expect(delivered.item.exceptions?.[0]?.mechanism?.handled).toBe(false);

    // The marked faults: the server throw and the first-render throw of `once`.
    const marked = markSentryEgress();
    await page.goto("/e2e-fault/server-throw");
    await expectContainedErrorUi(page);
    await page.goto(`/e2e-fault/once?token=noise02-${seed.runId}-${process.pid}`);
    await expectContainedErrorUi(page);
    await boundary(page).getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("fault-fixture-ok")).toBeVisible({ timeout: 20_000 });

    // BARRIER. A second unmarked throw, raised after the marked ones. Once it
    // has arrived, the marked events have had every chance to be sent too; the
    // short settle covers asynchronous event processing out of order.
    const barrier = markSentryEgress();
    await page.goto("/e2e-fault/unmarked-throw");
    await expectContainedErrorUi(page);
    await waitForSentryEgress((records) => serverEventsCarrying(records, UNMARKED)[0], {
      since: barrier,
    });
    await page.waitForTimeout(2_000);

    const markedSent = errorEvents(readSentryEgress(marked)).filter((e) =>
      eventTexts(e.item).some((t) => t.includes(CANARY)),
    );
    expect(markedSent).toEqual([]);
  });

  test("a browser-raised fault leaves only through the tunnel, where the guard holds it", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    const start = markSentryEgress();
    await page.goto("/e2e-fault/client-throw");
    await expect(page.getByTestId("client-fault-arming")).toHaveCount(0, {
      timeout: 20_000,
    });
    await expectContainedErrorUi(page);

    // The browser keeps this event BY DESIGN (SENTRY-NOISE-01: deciding in the
    // browser would need a NEXT_PUBLIC_* bypass). Before this lane it reached
    // the operational project through the tunnel; here it is the guard that
    // receives it, from this server's own forwarding of the tunnel request.
    const { record, item } = await waitForSentryEgress(
      (records) =>
        errorEvents(records).find(
          (e) =>
            e.item.platform === "javascript" &&
            eventTexts(e.item).some((t) => t.includes(CANARY)),
        ),
      { since: start },
    );
    expect(record.forwardedHost).toBe(new URL(E2E_APP_ORIGIN).host);
    expect(record.path).toContain("/envelope/");
    expect(item.exceptions?.[0]?.mechanism).toEqual({ type: "generic", handled: true });
  });

  test("redirect() and notFound() raise nothing that would be sent", async ({ page }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    const start = markSentryEgress();
    await page.goto("/e2e-fault/redirect");
    await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
    const response = await page.goto("/e2e-fault/not-found");
    expect(response?.status()).toBe(404);

    // Same barrier as above: an event that IS sent, raised afterwards.
    const barrier = markSentryEgress();
    await page.goto("/e2e-fault/unmarked-throw");
    await expectContainedErrorUi(page);
    await waitForSentryEgress((records) => serverEventsCarrying(records, UNMARKED)[0], {
      since: barrier,
    });
    await page.waitForTimeout(2_000);

    const navigationEvents = errorEvents(readSentryEgress(start)).filter(
      (e) => !eventTexts(e.item).some((t) => t.includes(UNMARKED)),
    );
    expect(navigationEvents).toEqual([]);
  });
});
