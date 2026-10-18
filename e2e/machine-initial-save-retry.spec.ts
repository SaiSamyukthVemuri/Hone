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
          // OPTIONAL in the real synthetic profile, and the command now
          // refuses a capture missing a REQUIRED field (Codex, #860
          // 4299434251). A fixture contract must describe the product it
          // stands in for, not a stricter machine.
          optional: true,
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

    // AND SO IS THE MACHINE IDENTITY, which is the round-12 repair
    // (Codex, #860 4300759930). The entry's own fields froze from round 6;
    // the dropdown and the mode buttons did not, because the revision
    // save's unresolved state never left this child component.
    //
    // WHY THAT MATTERED MORE THAN IT LOOKS: switching machine here
    // UNMOUNTS the entry and discards the retry key it is holding. Switch
    // back, press Save, and a new key is minted — appending a duplicate
    // IMMUTABLE capture if the first request committed. The control that
    // can destroy the key has to be inside the freeze the key depends on.
    await expect(
      page.getByTestId("machine-select"),
      "the machine could be changed while a revision save was unresolved",
    ).toBeDisabled();
    // THE MODE BUTTONS ARE NOT PROVEN HERE, AND SAYING SO IS THE POINT.
    // My first version of this assertion looped over `/^machine-mode-/` and
    // passed. It passed VACUOUSLY: `synthetic:demo-multineedle` declares one
    // mode, the picker renders only at `modes.length > 1`, so the locator
    // matched nothing and a loop over zero elements asserts nothing. (It
    // would also have matched `machine-mode-picker`, the container DIV,
    // which `toBeDisabled` can never hold.) A zero-iteration loop reporting
    // success is the same green-by-absence trap as a spec-count pin.
    //
    // So this branch is a TRIPWIRE, not a proof: if a future catalogue gives
    // this profile a second mode, the picker appears and the buttons must be
    // frozen like the select above - the test will then prove it rather than
    // quietly resume passing on nothing.
    const picker = page.getByTestId("machine-mode-picker");
    if (await picker.count()) {
      const modeButtons = picker.getByRole("button");
      const modeCount = await modeButtons.count();
      expect(modeCount, "a rendered picker offers a choice").toBeGreaterThan(1);
      for (let i = 0; i < modeCount; i += 1) {
        await expect(modeButtons.nth(i)).toBeDisabled();
      }
    } else {
      test.info().annotations.push({
        type: "not-proven",
        description:
          "Mode-button freeze NOT proven at runtime: this profile has one mode, so no picker renders. The machine select above proves `identityFrozen` reaches the identity controls; the mode button is the same flag at a sibling call site and is asserted only at source level.",
      });
    }

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

// ===========================================================================
// THE ROUTE BINDING, MOUNTED — a refusal she can SEE.
//
// IT LIVES IN THIS FILE because it needs the same fixture as the test above:
// a signed-in owner, a synthetic machine with a published contract, and a
// draft session. Duplicating eighty lines of that into its own spec would be
// a second thing to keep in step.
//
// WHAT THE DATABASE TESTS CANNOT SHOW. tests/db/machine-setup-storage proves
// six ways that the command REFUSES a block that is not this route's
// (Codex, #860 4297032712). None of them can show that the practitioner
// learns it refused — and a clinical save that silently does nothing is its
// own defect: she believes the settings are recorded, moves on, and the
// record is simply missing.
//
// HOW THE MISMATCH IS PRODUCED, AND WHY NOT THE OBVIOUS WAY. The first
// version of this test moved the block into another client's session and
// reloaded. The database refused the FIXTURE: a trigger holds
// `session_blocks.session_id` fixed once the row exists ("A treatment record
// cannot be re-assigned ... soft-delete this record and chart it where it
// belongs"). That guard is right, and it means a stale page cannot produce
// this mismatch by data moving underneath it.
//
// So the test produces the case Codex actually named — a TAMPERED REQUEST.
// The save's server-action payload is intercepted and the block id is
// swapped for one belonging to another client of the same studio. Studio
// membership is satisfied throughout, which is exactly why membership could
// not catch this and the lineage check had to exist.
// ===========================================================================
test("a setup write that is not this route's is refused, and SAID @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  await loginAsOwner(page, seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);

  // ANOTHER CLIENT OF THE SAME STUDIO, with a treatment of their own. Created
  // directly, which is allowed: the trigger forbids MOVING a block, not
  // creating one.
  const prac = await sql<{ id: string }>(
    `select id from public.practitioners
      where studio_id = $1 and role = 'owner' limit 1`,
    [seed.studioId],
  );
  const victim = await sql<{ block_id: string }>(
    `with c as (
       insert into public.clients (studio_id, name)
       values ($1, 'Route Binding Victim') returning id
     ), s as (
       insert into public.sessions (studio_id, client_id, practitioner_id, modality)
       select $1, c.id, $2, 'electrolysis' from c returning id
     ), b as (
       insert into public.session_blocks (studio_id, session_id)
       select $1, s.id from s returning id
     )
     select id as block_id from b`,
    [seed.studioId, prac[0]!.id],
  );
  const victimBlockId = victim[0]!.block_id;

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  const gateOpen = await openMachinePanel(page);
  test.skip(!gateOpen, "the machine panel is gated off in this environment");

  await page.getByTestId("machine-select").selectOption(machineId);
  await page.getByTestId("save-treatment-area").click({ timeout: T });

  let blockId = "";
  await expect
    .poll(
      async () => {
        const rows = await sql<{ id: string }>(
          `select id from public.session_blocks
            where session_id = $1 and deleted_at is null
            order by sort_order desc limit 1`,
          [sessionId],
        );
        blockId = rows[0]?.id ?? "";
        return blockId;
      },
      { timeout: T, message: "the treatment area was not created" },
    )
    .not.toBe("");

  await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
  expect(await openMachinePanel(page)).toBe(true);
  await expect(page.getByTestId("machine-reading-entry")).toBeVisible({
    timeout: T,
  });

  // THE TAMPER. Every POST to this route from here on carries the OTHER
  // client's block id in place of this one. Nothing else is altered: the
  // session and client the action sends are still this route's, which is the
  // precise shape of the attack — a block that is not this session's.
  const swapped = { count: 0 };
  await page.route(`**/clients/${clientId}/sessions/${sessionId}**`, async (route) => {
    const body = route.request().postData();
    if (route.request().method() !== "POST" || !body || !body.includes(blockId)) {
      await route.continue();
      return;
    }
    swapped.count += 1;
    await route.continue({ postData: body.split(blockId).join(victimBlockId) });
  });

  await page.getByTestId("reading-current").fill("120");
  await page.getByTestId("reading-duration").fill("300.5");
  await page.getByTestId("reading-energy_shown").fill("1.25");
  await page.getByTestId("machine-reading-save").click();

  // SHE IS TOLD. Not a spinner that stops, not a form that closes as though
  // it saved.
  const message = page.getByTestId("machine-reading-message");
  await expect(message, "the refusal was silent").toBeVisible({ timeout: T });
  expect((await message.innerText()).trim().length).toBeGreaterThan(0);

  // AND IT IS NOT REPORTED AS SAVED, which is the half that would send her
  // away believing the record is complete.
  await expect(page.getByTestId("machine-reading-saved")).toHaveCount(0);

  // THE TAMPER ACTUALLY HAPPENED. Without this the assertions above are
  // satisfied by an interception that never fired and a save that failed for
  // some other reason entirely.
  expect(swapped.count, "the block id was never swapped").toBeGreaterThan(0);

  // AND NOTHING REACHED THE OTHER CLIENT'S CHART, which is the whole point.
  const rows = await sql<{ n: string }>(
    `select count(*)::text as n from public.treatment_setup_readings
      where session_block_id = $1`,
    [victimBlockId],
  );
  expect(rows[0]!.n, "a reading reached another client's chart").toBe("0");
});

// ===========================================================================
// THE READ IS BOUND TOO — another client's captures never render here.
//
// ROUND 8 CLAIMED THIS WAS FIXED AND IT WAS NOT. The read action gained
// `assertSessionForClient` and I reported the hole closed; the QUERY still
// filtered on the block id alone, and the studio-member SELECT policy
// admitted it. A crafted request therefore returned another client's
// captures and the chart rendered them under "Recorded this treatment"
// (Codex, #860 4298457378).
//
// The lesson is the one I had already written for the write path, two
// rounds earlier: an application lineage check authorizes the ROUTE. Only a
// predicate in the query binds the RECORD to it.
//
// Same technique as the write-side case below it: the save's payload is not
// what is swapped here — the LOAD's is, because the panel reads what is
// already recorded every time it opens.
// ===========================================================================
test("another client's recorded captures never render on this chart @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  await loginAsOwner(page, seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  const gateOpen = await openMachinePanel(page);
  test.skip(!gateOpen, "the machine panel is gated off in this environment");

  // SEEDED AFTER THE GATE CHECK. The gate-closed run proves the open one
  // was not vacuous by leaving the machine tables untouched, and this
  // fixture ran BEFORE the skip — so a skipped test still wrote one
  // capture and one reading, and the closed run stopped measuring zero.
  // ANOTHER CLIENT OF THE SAME STUDIO, with a capture of their own carrying a
  // value this chart never records. If it ever appears on screen, it came
  // from their record.
  const prac = await sql<{ id: string }>(
    `select id from public.practitioners
      where studio_id = $1 and role = 'owner' limit 1`,
    [seed.studioId],
  );
  const victim = await sql<{ block_id: string; session_id: string }>(
    `with c as (
       insert into public.clients (studio_id, name)
       values ($1, 'Read Binding Victim') returning id
     ), s as (
       insert into public.sessions (studio_id, client_id, practitioner_id, modality)
       select $1, c.id, $2, 'electrolysis' from c returning id
     ), b as (
       insert into public.session_blocks (studio_id, session_id)
       select $1, s.id from s returning id, session_id
     )
     select id as block_id, session_id from b`,
    [seed.studioId, prac[0]!.id],
  );
  const victimBlockId = victim[0]!.block_id;

  // A CAPTURE ON THEIR CHART, inserted directly.
  //
  // NOT THROUGH THE COMMAND: `sql()` here connects as the admin role, so
  // `own_practitioner_in_studio` finds nobody and the command refuses with
  // "Not an active member of this studio" — correctly. What this test needs
  // is merely that foreign data EXISTS to be leaked; how it got there is not
  // the subject, and the command's own route binding has six DB cases of its
  // own.
  await sql(
    `with cap as (
       insert into public.treatment_setup_captures
         (studio_id, session_block_id, studio_machine_id, machine_profile_id,
          machine_profile_version, mode_key, group_key, channels, revision)
       values ($1, $2, $3, 'synthetic:demo-multineedle', 2, 'galvanic',
               'g1', '{}'::smallint[], 1)
       returning id
     )
     insert into public.treatment_setup_readings
       (studio_id, session_block_id, capture_id, studio_machine_id,
        machine_profile_id,
        machine_profile_version, mode_key, group_key, channels, stage_key,
        field_key, value_numeric, native_unit, decimals, revision,
        observation_source)
     select $1, $2, cap.id, $3, 'synthetic:demo-multineedle', 2, 'galvanic',
            'g1', '{}'::smallint[], null, 'current', 777, 'µA', 0, 1,
            'practitioner-entered'
       from cap`,
    [seed.studioId, victimBlockId, machineId],
  );

  await page.getByTestId("machine-select").selectOption(machineId);
  await page.getByTestId("save-treatment-area").click({ timeout: T });

  let blockId = "";
  await expect
    .poll(
      async () => {
        const rows = await sql<{ id: string }>(
          `select id from public.session_blocks
            where session_id = $1 and deleted_at is null
            order by sort_order desc limit 1`,
          [sessionId],
        );
        blockId = rows[0]?.id ?? "";
        return blockId;
      },
      { timeout: T, message: "the treatment area was not created" },
    )
    .not.toBe("");

  // THE TAMPER. Every POST to this route now carries the OTHER client's block
  // id. The session and client it sends are still this route's — which is
  // precisely the shape the application check cannot catch.
  const swapped = { count: 0 };
  await page.route(`**/clients/${clientId}/sessions/${sessionId}**`, async (route) => {
    const body = route.request().postData();
    if (route.request().method() !== "POST" || !body || !body.includes(blockId)) {
      await route.continue();
      return;
    }
    swapped.count += 1;
    await route.continue({ postData: body.split(blockId).join(victimBlockId) });
  });

  // EVERY RESPONSE BODY THE PAGE RECEIVES, collected before the read runs.
  // A value absent from the DOM but present in a payload is still a leak -
  // the next render could show it, and the practitioner's browser already
  // holds it.
  const bodies: string[] = [];
  page.on("response", (res) => {
    if (res.request().method() !== "POST") return;
    void res
      .text()
      .then((t) => bodies.push(t))
      .catch(() => {
        // A body that cannot be read is not evidence either way; the DOM
        // assertion below is what carries the claim.
      });
  });

  // Reopening the area makes the panel load what is "already recorded".
  await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
  expect(await openMachinePanel(page)).toBe(true);

  expect(swapped.count, "the block id was never swapped").toBeGreaterThan(0);

  // ---------------------------------------------------------------------
  // 1 · THE ISOLATION PROPERTY, which is the claim this test exists for.
  // ---------------------------------------------------------------------
  // THE WHOLE DOCUMENT, not one locator. The victim's distinctive value must
  // not appear anywhere on the page - inside the panel, in the history below
  // it, in a heading, or in a hidden attribute.
  await expect(
    page.locator("body"),
    "another client's recorded value is on this page",
  ).not.toContainText("777");

  // AND NOT IN ANYTHING THE PAGE WAS SENT. Give the in-flight reads a moment
  // to land first, or this asserts over an empty list.
  await expect
    .poll(() => bodies.length, { timeout: T })
    .toBeGreaterThan(0);
  expect(
    bodies.filter((b) => b.includes("777")),
    "another client's recorded value reached this page in a response body",
  ).toEqual([]);

  // ---------------------------------------------------------------------
  // 2 · THE MECHANISM, so a silent change back to rendering is caught.
  // ---------------------------------------------------------------------
  // The tampered read is REFUSED, so the surface says it could not read
  // rather than showing a confident, wrong "Recorded this treatment"...
  await expect(
    page.getByTestId("machine-recorded-setups-unavailable"),
    "the tampered read did not come back unavailable",
  ).toBeVisible({ timeout: T });
  // ...and the entry is declined entirely, because an identity read that
  // failed must not drive a write (4307523228).
  await expect(
    page.getByTestId("machine-reading-entry"),
    "the entry rendered on an identity read that failed",
  ).toHaveCount(0);
});

test("POSITIVE CONTROL: her OWN block reads and renders normally @390px", async ({
  page,
}) => {
  // WITHOUT THIS THE TEST ABOVE IS SATISFIED BY A SURFACE THAT RENDERS
  // NOTHING, EVER - which is now exactly the state it expects. So this proves
  // the same surface still works on an untampered read of her own block: the
  // entry renders, the recorded history renders, and her own value is there.
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  const gateOpen = await openMachinePanel(page);
  if (!gateOpen) {
    test.info().annotations.push({
      type: "gate-closed",
      description:
        "No verified model is offered, so the positive control did NOT run.",
    });
    return;
  }

  await page.getByTestId("machine-select").selectOption(machineId);
  await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
    timeout: T,
  });
  await page.getByTestId("reading-current").fill("123");
  await page.getByTestId("reading-duration").fill("300.5");
  await page.getByTestId("reading-energy_shown").fill("1.25");
  await page.getByTestId("save-treatment-area").click({ timeout: T });
  await expect(page.getByTestId("save-treatment-area")).toHaveCount(0, {
    timeout: T,
  });

  // Reopen: an untampered read of her OWN block.
  await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
  expect(await openMachinePanel(page)).toBe(true);
  await expect(
    page.getByTestId("machine-reading-entry"),
    "an untampered read did not render the entry, so the test above proves nothing",
  ).toBeVisible({ timeout: T });
  await expect(
    page.getByTestId("machine-recorded-setups-unavailable"),
  ).toHaveCount(0);
  await expect(page.getByTestId("machine-first-panel")).toContainText("123");

  test.info().annotations.push({
    type: "gate-open",
    description: "An untampered read rendered the entry and her own value.",
  });
});

// ===========================================================================
// THE MODE BUTTONS, MOUNTED — the half the test above cannot prove.
//
// WHY IT IS A SEPARATE TEST AND NOT ANOTHER STEP. The test above runs on
// `synthetic:demo-multineedle`, which declares ONE mode, so its picker never
// renders. My first attempt asserted the mode freeze there anyway, by looping
// over `/^machine-mode-/`, and it PASSED — over zero elements. A loop that
// iterates nothing reports success exactly like a loop that checked
// something. (The same regex would also have matched `machine-mode-picker`,
// the container DIV, which `toBeDisabled` can never hold, so the assertion
// could only pass while it was vacuous.) The fix is not a better regex; it
// is a fixture where the control actually exists.
//
// So this runs on `synthetic:demo-single-probe`, which has TWO modes, and
// asserts the count BEFORE asserting the state — a proof whose setup can go
// missing has to say so out loud.
//
// WHAT IS AT STAKE, same as its sibling. A mode change writes the same stored
// selection as a device change and is part of the digest the held retry key
// is bound to; changing mode mid-flight remounts the entry and discards that
// key. Press Save after that and a NEW key is minted — appending a duplicate
// IMMUTABLE capture if the first request had already committed. A control
// that can destroy the key belongs inside the freeze the key depends on.
// ===========================================================================

/** Unit B: no channels, two modes. Mirrors the catalogue, including OPTIONAL. */
const SINGLE_PROBE = {
  profileId: "synthetic:demo-single-probe",
  version: 1,
  channels: null as number | null,
  modes: {
    // `pulse_width` is OPTIONAL in the catalogue, and the fixture says so.
    // The command refuses a capture missing a REQUIRED field, so a fixture
    // that silently promoted it would stand in for a STRICTER machine than
    // the product — the same correction round 11 made to the contract above.
    blend: [
      { field_key: "current", native_unit: "mA", decimals: 2, quantity: "current" },
      {
        field_key: "pulse_width",
        native_unit: "ms",
        decimals: 0,
        quantity: "duration",
        optional: true,
      },
    ],
    thermolysis: [
      { field_key: "current", native_unit: "µA", decimals: 1, quantity: "current" },
      { field_key: "intensity", native_unit: "%", decimals: 0, quantity: "intensity" },
    ],
  },
} as const;

async function registerSingleProbe(studioId: string, displayName: string) {
  const id = randomUUID();
  await sql(
    `insert into public.studio_machines
       (id, studio_id, machine_profile_id, machine_profile_version, display_name)
     values ($1, $2, $3, $4, $5)`,
    [id, studioId, SINGLE_PROBE.profileId, SINGLE_PROBE.version, displayName],
  );
  // ONE PUBLISH PER MODE: the contract is per (profile, version, MODE), and a
  // mode whose contract is missing is refused at save time with a message
  // about the contract — which would read exactly like the defect being
  // looked for here.
  for (const [modeKey, fields] of Object.entries(SINGLE_PROBE.modes)) {
    await sql(
      `select public.sync_machine_profile_contract($1, $2, $3, $4, null, $5::jsonb)`,
      [
        SINGLE_PROBE.profileId,
        SINGLE_PROBE.version,
        modeKey,
        SINGLE_PROBE.channels,
        JSON.stringify(fields),
      ],
    );
  }
  return id;
}

test("an unresolved REVISION save freezes the MODE BUTTONS too @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const machineId = await registerSingleProbe(seed.studioId, "Room 2 single");
  await loginAsOwner(page, seed);

  // Armed only around the save being lost — see the sibling above.
  const lost = { arm: false, fired: 0 };
  await page.route(`**/clients/${clientId}/sessions/${sessionId}**`, async (route) => {
    if (route.request().method() !== "POST" || !lost.arm) {
      await route.continue();
      return;
    }
    lost.arm = false;
    lost.fired += 1;
    try {
      await route.fetch();
    } catch {
      // An upstream failure is an ordinary network error, a different case;
      // the commit poll below fails either way, which is the right outcome.
    }
    await route.abort("failed");
  });

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  const gateOpen = await openMachinePanel(page);

  if (!gateOpen) {
    test.info().annotations.push({
      type: "gate-closed",
      description:
        "HONE_SYNTHETIC_MACHINE_PROFILE is not in the server env, so the " +
        "mode-button freeze did NOT run. Not acceptance evidence for it.",
    });
    expect(await totals(sessionId)).toEqual({
      blocks: 0,
      submissions: 0,
      captures: 0,
      readings: 0,
      claims: 0,
    });
    return;
  }

  test.info().annotations.push({
    type: "gate-open",
    description: "The mode-button freeze executed against a two-mode unit.",
  });

  const picker = page.getByTestId("machine-mode-picker");
  // THE BUTTONS, not the container. `getByRole` inside the picker cannot
  // match the wrapping div, which is how the vacuous version went wrong.
  const modeButtons = picker.getByRole("button");

  await test.step("0: the fixture really does offer a choice of mode", async () => {
    // ASSERTED FIRST, AND ON PURPOSE. Everything below is about the STATE of
    // these buttons; if they do not exist, every one of those assertions
    // passes without checking anything. This is the guard that makes the
    // rest of the test falsifiable.
    await page.getByTestId("machine-select").selectOption(machineId);
    await expect(page.getByTestId("machine-chosen")).toContainText("Room 2 single", {
      timeout: T,
    });
    await expect(picker).toBeVisible({ timeout: T });
    expect(
      await modeButtons.count(),
      "the two-mode fixture rendered no choice — the proof below would be vacuous",
    ).toBe(2);
    // AND THEY START LIVE, or "disabled" below proves nothing either.
    await expect(modeButtons.nth(0)).toBeEnabled();
    await expect(modeButtons.nth(1)).toBeEnabled();
  });

  await test.step("1: the initial settings are recorded", async () => {
    // Blend is the first active mode, so these are blend's fields.
    await page.getByTestId("reading-current").fill("1.20");
    await page.getByTestId("reading-pulse_width").fill("9");
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect
      .poll(async () => (await totals(sessionId)).blocks, { timeout: T })
      .toBe(1);
  });

  await test.step("2: a REVISION is saved and its answer is LOST", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    await expect(page.getByTestId("machine-reading-entry")).toBeVisible({
      timeout: T,
    });

    const before = await totals(sessionId);

    await page.getByTestId("reading-current").fill("1.40");
    lost.arm = true;
    await page.getByTestId("machine-reading-save").click();

    // IT COMMITTED. Without this the "retry" below is just a first save, and
    // the freeze it is testing would be guarding nothing.
    await expect
      .poll(async () => (await totals(sessionId)).submissions, {
        timeout: T,
        message: "the intercepted revision never reached the database",
      })
      .toBe(before.submissions + 1);
    expect(lost.fired, "the interception never fired").toBe(1);

    // THE CLAIM. Every mode button is frozen while the outcome is unknown.
    await expect(page.getByTestId("setting-draft-frozen")).toBeVisible({
      timeout: T,
    });
    const n = await modeButtons.count();
    expect(n, "the picker disappeared mid-test; nothing below is proven").toBe(2);
    for (let i = 0; i < n; i += 1) {
      await expect(
        modeButtons.nth(i),
        `mode button ${i} stayed live while a revision save was unresolved`,
      ).toBeDisabled();
    }
    // The device picker too, which the sibling test also proves — kept here
    // because the two controls are frozen by one flag and a change that
    // split them should fail somewhere.
    await expect(page.getByTestId("machine-select")).toBeDisabled();

    // AND THE RETRY IS ABSORBED: one change she made once, one capture.
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({
      timeout: T,
    });
    const after = await totals(sessionId);
    expect(
      after.submissions,
      "the retry minted a new save instead of being absorbed",
    ).toBe(before.submissions + 1);

    // AND THE FREEZE LIFTS. A control that never comes back is a different
    // defect wearing this test's green.
    await expect(modeButtons.nth(0)).toBeEnabled();
    await expect(page.getByTestId("machine-select")).toBeEnabled();
  });
});

// ===========================================================================
// A1 + A1b — THE SAVE SURVIVES A RELOAD, AND A DELIBERATE SECOND AREA STILL
// CREATES TWO.
//
// *** UNEXECUTED. *** Written against the A1b head; it has never run, and it
// is queued for the shared heavy slot behind Photos, General, Team and
// Insurance. The DB tests prove the command absorbs a repeat carrying the same
// key, and the unit lane proves the id's rules and the form's wiring. NEITHER
// can prove the browser hop: that the key actually survives a reload in the
// URL, and that the form then tells her the area exists instead of asking her
// to re-enter anything.
//
// WHY THE FIRST VERSION OF THIS FEATURE WAS WRONG, which is what these cases
// exist to prevent recurring (Codex #922 4305312331). Carrying the key alone
// is not enough: a reload destroys the DRAFT, the key only reaches the command
// inside `initialSetup`, and a save with an empty draft therefore sends NO key
// at all and creates a second area. Seeding the unresolved flag made it worse
// by freezing a draft built from fresh defaults, so the payload could not be
// reconstructed even in principle. The fix answers the question — "did my save
// commit?" — by READING the claim, and these cases assert she is told, not
// asked.
//
// IT REUSES THE FIXTURE ABOVE deliberately. Published contracts are immutable
// per (profile, version, mode), so a second spec publishing the same synthetic
// profile fails in its FIXTURE rather than its assertions — and a single-spec
// run can never see it.
// ===========================================================================

/** The `area_op` the address bar is carrying, or null. */
function areaOpOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get("area_op");
  } catch {
    return null;
  }
}

test("a lost response SURVIVES a reload: she is told the area exists @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  await loginAsOwner(page, seed);

  const lost = { arm: false, fired: 0 };
  await page.route(`**/clients/${clientId}/sessions/${sessionId}**`, async (route) => {
    if (route.request().method() !== "POST" || !lost.arm) {
      await route.continue();
      return;
    }
    lost.arm = false;
    lost.fired += 1;
    // The server COMMITS and only the page's fetch fails: a lost ANSWER, not a
    // failed request. `route.abort()` alone would prove nothing here.
    try {
      await route.fetch();
    } catch {
      // An upstream failure is an ordinary network error, a different case.
      // The assertions below catch it either way, because no area would exist.
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
    test.info().annotations.push({
      type: "gate-closed",
      description:
        "HONE_SYNTHETIC_MACHINE_PROFILE is not in the server env, so the " +
        "reload reconciliation did NOT run. This run is not acceptance " +
        "evidence for it.",
    });
    return;
  }
  test.info().annotations.push({
    type: "gate-open",
    description: "The reload reconciliation of a lost initial save executed.",
  });

  let carried: string | null = null;

  await test.step("1: the settings are entered and the first Save's answer is LOST", async () => {
    await page.getByTestId("machine-select").selectOption(machineId);
    await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
      timeout: T,
    });
    await page.getByTestId("reading-current").fill("120");
    await page.getByTestId("reading-duration").fill("300.5");
    await page.getByTestId("reading-energy_shown").fill("1.25");

    lost.arm = true;
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect(
      page.getByRole("alert").filter({ hasText: /press save again/i }),
    ).toBeVisible({ timeout: T });
    expect(lost.fired, "the interception never fired").toBe(1);
  });

  await test.step("2: the key is in the ADDRESS BAR, which is what a reload keeps", async () => {
    // The whole mechanism. Before A1 this lived only in React state, so the
    // reload below discarded it.
    await expect
      .poll(() => areaOpOf(page.url()), { timeout: T })
      .not.toBeNull();
    carried = areaOpOf(page.url());
    expect(carried).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  await test.step("3: the area IS already there — the save committed, the answer did not", async () => {
    await expect
      .poll(async () => (await totals(sessionId)).blocks, {
        timeout: T,
        message: "the intercepted save never reached the database",
      })
      .toBe(1);
    expect((await totals(sessionId)).claims, "the save left its receipt").toBe(1);
  });

  await test.step("4: SHE RELOADS, and is TOLD the area was saved", async () => {
    await page.reload();
    // The URL survived the reload carrying the same id.
    expect(areaOpOf(page.url()), "the reload lost the save's identity").toBe(carried);

    await page.getByTestId("add-settings-block-cta").click({ timeout: T });

    // THE ANSWER, not a retry instruction. Nothing is re-entered.
    await expect(page.getByTestId("initial-save-already-saved")).toBeVisible({
      timeout: T,
    });
    // And the parameter is cleared, so a second reload cannot re-ask a
    // question already answered.
    await expect.poll(() => areaOpOf(page.url()), { timeout: T }).toBeNull();

    // She is NOT asked to press Save again, and cannot.
    await expect(page.getByTestId("save-treatment-area")).toBeDisabled();
  });

  await test.step("5: and closing it leaves ONE area, with her values, once", async () => {
    await page.getByTestId("initial-save-already-saved-close").click({ timeout: T });
    expect(
      await totals(sessionId),
      "the reload produced a second treatment area",
    ).toEqual({
      blocks: 1,
      submissions: 1,
      captures: 1,
      readings: 3,
      claims: 1,
    });
  });
});

test("SAM'S RULE: a deliberate identical second area is still TWO areas @390px", async ({
  page,
}) => {
  // THE CASE THE REJECTED APPROACH COULD NOT PASS. #920 matched claims by
  // payload DIGEST, so a byte-identical second area was absorbed as a retry
  // and the only escape was to alter a clinical value. Sam's rule is that she
  // must NEVER have to do that. A fresh form open carries no `area_op`, so it
  // mints its own id and the save is its own save — nothing to defeat.
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  const gateOpen = await openMachinePanel(page);
  if (!gateOpen) {
    test.info().annotations.push({
      type: "gate-closed",
      description:
        "No verified model is offered, so Sam's rule was NOT exercised. This " +
        "run is not acceptance evidence for it.",
    });
    return;
  }
  test.info().annotations.push({
    type: "gate-open",
    description: "A deliberate identical second area was created.",
  });

  /** Enter the SAME readings and save, from a form that is already open. */
  async function saveIdentical() {
    await page.getByTestId("machine-select").selectOption(machineId);
    await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
      timeout: T,
    });
    await page.getByTestId("reading-current").fill("120");
    await page.getByTestId("reading-duration").fill("300.5");
    await page.getByTestId("reading-energy_shown").fill("1.25");
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect(page.getByTestId("save-treatment-area")).toHaveCount(0, {
      timeout: T,
    });
  }

  await test.step("the first area is saved normally", async () => {
    await saveIdentical();
    expect((await totals(sessionId)).blocks).toBe(1);
    // A successful save closes its operation, so nothing is left in the URL to
    // make the next one look like a retry.
    expect(areaOpOf(page.url()), "a closed save left its id behind").toBeNull();
  });

  await test.step("a FRESH form with byte-identical settings creates a SECOND area", async () => {
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    await saveIdentical();

    const t = await totals(sessionId);
    expect(
      t.blocks,
      "the identical second area was suppressed — she would have had to change a clinical value",
    ).toBe(2);
    expect(t.claims, "each save left its own receipt").toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AN UNSETTLED EARLIER SAVE IS RECOVERED BY AN EXPLICIT CHOICE
// (Codex #922 4307515255, scoped by ops01)
// ---------------------------------------------------------------------------
//
// THE THREE FINDINGS THESE SIT ON TOP OF. A bare save from a reloaded form
// went UNKEYED and made a second area, so such saves were blocked; blocking
// them meant closing had to DISCARD the key, or every later Add resumed an
// abandoned operation with no way back; but "no claim found" is NOT settled,
// because the command takes its advisory lock BEFORE the claim lookup and
// writes the claim at the very END — so a read landing mid-commit sees no row
// for a save that is about to succeed. Discarding the key on that answer threw
// away the only identity that could absorb the original.
//
// THE KEY IS THEREFORE RETAINED WHILE UNSETTLED — and never used silently,
// because absorbing a save whose values merely MATCH would suppress an area
// she meant to create as a second one. Sam's standing requirement is that
// recovery preserve the ability to make an identical second area deliberately,
// so she is asked.
//
// HOW THE UNSETTLED STATE IS REACHED, DETERMINISTICALLY AND WITH NO HOOK.
// `route.abort("failed")` with NO `route.fetch()`: the request never reaches
// the server, so nothing commits, no claim exists, and the client cannot know
// which. That is the exact opposite of the reload case above, which calls
// `route.fetch()` on purpose so the server COMMITS and only the answer is
// lost — and whose comment says "`route.abort()` alone would prove nothing
// here". For these cases abort-alone is the whole point.
//
// WHAT THESE CANNOT COVER, stated so a green run is not read as more than it
// is: the case where the original COMMITTED while the lookup said absent. That
// needs the real race. Absorption by key is proved instead in
// tests/db/machine-setup-submission.db.test.ts (two concurrent retries of one
// save resolving to ONE submission; a retry key refusing a different payload)
// and tests/db/machine-initial-save.db.test.ts (the create claim's own retry
// cases).

/** Drive the form to an UNSETTLED save, then close it. Returns the held key. */
async function unsettledThenClose(
  page: Page,
  clientId: string,
  sessionId: string,
  machineId: string,
): Promise<string> {
  const lost = { arm: false };
  await page.route(`**/clients/${clientId}/sessions/${sessionId}**`, async (route) => {
    if (route.request().method() !== "POST" || !lost.arm) {
      await route.continue();
      return;
    }
    lost.arm = false;
    // NO `route.fetch()`. The request never reaches the server, so NOTHING
    // commits and no claim is written — while the page sees only a failure it
    // cannot interpret. That is the unsettled state, with no timing guess.
    await route.abort("failed");
  });

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  expect(await openMachinePanel(page)).toBe(true);
  await page.getByTestId("machine-select").selectOption(machineId);
  await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
    timeout: T,
  });
  await page.getByTestId("reading-current").fill("120");
  await page.getByTestId("reading-duration").fill("300.5");
  await page.getByTestId("reading-energy_shown").fill("1.25");

  lost.arm = true;
  await page.getByTestId("save-treatment-area").click({ timeout: T });

  // THE KEY IS IN THE URL, which is what survives everything below.
  await expect.poll(() => areaOpOf(page.url()), { timeout: T }).not.toBeNull();
  const key = areaOpOf(page.url());
  expect(key).not.toBeNull();

  // NOTHING COMMITTED, so the choice she is about to be offered is genuinely
  // about an unsettled save rather than a recorded one.
  expect((await totals(sessionId)).blocks).toBe(0);

  // A RELOAD, AND IT IS NOT OPTIONAL. Cancel is DISABLED while the save's
  // outcome is unknown - deliberately, because Cancel is the one control that
  // destroys the retry key (Codex, #860 4301633049). So closing is not
  // reachable in this mount at all; the reload is what clears
  // `saveUnresolved`, runs the claim lookup, and brings the form to the
  // unsettled-but-settled-enough-to-leave state. It is also the real
  // scenario: she lost the answer and came back.
  await page.reload();
  await expect(page.getByTestId("initial-save-resume-choice")).toBeVisible({
    timeout: T,
  });

  // CLOSE WHILE UNSETTLED. The key must survive this.
  await page.getByTestId("cancel-treatment-area").click({ timeout: T });
  expect(
    areaOpOf(page.url()),
    "closing while unsettled discarded the key, so the original cannot be reconciled",
  ).toBe(key);
  return key as string;
}

/** Enter the same readings the unsettled save carried. */
async function enterIdentical(page: Page, machineId: string) {
  await page.getByTestId("machine-select").selectOption(machineId);
  await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
    timeout: T,
  });
  await page.getByTestId("reading-current").fill("120");
  await page.getByTestId("reading-duration").fill("300.5");
  await page.getByTestId("reading-energy_shown").fill("1.25");
}

/** Every area's readings on this session, as `field=value` per block. */
async function readingsPerBlock(sessionId: string) {
  const rows = await sql<{ block: string; shape: string }>(
    `select b.id::text as block,
            string_agg(r.field_key || '=' || r.value_numeric::text, ',' order by r.field_key) as shape
       from public.session_blocks b
       join public.treatment_setup_captures c on c.session_block_id = b.id
       join public.treatment_setup_readings r on r.capture_id = c.id
      where b.session_id = $1
      group by b.id`,
    [sessionId],
  );
  return rows.map((r) => r.shape);
}

test("(i) an unsettled close keeps the key, and RESUME creates exactly ONE area @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  await loginAsOwner(page, seed);

  const key = await unsettledThenClose(page, clientId, sessionId, machineId);

  await test.step("the next Add ASKS, rather than resuming silently", async () => {
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    // THE KEY IS STILL IN THE URL after the close, which is what makes this
    // Add a resumption rather than a fresh area.
    expect(areaOpOf(page.url())).toBe(key);
    await expect(page.getByTestId("initial-save-resume-choice")).toBeVisible({
      timeout: T,
    });
    // HELD UNTIL SHE ANSWERS: saving first would decide it for her.
    await expect(page.getByTestId("save-treatment-area")).toBeDisabled();
  });

  await test.step("RESUME re-uses the held key and creates ONE area", async () => {
    await page.getByTestId("initial-save-resume-choice-resume").click({ timeout: T });
    expect(
      areaOpOf(page.url()),
      "resuming minted a fresh key, so the original could not be absorbed",
    ).toBe(key);

    // RESUME MEANS RE-ENTER. A settings-free resume is held, because such a
    // save cannot reproduce the settings she entered — if the original never
    // committed it would create an area missing all of them.
    expect(await openMachinePanel(page)).toBe(true);
    await enterIdentical(page, machineId);

    // STILL HELD, because the reload cleared the WHOLE draft and not only the
    // settings (Codex, #922 4307763145). Re-entering one machine group is
    // necessary and not sufficient: everything else would otherwise be saved
    // at its post-reload default while she believes she is restoring.
    await expect(
      page.getByTestId("save-treatment-area"),
      "save was reachable with only the machine group re-entered",
    ).toBeDisabled();
    await page.getByTestId("initial-save-resume-reconstructed").check();
    await expect(page.getByTestId("save-treatment-area")).toBeEnabled({
      timeout: T,
    });

    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect(page.getByTestId("save-treatment-area")).toHaveCount(0, {
      timeout: T,
    });

    const t = await totals(sessionId);
    expect(t.blocks, "the resumed save did not create the area").toBe(1);
    expect(t.claims, "the resumed save left no receipt under its key").toBe(1);
    expect(t.captures).toBe(1);
  });

  test.info().annotations.push({
    type: "gate-open",
    description: "An unsettled close was recovered by RESUME into one area.",
  });
});

test("(ii) START NEW creates a SECOND area with IDENTICAL values @390px", async ({
  page,
}) => {
  // SAM'S RULE, ON THIS PATH. The retained key is what makes absorption
  // possible, and absorption is exactly what must NOT happen when she says
  // this is a new area. Nothing here changes a clinical value to get one.
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  await loginAsOwner(page, seed);

  const key = await unsettledThenClose(page, clientId, sessionId, machineId);

  await test.step("START NEW releases the key", async () => {
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await expect(page.getByTestId("initial-save-resume-choice")).toBeVisible({
      timeout: T,
    });
    await page.getByTestId("initial-save-resume-choice-new").click({ timeout: T });
    expect(
      areaOpOf(page.url()),
      "start-new kept the old key, so an intentional second area would be absorbed",
    ).not.toBe(key);
  });

  await test.step("the first area saves with those values", async () => {
    expect(await openMachinePanel(page)).toBe(true);
    await enterIdentical(page, machineId);
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect(page.getByTestId("save-treatment-area")).toHaveCount(0, {
      timeout: T,
    });
    expect((await totals(sessionId)).blocks).toBe(1);
  });

  await test.step("and a BYTE-IDENTICAL second area is still a second area", async () => {
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    await enterIdentical(page, machineId);
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect(page.getByTestId("save-treatment-area")).toHaveCount(0, {
      timeout: T,
    });

    const t = await totals(sessionId);
    expect(
      t.blocks,
      "the identical second area was suppressed — she would have had to change a clinical value",
    ).toBe(2);
    expect(t.claims, "each save left its own receipt").toBe(2);

    // THE VALUES ARE COMPARED, not just counted: two areas that differed
    // would satisfy a count while failing the rule.
    const shapes = await readingsPerBlock(sessionId);
    expect(shapes).toHaveLength(2);
    expect(
      shapes[0],
      "the two areas do not hold identical readings, so this is not Sam's case",
    ).toBe(shapes[1]);
  });

  test.info().annotations.push({
    type: "gate-open",
    description:
      "An identical second area was created deliberately, with no value changed.",
  });
});

test("(iii) CONTROL: a SETTLED close clears the key, and the next Add is ordinary @390px", async ({
  page,
}) => {
  // Without this, every assertion above is satisfied by a form that NEVER
  // clears the key — which was the defect 4305701038 reported from the other
  // direction, and the reason this reversed twice.
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  expect(await openMachinePanel(page)).toBe(true);
  await enterIdentical(page, machineId);

  await test.step("a save that SETTLES leaves nothing behind", async () => {
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect(page.getByTestId("save-treatment-area")).toHaveCount(0, {
      timeout: T,
    });
    expect((await totals(sessionId)).blocks).toBe(1);
    expect(
      areaOpOf(page.url()),
      "a settled save left its key in the URL, so the next Add would resume it",
    ).toBeNull();
  });

  await test.step("so the next Add is an ORDINARY form, with no choice to make", async () => {
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await expect(page.getByTestId("initial-save-resume-choice")).toHaveCount(0);
    await expect(page.getByTestId("initial-save-resume-checking")).toHaveCount(0);
    // AND IT SAVES NORMALLY, with no settings at all - the case 4305701038
    // found blocked for ever by a retained key.
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect(page.getByTestId("save-treatment-area")).toHaveCount(0, {
      timeout: T,
    });
    expect((await totals(sessionId)).blocks).toBe(2);
  });

  test.info().annotations.push({
    type: "gate-open",
    description: "A settled close cleared the key and the next Add was ordinary.",
  });
});

test("an abandoned save does not poison the next one @390px", async ({ page }) => {
  // TWO FINDINGS AT ONCE (Codex #922 4305312340 and 4305312335). Cancel after
  // a failed save used to leave `area_op` in the URL, so the next Add treated
  // an abandoned attempt as an open save; and with the parameter still there,
  // opening EDIT on an existing area consumed the create key and froze the
  // edit with Cancel disabled.
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  const gateOpen = await openMachinePanel(page);
  if (!gateOpen) {
    test.info().annotations.push({
      type: "gate-closed",
      description:
        "No verified model is offered, so the abandon/edit cases did NOT run.",
    });
    return;
  }
  test.info().annotations.push({
    type: "gate-open",
    description: "The abandon and edit-mode cases executed.",
  });

  await test.step("a save is started, then abandoned with Cancel", async () => {
    await page.getByTestId("machine-select").selectOption(machineId);
    await page.getByTestId("reading-current").fill("120");
    await page.getByTestId("reading-duration").fill("300.5");
    await page.getByTestId("reading-energy_shown").fill("1.25");
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect(page.getByTestId("save-treatment-area")).toHaveCount(0, {
      timeout: T,
    });
  });

  await test.step("and EDIT on the saved area is not frozen by a stale id", async () => {
    // The parameter should already be gone; this asserts the consequence
    // rather than only the URL, because the consequence is what she feels.
    expect(areaOpOf(page.url())).toBeNull();
    // The edit trigger is keyed by block id (`edit-area-<uuid>`), so this
    // takes the one area on the chart by prefix rather than inventing a
    // testid that does not exist.
    await page
      .locator('[data-testid^="edit-area-"]')
      .first()
      .click({ timeout: T });
    await expect(page.getByTestId("cancel-treatment-area")).toBeEnabled({
      timeout: T,
    });
    // Nothing is claiming a save is unresolved.
    await expect(page.getByTestId("initial-save-already-saved")).toHaveCount(0);
  });
});
