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

/**
 * WHEN a message was logged, relative to the logout's own hard navigation.
 * `before` is an ordinary page; `teardown` is the window that opens when Sign
 * out is activated and closes the moment the navigation settles; `after` is
 * everything from there on, including FACT 6's direct /dashboard probe.
 */
type Phase = "before" | "teardown" | "after";

type ConsoleError = { text: string; url: string; phase: Phase };

type SignOutTraffic = {
  actionPosts: ActionPost[];
  consoleErrors: ConsoleError[];
  consoleWarnings: string[];
  pageErrors: string[];
  /** Advanced by the observer; every console error is stamped with it. */
  phase: Phase;
  /** Whether the logout's hard navigation actually happened. No cause, no exception. */
  logoutNavigated: boolean;
  /** Opens the teardown window, taking the boundary snapshot of in-flight requests. */
  openTeardownWindow: () => void;
  /** Closes it. Nothing started after this is ever owned by the navigation. */
  closeTeardownWindow: () => void;
  /**
   * Requests the logout navigation OWNS: those already in flight when Sign out
   * was activated, plus any started before the navigation settled. Recorded
   * from this harness's own bookkeeping of request/response events — NOT from
   * whether the browser happened to report an abort, which is where four
   * earlier attempts came unstuck. Its membership is deterministic.
   */
  teardownOwned: Set<string>;
  /**
   * Owned requests that turned out NOT to be cancelled: they came back with a
   * response, or failed for a reason of their own. Ownership proves only that
   * a request was running when the navigation began — a 500 or a refused
   * connection on one of them is a real failure and must stay RED.
   */
  settledIndependently: Set<string>;
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

// 3. THE LOGOUT'S OWN HARD NAVIGATION, which this spec causes on purpose.
//
// SIGNOUT-02c gives the in-flight hold to the action's promise, so the form's
// action is a client function — and Next then stops routing the action's
// redirect, making /login a HARD browser navigation. That tears the document
// down, so prefetches still running for the menu's destinations die with it,
// and Chrome makes its HTTPS-First attempt on the fresh document. Neither is
// the application reporting a fault.
//
// THIS IS NOT A MESSAGE-PREFIX FILTER. A rule that forgave
// "Failed to fetch RSC payload for …" by its wording would forgive it before
// the logout, and during FACT 6's direct /dashboard probe afterwards — which
// is exactly how a real defect would ride out of this spec unnoticed.
//
// THE EXCEPTION IS SCOPED BY REQUEST OWNERSHIP. When Sign out is activated the
// observer snapshots every request still in flight; anything started before
// the navigation settles joins them. Those, and only those, are the requests
// the navigation kills, and only a message naming one of them is forgiven.
//
// FOUR EARLIER ATTEMPTS FAILED, and each failed the same way: they asked the
// BROWSER which requests it had aborted. That answer is not deterministic —
// across identical runs the abort set held six of eight cancelled prefetches,
// then a different six, and messages arrived on both sides of every boundary
// tried (the URL change, the load event, the next deliberate request). Failure
// counts across those four scopings were 5, 1, 4 and 3 on unchanged code. The
// variance was the browser's reporting, not the rule.
//
// Ownership is recorded HERE instead, from this harness's own request
// bookkeeping, so membership does not depend on what the browser chose to
// report or when. A forgiven message is still PRINTED in the observation line.
export function isLogoutTeardownNoise(
  e: ConsoleError,
  evidence: {
    logoutNavigated: boolean;
    teardownOwned: ReadonlySet<string>;
    settledIndependently: ReadonlySet<string>;
  },
): boolean {
  // Nothing logged before the logout is ever forgiven — first, because it is
  // the one gate ownership cannot supply on its own: the filter runs once at
  // the end, so a request that failed BEFORE the logout and was later owned by
  // it would otherwise be excused retrospectively.
  if (e.phase === "before") return false;

  // And there must be a cause. A logout that never dispatched tears nothing
  // down, and must not get a quieter console than one that did.
  if (!evidence.logoutNavigated) return false;

  const rsc = /^Failed to fetch RSC payload for (\S+?)\. Falling back/.exec(e.text);
  if (rsc) {
    const named = withoutQuery(rsc[1]!);
    // OWNERSHIP IS NECESSARY BUT NOT SUFFICIENT. It proves the request was
    // running when the navigation began — not that the navigation is what
    // ended it. A prefetch that was in flight at the boundary and then failed
    // on its own account (a 500, a refused connection) would otherwise be
    // forgiven for a regression it was actually reporting.
    return (
      evidence.teardownOwned.has(named) && !evidence.settledIndependently.has(named)
    );
  }

  // Chrome's HTTPS-First upgrade attempt on the document the logout navigated
  // TO. This lane is served over http, so an https:// attribution is by
  // construction the browser and not the app, and it must name the logout's
  // own destination.
  if (!e.text.startsWith("Failed to load resource: net::ERR_SSL_PROTOCOL_ERROR")) {
    return false;
  }
  try {
    const u = new URL(e.url);
    return u.protocol === "https:" && u.pathname === "/login";
  } catch {
    return false;
  }
}

/** origin + path: the identity a request and the message about it share. */
function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function isTelemetryNoise(e: ConsoleError, traffic?: SignOutTraffic): boolean {
  return (
    TELEMETRY_ORIGIN.test(e.url) ||
    TELEMETRY_EMITTER.some((pattern) => pattern.test(e.text)) ||
    (traffic !== undefined && isLogoutTeardownNoise(e, traffic))
  );
}

function render(e: ConsoleError): string {
  // The PHASE is part of the evidence: whether a message is teardown noise or
  // a defect depends on when it was logged relative to the logout's own
  // navigation, and a reader of a failure needs that without re-running.
  return `[${e.phase}] ${e.text} @ ${e.url || "(no origin)"}`;
}

function applicationConsoleErrors(
  errors: ConsoleError[],
  traffic?: SignOutTraffic,
): string[] {
  return errors.filter((e) => !isTelemetryNoise(e, traffic)).map(render);
}

function suppressedTelemetryErrors(
  errors: ConsoleError[],
  traffic?: SignOutTraffic,
): string[] {
  return errors.filter((e) => isTelemetryNoise(e, traffic)).map(render);
}

function recordSignOutTraffic(page: Page): SignOutTraffic {
  // LIVE IN-FLIGHT BOOKKEEPING, private to this recorder. It is the whole
  // basis of the teardown exception: what was already running when the logout
  // was activated, and what started before the navigation settled. Counted,
  // because the same route can legitimately be in flight more than once.
  const inFlight = new Map<string, number>();

  const traffic: SignOutTraffic = {
    actionPosts: [],
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    phase: "before",
    logoutNavigated: false,
    teardownOwned: new Set<string>(),
    settledIndependently: new Set<string>(),
    openTeardownWindow() {
      // THE BOUNDARY SNAPSHOT. Everything in flight at this instant is about
      // to be killed by the navigation the press is starting.
      for (const url of inFlight.keys()) traffic.teardownOwned.add(url);
      traffic.phase = "teardown";
    },
    closeTeardownWindow() {
      traffic.phase = "after";
    },
  };

  const bump = (url: string, by: number) => {
    const key = withoutQuery(url);
    const next = (inFlight.get(key) ?? 0) + by;
    if (next > 0) inFlight.set(key, next);
    else inFlight.delete(key);
  };
  page.on("request", (request) => {
    bump(request.url(), 1);
    // A request that STARTS inside the window is owned by the navigation about
    // to replace the document, exactly as one already running is.
    if (traffic.phase === "teardown") {
      traffic.teardownOwned.add(withoutQuery(request.url()));
    }
  });
  page.on("requestfinished", (request) => bump(request.url(), -1));

  // A REAL ERROR STATUS is the request failing on its own account, and is the
  // server-regression half of what ownership alone cannot see.
  //
  // `requestfinished` deliberately is NOT used for this. A streaming RSC
  // response that the navigation cuts mid-body still reports as finished with
  // status 200, so treating "finished" as "settled independently" excluded the
  // very requests the exception exists for — measured: four real cases went
  // red that way, with their logouts provably perfect.
  page.on("response", (response) => {
    // NOT PHASE-GATED, deliberately. The rule accepts LATE messages about
    // owned requests — a hard navigation keeps reporting after the window
    // shuts — so settlement has to be recorded just as late, or an owned
    // prefetch that 500s a moment after `waitForURL` resolves would leave no
    // record and have its genuine regression forgiven. Ownership is already
    // the bound here: `teardownOwned` only ever gains entries between the
    // activation snapshot and the navigation settling.
    const key = withoutQuery(response.url());
    if (traffic.teardownOwned.has(key) && response.status() >= 400) {
      traffic.settledIndependently.add(key);
    }
  });
  page.on("requestfailed", (request) => {
    bump(request.url(), -1);
    // Same reasoning as the response handler: bounded by ownership, not by
    // the phase Playwright happened to report the failure in.
    if (!traffic.teardownOwned.has(withoutQuery(request.url()))) return;
    const reason = request.failure()?.errorText ?? "";
    // An ABORT is the navigation doing its work. Anything else — a refused
    // connection, a DNS failure, a reset — is the request failing on its own
    // account, and stays RED.
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason)) {
      traffic.settledIndependently.add(withoutQuery(request.url()));
    }
  });

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
        phase: traffic.phase,
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

  // THE WINDOW OPENS HERE, on the press that starts the navigation — and the
  // boundary snapshot is taken at the same instant.
  traffic.openTeardownWindow();
  const activatedVia = await activate(panel);

  // FACT 2, sampled IMMEDIATELY: React flushes a discrete click update
  // synchronously, so the unmount — if any — has already happened by the time
  // the activation call resolves.
  const menuPresentImmediatelyAfterActivation = (await panel.count()) > 0;

  // Bounded, non-throwing: a logout that never dispatched simply never
  // navigates, and that is a measurement, not an error.
  traffic.logoutNavigated = await page
    .waitForURL(/\/login/, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  // AND IT CLOSES THE MOMENT THE NAVIGATION SETTLES. Nothing started after
  // this line is ever owned by it — which is what keeps FACT 6's direct
  // /dashboard probe below judged with no exception at all.
  traffic.closeTeardownWindow();

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
    `teardown-owned: ${JSON.stringify([...o.traffic.teardownOwned])}`,
    `settled independently: ${JSON.stringify([...o.traffic.settledIndependently])}`,
    `application console errors: ${JSON.stringify(
      applicationConsoleErrors(o.traffic.consoleErrors, o.traffic),
    )}`,
    `suppressed third-party telemetry: ${JSON.stringify(
      suppressedTelemetryErrors(o.traffic.consoleErrors, o.traffic),
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
    applicationConsoleErrors(o.traffic.consoleErrors, o.traffic),
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


// ---------------------------------------------------------------------------
// WHAT THE TEARDOWN EXCEPTION FORGIVES, AND WHAT IT MUST NOT.
//
// The exception exists because the logout's hard navigation kills requests
// that were running when it began. It is scoped by OWNERSHIP of those
// requests, never by the wording of a message — a prefix filter would forgive
// an RSC failure before the logout and during FACT 6's direct /dashboard
// probe, which is exactly how a real defect would ride out of this spec.
//
// These cases pin each direction against synthetic records, so they cannot
// drift with timing or with what the browser chose to report on the day.
test.describe("SIGNOUT-01 · the teardown exception is scoped, not a blanket", () => {
  const RSC = (url: string) =>
    `Failed to fetch RSC payload for ${url}. Falling back to browser navigation. TypeError: Failed to fetch`;
  const OWNED = "http://localhost:3111/settings/profile";
  const NOT_OWNED = "http://localhost:3111/dashboard";
  const evidence = {
    logoutNavigated: true,
    teardownOwned: new Set<string>([OWNED]),
    settledIndependently: new Set<string>(),
  };

  test("1. an RSC failure BEFORE the logout is real", () => {
    expect(
      isLogoutTeardownNoise({ text: RSC(OWNED), url: OWNED, phase: "before" }, evidence),
      "a failure before the logout was forgiven",
    ).toBe(false);
  });

  test("2. a teardown-OWNED cancellation during the logout is forgiven", () => {
    expect(
      isLogoutTeardownNoise({ text: RSC(OWNED), url: OWNED, phase: "teardown" }, evidence),
    ).toBe(true);
  });

  test("3. an UNRELATED RSC failure during the flow is real", () => {
    // Same window, same wording, a request the navigation never owned. This is
    // what separates "the navigation killed it" from "it looks alike".
    expect(
      isLogoutTeardownNoise(
        { text: RSC(NOT_OWNED), url: NOT_OWNED, phase: "teardown" },
        evidence,
      ),
      "a message was forgiven for a request the navigation never owned",
    ).toBe(false);
  });

  test("4. an RSC failure on the dashboard probe is real", () => {
    // FACT 6 lives here, and this is the property that protects it: the window
    // is shut before the probe runs, so NOTHING the probe requests can join
    // `teardownOwned`. Its failures are always real.
    expect(
      isLogoutTeardownNoise(
        { text: RSC(NOT_OWNED), url: NOT_OWNED, phase: "after" },
        evidence,
      ),
      "a dashboard-probe failure inherited the teardown exception",
    ).toBe(false);
  });

  test("late reporting of an OWNED request is still the same teardown", () => {
    // A hard navigation keeps reporting on the way down, and some of it lands
    // after the window has shut. That is the same request the navigation
    // killed, arriving late — the ownership record says so, and the clock
    // cannot. Closing the exception on arrival time instead reddened five real
    // cases whose logouts were provably perfect.
    expect(
      isLogoutTeardownNoise({ text: RSC(OWNED), url: OWNED, phase: "after" }, evidence),
    ).toBe(true);
  });

  test("an OWNED request that failed on its own account is real", () => {
    // Codex P2. Ownership proves only that a request was in flight when the
    // navigation began. A prefetch that was running at that boundary and then
    // came back 500, or was refused, is reporting a REGRESSION — and would
    // otherwise be forgiven for it. Anything the browser saw settle by itself
    // is excluded from the exception.
    expect(
      isLogoutTeardownNoise({ text: RSC(OWNED), url: OWNED, phase: "teardown" }, {
        logoutNavigated: true,
        teardownOwned: new Set<string>([OWNED]),
        settledIndependently: new Set<string>([OWNED]),
      }),
      "a request that failed independently was forgiven as teardown",
    ).toBe(false);
  });

  test("the RULE rejects a late-reported independent failure", () => {
    // Half of the property. The other half — that such a failure is actually
    // RECORDED when it arrives late — is driven against the real recorder in
    // the test below, because this one pre-populates the set and so cannot
    // see the recorder at all.
    expect(
      isLogoutTeardownNoise({ text: RSC(OWNED), url: OWNED, phase: "after" }, {
        logoutNavigated: true,
        teardownOwned: new Set<string>([OWNED]),
        settledIndependently: new Set<string>([OWNED]),
      }),
      "a late-reported independent failure was forgiven as teardown",
    ).toBe(false);
  });

  test("the RECORDER captures an owned failure that arrives after the window shuts", async ({
    page,
  }) => {
    // Codex P2, and the vacuity it names is real: every other case here hands
    // `isLogoutTeardownNoise` a set built by hand, so restoring a
    // `phase !== "teardown"` guard to the response/requestfailed handlers
    // would leave them all green while the suppression quietly came back.
    //
    // This one drives `recordSignOutTraffic` itself. A request is started
    // INSIDE the teardown window — so it is owned — and its 500 is delivered
    // only after `closeTeardownWindow()`. If settlement recording is ever
    // phase-gated again, nothing is recorded and this fails.
    await page.goto("/login");
    const traffic = recordSignOutTraffic(page);

    let deliver!: () => void;
    const held = new Promise<void>((resolve) => (deliver = resolve));
    await page.route("**/__late_owned_probe", async (route) => {
      await held;
      await route.fulfill({ status: 500, contentType: "text/plain", body: "boom" });
    });

    const key = new URL("/__late_owned_probe", page.url()).origin + "/__late_owned_probe";

    traffic.openTeardownWindow();
    const started = page.evaluate(() =>
      fetch("/__late_owned_probe").catch(() => undefined),
    );
    // WAIT FOR THIS REQUEST SPECIFICALLY, not merely for the set to be
    // non-empty. A busier page — CI, with analytics and prefetches still
    // moving — satisfies "size > 0" with something else entirely, and the
    // window then shuts before the probe is registered as owned. That made
    // this test pass locally and fail in CI, which is the wrong way round for
    // a control.
    await expect
      .poll(() => traffic.teardownOwned.has(key), {
        timeout: 15_000,
        message: "the probe request was never recorded as teardown-owned",
      })
      .toBe(true);

    traffic.closeTeardownWindow();
    expect(traffic.phase, "precondition: the window is shut before the 500 lands").toBe(
      "after",
    );

    deliver();
    await started;

    await expect
      .poll(() => traffic.settledIndependently.has(key), {
        timeout: 10_000,
        message:
          "an owned request's 500 was not recorded because it arrived after the window shut",
      })
      .toBe(true);

    // And the rule consumes that record: the failure stays real.
    expect(
      isLogoutTeardownNoise(
        { text: RSC(key), url: key, phase: "after" },
        traffic,
      ),
      "the recorded independent failure was still forgiven",
    ).toBe(false);

    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("5. an ordinary console error is real, wherever it lands", () => {
    for (const phase of ["before", "teardown", "after"] as const) {
      for (const text of [
        "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
        "Uncaught TypeError: cannot read properties of null",
        "Failed to load resource: net::ERR_CONNECTION_REFUSED",
      ]) {
        expect(
          isLogoutTeardownNoise({ text, url: NOT_OWNED, phase }, evidence),
          `forgiven in ${phase}: ${text}`,
        ).toBe(false);
      }
    }
  });

  test("with NO logout navigation, the window forgives nothing", () => {
    // A logout that never dispatched tears nothing down, so it must not get a
    // quieter console than one that did.
    expect(
      isLogoutTeardownNoise({ text: RSC(OWNED), url: OWNED, phase: "teardown" }, {
        logoutNavigated: false,
        teardownOwned: new Set<string>([OWNED]),
        settledIndependently: new Set<string>(),
      }),
      "noise was forgiven for a logout that never navigated",
    ).toBe(false);
  });

  test("the HTTPS-First attempt is forgiven only for the logout's destination", () => {
    const ssl = "Failed to load resource: net::ERR_SSL_PROTOCOL_ERROR";
    expect(
      isLogoutTeardownNoise(
        { text: ssl, url: "https://localhost:3111/login", phase: "teardown" },
        evidence,
      ),
    ).toBe(true);
    expect(
      isLogoutTeardownNoise(
        { text: ssl, url: "https://localhost:3111/dashboard", phase: "teardown" },
        evidence,
      ),
      "forgiven for a document the logout never navigated to",
    ).toBe(false);
    expect(
      isLogoutTeardownNoise(
        { text: ssl, url: "http://localhost:3111/login", phase: "teardown" },
        evidence,
      ),
      "forgiven for a plain http URL this lane really does serve",
    ).toBe(false);
  });
});
