import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { seedE2eStudio, seedE2eDraftElectrolysisSession, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// MPX-03 — THE LOST RESPONSE, AND PRESSING SAVE AGAIN.
//
// SAM'S PROOF ITEM, and the one thing no database test can show: that the
// APPLICATION reuses its retry key. The DB tests prove the command absorbs a
// repeat carrying the same key; they cannot prove the form sends the same key
// twice, and a form that minted a fresh key per attempt would leave every one
// of them passing with the hole wide open.
//
// WHAT THE SHAPE HAS TO BE, and it is the easy thing to get wrong. A lost
// RESPONSE is not a failed request: the save reached the server and committed,
// and only the answer was lost on the way back. `route.abort()` alone would
// stop the request ever arriving - the first attempt would write nothing, the
// retry would create the area for the first time, and the test would pass
// without the claim ever being exercised. So the interception FETCHES the
// request (the server commits) and only then fails the page's fetch, and the
// database is read between the two attempts to prove the area already exists.
//
// WHY IT USED TO BE UNTESTABLE. Until 0223's create claim this path was not
// retryable at all: the submission command's key is unique per (BLOCK, key),
// the initial save creates the block first, so a repeat collided with nothing
// and produced a SECOND treatment area carrying a second copy of the settings.
// The form refused the second attempt and told her to reload the chart. The
// claim is anchored to the SESSION instead, which does pre-exist the area.
//
// GATE-OPEN / GATE-CLOSED PAIR, like its siblings: the synthetic profile is
// the only active one, behind HONE_SYNTHETIC_MACHINE_PROFILE in the NEXT
// SERVER's env. A gate-closed run proves the evidence gate and says in an
// annotation that it is not acceptance evidence for the retry.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 20_000;

const PROFILE_ID = "synthetic:demo-multineedle";
const VERSION = 2;
const CHANNELS = 4;

async function registerMachine(studioId: string, displayName: string) {
  const id = randomUUID();
  await sql(
    `insert into public.studio_machines
       (id, studio_id, machine_profile_id, machine_profile_version, display_name)
     values ($1, $2, $3, $4, $5)`,
    [id, studioId, PROFILE_ID, VERSION, displayName],
  );
  await sql(
    `select public.sync_machine_profile_contract($1, $2, 'galvanic', $3, null, $4::jsonb)`,
    [
      PROFILE_ID,
      VERSION,
      CHANNELS,
      JSON.stringify([
        { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
        { field_key: "duration", native_unit: "s", decimals: 1, quantity: "duration" },
        {
          field_key: "energy_shown",
          native_unit: "device-display",
          decimals: 2,
          quantity: "energy-display",
        },
      ]),
    ],
  );
  return id;
}

/** Everything one session could have accumulated. */
async function totals(sessionId: string) {
  const rows = await sql<{
    blocks: string;
    submissions: string;
    captures: string;
    readings: string;
    claims: string;
  }>(
    `select
       (select count(*)::text from public.session_blocks
         where session_id = $1) as blocks,
       (select count(*)::text from public.treatment_setup_submissions s
         join public.session_blocks b on b.id = s.session_block_id
        where b.session_id = $1) as submissions,
       (select count(*)::text from public.treatment_setup_captures c
         join public.session_blocks b on b.id = c.session_block_id
        where b.session_id = $1) as captures,
       (select count(*)::text from public.treatment_setup_readings g
         join public.session_blocks b on b.id = g.session_block_id
        where b.session_id = $1) as readings,
       (select count(*)::text from public.treatment_area_create_claims cl
         where cl.session_id = $1) as claims`,
    [sessionId],
  );
  const r = rows[0]!;
  return {
    blocks: Number(r.blocks),
    submissions: Number(r.submissions),
    captures: Number(r.captures),
    readings: Number(r.readings),
    claims: Number(r.claims),
  };
}

async function openMachinePanel(page: Page): Promise<boolean> {
  await expect(page.getByTestId("machine-first-trigger")).toBeVisible({ timeout: T });
  await page.getByTestId("machine-first-open").click();
  await expect(page.getByTestId("machine-first-panel")).toBeVisible({ timeout: T });
  const select = page.getByTestId("machine-select");
  const chosen = page.getByTestId("machine-chosen");
  if ((await select.count()) === 0) return (await chosen.count()) > 0;
  return (await select.locator("option").count()) > 1 || (await chosen.count()) > 0;
}

test("a lost response on the initial save is retried, not duplicated @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  await loginAsOwner(page, seed);

  // ONE-SHOT, and armed only around the first Save. A server action POSTs to
  // the current route, so an always-on interception would also swallow the
  // RETRY - and the retry is the half being proved.
  const lost = { arm: false, fired: 0 };
  await page.route(`**/clients/${clientId}/sessions/${sessionId}**`, async (route) => {
    if (route.request().method() !== "POST" || !lost.arm) {
      await route.continue();
      return;
    }
    lost.arm = false;
    lost.fired += 1;
    // THE REQUEST IS PERFORMED, so the server commits, and only the page's
    // fetch fails. This is what makes it a lost ANSWER rather than a failed
    // request - and it is the whole reason this test can exercise the claim.
    try {
      await route.fetch();
    } catch {
      // The upstream call failing would make this an ordinary network error,
      // which is a different case; the assertions below catch it either way
      // because no area would exist.
    }
    await route.abort("failed");
  });

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({
    timeout: T,
  });
  const gateOpen = await openMachinePanel(page);

  if (!gateOpen) {
    await test.step("GATE CLOSED: no real model is offered, and nothing is recorded", async () => {
      await expect(
        page.getByText(/No verified machine is available to select yet/i),
      ).toBeVisible({ timeout: T });
      const sel = page.getByTestId("machine-select");
      const real =
        (await sel.count()) === 0 ? 0 : (await sel.locator("option").count()) - 1;
      expect(real, "a real machine was offered with the gate closed").toBe(0);
      expect(await totals(sessionId)).toEqual({
        blocks: 0,
        submissions: 0,
        captures: 0,
        readings: 0,
        claims: 0,
      });
    });
    test.info().annotations.push({
      type: "gate-closed",
      description:
        "HONE_SYNTHETIC_MACHINE_PROFILE is not in the server env, so the " +
        "lost-response retry did NOT run. This run is not acceptance evidence " +
        "for it.",
    });
    return;
  }

  test.info().annotations.push({
    type: "gate-open",
    description: "The lost-response retry of the initial save executed.",
  });

  await test.step("1: the settings are entered, and the first Save's answer is LOST", async () => {
    await page.getByTestId("machine-select").selectOption(machineId);
    await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
      timeout: T,
    });
    await page.getByTestId("reading-current").fill("120");
    await page.getByTestId("reading-duration").fill("300.5");
    await page.getByTestId("reading-energy_shown").fill("1.25");

    lost.arm = true;
    await page.getByTestId("save-treatment-area").click({ timeout: T });

    // SHE IS TOLD, and told the right thing. The message used to say "do NOT
    // save again: reload this chart"; it now says to press Save again, and
    // that instruction is only honest because of the claim.
    await expect(
      page.getByRole("alert").filter({ hasText: /press save again/i }),
    ).toBeVisible({ timeout: T });
    expect(lost.fired, "the interception never fired").toBe(1);
  });

  await test.step("2: the area IS already there — the save committed, the answer did not", async () => {
    // THE ASSERTION THAT MAKES STEP 3 MEAN ANYTHING. If the first attempt had
    // written nothing, the retry would simply be creating the area for the
    // first time and the claim would never be exercised.
    await expect
      .poll(async () => (await totals(sessionId)).blocks, {
        timeout: T,
        message: "the intercepted save never reached the database",
      })
      .toBe(1);
    const t = await totals(sessionId);
    expect(t.submissions, "the settings committed with the area").toBe(1);
    expect(t.readings).toBe(3);
    expect(t.claims, "the save left its receipt").toBe(1);
  });

  await test.step("3: pressing Save again is ABSORBED — one area, not two", async () => {
    // The interception is spent, so this attempt completes normally. It must
    // carry the SAME retry key, which is the only thing the application can
    // get wrong here.
    await page.getByTestId("save-treatment-area").click({ timeout: T });

    // THE FORM CLOSES, exactly as it does on a first successful save: the
    // caller cannot tell an absorbed retry from the original, and should not
    // have to.
    await expect(page.getByTestId("save-treatment-area")).toHaveCount(0, {
      timeout: T,
    });

    expect(
      await totals(sessionId),
      "the retry created a second treatment area",
    ).toEqual({
      blocks: 1,
      submissions: 1,
      captures: 1,
      readings: 3,
      claims: 1,
    });
  });

  await test.step("4: and the one area holds the values she entered, once", async () => {
    const rows = await sql<{ field_key: string; value_numeric: string | null }>(
      `select r.field_key, r.value_numeric::text as value_numeric
         from public.treatment_setup_readings r
         join public.session_blocks b on b.id = r.session_block_id
        where b.session_id = $1
        order by r.field_key`,
      [sessionId],
    );
    expect(rows.map((r) => `${r.field_key}=${r.value_numeric}`)).toEqual([
      "current=120",
      "duration=300.5",
      "energy_shown=1.25",
    ]);
  });
});
