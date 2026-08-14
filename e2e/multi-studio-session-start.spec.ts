import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedSecondStudioForSameUser,
  seedClientInStudio,
  getOwnerPractitionerIdForStudio,
  getSessionsForClient,
  type E2eSeed,
  type SecondStudio,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// MULTI-STUDIO SESSION START: the 0181 production regression, in a real browser.
//
// THE INCIDENT. A practitioner active in TWO studios opened
// /clients/<id>/sessions/new (HTTP 200) and got HTTP 500 on tapping a modality:
// "Failed to start session: Client not found in this studio." (digest 2140849265).
// 0167's start_session resolved the acting studio with an unordered `limit 1`
// over every active membership, so the page rendered against the SELECTED studio
// while the command ran against whichever row Postgres happened to return.
//
// WHY THE EXISTING SUITE MISSED IT. Every other spec seeds ONE studio, where
// `limit 1` has exactly one candidate and is therefore always right. The fixture
// was structurally incapable of expressing the defect. This spec seeds the shape
// that can.
//
// WHAT THIS DRIVES. The REAL journey, profile → "+ Log session" → modality,
// not a page.goto to the destination. A soft navigation and a form POST to a
// server action are exactly the two hops the incident lived in, and a goto skips
// the first while asserting only a URL would miss a 500 on the second. The
// selected studio is chosen through Hone's REAL mechanism (the multi-membership
// chooser), never by writing a cookie.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let studioB: SecondStudio;
let clientInA: { clientId: string; clientName: string };
let practInA: string;

/** Fail the test on ANY uncaught page error, the class this incident produced. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("response", (res) => {
    if (res.status() >= 500) errors.push(`HTTP ${res.status()} ${new URL(res.url()).pathname}`);
  });
  return errors;
}

/** Pick a studio by NAME through the real multi-membership chooser. */
async function chooseStudio(page: Page, studioName: string): Promise<void> {
  await page.goto("/dashboard");
  // A 2+ membership user with no valid selection is redirected to the chooser.
  await page.waitForURL(/no-access|dashboard/);
  if (page.url().includes("no-access")) {
    await page.getByRole("button", { name: new RegExp(studioName, "i") }).click();
    await page.waitForURL(/dashboard/);
  }
}

test("a two-studio practitioner can start a session in EITHER studio", async ({
  page,
}) => {
  const errors = trackPageErrors(page);

  await test.step("seed the first studio and sign in with the real magic-link flow", async () => {
    seed = await seedE2eStudio();
    clientInA = await seedClientInStudio(seed.studioId, "Client A");
    practInA = await getOwnerPractitionerIdForStudio(seed.studioId);
    // Sign in while the account still has ONE membership, so the magic-link
    // flow lands on the dashboard exactly as it does for every other user.
    await loginAsOwner(page, seed);
  });

  await test.step("the SAME human gains a second active studio membership", async () => {
    // Deliberately AFTER sign-in: this is how the shape arises in reality, an
    // existing practitioner is added to a second studio. From the next request
    // on, a user with 2+ memberships and no valid selection must choose.
    studioB = await seedSecondStudioForSameUser(seed);
    expect(studioB.practitionerId).not.toBe(practInA);
  });

  // -------------------------------------------------------------------------
  // STUDIO B, the side that produced the production 500.
  // -------------------------------------------------------------------------
  await test.step("select Studio B through the real chooser", async () => {
    await chooseStudio(page, studioB.studioName);
  });

  await test.step("profile → + Log session → Electrolysis lands on the chart", async () => {
    await page.goto(`/clients/${studioB.clientId}`);
    await expect(
      page.getByRole("heading", { name: studioB.clientName }),
    ).toBeVisible();

    // SOFT NAVIGATION, not a goto: this is the hop the practitioner takes.
    await page.getByRole("link", { name: "+ Log session" }).click();
    await page.waitForURL(new RegExp(`/clients/${studioB.clientId}/sessions/new`));
    await expect(page.getByRole("heading", { name: "New session" })).toBeVisible();

    // The server action POST. This is where the 500 happened.
    await page.getByRole("button", { name: "Electrolysis" }).click();

    // A CREATED session id, never /sessions/new and never the error screen.
    await page.waitForURL(
      new RegExp(
        `/clients/${studioB.clientId}/sessions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`,
      ),
    );
  });

  await test.step("no 500, no client-side exception screen", async () => {
    await expect(
      page.getByText(/Application error|client-side exception/i),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  await test.step("the session belongs to Studio B and B's practitioner row", async () => {
    const rows = await getSessionsForClient(studioB.clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0].studio_id).toBe(studioB.studioId);
    // The SPECIFIC membership: not "some" row that happened to work.
    expect(rows[0].practitioner_id).toBe(studioB.practitionerId);
    expect(rows[0].modality).toBe("electrolysis");
  });

  // -------------------------------------------------------------------------
  // STUDIO A, the other authorized membership must work too, so the fix is
  // "bind to the selection", not "prefer the other studio".
  // -------------------------------------------------------------------------
  await test.step("switch to Studio A and chart there as well", async () => {
    await page.goto("/no-access?reason=multiple-studios");
    await page
      .getByRole("button", { name: new RegExp(seed.studioName, "i") })
      .click();
    await page.waitForURL(/dashboard/);

    await page.goto(`/clients/${clientInA.clientId}`);
    await page.getByRole("link", { name: "+ Log session" }).click();
    await page.waitForURL(new RegExp(`/clients/${clientInA.clientId}/sessions/new`));
    await page.getByRole("button", { name: "Electrolysis" }).click();
    await page.waitForURL(
      new RegExp(
        `/clients/${clientInA.clientId}/sessions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`,
      ),
    );
  });

  await test.step("the Studio A session belongs to A and A's practitioner row", async () => {
    const rows = await getSessionsForClient(clientInA.clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0].studio_id).toBe(seed.studioId);
    expect(rows[0].practitioner_id).toBe(practInA);
    // Cross-studio drift would show up here as B's studio or B's practitioner.
    expect(rows[0].studio_id).not.toBe(studioB.studioId);
    expect(rows[0].practitioner_id).not.toBe(studioB.practitionerId);
  });

  await test.step("still no 500 and no error screen across the whole journey", async () => {
    await expect(
      page.getByText(/Application error|client-side exception/i),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
