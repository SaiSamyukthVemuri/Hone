import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";

// SIGNOUT-01. An authenticated practitioner pressed "Sign out" and stayed
// signed in.
//
// The old menus rendered the control as
//
//     <form action={signOut}>
//       <button type="submit" onClick={close}>Sign out</button>
//     </form>
//
// inside a panel rendered from local `open` state. React flushes a discrete
// click update synchronously, so `close()` detached the <form> while the click
// event was still propagating — before the submit button's activation
// behaviour ran. The browser then cancelled the submission against a
// disconnected form, React's action interception never fired, and the Server
// Action never dispatched. The menu vanished, so the press LOOKED like it
// worked; the session was still alive.
//
// THE POINT OF THIS SPEC: "the menu closed" and "the address bar says /login"
// are BOTH insufficient. Six facts are measured separately, and the
// load-bearing ones are the two a UI-only proof cannot fake —
//
//   * the Server Action dispatched at all (observed on the wire), and
//   * the Supabase session rows are GONE from auth.sessions /
//     auth.refresh_tokens (observed in the database).
//
// Both surfaces are covered because both carried the same defect: the desktop
// AccountMenu and the phone-width MobileMenu.

const APP_SHELL_NAV = "Open account menu";

type ActionPost = { url: string; via: string; actionId: string };

type ConsoleError = { text: string; url: string };

type SignOutTraffic = {
  actionPosts: ActionPost[];
  consoleErrors: ConsoleError[];
  consoleWarnings: string[];
  pageErrors: string[];
};

// Console noise this LOCAL lane emits no matter what the app does. It arrives
// in two shapes, so it is suppressed by two different mechanisms — and NEVER by
// a loose substring, which could swallow a genuine application error whose
// message merely mentioned one of these names.
//
//  1. RESOURCE failures. The Vercel analytics scripts exist only on a Vercel
//     deployment, and PostHog is deliberately tokenless here, so their requests
//     404/429. The browser attributes these to the FAILING URL, so they are
//     suppressed by ORIGIN — a property the application cannot accidentally
//     acquire.
//
//  2. Messages logged BY a third-party bundle running inside the page. These
//     carry the app's own URL, so there is no origin to attribute them by.
//     Each is pinned as an ANCHORED, emitter-specific pattern: a message must
//     BEGIN with the third party's own prefix to be suppressed.
//
// And the suppressed messages are PRINTED in the observation line either way,
// so nothing this filter drops can hide from the evidence.
const TELEMETRY_ORIGIN = /\/_vercel\/|\/ingest(\/|$|\?)|posthog\.com/i;

const TELEMETRY_EMITTER = [
  // posthog-js logs this from the application bundle when no token is set.
  /^\[PostHog\.js\] /,
  // Chrome attributes a MIME refusal to the document, naming the refused
  // script inside the message; the path is pinned so only a _vercel asset
  // matches.
  /^Refused to execute script from '[^']*\/_vercel\/[^']*'/,
];

// 3. TEARDOWN OF THE LOGOUT'S OWN NAVIGATION, which this spec causes on purpose.
//
// SIGNOUT-02c had to give the in-flight hold to the action's promise, which
// means the form's action is a client function — and Next then stops routing
// the action's redirect, so reaching /login is a HARD browser navigation
// rather than a soft RSC one. That is a real change, recorded in
// app/(app)/signout-flight.ts, and it has a visible consequence here: a hard
// navigation tears the document down, so any prefetch still in flight for the
// menu's destinations fails, and Chrome makes its HTTPS-First attempt on the
// fresh document.
//
// Neither is the application reporting a fault. The logout itself is measured
// separately and completely — the Server Action dispatched, auth.sessions and
// auth.refresh_tokens are empty, the cookie is gone, /dashboard is no longer
// served — and every one of those facts was true in the runs that reddened on
// this assertion alone.
//
// Both patterns are ANCHORED and narrow, in keeping with the rule above: a
// message must BEGIN with the browser's own prefix, and the SSL one must also
// be attributed to an https:// URL, which this HTTP-only lane never serves. A
// genuine application error cannot acquire either property by accident. And
// like everything else here, they are PRINTED in the observation line.
const NAVIGATION_TEARDOWN = [
  // An RSC prefetch for a menu destination, cancelled by the navigation.
  /^Failed to fetch RSC payload for /,
];

function isNavigationTeardown(e: ConsoleError): boolean {
  if (NAVIGATION_TEARDOWN.some((pattern) => pattern.test(e.text))) return true;
  // Chrome's HTTPS-First upgrade attempt on the freshly loaded document. The
  // lane is served over http, so an https:// attribution is by construction
  // the browser and not the app.
  return (
    e.text.startsWith("Failed to load resource: net::ERR_SSL_PROTOCOL_ERROR") &&
    e.url.startsWith("https://")
  );
}

function isTelemetryNoise(e: ConsoleError): boolean {
  return (
    TELEMETRY_ORIGIN.test(e.url) ||
    TELEMETRY_EMITTER.some((pattern) => pattern.test(e.text)) ||
    isNavigationTeardown(e)
  );
}

function render(e: ConsoleError): string {
  return `${e.text} @ ${e.url || "(no origin)"}`;
}

function applicationConsoleErrors(errors: ConsoleError[]): string[] {
  return errors.filter((e) => !isTelemetryNoise(e)).map(render);
}

function suppressedTelemetryErrors(errors: ConsoleError[]): string[] {
  return errors.filter(isTelemetryNoise).map(render);
}

function recordSignOutTraffic(page: Page): SignOutTraffic {
  const traffic: SignOutTraffic = {
    actionPosts: [],
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
  };

  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const headers = request.headers();
    const header = headers["next-action"];
    if (header) {
      traffic.actionPosts.push({
        url: request.url(),
        via: "next-action header",
        actionId: header,
      });
      return;
    }
    let body = "";
    try {
      body = request.postData() ?? "";
    } catch {
      body = "";
    }
    const match = body.match(/\$ACTION_ID_([0-9a-f]+)/);
    if (match) {
      traffic.actionPosts.push({
        url: request.url(),
        via: "progressive-enhancement form body",
        actionId: match[1]!,
      });
    }
  });

  page.on("console", (message) => {
    const type = message.type();
    if (type === "error") {
      traffic.consoleErrors.push({
        text: message.text(),
        url: message.location()?.url ?? "",
      });
    }
    if (type === "warning") traffic.consoleWarnings.push(message.text());
  });
  page.on("pageerror", (error) => {
    traffic.pageErrors.push(`${error.name}: ${error.message}`);
  });

  return traffic;
}

// FACT 4 instrument, half one: the server's own record of the session.
// `supabase.auth.signOut()` defaults to global scope, so a real logout leaves
// the user with no session row and no live refresh token. A press that only
// closed a menu leaves both behind.
async function authUserId(email: string): Promise<string> {
  const rows = await sql<{ id: string }>(
    `select id::text as id from auth.users where email = $1`,
    [email],
  );
  expect(rows, `exactly one local auth user for ${email}`).toHaveLength(1);
  return rows[0]!.id;
}

async function liveSessionCount(userId: string): Promise<number> {
  const rows = await sql<{ n: string }>(
    `select count(*)::text as n from auth.sessions where user_id = $1::uuid`,
    [userId],
  );
  return Number(rows[0]!.n);
}

async function liveRefreshTokenCount(userId: string): Promise<number> {
  const rows = await sql<{ n: string }>(
    `select count(*)::text as n
       from auth.refresh_tokens
      where user_id = $1 and revoked = false`,
    [userId],
  );
  return Number(rows[0]!.n);
}

// FACT 4 instrument, half two: the browser's own credential. A cleared
// Supabase auth cookie is what stops the NEXT request being authenticated.
async function authCookieNames(page: Page): Promise<string[]> {
  const cookies = await page.context().cookies();
  return cookies
    .filter((c) => /^sb-.*-auth-token/.test(c.name) && c.value !== "")
    .map((c) => c.name)
    .sort();
}

// Reads `read` until `done` or the budget expires, and returns the LAST value
// seen either way — so a failure reports the real number, not a timeout.
async function settle<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  budgetMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

type SignOutObservation = {
  activatedVia: string;
  menuPresentImmediatelyAfterActivation: boolean;
  actionPosts: ActionPost[];
  urlAfter: string;
  sessionsAfter: number;
  refreshTokensAfter: number;
  authCookiesAfter: string[];
  dashboardUrlAfterwards: string;
  shellPresentAfterwards: boolean;
  traffic: SignOutTraffic;
};

// Drives ONE logout and returns every fact separately, so a failure names the
// fact that broke instead of collapsing them into "sign out did not work".
// Nothing here throws on the unhappy path: the bounded waits let a press that
// did nothing be MEASURED rather than time out.
async function observeSignOut(
  page: Page,
  userId: string,
  openMenu: () => Promise<Locator>,
  activate: (panel: Locator) => Promise<string>,
): Promise<SignOutObservation> {
  const traffic = recordSignOutTraffic(page);

  const panel = await openMenu();
  await expect(panel, "the menu panel is open before the press").toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Sign out" }),
    "Sign out is reachable in the open menu",
  ).toBeVisible();

  const activatedVia = await activate(panel);

  // FACT 2, sampled IMMEDIATELY: React flushes a discrete click update
  // synchronously, so the unmount — if any — has already happened by the time
  // the activation call resolves.
  const menuPresentImmediatelyAfterActivation = (await panel.count()) > 0;

  // Bounded, non-throwing: a logout that never dispatched simply never
  // navigates, and that is a measurement, not an error.
  await page.waitForURL(/\/login/, { timeout: 15_000 }).catch(() => {});

  const urlAfter = page.url();
  const sessionsAfter = await settle(
    () => liveSessionCount(userId),
    (n) => n === 0,
  );
  const refreshTokensAfter = await liveRefreshTokenCount(userId);
  const authCookiesAfter = await authCookieNames(page);

  // FACT 6: a DIRECT navigation afterwards, which is the thing the
  // practitioner actually does next.
  await page.goto("/dashboard");
  await page.waitForLoadState("domcontentloaded");
  const dashboardUrlAfterwards = page.url();
  const shellPresentAfterwards =
    (await page.getByRole("button", { name: APP_SHELL_NAV }).count()) > 0 ||
    (await page.getByRole("button", { name: "Open navigation menu" }).count()) >
      0;

  return {
    activatedVia,
    menuPresentImmediatelyAfterActivation,
    actionPosts: traffic.actionPosts,
    urlAfter,
    sessionsAfter,
    refreshTokensAfter,
    authCookiesAfter,
    dashboardUrlAfterwards,
    shellPresentAfterwards,
    traffic,
  };
}

// Every measured fact, rendered into ONE line. It rides on every assertion
// message so a failure reports the WHOLE outcome — dispatched or not, session
// alive or dead, cookie kept or cleared, /dashboard still reachable or not —
// instead of only the first predicate that tripped. That is what makes a red
// run here evidence about the defect rather than evidence about an assertion.
function describeObservation(o: SignOutObservation): string {
  return [
    `activated via ${o.activatedVia}`,
    `menu still mounted immediately after the press: ${o.menuPresentImmediatelyAfterActivation}`,
    `Server Action POSTs: ${o.actionPosts.length} ${JSON.stringify(
      o.actionPosts.map((p) => p.via),
    )}`,
    `auth.sessions rows surviving: ${o.sessionsAfter}`,
    `live auth.refresh_tokens surviving: ${o.refreshTokensAfter}`,
    `auth cookies surviving: ${JSON.stringify(o.authCookiesAfter)}`,
    `url after the press: ${o.urlAfter}`,
    `url after a direct /dashboard navigation: ${o.dashboardUrlAfterwards}`,
    `authenticated shell served afterwards: ${o.shellPresentAfterwards}`,
    `console warnings: ${JSON.stringify(o.traffic.consoleWarnings)}`,
    `application console errors: ${JSON.stringify(
      applicationConsoleErrors(o.traffic.consoleErrors),
    )}`,
    `suppressed third-party telemetry: ${JSON.stringify(
      suppressedTelemetryErrors(o.traffic.consoleErrors),
    )}`,
    `page errors: ${JSON.stringify(o.traffic.pageErrors)}`,
  ].join(" | ");
}

// The facts, asserted in MECHANISM order so the first failure names the real
// defect (nothing dispatched) rather than a downstream symptom of it.
function assertRealLogout(o: SignOutObservation, surface: string) {
  const measured = describeObservation(o);
  const claim = (text: string) => `${surface}: ${text}\n    MEASURED — ${measured}`;

  expect(
    o.actionPosts.length,
    claim("the Sign out Server Action DISPATCHED at all"),
  ).toBeGreaterThan(0);

  expect(
    o.actionPosts.length,
    claim("EXACTLY ONE logout submission, no double submit"),
  ).toBe(1);

  expect(
    o.sessionsAfter,
    claim("every auth.sessions row for this practitioner is gone"),
  ).toBe(0);

  expect(
    o.refreshTokensAfter,
    claim("no live auth.refresh_tokens row survives the logout"),
  ).toBe(0);

  expect(
    o.authCookiesAfter,
    claim("the Supabase auth cookie was cleared from the browser"),
  ).toEqual([]);

  expect(o.urlAfter, claim("the practitioner arrived at /login")).toMatch(
    /\/login/,
  );

  expect(
    o.dashboardUrlAfterwards,
    claim("a direct /dashboard navigation afterwards is refused"),
  ).toMatch(/\/login/);

  expect(
    o.shellPresentAfterwards,
    claim("no authenticated shell is served afterwards"),
  ).toBe(false);

  expect(
    o.traffic.pageErrors,
    claim("ordinary logout raises no runtime error"),
  ).toEqual([]);

  expect(
    applicationConsoleErrors(o.traffic.consoleErrors),
    claim("ordinary logout logs no console error from the application"),
  ).toEqual([]);
}

let seed: E2eSeed;
let ownerUserId: string;

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  ownerUserId = await authUserId(seed.ownerEmail);
});

async function loginFresh(page: Page): Promise<void> {
  await loginAsOwner(page, seed);
  expect(
    await liveSessionCount(ownerUserId),
    "precondition: the practitioner holds a live session before signing out",
  ).toBeGreaterThan(0);
  expect(
    await authCookieNames(page),
    "precondition: the browser holds a Supabase auth cookie",
  ).not.toEqual([]);
}

test.describe("SIGNOUT-01 · desktop AccountMenu", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  async function openAccountMenu(page: Page): Promise<Locator> {
    await page.getByRole("button", { name: APP_SHELL_NAV }).click();
    return page.getByRole("navigation", { name: "Account menu" });
  }

  test("pressing Sign out destroys the session, not just the menu", async ({
    page,
  }) => {
    await loginFresh(page);
    const observation = await observeSignOut(
      page,
      ownerUserId,
      () => openAccountMenu(page),
      async (panel) => {
        await panel.getByRole("button", { name: "Sign out" }).click();
        return "pointer";
      },
    );
    assertRealLogout(observation, "desktop AccountMenu");
  });

  test("keyboard activation signs out too", async ({ page }) => {
    await loginFresh(page);
    const observation = await observeSignOut(
      page,
      ownerUserId,
      () => openAccountMenu(page),
      async (panel) => {
        const button = panel.getByRole("button", { name: "Sign out" });
        await button.focus();
        await button.press("Enter");
        return "keyboard (Enter)";
      },
    );
    assertRealLogout(observation, "desktop AccountMenu (keyboard)");
  });

  test("ordinary account links still navigate and still close the menu", async ({
    page,
  }) => {
    await loginFresh(page);
    const panel = await openAccountMenu(page);
    await expect(panel).toBeVisible();
    await panel.getByRole("link", { name: "Settings" }).click();
    await page.waitForURL(/\/settings\/profile/, { timeout: 20_000 });
    await expect(panel, "the menu closed on an ordinary link").toHaveCount(0);

    // Escape and outside-click dismissal are untouched.
    const reopened = await openAccountMenu(page);
    await expect(reopened).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reopened, "Escape still dismisses").toHaveCount(0);

    const reopenedAgain = await openAccountMenu(page);
    await expect(reopenedAgain).toBeVisible();
    await page.mouse.click(5, 400);
    await expect(reopenedAgain, "an outside click still dismisses").toHaveCount(
      0,
    );
  });
});

test.describe("SIGNOUT-01 · phone-width MobileMenu", () => {
  // iPhone-12-class emulation, declared explicitly: the devices[] descriptors
  // carry defaultBrowserType webkit, which this chromium-only lane does not
  // install.
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });

  async function openMobileMenu(page: Page): Promise<Locator> {
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    return page.getByRole("navigation", { name: "Mobile navigation" });
  }

  test("tapping Sign out destroys the session, not just the sheet", async ({
    page,
  }) => {
    await loginFresh(page);
    const observation = await observeSignOut(
      page,
      ownerUserId,
      () => openMobileMenu(page),
      async (panel) => {
        await panel.getByRole("button", { name: "Sign out" }).click();
        return "touch";
      },
    );
    assertRealLogout(observation, "mobile MobileMenu");
  });

  test("keyboard activation signs out too", async ({ page }) => {
    await loginFresh(page);
    const observation = await observeSignOut(
      page,
      ownerUserId,
      () => openMobileMenu(page),
      async (panel) => {
        const button = panel.getByRole("button", { name: "Sign out" });
        await button.focus();
        await button.press("Enter");
        return "keyboard (Enter)";
      },
    );
    assertRealLogout(observation, "mobile MobileMenu (keyboard)");
  });

  test("ordinary sheet links still navigate and still close the sheet", async ({
    page,
  }) => {
    await loginFresh(page);
    const panel = await openMobileMenu(page);
    await expect(panel).toBeVisible();
    await panel.getByRole("link", { name: "Records" }).click();
    await page.waitForURL(/\/records/, { timeout: 20_000 });
    await expect(panel, "the sheet closed on an ordinary link").toHaveCount(0);

    const reopened = await openMobileMenu(page);
    await expect(reopened).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reopened, "Escape still dismisses").toHaveCount(0);

    const reopenedAgain = await openMobileMenu(page);
    await expect(reopenedAgain).toBeVisible();
    await page.mouse.click(5, 700);
    await expect(reopenedAgain, "an outside tap still dismisses").toHaveCount(0);
  });
});

test.describe("SIGNOUT-01 · after logout", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("refresh and back navigation do not resurrect the session", async ({
    page,
  }) => {
    await loginFresh(page);
    const observation = await observeSignOut(
      page,
      ownerUserId,
      async () => {
        await page.getByRole("button", { name: APP_SHELL_NAV }).click();
        return page.getByRole("navigation", { name: "Account menu" });
      },
      async (panel) => {
        await panel.getByRole("button", { name: "Sign out" }).click();
        return "pointer";
      },
    );
    assertRealLogout(observation, "desktop AccountMenu (post-logout nav)");

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    expect(page.url(), "a refresh stays unauthenticated").toMatch(/\/login/);

    await page.goBack();
    await page.waitForLoadState("domcontentloaded");
    expect(
      page.url(),
      "going back does not restore an authenticated route",
    ).toMatch(/\/login/);
    expect(
      await page.getByRole("button", { name: APP_SHELL_NAV }).count(),
      "no authenticated shell after going back",
    ).toBe(0);
    expect(
      await liveSessionCount(ownerUserId),
      "no session was resurrected",
    ).toBe(0);
  });

  test("an already-unauthenticated visitor is still routed to /login", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    await page.goto("/settings/profile");
    await page.waitForURL(/\/login/, { timeout: 20_000 });
  });
});
