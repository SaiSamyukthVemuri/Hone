import { test, expect } from "@playwright/test";
import { seedE2eStudio, sql } from "./helpers/seed";

// ===========================================================================
// P0 EMERGENCY — NEW-CLIENT WAITLIST, END TO END
// ===========================================================================
//
// The ONE reserved slug this lane enables, named literally in
// e2e/helpers/local-env.ts (NEW_CLIENT_WAITLIST_STUDIO_SLUGS). No other spec
// claims it: every other seeded studio gets a random `e2e-studio-<runId>`
// slug, so the rest of the browser suite runs with the feature OFF. That makes
// the extended run itself the flag-OFF regression proof — if this feature
// could leak into an unlisted studio, the existing public-booking specs go red.
const WAITLIST_SLUG = "e2e-waitlist-p0";
const CANARY_EMAIL = "e2e-waitlist-canary@harness.local";

// WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT.
//
// This lane runs with RESEND_API_KEY="re_dummy_resend_key" (see
// e2e/helpers/local-env.ts), so the provider genuinely refuses. The waitlist
// action is FAIL-CLOSED by design, so the browser lane exercises the REFUSAL
// side of the commit law — which is the side that matters most here: the UI
// must never claim someone joined a waitlist nobody received, and nothing may
// be written on the way there.
//
// The provider-ACCEPTED path (success UI) is proven in the unit lane, in
// tests/app/book/new-client-waitlist-action.test.ts. Deliberately not here:
// the only way to make this lane report success would be to give the action a
// code path that can succeed WITHOUT a real send, and such a path could also
// fire in production. The fail-closed guarantee is worth more.
//
// Same split, same reason, as e2e/practitioner-assisted-intake.spec.ts.

async function seedWaitlistStudio() {
  const seed = await seedE2eStudio();
  // The reserved slug is a SINGLETON — `studios_slug_unique` (migration 0010)
  // allows exactly one holder. Release it from any earlier holder before
  // claiming it, so the second scenario in this file (and a re-run against a
  // database that was not freshly reset) cannot trip the constraint.
  await sql(
    `update public.studios set slug = 'e2e-waitlist-released-' || id where slug = $1`,
    [WAITLIST_SLUG],
  );
  await sql(`update public.studios set slug = $2 where id = $1`, [seed.studioId, WAITLIST_SLUG]);
  return { ...seed, slug: WAITLIST_SLUG };
}

async function countsFor(studioId: string) {
  const [clients] = await sql<{ n: string }>(
    `select count(*)::text as n from public.clients where studio_id = $1`, [studioId],
  );
  const [appointments] = await sql<{ n: string }>(
    `select count(*)::text as n from public.appointments where studio_id = $1`, [studioId],
  );
  const [marketing] = await sql<{ n: string }>(
    `select count(*)::text as n from public.waitlist where lower(email) = lower($1)`, [CANARY_EMAIL],
  );
  return {
    clients: Number(clients.n),
    appointments: Number(appointments.n),
    marketingWaitlist: Number(marketing.n),
  };
}

test.describe("new client at a waitlisted studio", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true });

  test("sees the waitlist immediately, submits it, and nothing is written", async ({ page }) => {
    const seed = await seedWaitlistStudio();
    const before = await countsFor(seed.studioId);
    expect(before.clients).toBe(0);
    expect(before.appointments).toBe(0);

    await page.goto(`/book/${WAITLIST_SLUG}`);
    await expect(page.getByText(seed.studioName).first()).toBeVisible();

    // --- the waitlist appears the MOMENT they identify as a new client:
    //     no service, no date, no slot list, and no slot lookup in between.
    await page.getByRole("button", { name: /new client/i }).click();
    await expect(
      page.getByRole("heading", { name: /join the new-client waitlist/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.locator('input[type="date"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^book appointment$/i })).toHaveCount(0);

    // --- the studio has NOT stopped booking: the escape back is right there.
    await expect(
      page.getByRole("button", { name: /already a client\? continue booking\./i }),
    ).toBeVisible();
    await expect(page.getByText(/fully booked|no appointments available/i)).toHaveCount(0);

    // --- 390px: nothing overflows horizontally.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the waitlist form must not overflow 390px").toBeLessThanOrEqual(0);

    // --- the CTA is a real touch target.
    const cta = page.getByRole("button", { name: /^join waitlist$/i });
    await expect(cta).toBeVisible();
    const box = await cta.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    await page.getByLabel(/^name/i).fill("E2E Waitlist Canary");
    await page.getByLabel(/^email/i).fill(CANARY_EMAIL);
    await page.getByLabel(/^phone/i).fill("+1 555 555 0199");
    await cta.click();

    // --- the outcome is TRUTHFUL. The provider refuses (dummy key), so the
    //     visitor is told so and is NEVER shown the success state. Either
    //     truthful refusal is acceptable; a false success is not.
    await expect(
      page.getByText(/couldn't record your waitlist request|couldn't confirm your waitlist request/i),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByRole("heading", { name: /you're on the waitlist/i }),
    ).toHaveCount(0);

    // --- and nothing was written, on either outcome.
    const after = await countsFor(seed.studioId);
    expect(after.clients, "no client may be created").toBe(0);
    expect(after.appointments, "no appointment may be created").toBe(0);
    expect(
      after.marketingWaitlist,
      "the marketing public.waitlist table must never receive a booking lead",
    ).toBe(0);
  });
});

test("an existing client at a waitlisted studio keeps the normal booking path", async ({ page }) => {
  const seed = await seedWaitlistStudio();

  await page.goto(`/book/${WAITLIST_SLUG}`);
  await page.getByRole("button", { name: /existing client/i }).click();

  // Exactly what it was before this feature: the client-portal hand-off.
  await expect(
    page.getByRole("heading", { name: new RegExp(`already a ${seed.studioName} client`, "i") }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: /sign in to client portal/i })).toBeVisible();

  // No waitlist framing reaches an existing client.
  await expect(
    page.getByRole("heading", { name: /join the new-client waitlist/i }),
  ).toHaveCount(0);
  await expect(page.getByText(/waitlist/i)).toHaveCount(0);
});
