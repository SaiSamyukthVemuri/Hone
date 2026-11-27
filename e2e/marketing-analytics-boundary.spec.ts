import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { seedE2eStudio, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-124 item 6. PostHog starts only from the marketing surface. The signed-in app, /book, a token route and the portal must
// not even LOAD the posthog-js code, must not request /ingest, and must hold no `ph_*` cookie or storage after load.
//
// Why the check is on the loaded code and not only on storage: the lane builds WITHOUT a PostHog project token, so the SDK never
// initialises here and a storage-only assertion would pass vacuously on the old code too. posthog-js's own bundle carries the
// marker below; on the old code it was in every route's JS, now only marketing pages fetch it (positive control: "/"). When a
// token IS present (a production-like local build), the storage assertions are real as well.
// Run against the old instrumentation-client.ts init, the non-marketing cases here fail on the marker.

const MARKER = "primary_window_exists";

async function observe(page: Page, url: string) {
  const loadedMarker: string[] = [];
  const ingest: string[] = [];
  // A production-like local run may carry a synthetic token: never let a PostHog request leave the machine.
  await page.route(/\/ingest(\/|$)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  page.on("request", (r) => {
    if (/\/ingest(\/|$)/.test(new URL(r.url()).pathname)) ingest.push(r.method());
  });
  page.on("response", async (res) => {
    if (res.request().resourceType() !== "script" || !res.ok()) return;
    try {
      if ((await res.text()).includes(MARKER)) loadedMarker.push(new URL(res.url()).pathname);
    } catch {
      /* body not available (redirect/aborted): not the bundle */
    }
  });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const stored = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => /^ph_|posthog/i.test(k)));
  const cookies = (await page.context().cookies()).map((c) => c.name).filter((n) => /^ph_|posthog/i.test(n));
  return { loadedMarker, ingest, stored, cookies };
}

test.describe("PostHog is marketing-only", () => {
  test("positive control: a marketing page fetches the PostHog code", async ({ page }) => {
    const r = await observe(page, "/");
    expect(r.loadedMarker.length, "the marker probe must find the posthog-js bundle on a marketing page").toBeGreaterThan(0);
  });

  test("/book/<slug> loads no PostHog code and stores nothing", async ({ page }) => {
    const seed = await seedE2eStudio();
    const r = await observe(page, `/book/${seed.slug}`);
    expect(r).toEqual({ loadedMarker: [], ingest: [], stored: [], cookies: [] });
  });

  test("a token route loads no PostHog code and stores nothing", async ({ page }) => {
    const r = await observe(page, "/cancel/syntheticfaketoken0123456789abcdef");
    expect(r).toEqual({ loadedMarker: [], ingest: [], stored: [], cookies: [] });
  });

  test("the signed-in app loads no PostHog code and stores no ph_* entry", async ({ page }) => {
    const seed = await seedE2eStudio();
    const clientId = randomUUID();
    await sql(`insert into public.clients (id, studio_id, name, email) values ($1,$2,'Synthetic Analytics Client','an-${seed.studioId.slice(0, 8)}@harness.local')`, [clientId, seed.studioId]);
    await loginAsOwner(page, seed);
    const r = await observe(page, `/clients/${clientId}`);
    expect(r).toEqual({ loadedMarker: [], ingest: [], stored: [], cookies: [] });
  });

  test("the portal loads no PostHog code and stores no ph_* entry", async ({ page }) => {
    const seed = await seedE2eStudio();
    const clientId = randomUUID();
    await sql(`insert into public.clients (id, studio_id, name, email) values ($1,$2,'Synthetic Portal Client','pt-${seed.studioId.slice(0, 8)}@harness.local')`, [clientId, seed.studioId]);
    const raw = randomBytes(32).toString("base64url");
    await sql(`insert into public.client_portal_sessions (studio_id, client_id, session_token_hash, expires_at) values ($1,$2,$3, now() + interval '7 days')`, [seed.studioId, clientId, createHash("sha256").update(raw, "utf8").digest("hex")]);
    await page.context().addCookies([{ name: "hone_portal_session", value: raw, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
    const r = await observe(page, "/portal");
    expect(r).toEqual({ loadedMarker: [], ingest: [], stored: [], cookies: [] });
  });
});
