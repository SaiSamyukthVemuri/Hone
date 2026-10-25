import { expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { E2E_APP_ORIGIN } from "./local-env";

// WebKit-only test-browser workaround, shared by the non-required WebKit job
// (webkit-hon-62, webkit-cln-006). Never imported by a Chromium path: every
// caller checks the engine first, so Chromium behaves exactly as before.
//
// WebKit only (#1094, runs 40077309473 and 40078281596): after the http
// /login document, WebKit fetched every relative /_next/static chunk, CSS
// file and font as https://localhost and failed the TLS handshake, so the
// page never hydrated. That response carries both the app CSP's
// upgrade-insecure-requests and Strict-Transport-Security, and bypassCSP did
// not stop it, so the test browser strips both from document responses. The
// app's headers are unchanged everywhere else.
//
// route.fetch() issues the request itself, so only requests that are safe to
// send twice are fetched: GET documents on the app origin outside /auth/.
// The magic-link hops (GoTrue's /auth/v1/verify and the app's /auth/callback)
// carry single-use tokens and are never fetched (run 40083395180). A 3xx
// cannot be fulfilled in WebKit, so it is continued unmodified instead.
//
// A route handler runs only for the FIRST URL of a redirect chain (run
// 40084710495), so the magic link is followed by the context's request API,
// never navigated: its cookies land in the context and no redirect target is
// ever a document.
//
// e2e/availability-hours-editor.spec.ts carries its own copy of the handler;
// tests/ci/ci-config.test.ts pins the two copies byte-identical.
const APP_ORIGIN = new URL(E2E_APP_ORIGIN).origin;

async function withoutHttpsUpgrade(route: Route) {
  const request = route.request();
  if (request.resourceType() !== "document" || request.method() !== "GET") return route.fallback();
  const url = new URL(request.url());
  if (url.origin !== APP_ORIGIN || url.pathname.startsWith("/auth/")) return route.fallback();
  const response = await route.fetch({ maxRedirects: 0 });
  if (response.status() >= 300 && response.status() < 400) return route.continue();
  const headers = { ...response.headers() };
  delete headers["strict-transport-security"];
  const csp = headers["content-security-policy"];
  if (csp !== undefined) {
    headers["content-security-policy"] = csp
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d !== "" && d !== "upgrade-insecure-requests")
      .join("; ");
  }
  return route.fulfill({ response, headers });
}

const installed = new WeakSet<BrowserContext>();

/** True when this page runs in WebKit. */
export function isWebKit(page: Page): boolean {
  return page.context().browser()?.browserType().name() === "webkit";
}

/** Registers the header-stripping route once per context. */
export async function installWebkitLocalhostFix(context: BrowserContext): Promise<void> {
  if (installed.has(context)) return;
  installed.add(context);
  await context.route("**/*", withoutHttpsUpgrade);
}

/** Follows a magic link in WebKit without navigating to it, then lands on /dashboard. */
export async function followMagicLinkWebkit(page: Page, link: string): Promise<void> {
  const landed = await page.context().request.get(link);
  expect(new URL(landed.url()).pathname, "the magic link signs in and lands on /dashboard").toBe("/dashboard");
  await page.goto("/dashboard");
}
