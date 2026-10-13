import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { seedE2eStudio, seedE2eDraftElectrolysisSession, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// MPX-03 — the machine-first workflow in a real browser, against a real stack.
//
// Drives the sequence the Fett composition needs: a registered machine →
// selection → reading save → RELOAD → next-visit retrieval. Database rows are
// ground truth throughout; no assertion here passes on copy alone.
//
// ---------------------------------------------------------------------------
// WHY THIS SPEC HAS TWO HONEST HALVES
// ---------------------------------------------------------------------------
//
// Every REAL machine profile is evidence-gated and `blocked`, so the picker is
// empty by design and the workflow is undemonstrable without one active
// profile. The only active profile is the synthetic demo one, and it exists
// behind a gate that is deliberately hard to open: `server-only`,
// `HONE_SYNTHETIC_MACHINE_PROFILE` must equal exactly "1", and production is
// refused outright even if the flag leaks there.
//
// The gate is read IN THE NEXT SERVER PROCESS, so setting the variable in this
// spec's own process does nothing - it has to be in `webServer.env`
// (`E2E_WEB_SERVER_ENV`). This spec therefore adapts rather than assuming:
//
//   FLAG OFF - it asserts the claim that matters most, that NO real model is
//              offered. That is not a skip and not vacuous; it is the
//              evidence-gating rule under test in a real browser.
//   FLAG ON  - it drives the whole five-step workflow and asserts the rows.
//
// So this file is never green-by-skip. Whichever way the server is configured,
// it proves something real, and it reports which half ran.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 20_000;

/** The one profile that is active, and only behind the server-side gate. */
const SYNTHETIC_PROFILE_ID = "synthetic:demo-multineedle";
const SYNTHETIC_VERSION = 1;
// The synthetic profile declares four independently controlled outputs, and
// the published contract has to say so or a per-channel group is refused.
const SYNTHETIC_CHANNELS = 4;

async function noOverflow(page: Page) {
  const [sw, cw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(
    sw,
    `no horizontal overflow (scrollWidth ${sw} vs clientWidth ${cw})`,
  ).toBeLessThanOrEqual(cw);
}

/**
 * Register one machine directly, which is option (b) of the agreed split: the
 * owner-registration UI is not needed for this composition, so the row is
 * seeded and the four steps that touch the clinical record are driven.
 *
 * Seeded through the shared `sql` helper rather than by adding to
 * e2e/helpers/seed.ts, which two other branches are editing.
 */
async function registerMachine(studioId: string, displayName: string) {
  const id = randomUUID();
  await sql(
    `insert into public.studio_machines
       (id, studio_id, machine_profile_id, machine_profile_version, display_name)
     values ($1, $2, $3, $4, $5)`,
    [id, studioId, SYNTHETIC_PROFILE_ID, SYNTHETIC_VERSION, displayName],
  );

  // PUBLISH THE CONTRACT for this profile version, through the COMMAND.
  //
  // `record_treatment_setup_group` validates every reading against the
  // published contract and FAILS CLOSED when none exists. In production
  // deployment authority publishes it; this spec seeds its unit directly, so it
  // has to publish too or steps 6-7 would be refused - and that refusal would
  // look like a broken feature rather than an unseeded fixture.
  //
  // THROUGH THE COMMAND, not raw inserts. An earlier version of this inserted
  // into machine_profile_field_contract directly and broke the moment the
  // schema grew a parent: the field contract now has an FK to
  // machine_profile_mode_contract and a NOT NULL `quantity`, so the raw insert
  // violated both. Calling the command means the fixture cannot drift from the
  // schema again. `sql()` runs as postgres, which is the deployment authority
  // the command requires - EXECUTE is revoked from `authenticated`.
  //
  // The rows mirror the synthetic profile's galvanic mode: current in µA at
  // whole numbers, duration in seconds at one decimal. The save assertions are
  // about the machine's OWN unit and precision surviving, so these must match
  // the profile rather than be convenient.
  await sql(
    `select public.sync_machine_profile_contract($1, $2, 'galvanic', $3, null, $4::jsonb)`,
    [
      SYNTHETIC_PROFILE_ID,
      SYNTHETIC_VERSION,
      SYNTHETIC_CHANNELS,
      JSON.stringify([
        { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current" },
        { field_key: "duration", native_unit: "s", decimals: 1, quantity: "duration" },
      ]),
    ],
  );
  return id;
}

async function readingsFor({ blockId }: { blockId: string }) {
  return sql<{
    field_key: string;
    value_numeric: string | null;
    native_unit: string;
    decimals: number;
    machine_profile_id: string;
    machine_profile_version: number;
    recorded_by_practitioner_id: string | null;
  }>(
    `select field_key, value_numeric::text as value_numeric, native_unit, decimals,
            machine_profile_id, machine_profile_version, recorded_by_practitioner_id
       from public.treatment_setup_readings
      where session_block_id = $1
      order by field_key`,
    [blockId],
  );
}

/**
 * Every reading in a studio, for the "nothing was recorded" claim. Separate
 * from readingsFor({ blockId }) on purpose: the gate-closed branch has no block
 * to name, and reaching for the nearest id in scope is what made that
 * assertion vacuous in the first place.
 */
async function readingsInStudio(studioId: string) {
  return sql<{ field_key: string; session_block_id: string }>(
    `select field_key, session_block_id
       from public.treatment_setup_readings
      where studio_id = $1
      order by field_key`,
    [studioId],
  );
}

/**
 * ANOTHER session for a client who already exists — the next visit.
 *
 * Deliberately NOT seedE2eDraftElectrolysisSession, which inserts a FRESH
 * CLIENT on every call (`const clientId = randomUUID()`). Step 9 used it and so
 * navigated to a different person's chart.
 *
 * Before the client-scoping fix that passed anyway, because the prior-setup
 * read was studio-scoped and found the readings regardless of whose chart was
 * open — i.e. the step was passing BECAUSE of the defect, and asserting
 * nothing about same-client retrieval. Now that latest_setup_for_client filters
 * by client_id, the old fixture makes the step hang until timeout, which reads
 * like a broken feature and is a broken fixture. Found by Codex at a66f5ec9.
 */
async function seedNextVisitForSameClient(
  studioId: string,
  clientId: string,
): Promise<{ sessionId: string }> {
  const prac = (
    await sql<{ id: string }>(
      `select id from public.practitioners
        where studio_id = $1 and role = 'owner' limit 1`,
      [studioId],
    )
  )[0]!;
  const rows = await sql<{ id: string }>(
    `insert into public.sessions (studio_id, client_id, practitioner_id, modality)
     values ($1, $2, $3, 'electrolysis')
     returning id`,
    [studioId, clientId, prac.id],
  );
  return { sessionId: rows[0]!.id };
}

async function openSettingsForm(page: Page, clientId: string, sessionId: string) {
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({
    timeout: T,
  });
}

/** Open the machine panel and report whether the gate is open. */
async function openMachinePanel(page: Page): Promise<boolean> {
  // It loads ON DEMAND. That is load-bearing: an on-mount request once broke
  // repeat-client-fast-charting, which classifies any server-action POST
  // without an idempotencyKey as a source re-read.
  await expect(page.getByTestId("machine-first-trigger")).toBeVisible({ timeout: T });
  await page.getByTestId("machine-first-open").click();
  await expect(page.getByTestId("machine-first-panel")).toBeVisible({ timeout: T });

  // IS THE GATE OPEN? The panel has THREE states, and an earlier version of
  // this helper only recognised one of them:
  //
  //   selectable.length === 0  -> "No verified machine is available"  (CLOSED)
  //   !chosen                  -> the picker                          (OPEN)
  //   chosen                   -> the machine-chosen block            (OPEN)
  //
  // It returned "offered a selection" only for the picker, so once the
  // remembered selection actually PERSISTED - which it now does - the second
  // mount showed the chosen machine and this read it as a failure. The ops01
  // lane's gate-open run found exactly that at step 6, on the edit form of the
  // block just saved. A consequence of fixing persistence, not of the panel.
  const picker = page.getByText(/Choose the machine you are working on/i);
  const chosen = page.getByTestId("machine-chosen");
  return (await picker.count()) > 0 || (await chosen.count()) > 0;
}

test("machine-first: no real model is ever offered, and the synthetic workflow records and retrieves @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  await loginAsOwner(page, seed);

  let gateOpen = false;

  await test.step("1: the panel makes no request until asked, then opens", async () => {
    await openSettingsForm(page, clientId, sessionId);
    gateOpen = await openMachinePanel(page);
    await noOverflow(page);
  });

  await test.step("2: every REAL model is listed as not selectable, with a reason", async () => {
    // True in BOTH halves, and the single most important claim in this file:
    // evidence-gating is visible to the practitioner rather than silent.
    await expect(page.getByText("Not yet selectable")).toBeVisible({ timeout: T });
    for (const name of [
      "Silhouet-Tone Evolution ST 350",
      "Silhouet-Tone ST 250",
      "Permanence GEMM-16 (US)",
      "Dectro Junior 3G",
    ]) {
      await expect(
        page.getByText(name, { exact: false }).first(),
        `${name} must be shown as withheld, not silently omitted`,
      ).toBeVisible({ timeout: T });
    }
    // And none of them is a choice.
    expect(
      await page.locator('[data-testid^="machine-pick-"]').count(),
      "a real model was offered as selectable",
    ).toBeLessThanOrEqual(1);
  });

  if (!gateOpen) {
    await test.step("GATE CLOSED: nothing is selectable, which is the rule under test", async () => {
      // HONE_SYNTHETIC_MACHINE_PROFILE is not set in the SERVER's environment
      // (webServer.env / E2E_WEB_SERVER_ENV). With no active profile, a
      // registered machine is still not offerable - that is the gate working,
      // not a missing fixture.
      await expect(
        page.getByText(/No verified machine is available to select yet/i),
      ).toBeVisible({ timeout: T });
      expect(await page.locator('[data-testid^="machine-pick-"]').count()).toBe(0);
      // Nothing was recorded, because nothing could be.
      //
      // THIS ASSERTION WAS VACUOUS until Codex found it at 9c6fbbe5: it called
      // readingsFor(machineId) while the helper filters session_block_id, so
      // two unrelated UUIDs guaranteed an empty result and the expectation
      // could not fail. It had already "passed" on three CI runners.
      //
      // Scoped to the STUDIO now, which is a stronger claim than the one
      // originally intended - nothing was recorded anywhere in this studio, not
      // merely nothing against this machine - and there is no id to mismatch.
      const rows = await readingsInStudio(seed.studioId);
      expect(rows, "a reading was recorded while no profile was selectable").toHaveLength(0);
    });
    test.info().annotations.push({
      type: "gate-closed",
      description:
        "HONE_SYNTHETIC_MACHINE_PROFILE is not in the server env, so the " +
        "selection/save/retrieval half did not run. Set it in E2E_WEB_SERVER_ENV " +
        "to exercise the full workflow. The evidence-gating half above DID run.",
    });
    return;
  }

  // ---- GATE OPEN: the full workflow -------------------------------------
  let blockId = "";

  await test.step("3: the synthetic machine is selectable, and names its model", async () => {
    await expect(page.getByTestId(`machine-pick-${machineId}`)).toBeVisible({
      timeout: T,
    });
    // Scoped to the BUTTON and then to the CHOSEN block. Page-wide text
    // locators are what broke step 4 (3 matches, the field's advisory notes
    // contain its name), and the same shape would bite here as soon as a
    // prior-setup card renders the model too.
    await expect(page.getByTestId(`machine-pick-${machineId}`)).toContainText(
      "Synthetic Demo Multineedle",
    );
    await page.getByTestId(`machine-pick-${machineId}`).click();
    await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
      timeout: T,
    });
    await noOverflow(page);
  });

  await test.step("4: the chart shows that model's NATIVE fields", async () => {
    // Labels and units are the machine's own, from the profile - not this
    // spec's and not the schema's.
    //
    // TARGETED BY TESTID, not by page text. getByText("Current") was a
    // strict-mode violation with THREE matches: the field label, plus two
    // advisory notes that legitimately contain the field's name ("Current is
    // documented in microamps and per-probe..."). Found by the ops01 lane's
    // gate-open diagnostic, which is the first run that ever reached this step
    // with a selectable machine - the gate-closed half returns before here, so
    // no amount of CI on the closed path could have caught it.
    //
    // It also makes the assertion stronger: prose mentioning the word cannot
    // satisfy "the machine's own label is rendered".
    await expect(page.getByTestId("field-label-current")).toHaveText("Current", {
      timeout: T,
    });
    await expect(page.getByTestId("field-unit-current")).toHaveText("(µA)");
    // "Time" is the GEMM's native name for duration - the profile's word, not
    // the quantity's, which is the thing worth proving.
    await expect(page.getByTestId("field-label-duration")).toHaveText("Time");
    await expect(page.getByTestId("field-unit-duration")).toHaveText("(s)");
  });

  await test.step("5: save the settings block, so there is a block to record against", async () => {
    // The panel refuses to collect a reading it has nowhere to put, so the
    // block must exist first. Entry appears on the saved block's edit form.
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(
        async () => {
          const rows = await sql<{ id: string }>(
            `select id from public.session_blocks
              where session_id = $1 and deleted_at is null order by sort_order limit 1`,
            [sessionId],
          );
          blockId = rows[0]?.id ?? "";
          return blockId;
        },
        { timeout: T, message: "the settings block never saved" },
      )
      .not.toBe("");
  });

  await test.step("6: READINGS SAVE to the database, with native unit and precision", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
    const open = await openMachinePanel(page);
    expect(open, "the machine panel did not offer a selection on the edit form").toBe(
      true,
    );

    // The remembered machine is already chosen - step 8 asserts that properly.
    if ((await page.getByTestId(`machine-pick-${machineId}`).count()) > 0) {
      await page.getByTestId(`machine-pick-${machineId}`).click();
    }

    await page.getByTestId("reading-current").fill("135");
    await page.getByTestId("reading-duration").fill("300.5");
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({ timeout: T });

    const rows = await readingsFor({ blockId });
    expect(rows.map((r) => r.field_key)).toEqual(["current", "duration"]);
    const byField = new Map(rows.map((r) => [r.field_key, r]));
    // Native unit and the machine's precision survive the browser round trip.
    expect(byField.get("current")!.native_unit).toBe("µA");
    expect(byField.get("current")!.value_numeric).toBe("135");
    expect(byField.get("duration")!.value_numeric).toBe("300.5");
    expect(byField.get("duration")!.decimals).toBe(1);
    // Provenance: the captured profile version and who recorded it.
    expect(byField.get("current")!.machine_profile_id).toBe(SYNTHETIC_PROFILE_ID);
    expect(byField.get("current")!.machine_profile_version).toBe(SYNTHETIC_VERSION);
    expect(byField.get("current")!.recorded_by_practitioner_id).not.toBeNull();
  });

  await test.step("7: a recorded reading is IMMUTABLE — re-saving the same field is refused", async () => {
    // Not a UI claim: the database refuses it, so a second save cannot
    // overwrite the first observation.
    const before = await readingsFor({ blockId });
    let refused = false;
    try {
      await sql(
        `insert into public.treatment_setup_readings
           (studio_id, session_block_id, machine_profile_id, machine_profile_version,
            mode_key, group_key, field_key, value_numeric, native_unit, decimals,
            observation_source)
         values ($1, $2, $3, $4, 'galvanic', 'g1', 'current', 999, 'µA', 0,
                 'practitioner-entered')`,
        [seed.studioId, blockId, SYNTHETIC_PROFILE_ID, SYNTHETIC_VERSION],
      );
    } catch {
      refused = true;
    }
    expect(refused, "a duplicate reading for the same field was accepted").toBe(true);
    const after = await readingsFor({ blockId });
    expect(after).toEqual(before);
  });

  await test.step("8: RELOAD — the remembered machine survives a fresh page load", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
    await openMachinePanel(page);
    // Chosen already, from the database rather than from component state.
    await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
      timeout: T,
    });
    await expect(page.getByTestId("machine-first-status")).toHaveAttribute(
      "data-persistence",
      "database",
      { timeout: T },
    );

    const remembered = await sql<{ default_machine_id: string | null }>(
      `select p.default_machine_id
         from public.practitioners p
        where p.studio_id = $1 and p.role = 'owner'`,
      [seed.studioId],
    );
    expect(remembered[0]?.default_machine_id).toBe(machineId);
  });

  await test.step("9: NEXT-VISIT RETRIEVAL — the prior setup is shown on a new visit", async () => {
    // THE SAME CLIENT, a later visit. This is the whole point of the step:
    // next-visit guidance must come from THIS client's own history.
    const next = await seedNextVisitForSameClient(seed.studioId, clientId);
    await page.goto(`/clients/${clientId}/sessions/${next.sessionId}`);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await openMachinePanel(page);

    const prior = page.getByTestId("machine-prior-setup");
    await expect(prior).toBeVisible({ timeout: T });
    // SCOPED TO THE CARD. A machine is also REMEMBERED from the previous visit
    // here, so the chosen-machine block names the same model and a page-wide
    // locator is a 2-match strict-mode violation. Found by auditing the rest of
    // the file after step 4 failed, rather than waiting for the next run.
    await expect(prior).toContainText("Last recorded setup");
    await expect(prior).toContainText("Synthetic Demo Multineedle");
    // The values, in their own units, from the previous visit.
    await expect(page.getByTestId("machine-prior-setup")).toContainText("135");
    await expect(page.getByTestId("machine-prior-setup")).toContainText("300.5");
    await expect(page.getByTestId("machine-prior-setup")).toContainText("µA");
    await noOverflow(page);
  });

  await test.step("9b: ANOTHER client's chart does NOT show this setup", async () => {
    // The negative half, without which step 9 would pass again the moment the
    // prior-setup read regressed to studio scoping - which is exactly how the
    // original defect hid. A studio-mate must see nothing from this client.
    const stranger = await seedE2eDraftElectrolysisSession(seed);
    await page.goto(`/clients/${stranger.clientId}/sessions/${stranger.sessionId}`);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await openMachinePanel(page);
    await expect(
      page.getByTestId("machine-prior-setup"),
      "another client's chart showed this client's recorded setup",
    ).toHaveCount(0);
  });

  await test.step("10: the earlier reading is unchanged by the new visit", async () => {
    const rows = await readingsFor({ blockId });
    const byField = new Map(rows.map((r) => [r.field_key, r]));
    expect(byField.get("current")!.value_numeric).toBe("135");
    expect(byField.get("duration")!.value_numeric).toBe("300.5");
  });
});
