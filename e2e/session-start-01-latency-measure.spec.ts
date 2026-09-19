import { test, expect } from "@playwright/test";

import { seedE2eStudio, seedE2eClient, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// SESSION-START-01 slice 2 — THE MEASUREMENT RIG.
//
// This spec exists to PRODUCE NUMBERS, not to assert behaviour. It drives the
// real journey against the local stack with HONE_PERF_TIMING=1, so the server
// emits one structured perf summary per request to stderr. Those lines are the
// evidence; this file just makes them happen reproducibly.
//
// WHY A SPEC AND NOT A SCRIPT. The journey needs an authenticated practitioner,
// a seeded studio, a client and a linked appointment. All of that already
// exists in e2e/helpers, and reimplementing it in a one-off script would give a
// different data shape than every other proof in the repo — which is precisely
// how before/after comparisons stop being comparable.
//
// TWO SCENARIOS, BECAUSE THE RECON SAYS THEY DIFFER:
//   * WITHOUT a linked appointment — no completion, no postcare;
//   * WITH a linked confirmed past appointment — the ordinary practitioner
//     flow, which is the one that also runs mark-complete AND the postcare
//     provider send before the redirect.
//
// Run:
//   HONE_PERF_TIMING=1 npx playwright test e2e/session-start-01-latency-measure.spec.ts
//
// The summaries land in the Playwright webServer output. Filter for
// `"perf_timing":true`.

const T = 60_000;

// COSTS NOTHING IN CI, ON PURPOSE.
//
// This is a measurement rig, not a behaviour proof: without HONE_PERF_TIMING=1
// the server emits no spans and these three journeys would be pure wall-clock
// for no evidence. Every spec on disk must belong to a browser group, so it
// cannot simply be left unregistered — instead it skips itself unless someone
// is measuring, which keeps it reproducible without charging every PR for it.
test.skip(
  process.env.HONE_PERF_TIMING !== "1",
  "measurement rig: run with HONE_PERF_TIMING=1",
);

// FIRST USEFUL CONTENT, MEASURED RATHER THAN ASSERTED.
//
// The three scenarios below previously anchored on `page.locator("body")`,
// described in the comment as "a real charting affordance". It is not one: the
// body element is visible the instant the document begins parsing, so that wait
// returned before any chart content existed and the rig produced NO
// client-visible number at all — only the server-side region span.
//
// This route has NO Suspense boundary (the slice says so deliberately, and a
// unit guard pins it), so the whole document renders in ONE pass: there is no
// partial paint to race. First useful content is therefore gated on the entire
// server critical path — identity, core, the wave, and the serial tail — and
// any real content anchor measures the same thing. The session heading
// ("<modality> session") is that anchor: it is chart content, not chrome.
//
// Reported from the browser's own Navigation Timing for the CHART document, so
// it is the document's cost and not a Playwright stopwatch spanning the driver
// round trip.
async function recordFirstUsefulContent(page: import("@playwright/test").Page, label: string) {
  const heading = page.getByRole("heading", { name: /session$/i }).first();
  await expect(heading).toBeVisible({ timeout: T });
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!n) return null;
    return {
      request_to_response_end_ms: Math.round(n.responseEnd - n.requestStart),
      ttfb_ms: Math.round(n.responseStart - n.requestStart),
      dom_content_loaded_ms: Math.round(n.domContentLoadedEventEnd - n.startTime),
      dom_interactive_ms: Math.round(n.domInteractive - n.startTime),
    };
  });
  console.log(`[FUC] ${JSON.stringify({ scenario: label, ...(nav ?? {}) })}`);
}

test.describe("SESSION-START-01 latency measurement", () => {
  test("scenario A — start a session with NO linked appointment", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    await loginAsOwner(page, seed);

    await page.goto(`/clients/${clientId}/sessions/new`);
    await page.getByRole("button", { name: /electrolysis/i }).click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}/i, { timeout: T });

    await recordFirstUsefulContent(page, "A");
  });

  test("scenario B — start from a linked confirmed PAST appointment", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);

    // A confirmed appointment that has already ended is the shape that arms
    // BOTH mark-complete and the postcare auto-send, which is the path the
    // recon identified as the slow one.
    // E2eSeed carries no practitioner id; the owner row is looked up the way
    // seedE2eClientWithPreviousAreas already does it.
    const practitionerId = (
      await sql<{ id: string }>(
        `select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`,
        [seed.studioId],
      )
    )[0]?.id;
    expect(practitionerId, "seeded studio must have an owner practitioner").toBeTruthy();

    const rows = await sql<{ id: string }>(
      `insert into public.appointments
         (studio_id, client_id, practitioner_id, service_id, starts_at, ends_at,
          duration_minutes, status)
       values ($1, $2, $3,
               (select id from public.services where studio_id = $1 and active limit 1),
               now() - interval '2 hours', now() - interval '1 hour', 60, 'confirmed')
       returning id`,
      [seed.studioId, clientId, practitionerId],
    );
    const appointmentId = rows[0]?.id;
    expect(appointmentId, "the linked-appointment scenario needs an appointment").toBeTruthy();

    await loginAsOwner(page, seed);
    await page.goto(
      `/clients/${clientId}/sessions/new?appointment_id=${appointmentId}`,
    );
    await page.getByRole("button", { name: /electrolysis/i }).click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}/i, { timeout: T });
    await recordFirstUsefulContent(page, "B");
  });
  test("scenario C — postcare ARMED: auto_on_complete + non-consultation + aftercare", async ({
    page,
  }) => {
    // WHY THIS SCENARIO EXISTS. Scenarios A and B never ran the postcare path
    // at all, and the recon had named it the prime suspect. The gate
    // (shouldAutoSendPostcare) needs FIVE things, and a default seeded studio
    // fails two of them: it is not opted into auto_on_complete, and its
    // services are `consultation`, which the gate skips deliberately because
    // the auto path has no "treatment performed" attestation.
    //
    // So the suspect is NOT on the default path. It is reachable only for a
    // studio that opted in, with a treatment service and aftercare text
    // configured. This scenario builds exactly that studio so the branch is
    // measured rather than assumed.
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);

    const practitionerId = (
      await sql<{ id: string }>(
        `select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`,
        [seed.studioId],
      )
    )[0]?.id;

    // Arm every term of the gate.
    await sql(
      `update public.studios
          set postcare_delivery_mode = 'auto_on_complete',
              postcare_aftercare_text = 'Keep the area clean and dry for 24 hours.'
        where id = $1`,
      [seed.studioId],
    );
    const serviceId = (
      await sql<{ id: string }>(
        `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
         values ($1, 'E2E Electrolysis Treatment', 60, 12000, true, 'electrolysis')
         returning id`,
        [seed.studioId],
      )
    )[0]?.id;
    expect(serviceId, "postcare scenario needs a non-consultation service").toBeTruthy();

    const apptId = (
      await sql<{ id: string }>(
        `insert into public.appointments
           (studio_id, client_id, practitioner_id, service_id, starts_at, ends_at,
            duration_minutes, status)
         values ($1, $2, $3, $4,
                 now() - interval '2 hours', now() - interval '1 hour', 60, 'confirmed')
         returning id`,
        [seed.studioId, clientId, practitionerId, serviceId],
      )
    )[0]?.id;

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/sessions/new?appointment_id=${apptId}`);
    await page.getByRole("button", { name: /electrolysis/i }).click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}/i, { timeout: T });
    await recordFirstUsefulContent(page, "C");

    // NOT ASSERTED: that a provider round-trip time was observed. Without a
    // real Resend key the transport fails fast, so this scenario measures the
    // postcare DB join and the transport ATTEMPT — never real provider
    // latency. That boundary is stated in the handoff rather than papered over.
  });
});
