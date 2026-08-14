import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

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

async function expectContainedErrorUi(page: Page): Promise<void> {
  await expect(page.getByTestId("route-error-boundary")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByRole("heading", { name: "Something went wrong", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Go to Dashboard" }),
  ).toBeVisible();
}

// The app shell (sticky header + primary nav) is rendered by
// app/(app)/layout.tsx, which sits OUTSIDE app/(app)/error.tsx. Its presence
// alongside the error card is the positive proof that the failure was contained
// at the (app) boundary and did not escape to global-error.tsx, which replaces
// the whole document and would take the header with it.
async function expectContainedInsideAppShell(page: Page): Promise<void> {
  await expect(page.getByRole("link", { name: "Go to Dashboard" })).toBeVisible();
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Clients" }),
  ).toBeVisible();
}

async function expectNoRawErrorDetail(page: Page): Promise<void> {
  const body = await page.locator("body").innerText();
  expect(body).not.toContain(CANARY);
  expect(body).not.toContain(CANARY_CONTEXT);
  expect(body).not.toContain("Failed to load fault fixture");
  expect(body).not.toContain(REACT_ELISION);
  // No stack frames, no module paths, no bundler internals.
  expect(body).not.toMatch(/\bat\s+\w+\s+\(/);
  expect(body).not.toContain(".tsx:");
  expect(body).not.toContain("webpack");
  expect(body).not.toContain("node_modules");
  // A missing reference must produce NO reference line, never a fake one.
  expect(body).not.toContain("undefined");
  expect(body).not.toContain("null");
  expect(body).not.toContain("NaN");
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
    const reference = page.getByTestId("route-error-reference");
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
    await expect(page.getByTestId("route-error-reference")).toHaveCount(0);
    await expect(page.getByText(/Reference:/)).toHaveCount(0);
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

    await page.getByRole("button", { name: "Try again" }).click();

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

    await page.getByRole("link", { name: "Go to Dashboard" }).click();

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

    await page.goto("/clients");

    await expect(page.getByTestId("route-error-boundary")).toHaveCount(0);
    await expect(page.getByText(seed.clientName).first()).toBeVisible({
      timeout: 20_000,
    });
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
    const contained = await page.getByTestId("route-error-boundary").innerText();
    expect(contained).not.toContain(seed.clientName);
    expect(contained).not.toContain(seed.clientEmail);
    expect(contained).not.toContain(seed.studioName);
    expect(contained).not.toContain(seed.ownerEmail);
    expect(contained).not.toContain(seed.studioId);
  });
});
