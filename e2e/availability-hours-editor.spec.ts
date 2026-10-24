import { test, expect, type Page, type Route } from "@playwright/test";
import { seedE2eStudio, getStudioWeeklyDefaults, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { E2E_APP_ORIGIN } from "./helpers/local-env";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";

// HON-62 — the weekly-hours "Opens"/"Closes" fields on Settings >
// Availability (the onboarding "Configure availability" step lands here) were
// a custom button-and-list picker: no typing, a 256px nested scroller that
// opened at 6:00 AM, and no way to choose a time outside 06:00–22:00. They are
// now native <input type="time">. This spec is the mounted half of the
// regression proof; tests/app/settings/availability-hours-editor.test.ts is
// the unit half.
//
// What this spec cannot prove: on a touch device the native control opens
// the OS wheel picker, which is not in the DOM and which Playwright cannot
// scroll. The touch case below proves the input takes a tap and focus with
// nothing intercepting it; real-device acceptance on iPad Safari is manual.
//
// SAFETY: a fresh synthetic studio on the LOCAL stack, flag OFF.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;

type Row = Awaited<ReturnType<typeof getStudioWeeklyDefaults>>[number];

function hours(rows: Row[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const r of rows) {
    if (r.practitioner_id !== null) continue;
    out[r.day_of_week] = r.is_open
      ? `${String(r.open_time).slice(0, 5)}-${String(r.close_time).slice(0, 5)}`
      : "closed";
  }
  return out;
}

async function openDay(page: Page, day: string) {
  await page.getByRole("button", { name: `Edit ${day}` }).click();
  await expect(page.getByLabel(`${day} opens`)).toBeVisible();
}

test.beforeAll(async () => {
  expect(E2E_APP_ORIGIN).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)/);
  seed = await seedE2eStudio();
});

// WebKit only (#1094, runs 40077309473 and 40078281596): after the http
// /login document, WebKit fetched every relative /_next/static chunk, CSS
// file and font as https://localhost and failed the TLS handshake, so the
// page never hydrated. That response carries both the app CSP's
// upgrade-insecure-requests and Strict-Transport-Security, and bypassCSP did
// not stop it, so the test browser strips both from document responses.
// Chromium registers no route at all; the app's headers are unchanged
// everywhere else.
//
// route.fetch() issues the request itself, so only requests that are safe to
// send twice are fetched: GET documents on the app origin outside /auth/.
// The magic-link hops (GoTrue's /auth/v1/verify and the app's /auth/callback)
// carry single-use tokens and are never fetched (run 40083395180). A 3xx
// cannot be fulfilled in WebKit, so it is continued unmodified instead.
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

test.beforeEach(async ({ context, browserName }) => {
  if (browserName !== "webkit") return;
  await context.route("**/*", withoutHttpsUpgrade);
});

// WebKit only (run 40084710495): a route handler runs only for the FIRST URL
// of a redirect chain, so the /dashboard document that /auth/callback's 307
// lands on reached WebKit unstripped, still carrying upgrade-insecure-requests.
// Every localhost load was https from then on, even under the stripped
// /settings/availability document that followed. (The /login page's ~20 http
// responses carrying HSTS upgraded nothing, so HSTS was not the trigger.) So in
// WebKit the magic link is followed by the context's request API: its
// cookies land in the browser context and no redirect target is ever a
// document. Chromium signs in exactly as before.
async function signIn(page: Page, browserName: string) {
  if (browserName !== "webkit") return loginAsOwner(page, seed);
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(seed.ownerEmail);
  const seen = await listMessageIds(seed.ownerEmail);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(seed.ownerEmail, E2E_APP_ORIGIN, { excludeIds: seen });
  const landed = await page.context().request.get(link);
  expect(new URL(landed.url()).pathname, "the magic link signs in and lands on /dashboard").toBe("/dashboard");
}

test("an owner types Monday's hours with the keyboard, saves, and they survive a reload", async ({
  page,
  browserName,
}) => {
  await signIn(page, browserName);
  await page.goto("/settings/availability");
  await openDay(page, "Monday");

  const opens = page.getByLabel("Monday opens");
  const closes = page.getByLabel("Monday closes");
  await expect(opens).toHaveAttribute("type", "time");

  // Keyboard only: focus the field and type into its segments (en-US hh mm
  // AM/PM in both Chromium and WebKit).
  await opens.focus();
  await page.keyboard.type("0830AM");
  await closes.focus();
  await page.keyboard.type("0445PM");
  await expect(opens).toHaveValue("08:30");
  await expect(closes).toHaveValue("16:45");

  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect
    .poll(async () => hours(await getStudioWeeklyDefaults(seed.studioId))[1])
    .toBe("08:30-16:45");

  await page.reload();
  await openDay(page, "Monday");
  await expect(page.getByLabel("Monday opens")).toHaveValue("08:30");
  await expect(page.getByLabel("Monday closes")).toHaveValue("16:45");
});

test("re-saving an existing day without an edit leaves the stored week unchanged", async ({
  page,
  browserName,
}) => {
  await signIn(page, browserName);
  await page.goto("/settings/availability");
  await page.getByRole("button", { name: /Weekdays 10/ }).click();
  await page.getByRole("button", { name: /^Replace$/ }).click();
  await expect
    .poll(async () => hours(await getStudioWeeklyDefaults(seed.studioId))[2])
    .toBe("10:00-18:00");
  const before = hours(await getStudioWeeklyDefaults(seed.studioId));

  await openDay(page, "Tuesday");
  await expect(page.getByLabel("Tuesday opens")).toHaveValue("10:00");
  await expect(page.getByLabel("Tuesday closes")).toHaveValue("18:00");
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.getByLabel("Tuesday opens")).toBeHidden();

  expect(hours(await getStudioWeeklyDefaults(seed.studioId))).toEqual(before);
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 834, height: 1194 } });

  test("a tap reaches the hour field and focuses it; nothing overlays it", async ({ page, browserName }) => {
    await signIn(page, browserName);
    await page.goto("/settings/availability");
    await page.getByRole("button", { name: "Edit Wednesday" }).tap();
    const opens = page.getByLabel("Wednesday opens");
    // tap() fails its actionability check if another element would receive
    // the touch at the field's centre.
    await opens.tap();
    await expect(opens).toBeFocused();
    await expect(opens).toHaveAttribute("type", "time");
  });
});
