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

  await test.step("2b: while the outcome is unknown, the payload is FROZEN", async () => {
    // THE MOUNTED HALF of Codex #860 4296029608. The retry key is held so
    // that pressing Save again is safe, but
    // `create_block_with_initial_setup` binds that key to a digest of the
    // WHOLE payload. An edit before the retry therefore turns a committed
    // first attempt's safe retry into a mismatch refusal - and the way out of
    // a refusal looks like cancel-and-recreate, which duplicates the area.
    //
    // So the controls must be dead, and visibly so.
    await expect(page.getByTestId("setting-draft-frozen")).toBeVisible({
      timeout: T,
    });
    await expect(page.getByTestId("reading-current")).toBeDisabled();
    await expect(page.getByTestId("setting-group-g1-channel-1")).toBeDisabled();

    // AND A CONTROL REACHED ANYWAY CANNOT MOVE THE PAYLOAD. `fill` is refused
    // by Playwright on a disabled input, so this drives React's own change
    // path directly - which is what a stray control wired without `frozen`
    // would do, and exactly what the handler guard exists to stop.
    await page.getByTestId("reading-current").evaluate((el) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "999");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // THE PROOF OF THAT IS IN STEP 4, NOT HERE, and the first spelling got
    // this wrong. It asserted the input had snapped back to "120" — but the
    // handler refusing means NO state change, so React never re-renders and
    // never corrects the DOM node this just vandalised. The node reads 999
    // while the payload holds 120. That is a true description of a React
    // controlled input whose onChange declined, not a payload that moved, and
    // it is unreachable without this escape hatch because the input is
    // disabled.
    //
    // So the claim is made where it is observable: step 4 reads the stored
    // readings back and requires 120 / 300.5 / 1.25 — the values entered
    // BEFORE this forced edit. If the guard had let 999 through, the retry
    // would have carried it and step 4 would fail.
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
    // AND THIS IS WHERE STEP 2b'S CLAIM LANDS. A forced edit to 999 was
    // pushed through React's change path while the save was unresolved; if
    // the handler guard had accepted it, the retry would have carried 999
    // under the held key and this list would not read 120.
    expect(rows.map((r) => `${r.field_key}=${r.value_numeric}`)).toEqual([
      "current=120",
      "duration=300.5",
      "energy_shown=1.25",
    ]);
  });

  await test.step("5: the NEXT VISIT reads that save ONCE, not twice", async () => {
    // GAP 2, which this spec previously left open.
    //
    // It proved the retry was absorbed — one area, the values held once — and
    // then stopped. But the harm an unabsorbed retry does is not visible in
    // the block count: it is that the client's record acquires a second
    // capture indistinguishable from a genuine mid-treatment change, and the
    // NEXT VISIT then offers a "previous treatment" built from a duplicate.
    // Sam's chain names reload/retry as one limb and ends at the same client's
    // next visit, so the retry limb has to reach that read too.
    //
    // THE VISIT IS CREATED THROUGH THE APP, for the same reason as the
    // journey's: `start_session` (0167) is what a practitioner's "new session"
    // actually runs, and a seeded row bypasses it.
    // A NEXT VISIT IS OUTSIDE THE COALESCE WINDOW, and that is why this
    // ages the charted session rather than just asking for a new one.
    //
    // `start_session` (0167) REUSES an open session for the same studio,
    // client, practitioner and modality started within 90 minutes - "the
    // read-then-insert race that could produce two sessions for one visit".
    // That is correct: pressing "new session" twice during one appointment
    // must not split the chart in two. The first spelling of this step
    // asserted the app had created a different session and failed on exactly
    // that rule, which is the product working.
    //
    // So the fixture has to mean what the step says. Moving `started_at` back
    // two hours makes the charted session a PAST visit, which is what "the
    // next visit" presupposes; nothing about the recorded captures changes.
    await sql(
      `update public.sessions
          set started_at = now() - interval '2 hours'
        where id = $1`,
      [sessionId],
    );

    await page.goto(`/clients/${clientId}/sessions/new`);
    await page.locator('[data-modality="electrolysis"]').click({ timeout: T });
    await page.waitForURL(/\/clients\/[^/]+\/sessions\/[0-9a-f-]{36}/, {
      timeout: T,
    });
    const nextVisit = page.url().split("/sessions/")[1]!.split(/[?#]/)[0]!;
    expect(
      nextVisit,
      "the app reused the charted session, so this is not a next visit",
    ).not.toBe(sessionId);

    // EXACTLY ONE CAPTURE EXISTS for the charted session. Asserted here rather
    // than in step 3 because this is the claim that matters clinically: a
    // second capture would be permanent, un-editable, and would read as a
    // setting she changed.
    const caps = await sql<{ n: string }>(
      `select count(*)::text as n
         from public.treatment_setup_captures c
         join public.session_blocks b on b.id = c.session_block_id
        where b.session_id = $1`,
      [sessionId],
    );
    expect(
      caps[0]!.n,
      "the absorbed retry left a second capture after all",
    ).toBe("1");

    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);

    const prior = page.getByTestId("machine-prior-setup");
    await expect(prior).toBeVisible({ timeout: T });
    // THE VALUES SHE ENTERED, offered back as reference — read per field
    // rather than searched for in the panel's text, because that text also
    // carries a date and units.
    await expect(page.getByTestId("prior-setup-g1-current")).toContainText("120");
    await expect(page.getByTestId("prior-setup-g1-duration")).toContainText("300.5");
    // AND NOTHING IS PRE-FILLED from it, on this path as on every other.
    const draft = page.getByTestId("machine-setting-draft");
    await expect(draft).toBeVisible({ timeout: T });
    await expect(draft.getByTestId("reading-current")).toHaveValue("");
  });

  await test.step("6: the REVISION save freezes the same way, and absorbs its retry", async () => {
    // THE OTHER LIMB of one invariant (Codex, #860 4296029605). The initial
    // save and a revision are different commands with different digests, but
    // the rule is identical: while an outcome is unknown, the payload is
    // frozen. Proving only the initial save would leave the revision path
    // exactly as un-exercised as the reload path was before round 5.
    //
    // RUN LAST, deliberately. It appends a capture, and step 5's next-visit
    // read asserts the values guidance offers — adding a revision before it
    // would change that read and the step would fail on arithmetic rather
    // than on behaviour, which is how three assertions in the sibling
    // journey went stale.
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    await expect(page.getByTestId("machine-reading-entry")).toBeVisible({
      timeout: T,
    });

    const before = await totals(sessionId);

    // A genuine mid-treatment change, then its answer is lost.
    await page.getByTestId("reading-current").fill("140");
    await page.getByTestId("reading-duration").fill("290.0");
    await page.getByTestId("reading-energy_shown").fill("1.30");
    lost.arm = true;
    await page.getByTestId("machine-reading-save").click();

    // IT COMMITTED. Same shape as step 2: without this the retry below would
    // simply be the first successful save and would prove nothing.
    await expect
      .poll(async () => (await totals(sessionId)).submissions, {
        timeout: T,
        message: "the intercepted revision never reached the database",
      })
      .toBe(before.submissions + 1);

    // FROZEN, on this path too.
    await expect(page.getByTestId("setting-draft-frozen")).toBeVisible({
      timeout: T,
    });
    await expect(page.getByTestId("reading-current")).toBeDisabled();
    await expect(page.getByTestId("setting-group-add")).toBeDisabled();

    // AND THE RETRY IS ABSORBED — exactly one new capture for the change she
    // made once, which is the whole clinical point: a second capture is
    // permanent and reads as another adjustment.
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({
      timeout: T,
    });
    const after = await totals(sessionId);
    expect(
      after.submissions,
      "the retry minted a new save instead of being absorbed",
    ).toBe(before.submissions + 1);
    expect(
      after.readings,
      "the retry duplicated the readings",
    ).toBe(before.readings + 3);
  });
});
