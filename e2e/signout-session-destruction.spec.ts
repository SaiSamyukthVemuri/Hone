import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
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
  /**
   * Owned requests the browser EXPLICITLY reported as aborted. This is the
   * only thing that buys forgiveness now: suppression requires positive
   * evidence that the navigation cancelled the request, never the mere
   * absence of evidence that it succeeded.
   */
  cancelledByNavigation: Set<string>;
  /**
   * Paths the navigation owned MORE THAN ONE request for.
   *
   * A console message names a path, not a request, and `_rsc` makes several
   * distinct requests share one. Where that happened, a single abort cannot be
   * attributed to the request the message is about, so nothing on that path is
   * forgiven.
   */
  ambiguousOwnership: Set<string>;
  /** RSC / Next prefetch requests currently outstanding, by origin + path. */
  rscOutstanding: () => string[];
  /** Milliseconds since the last RSC request started or settled. */
  rscIdleMs: () => number;
  /**
   * DOCUMENT navigations this recorder has observed.
   *
   * The discriminator for "was this recorder installed before the page it is
   * judging?". A plain request count is not: a recorder attached after the
   * dashboard loaded still sees its trailing telemetry and prefetches within
   * milliseconds — measured, and it let a late-install mutation pass. A
   * document request happens once, at navigation, so only a recorder that
   * predates it can have seen one.
   */
  documentsSeen: () => number;
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
// `/monitoring` is Sentry's SAME-ORIGIN TUNNEL, not a product route:
// `next.config.ts` sets `tunnelRoute: "/monitoring"`, so browser telemetry is
// rewritten through this app's own origin and its failures are attributed to
// localhost like application traffic. Locally the tunnel answers 429 once the
// lane has emitted enough events, which is the SDK being rate-limited, not the
// application faulting.
//
// It surfaced when the quiescent boundary was introduced: waiting for a still
// network before the press gives the tunnel time to emit one more event, so a
// pre-existing lane artefact started landing inside the teardown phase.
//
// PINNED against `next.config.ts` below, because this is only sound while
// `/monitoring` really is the tunnel — if the route moves, or the app ever
// serves something real there, the pin fails rather than this quietly
// suppressing it.
const SENTRY_TUNNEL_ROUTE = "/monitoring";
const TELEMETRY_ORIGIN = new RegExp(
  `\\/_vercel\\/|\\/ingest(\\/|$|\\?)|posthog\\.com|${SENTRY_TUNNEL_ROUTE}(\\/|$|\\?)`,
  "i",
);

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
    cancelledByNavigation: ReadonlySet<string>;
    ambiguousOwnership: ReadonlySet<string>;
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
    // AN EXPLICIT INDEPENDENT FAILURE ALWAYS WINS. A 500 or a refused
    // connection is the request reporting a regression, whatever else is known
    // about it.
    if (evidence.settledIndependently.has(named)) return false;
    // SUPPRESSION NOW REQUIRES POSITIVE EVIDENCE OF CANCELLATION, and that is
    // the whole redesign.
    //
    // Ownership used to be enough: a URL in flight at the boundary was
    // forgiven unless something proved it had settled by itself. That inverted
    // the burden of proof onto "did this succeed independently?", a question
    // the network layer cannot answer — a completed 200 whose payload is
    // undecodable and a completed 200 discarded mid-teardown are the same
    // request. Four consecutive review findings landed on that one root cause,
    // each a finer heuristic over the same insufficient evidence.
    //
    // The burden is now the other way round: an RSC failure is REAL unless the
    // browser explicitly reported that request aborted. Absence of evidence
    // forgives nothing.
    //
    // WHAT MAKES THAT AFFORDABLE is the quiescent boundary. Abort reporting is
    // measurably non-deterministic — across identical runs the abort set held
    // six of eight cancelled prefetches, then a different six — which is why
    // earlier attempts abandoned it. `awaitRscQuiescence` removes the
    // dependency: the logout is not activated until no RSC request is
    // outstanding, so in an ordinary logout there is nothing to cancel, and
    // the non-determinism has nothing to act on.
    // AND THE EVIDENCE MUST BE ATTRIBUTABLE. A message names a PATH; `_rsc`
    // gives several distinct requests the same one. If the navigation owned
    // more than one request for this path, an abort on one of them says
    // nothing about the other — and the other may be exactly the completed 200
    // with an undecodable payload this rule exists to keep red. Ambiguity is
    // not evidence, so it does not forgive.
    if (evidence.ambiguousOwnership.has(named)) return false;
    return evidence.cancelledByNavigation.has(named);
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

/**
 * Is this the router fetching a payload, rather than any other request?
 *
 * Next marks them two ways and either is sufficient: the `_rsc` cache-busting
 * query parameter, and the `RSC` / `Next-Router-Prefetch` request headers a
 * prefetch carries. Matching on both means a change to one convention cannot
 * silently empty the tracked set — which would make the precondition below
 * pass by seeing nothing at all.
 */
function isRscRequest(request: Request): boolean {
  if (/[?&]_rsc=/.test(request.url())) return true;
  const headers = request.headers();
  return headers["rsc"] === "1" || headers["next-router-prefetch"] === "1";
}

/**
 * THE QUIESCENT BOUNDARY. Blocks until no RSC request is outstanding and none
 * has started or settled for `stableFor`, so the logout is activated against a
 * still network.
 *
 * WHY THE SPEC NEEDS THIS AT ALL. The teardown exception exists because a
 * logout kills prefetches that are still running, and their console noise is
 * not a fault. Four attempts tried to tell that noise apart from a real
 * failure after the fact, each with a finer network heuristic, and each drew a
 * review finding — because the evidence does not exist at that layer: a
 * payload cut mid-stream and a payload that arrived whole but will not decode
 * are indistinguishable from the request's lifecycle alone.
 *
 * Establishing the boundary instead dissolves the question. With nothing in
 * flight there is nothing for the navigation to cancel, so an RSC failure
 * during an ordinary logout is a real failure, and the rule can demand
 * positive cancellation evidence without depending on the browser's
 * non-deterministic abort reporting.
 *
 * NOT A SLEEP, and not a product change. The condition is driven by request
 * events — every start and settle moves `rscIdleMs` — so the wait ends as soon
 * as the traffic the page is genuinely making has stopped. Application
 * prefetching is untouched; this is a precondition of the measurement.
 *
 * FAILS DIAGNOSTICALLY, distinguishing the two reasons it can time out: work
 * still outstanding, or a stream of new requests that keeps resetting the idle
 * window. They call for different answers, so the error says which.
 *
 * HOW STRONG THIS IS, measured rather than assumed. Removing the wait from
 * `observeSignOut` does NOT red the real logout tests: by the time those open
 * the menu and assert Sign out is visible, the menu's own prefetches have
 * already settled, so the boundary they get is quiescent anyway. So this is a
 * GUARANTEE, not the repair of a currently-failing case — it stops the rule
 * depending on that timing holding by luck. The mechanism is pinned by case 7
 * below: blinding `isRscRequest`, or making this function return early, both
 * turn it red.
 */
async function awaitRscQuiescence(
  traffic: SignOutTraffic,
  { timeout = 20_000, stableFor = 750 }: { timeout?: number; stableFor?: number } = {},
): Promise<void> {
  try {
    await expect
      .poll(
        () => traffic.rscOutstanding().length === 0 && traffic.rscIdleMs() >= stableFor,
        { timeout, intervals: [50, 100, 250] },
      )
      .toBe(true);
  } catch {
    const outstanding = traffic.rscOutstanding();
    throw new Error(
      outstanding.length > 0
        ? `RSC traffic never quiesced within ${timeout}ms: ${outstanding.length} request(s) still outstanding — ${outstanding.join(", ")}. The logout boundary was not opened.`
        : `RSC traffic never quiesced within ${timeout}ms: nothing was outstanding, but new RSC requests kept arriving and reset the ${stableFor}ms idle window. The page generates continuous RSC traffic, so a quiescent boundary cannot be established this way.`,
    );
  }
}

function recordSignOutTraffic(page: Page): SignOutTraffic {
  // LIVE IN-FLIGHT BOOKKEEPING, private to this recorder. It is the whole
  // basis of the teardown exception: what was already running when the logout
  // was activated, and what started before the navigation settled. Counted,
  // because the same route can legitimately be in flight more than once.
  const inFlight = new Map<string, number>();

  // RSC / PREFETCH BOOKKEEPING, which is what the quiescent boundary is built
  // on. Tracked separately from `inFlight` because the precondition is about
  // one specific kind of traffic: the router's payload fetches, which are the
  // only requests whose cancellation produces the console noise in question.
  const rscInFlight = new Map<string, number>();
  let rscLastActivityAt = Date.now();
  let documentsSeen = 0;

  const rscBump = (url: string, by: number) => {
    const key = withoutQuery(url);
    const next = (rscInFlight.get(key) ?? 0) + by;
    if (next > 0) rscInFlight.set(key, next);
    else rscInFlight.delete(key);
    // EVENT-DRIVEN: every start and every settle moves this, so a stable-zero
    // window is a real observation rather than a timer someone chose.
    rscLastActivityAt = Date.now();
  };

  const traffic: SignOutTraffic = {
    actionPosts: [],
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    phase: "before",
    logoutNavigated: false,
    teardownOwned: new Set<string>(),
    settledIndependently: new Set<string>(),
    cancelledByNavigation: new Set<string>(),
    ambiguousOwnership: new Set<string>(),
    rscOutstanding: () => [...rscInFlight.keys()],
    rscIdleMs: () => Date.now() - rscLastActivityAt,
    documentsSeen: () => documentsSeen,
    openTeardownWindow() {
      // THE BOUNDARY SNAPSHOT. Everything in flight at this instant is about
      // to be killed by the navigation the press is starting.
      for (const [url, concurrent] of inFlight.entries()) {
        traffic.teardownOwned.add(url);
        // `inFlight` is counted, so one path can already stand for several
        // live requests.
        ownRequest(url, concurrent);
      }
      traffic.phase = "teardown";
    },
    closeTeardownWindow() {
      traffic.phase = "after";
    },
  };

  // How many requests the navigation owned for each path, and the ambiguity
  // that follows from more than one.
  const ownedInstances = new Map<string, number>();
  const ownRequest = (url: string, by = 1) => {
    const key = withoutQuery(url);
    const next = (ownedInstances.get(key) ?? 0) + by;
    ownedInstances.set(key, next);
    if (next > 1) traffic.ambiguousOwnership.add(key);
  };

  const bump = (url: string, by: number) => {
    const key = withoutQuery(url);
    const next = (inFlight.get(key) ?? 0) + by;
    if (next > 0) inFlight.set(key, next);
    else inFlight.delete(key);
  };
  page.on("request", (request) => {
    if (request.resourceType() === "document") documentsSeen += 1;
    bump(request.url(), 1);
    if (isRscRequest(request)) rscBump(request.url(), 1);
    // A request that STARTS inside the window is owned by the navigation about
    // to replace the document, exactly as one already running is.
    if (traffic.phase === "teardown") {
      traffic.teardownOwned.add(withoutQuery(request.url()));
      ownRequest(request.url());
    }
  });
  page.on("requestfinished", (request) => {
    bump(request.url(), -1);
    if (isRscRequest(request)) rscBump(request.url(), -1);
  });

  // A REAL ERROR STATUS is the request failing on its own account.
  //
  // COMPLETION IS DELIBERATELY NOT RECORDED HERE ANY MORE. Treating a finished
  // owned 2xx as "settled independently" was the fourth heuristic over the
  // same insufficient evidence, and it is unsound in both directions: a
  // streaming payload the navigation cuts can still report finished with 200,
  // and a completed 200 can still be undecodable. The rule no longer asks
  // whether a request succeeded on its own — it asks whether the browser
  // explicitly said the navigation cancelled it, and forgives only then.
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
    if (isRscRequest(request)) rscBump(request.url(), -1);
    // Same reasoning as the response handler: bounded by ownership, not by
    // the phase Playwright happened to report the failure in.
    if (!traffic.teardownOwned.has(withoutQuery(request.url()))) return;
    const reason = request.failure()?.errorText ?? "";
    // An ABORT is the navigation doing its work, and is now the ONLY thing
    // that earns forgiveness — recorded positively rather than inferred from
    // the absence of a contrary signal. Anything else — a refused connection,
    // a DNS failure, a reset — is the request failing on its own account, and
    // stays RED.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason)) {
      traffic.cancelledByNavigation.add(withoutQuery(request.url()));
    } else {
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
  traffic: SignOutTraffic,
  openMenu: () => Promise<Locator>,
  activate: (panel: Locator) => Promise<string>,
): Promise<SignOutObservation> {

  // THE RECORDER MUST PREDATE THE NAVIGATION IT JUDGES.
  //
  // Playwright reports events, not a backlog, so a recorder attached after the
  // dashboard loaded cannot see a prefetch already in flight — and the
  // quiescence wait below would then find an empty map, call the network
  // still, and open the logout boundary on top of a live request. Having
  // observed traffic already is the cheap proof that it was installed in time.
  expect(
    traffic.documentsSeen(),
    "the recorder saw no document navigation, so it was installed after the page loaded and an RSC request already in flight is invisible to the quiescence wait",
  ).toBeGreaterThan(0);

  // THE ACTION LOG STARTS HERE, not at the recorder.
  //
  // The recorder is installed before the login so it can see RSC requests
  // already in flight — but the magic-link login is ITSELF a server action, so
  // its POST would otherwise be counted as a logout submission and every
  // "exactly one logout" assertion would read 2. Measured, not guessed: that
  // is what these tests reported the moment the recorder moved earlier.
  //
  // Cleared rather than filtered by URL: every Server Action posts to the page
  // it was invoked from, so the login's POST and the logout's are
  // indistinguishable by address. What separates them is WHEN, and this is
  // that boundary.
  traffic.actionPosts.length = 0;

  const panel = await openMenu();
  await expect(panel, "the menu panel is open before the press").toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Sign out" }),
    "Sign out is reachable in the open menu",
  ).toBeVisible();

  // THE PRECONDITION, before any of it. Opening the menu prefetches its own
  // destinations, so the press would otherwise land while the router is still
  // fetching and every one of those would be cancelled by the navigation.
  // Waiting for a still network is what lets the rule below demand explicit
  // cancellation evidence instead of guessing from a request's lifecycle.
  await awaitRscQuiescence(traffic);
  expect(
    traffic.rscOutstanding(),
    "precondition: no RSC request is outstanding when the logout is activated",
  ).toEqual([]);

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

async function loginFresh(page: Page): Promise<SignOutTraffic> {
  // THE RECORDER GOES ON FIRST, before a single navigation.
  //
  // Installed after the login instead, it cannot see a request that was
  // ALREADY in flight — Playwright reports events, not a backlog — so an RSC
  // prefetch started by the dashboard render would be missing from
  // `rscInFlight`. The quiescence wait would then see an empty map, declare a
  // still network, and open the logout boundary on top of a live prefetch; the
  // cancellation would be missing from the ownership snapshot too, and a
  // healthy logout would fail on the resulting console error.
  const traffic = recordSignOutTraffic(page);
  await loginAsOwner(page, seed);
  expect(
    await liveSessionCount(ownerUserId),
    "precondition: the practitioner holds a live session before signing out",
  ).toBeGreaterThan(0);
  expect(
    await authCookieNames(page),
    "precondition: the browser holds a Supabase auth cookie",
  ).not.toEqual([]);
  return traffic;
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
    const traffic = await loginFresh(page);
    const observation = await observeSignOut(
      page,
      ownerUserId,
      traffic,
      () => openAccountMenu(page),
      async (panel) => {
        await panel.getByRole("button", { name: "Sign out" }).click();
        return "pointer";
      },
    );
    assertRealLogout(observation, "desktop AccountMenu");
  });

  test("keyboard activation signs out too", async ({ page }) => {
    const traffic = await loginFresh(page);
    const observation = await observeSignOut(
      page,
      ownerUserId,
      traffic,
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
    const traffic = await loginFresh(page);
    const observation = await observeSignOut(
      page,
      ownerUserId,
      traffic,
      () => openMobileMenu(page),
      async (panel) => {
        await panel.getByRole("button", { name: "Sign out" }).click();
        return "touch";
      },
    );
    assertRealLogout(observation, "mobile MobileMenu");
  });

  test("keyboard activation signs out too", async ({ page }) => {
    const traffic = await loginFresh(page);
    const observation = await observeSignOut(
      page,
      ownerUserId,
      traffic,
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
    const traffic = await loginFresh(page);
    const observation = await observeSignOut(
      page,
      ownerUserId,
      traffic,
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
// ---------------------------------------------------------------------------
// THE NATIVE SUBMISSION CONTRACT.
//
// READ FROM THE SERVER'S HTML, not from the live DOM, and that distinction is
// the whole test. After hydration React replaces a server action's form
// attribute with `action="javascript:throw new Error('React form unexpectedly
// submitted.')"` — a guard, on a form that is working perfectly. Asserting
// against the hydrated DOM therefore fails on correct code and would have sent
// me chasing a defect that was not there. What a press before hydration
// depends on is what the SERVER sent, so that is what this fetches.
//
// WHAT IT PROVES: the markup the browser receives can be submitted by the
// browser alone — a POST target and the Server Action's own id, which is the
// pair `recordSignOutTraffic`'s "progressive-enhancement form body" path reads.
//
// WHAT IT DOES NOT PROVE, said plainly rather than dressed up: an end-to-end
// logout with scripting disabled. The menu holding the Sign out control is
// opened by a client component, so with JS off a practitioner cannot reach the
// control at all. That is a limitation of the MENU, not of the form, and
// driving a hydrated click would prove neither.
//
// THE REGRESSION IT CATCHES, measured on this branch: giving the form a client
// function as its action removed the endpoint and the action id from the
// server's HTML entirely, so a pre-hydration press dispatched nothing.
test.describe("SIGNOUT-01 · the form the server sends can be submitted without JavaScript", () => {
  for (const shell of [
    { name: "desktop AccountMenu", id: "signout-account" },
    { name: "phone-width MobileMenu", id: "signout-mobile" },
  ] as const) {
    test(`${shell.name}: the served markup carries a POST target and the action id`, async ({
      page,
      context,
    }) => {
      await loginFresh(page);
      await page.goto("/dashboard");

      // The document as the SERVER wrote it. No scripts run against this.
      const response = await context.request.get(
        new URL("/dashboard", page.url()).toString(),
      );
      expect(response.status()).toBe(200);
      const html = await response.text();

      const at = html.indexOf(`id="${shell.id}"`);
      expect(at, `${shell.name}: the sign-out form is in the served HTML`).toBeGreaterThan(
        -1,
      );
      // The form element, from its own `<form` to the closing `>` of the tag,
      // plus what it contains.
      const open = html.lastIndexOf("<form", at);
      const close = html.indexOf("</form>", at);
      expect(close, `${shell.name}: the form is closed`).toBeGreaterThan(open);
      const form = html.slice(open, close);

      // A SUBMITTABLE TARGET. `action=""` is legitimate and means "post to
      // this URL"; a `javascript:` action is what the client-function
      // regression produced, and the browser cannot submit it.
      expect(
        /\bmethod="POST"/i.test(form),
        `${shell.name}: the served form does not POST: ${form.slice(0, 200)}`,
      ).toBe(true);
      expect(
        /action="javascript:/.test(form),
        `${shell.name}: the action is a javascript: URL, so a browser cannot submit it`,
      ).toBe(false);

      // THE ACTION'S OWN ID, which is what tells the server which Server
      // Action a native post is for. Without it the submission arrives with
      // nothing to dispatch.
      expect(
        /name="\$ACTION_ID_[0-9a-f]+"/.test(form),
        `${shell.name}: no $ACTION_ID_ field; a native submission has nothing to dispatch: ${form.slice(0, 240)}`,
      ).toBe(true);
    });
  }

  test("the control in the panel submits that form by id, not one of its own", () => {
    // The form is hoisted to the shell's persistent root so its observer
    // cannot be unmounted with the panel; the control therefore reaches it
    // with `form=`. If the control ever grew its own <form> again, the served
    // markup above would be proved about a form nothing submits.
    const source = readFileSync(
      join(process.cwd(), "app/(app)/SignOutMenuItem.tsx"),
      "utf8",
    );
    // COMMENTS STRIPPED FIRST. That file discusses the `<form>` SIGNOUT-01
    // was about, by name, in a load-bearing comment — matched against raw
    // source the absence assertion below fails on prose rather than on code.
    // Line comments before block comments, so a `//` line containing `/*`
    // cannot leave the block stripper eating real code.
    const leaf = source
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    expect(leaf, "the stripper kept real code").toContain("form={formId}");
    expect(leaf).toContain('type="submit"');
    expect(leaf).not.toMatch(/<form[\s>]/);
  });
});

test.describe("SIGNOUT-01 · the teardown exception is scoped, not a blanket", () => {
  const RSC = (url: string) =>
    `Failed to fetch RSC payload for ${url}. Falling back to browser navigation. TypeError: Failed to fetch`;
  const OWNED = "http://localhost:3111/settings/profile";
  const NOT_OWNED = "http://localhost:3111/dashboard";
  // The OWNED request here is one the browser explicitly reported as aborted —
  // which, under the redesigned rule, is the only thing that earns
  // forgiveness. Ownership alone no longer does.
  const evidence = {
    logoutNavigated: true,
    teardownOwned: new Set<string>([OWNED]),
    settledIndependently: new Set<string>(),
    cancelledByNavigation: new Set<string>([OWNED]),
    ambiguousOwnership: new Set<string>(),
  };

  test("1. an RSC failure BEFORE the logout is real", () => {
    expect(
      isLogoutTeardownNoise({ text: RSC(OWNED), url: OWNED, phase: "before" }, evidence),
      "a failure before the logout was forgiven",
    ).toBe(false);
  });

  test("2. an EXPLICITLY CANCELLED owned request during the logout is forgiven", () => {
    expect(
      isLogoutTeardownNoise({ text: RSC(OWNED), url: OWNED, phase: "teardown" }, evidence),
    ).toBe(true);
  });

  test("OWNERSHIP ALONE NO LONGER FORGIVES ANYTHING", () => {
    // THE REDESIGN, as a single assertion. A request in flight at the boundary
    // and never explicitly cancelled is a REAL failure now — which is exactly
    // the case the old rule forgave and the reason four findings landed on it.
    expect(
      isLogoutTeardownNoise({ text: RSC(OWNED), url: OWNED, phase: "teardown" }, {
        logoutNavigated: true,
        teardownOwned: new Set<string>([OWNED]),
        settledIndependently: new Set<string>(),
        cancelledByNavigation: new Set<string>(),
        ambiguousOwnership: new Set<string>(),
      }),
      "a message was forgiven on ownership alone, with no evidence the navigation cancelled anything",
    ).toBe(false);
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
        // Cancelled AND independently failed: the independent failure wins, or
        // a request that 500s while the page is going down would be excused.
        cancelledByNavigation: new Set<string>([OWNED]),
        ambiguousOwnership: new Set<string>(),
      }),
      "a request that failed independently was forgiven as teardown",
    ).toBe(false);
  });

  test("the RULE (given the record) rejects a late independent failure", () => {
    // SYNTHETIC, and only about the rule. It hands the set in by hand, so it
    // cannot see the recorders at all and must never be read as proof of them.
    // The recorder tests below drive the real listeners — one each — and are
    // what fails if late settlement stops being recorded.
    expect(
      isLogoutTeardownNoise({ text: RSC(OWNED), url: OWNED, phase: "after" }, {
        logoutNavigated: true,
        teardownOwned: new Set<string>([OWNED]),
        settledIndependently: new Set<string>([OWNED]),
        cancelledByNavigation: new Set<string>([OWNED]),
        ambiguousOwnership: new Set<string>(),
      }),
      "a late-reported independent failure was forgiven as teardown",
    ).toBe(false);
  });

  test("the RESPONSE recorder captures an owned 500 that arrives after the window shuts", async ({
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
        // Cancellation evidence present and still not forgiven: no cause, no
        // exception, whatever else is known.
        cancelledByNavigation: new Set<string>([OWNED]),
        ambiguousOwnership: new Set<string>(),
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

  test("the REQUESTFAILED recorder captures an owned non-abort failure that arrives late", async ({
    page,
  }) => {
    // The other listener, proved on its own. The 500 case above exercises the
    // `response` handler; a request that never gets a response at all goes
    // through `requestfailed`, which has its own phase-independence to keep.
    // Re-gating that handler on the phase would leave the 500 test green while
    // this one reds.
    //
    // NON-ABORT is the point of the case. An ERR_ABORTED is the navigation
    // doing its work and must NOT count as an independent settlement; a
    // refused connection is the request failing on its own account and must.
    await page.goto("/login");
    const traffic = recordSignOutTraffic(page);

    let deliver!: () => void;
    const held = new Promise<void>((resolve) => (deliver = resolve));
    await page.route("**/__late_failed_probe", async (route) => {
      await held;
      // Surfaces as net::ERR_CONNECTION_REFUSED — the request's own failure,
      // not an abort.
      await route.abort("connectionrefused");
    });

    const key =
      new URL("/__late_failed_probe", page.url()).origin + "/__late_failed_probe";

    traffic.openTeardownWindow();
    const started = page.evaluate(() =>
      fetch("/__late_failed_probe").catch(() => undefined),
    );
    await expect
      .poll(() => traffic.teardownOwned.has(key), {
        timeout: 15_000,
        message: "the probe request was never recorded as teardown-owned",
      })
      .toBe(true);

    traffic.closeTeardownWindow();
    expect(
      traffic.phase,
      "precondition: the window is shut before the failure lands",
    ).toBe("after");

    deliver();
    await started;

    await expect
      .poll(() => traffic.settledIndependently.has(key), {
        timeout: 15_000,
        message:
          "an owned request's non-abort failure was not recorded because it arrived after the window shut",
      })
      .toBe(true);

    // And the rule consumes that record: the failure stays real.
    //
    // `logoutNavigated` is set by hand because this probe never logs anyone
    // out. WITHOUT it the rule forgives nothing regardless — so the assertion
    // below would pass for the wrong reason, proving the cause-gate rather
    // than the settlement record it is about.
    traffic.logoutNavigated = true;
    expect(
      isLogoutTeardownNoise({ text: RSC(key), url: key, phase: "after" }, traffic),
      "the recorded non-abort failure was still forgiven",
    ).toBe(false);

    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("an ABORTED owned request is NOT recorded as an independent settlement", async ({
    page,
  }) => {
    // The other side of that listener, and the reason it inspects `errorText`
    // instead of treating every failure alike. An abort IS the navigation
    // tearing the document down — the exact thing the exception forgives — so
    // it must not land in `settledIndependently`, or the exception would
    // forgive nothing at all.
    await page.goto("/login");
    const traffic = recordSignOutTraffic(page);

    let deliver!: () => void;
    const held = new Promise<void>((resolve) => (deliver = resolve));
    await page.route("**/__late_aborted_probe", async (route) => {
      await held;
      await route.abort("aborted");
    });

    const key =
      new URL("/__late_aborted_probe", page.url()).origin + "/__late_aborted_probe";

    traffic.openTeardownWindow();
    const started = page.evaluate(() =>
      fetch("/__late_aborted_probe").catch(() => undefined),
    );
    await expect
      .poll(() => traffic.teardownOwned.has(key), { timeout: 15_000 })
      .toBe(true);

    deliver();
    await started;
    // The same chance the case above gets.
    await page.waitForTimeout(500);

    expect(
      traffic.settledIndependently.has(key),
      "an aborted request counted as settling independently, which would make the teardown exception forgive nothing",
    ).toBe(false);
    // AND IT IS RECORDED POSITIVELY. Forgiveness is no longer the default for
    // an owned request, so without this record the abort would read as real.
    expect(
      traffic.cancelledByNavigation.has(key),
      "an explicit abort was not recorded as cancelled by the navigation, so genuine teardown noise would now read as a failure",
    ).toBe(true);
    // So the rule still forgives it — with the cause supplied by hand, since
    // this probe never logs anyone out.
    traffic.logoutNavigated = true;
    expect(
      isLogoutTeardownNoise({ text: RSC(key), url: key, phase: "teardown" }, traffic),
      "an aborted, owned request was not forgiven as teardown",
    ).toBe(true);

    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("a COMPLETED owned 200 whose RSC payload is unusable stays RED", async ({
    page,
  }) => {
    // CASE 6 of the redesign, and the finding that started it.
    //
    // A prefetch can return HTTP 200, complete its transfer normally, and still
    // be unusable: Next logs `Failed to fetch RSC payload for …` when the body
    // is not a payload it can decode. There is no error status and no
    // `requestfailed`, so no amount of lifecycle inspection separates it from a
    // payload the navigation discarded.
    //
    // It no longer has to. The request was never explicitly cancelled, so
    // under the redesigned rule it is REAL by default — no completion
    // heuristic, no status special case. This is the case that made three
    // successive heuristics unsound, and it is now closed by the absence of
    // one.
    await page.goto("/login");
    const traffic = recordSignOutTraffic(page);

    let deliver!: () => void;
    const held = new Promise<void>((resolve) => (deliver = resolve));
    await page.route("**/__late_badrsc_probe", async (route) => {
      await held;
      // 200, a COMPLETE body, and content that is not a decodable RSC payload.
      // This is the shape the finding names: the transport succeeded and the
      // payload is still unusable.
      await route.fulfill({
        status: 200,
        contentType: "text/x-component",
        body: "<!doctype html><p>not a flight payload</p>",
      });
    });

    const key =
      new URL("/__late_badrsc_probe", page.url()).origin + "/__late_badrsc_probe";

    traffic.openTeardownWindow();
    const started = page.evaluate(() =>
      fetch("/__late_badrsc_probe").then(
        (r) => r.text(),
        () => undefined,
      ),
    );
    await expect
      .poll(() => traffic.teardownOwned.has(key), {
        timeout: 15_000,
        message: "the probe request was never recorded as teardown-owned",
      })
      .toBe(true);

    traffic.closeTeardownWindow();
    expect(
      traffic.phase,
      "precondition: the window is shut before the response completes",
    ).toBe("after");

    deliver();
    await started;

    // NOTHING CANCELLED IT, and that is the whole evidence needed.
    expect(
      traffic.cancelledByNavigation.has(key),
      "a request nobody aborted was recorded as cancelled by the navigation",
    ).toBe(false);
    expect(
      traffic.teardownOwned.has(key),
      "precondition: the request IS owned, so this proves ownership does not forgive",
    ).toBe(true);

    // Owned, not cancelled — therefore real.
    traffic.logoutNavigated = true;
    expect(
      isLogoutTeardownNoise({ text: RSC(key), url: key, phase: "after" }, traffic),
      "a completed 200 with an unusable RSC payload was forgiven as logout teardown noise",
    ).toBe(false);

    await page.unrouteAll({ behavior: "ignoreErrors" });
  });


  test("an abort on ONE _rsc request does not forgive another on the same path", async ({
    page,
  }) => {
    // THE IDENTITY COLLISION, driven end to end.
    //
    // A console message names a PATH; `_rsc` gives several distinct requests
    // the same one. So an abort recorded against `/x` could be read as
    // evidence about a DIFFERENT request to `/x` — and since a completed 2xx
    // is deliberately no longer recorded as an independent settlement, the
    // undecodable-payload case would be suppressed by an abort that had
    // nothing to do with it. That is precisely the regression the redesign
    // exists to keep visible.
    //
    // Two owned requests to one path, one aborted and one completed with an
    // unusable payload, must therefore leave the path AMBIGUOUS and forgive
    // nothing on it.
    await page.goto("/login");
    const traffic = recordSignOutTraffic(page);

    let deliverAbort!: () => void;
    let deliverBody!: () => void;
    const abortHeld = new Promise<void>((r) => (deliverAbort = r));
    const bodyHeld = new Promise<void>((r) => (deliverBody = r));

    await page.route("**/__collision_probe*", async (route) => {
      if (route.request().url().includes("_rsc=doomed")) {
        await abortHeld;
        await route.abort("aborted");
        return;
      }
      await bodyHeld;
      await route.fulfill({
        status: 200,
        contentType: "text/x-component",
        body: "<!doctype html><p>not a flight payload</p>",
      });
    });

    const key =
      new URL("/__collision_probe", page.url()).origin + "/__collision_probe";

    traffic.openTeardownWindow();
    const both = page.evaluate(() =>
      Promise.all([
        fetch("/__collision_probe?_rsc=doomed").catch(() => undefined),
        fetch("/__collision_probe?_rsc=intact").then(
          (r) => r.text(),
          () => undefined,
        ),
      ]),
    );

    await expect
      .poll(() => traffic.teardownOwned.has(key), { timeout: 15_000 })
      .toBe(true);

    deliverAbort();
    deliverBody();
    await both;
    await page.waitForTimeout(500);

    // The abort IS recorded — the collision is real, not hypothetical.
    expect(
      traffic.cancelledByNavigation.has(key),
      "precondition: the aborted request was recorded, so without the ambiguity guard it would forgive the other one",
    ).toBe(true);
    // And so is the ambiguity.
    expect(
      traffic.ambiguousOwnership.has(key),
      "two owned requests on one path were not marked ambiguous",
    ).toBe(true);

    // So nothing on that path is forgiven.
    traffic.logoutNavigated = true;
    expect(
      isLogoutTeardownNoise({ text: RSC(key), url: key, phase: "after" }, traffic),
      "an abort on one _rsc request forgave a decoding failure on another request to the same path",
    ).toBe(false);

    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});

test.describe("SIGNOUT-01 · the logout boundary is quiescent by construction", () => {
  test("7. the boundary WAITS for an outstanding RSC request, then proceeds", async ({
    page,
  }) => {
    // THE PRECONDITION ITSELF, proved in both directions — that it blocks
    // while router traffic is outstanding, and that it stops blocking once
    // that traffic settles. A precondition only ever asserted in the passing
    // direction would be satisfied by a function that returns immediately.
    //
    // This is what lets the rule demand explicit cancellation evidence. With
    // nothing outstanding at the press, an ordinary logout cancels nothing, so
    // the browser's non-deterministic abort reporting — six of eight
    // cancelled prefetches on one run, a different six on the next — has
    // nothing to be non-deterministic about.
    await page.goto("/login");
    const traffic = recordSignOutTraffic(page);

    let deliver!: () => void;
    const held = new Promise<void>((resolve) => (deliver = resolve));
    await page.route("**/__rsc_quiescence_probe*", async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: "text/x-component", body: "0:null\n" });
    });

    const key =
      new URL("/__rsc_quiescence_probe", page.url()).origin +
      "/__rsc_quiescence_probe";

    // A request the tracker must recognise as router traffic: it carries the
    // `_rsc` parameter AND the prefetch headers, the two marks Next uses.
    const started = page.evaluate(() =>
      fetch("/__rsc_quiescence_probe?_rsc=probe", {
        headers: { RSC: "1", "Next-Router-Prefetch": "1" },
      }).then(
        (r) => r.text(),
        () => undefined,
      ),
    );

    await expect
      .poll(() => traffic.rscOutstanding().includes(key), {
        timeout: 15_000,
        message: "the RSC probe was never tracked as outstanding",
      })
      .toBe(true);

    // IT BLOCKS. Bounded low so the negative half is cheap, and the diagnostic
    // has to name the outstanding request rather than failing blankly.
    let blocked: Error | null = null;
    await awaitRscQuiescence(traffic, { timeout: 2_000, stableFor: 250 }).catch(
      (e: Error) => {
        blocked = e;
      },
    );
    expect(
      blocked,
      "quiescence was declared while an RSC request was still outstanding — the logout boundary would open mid-prefetch",
    ).not.toBeNull();
    expect(
      String(blocked),
      "the diagnostic does not name the outstanding request",
    ).toContain("__rsc_quiescence_probe");
    expect(
      String(blocked),
      "the diagnostic does not distinguish outstanding work from a resetting idle window",
    ).toContain("still outstanding");

    // AND IT PROCEEDS once the request settles.
    deliver();
    await started;
    await awaitRscQuiescence(traffic, { timeout: 15_000, stableFor: 250 });
    expect(
      traffic.rscOutstanding(),
      "quiescence returned with RSC work still outstanding",
    ).toEqual([]);

    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});
test.describe("SIGNOUT-01 · the telemetry exception names a real tunnel", () => {
  test("the Sentry tunnel route this spec forgives is the one the app configures", () => {
    // The `/monitoring` suppression above is sound ONLY because that path is
    // Sentry's tunnel rather than a product route. Derived from the config
    // rather than assumed: if `tunnelRoute` moves, this fails loudly instead
    // of leaving the spec forgiving a path the application has taken back.
    const config = readFileSync(
      join(process.cwd(), "next.config.ts"),
      "utf8",
    );
    expect(
      config,
      `next.config.ts no longer routes Sentry through ${SENTRY_TUNNEL_ROUTE}, so forgiving that path is no longer justified`,
    ).toContain(`tunnelRoute: "${SENTRY_TUNNEL_ROUTE}"`);
  });
});
