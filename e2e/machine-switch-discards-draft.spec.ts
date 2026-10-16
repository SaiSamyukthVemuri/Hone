import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { seedE2eStudio, seedE2eDraftElectrolysisSession, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// MPX-03 — CHANGING THE MACHINE, CHANGING THE MODE, AND LOSING THE UNIT.
//
// WHY A SEPARATE FILE from machine-create-mode-journey.spec.ts. That one walks
// the single path a practitioner takes on a new treatment, in order, and its
// row counts are the arithmetic of that one walk. This one does the opposite:
// it changes the setup identity underneath a draft she has already typed, over
// and over, and asserts what must NOT be in the record afterwards. Folding
// these steps into the journey would mean re-deriving every count in it for
// cases that have nothing to do with the happy path.
//
// WHAT IT PROVES, and each one is a way to record the wrong thing permanently
// in an append-only clinical table:
//
//   1. A UNIT SWITCH with nothing re-typed, then SAVE. Nothing may be
//      recorded - not the first unit's numbers, and not the second's either.
//   2. A MODE SWITCH on one unit, which until this fixture existed could not
//      happen in a browser at all: the panel renders its mode picker only when
//      a unit offers a choice, and every synthetic profile carried exactly one
//      mode. `machine-mode-picker` had never rendered in any run.
//   3. THE SAME BLOCK then recording under BOTH units, each capture carrying
//      its own machine, profile and mode - the realistic case of moving a
//      client to another room's unit mid-treatment.
//   4. THE UNIT GOING OUT OF SERVICE while the draft is live. The save is
//      refused, and because the area and its settings are ONE transaction the
//      refusal takes the AREA with it: no block, no capture, no reading.
//
// THE TWO UNITS DISAGREE ON PURPOSE, and so do the two modes. Both share the
// field key `current` at different units and precision, so a value carried
// over is VISIBLE in the next form's box rather than having nowhere to show;
// and each has a field the other lacks, so "the other contract is gone" is
// distinguishable from "the other contract was relabelled". Those properties
// are asserted as fixture facts in tests/app/machines/machine-setup-actions,
// so this spec can rely on them instead of restating them.
//
// GATE-OPEN / GATE-CLOSED PAIR, like its siblings. Every real machine profile
// is evidence-gated and `blocked`, so the picker is empty unless
// HONE_SYNTHETIC_MACHINE_PROFILE is exactly "1" in the NEXT SERVER's env
// (`E2E_WEB_SERVER_ENV`) - setting it in this process does nothing. A
// gate-closed run proves the evidence gate instead, says so in an annotation,
// and is NOT acceptance evidence for anything below it.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 20_000;

/** Unit A: four channels, galvanic, `current` in µA at 0 decimals. */
const MULTI = {
  profileId: "synthetic:demo-multineedle",
  version: 2,
  channels: 4,
  modeKey: "galvanic",
  fields: [
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
  ],
} as const;

/**
 * Unit B: no channels, TWO modes, and `current` in mA at 2 decimals.
 *
 * The contract is published per (profile, version, MODE), so two modes are two
 * calls to the publisher. Both are published up front: a mode whose contract
 * is missing is refused at save time with a message about the contract, which
 * would read exactly like the defect this spec is looking for.
 */
const SINGLE = {
  profileId: "synthetic:demo-single-probe",
  version: 1,
  channels: null,
  modes: {
    blend: [
      { field_key: "current", native_unit: "mA", decimals: 2, quantity: "current" },
      { field_key: "pulse_width", native_unit: "ms", decimals: 0, quantity: "duration" },
    ],
    thermolysis: [
      { field_key: "current", native_unit: "µA", decimals: 1, quantity: "current" },
      { field_key: "intensity", native_unit: "%", decimals: 0, quantity: "intensity" },
    ],
  },
} as const;

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
 * Register one physical unit and publish its contract, THROUGH THE COMMAND.
 *
 * The owner-registration UI is not this spec's subject, so the inventory row
 * is seeded directly. The CONTRACT goes through `sync_machine_profile_contract`
 * because the field contract has an FK to the mode contract and a NOT NULL
 * `quantity`; a raw insert broke on both the moment the schema grew. `sql()`
 * runs as postgres, which is the deployment authority the publisher requires.
 */
async function registerUnit(
  studioId: string,
  displayName: string,
  profileId: string,
  version: number,
  channels: number | null,
  contracts: Record<string, readonly unknown[]>,
) {
  const id = randomUUID();
  await sql(
    `insert into public.studio_machines
       (id, studio_id, machine_profile_id, machine_profile_version, display_name)
     values ($1, $2, $3, $4, $5)`,
    [id, studioId, profileId, version, displayName],
  );
  for (const [modeKey, fields] of Object.entries(contracts)) {
    await sql(
      `select public.sync_machine_profile_contract($1, $2, $3, $4, null, $5::jsonb)`,
      [profileId, version, modeKey, channels, JSON.stringify(fields)],
    );
  }
  return id;
}

async function capturesFor(blockId: string) {
  return sql<{
    group_key: string;
    revision: number;
    mode_key: string;
    studio_machine_id: string;
    machine_profile_id: string;
    machine_profile_version: number;
    setup_submission_id: string | null;
  }>(
    `select group_key, revision, mode_key, studio_machine_id,
            machine_profile_id, machine_profile_version, setup_submission_id
       from public.treatment_setup_captures
      where session_block_id = $1
      order by group_key, revision`,
    [blockId],
  );
}

async function readingsFor(blockId: string) {
  return sql<{
    group_key: string;
    field_key: string;
    value_numeric: string | null;
    native_unit: string;
    decimals: number;
    mode_key: string;
    observation_source: string;
  }>(
    `select group_key, field_key, value_numeric::text as value_numeric,
            native_unit, decimals, mode_key, observation_source
       from public.treatment_setup_readings
      where session_block_id = $1
      order by mode_key, group_key, field_key`,
    [blockId],
  );
}

/** Every reading in the studio — for the "nothing at all was recorded" claims. */
async function readingsInStudio(studioId: string) {
  return sql<{ field_key: string; value_numeric: string | null }>(
    `select field_key, value_numeric::text as value_numeric
       from public.treatment_setup_readings where studio_id = $1`,
    [studioId],
  );
}

/** How many readings exist against one physical unit, anywhere. */
async function readingsOnUnit(machineId: string) {
  const rows = await sql<{ n: string }>(
    `select count(*)::text as n from public.treatment_setup_readings
      where studio_machine_id = $1`,
    [machineId],
  );
  return Number(rows[0]!.n);
}

async function blockIdOf(sessionId: string) {
  const rows = await sql<{ id: string }>(
    `select id from public.session_blocks
      where session_id = $1 and deleted_at is null
      order by sort_order limit 1`,
    [sessionId],
  );
  return rows[0]?.id ?? "";
}

async function blockCountOf(sessionId: string) {
  const rows = await sql<{ n: string }>(
    `select count(*)::text as n from public.session_blocks
      where session_id = $1 and deleted_at is null`,
    [sessionId],
  );
  return Number(rows[0]!.n);
}

async function openCreateForm(page: Page, clientId: string, sessionId: string) {
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({
    timeout: T,
  });
}

/** Open the machine panel and report whether the gate is open. */
async function openMachinePanel(page: Page): Promise<boolean> {
  await expect(page.getByTestId("machine-first-trigger")).toBeVisible({ timeout: T });
  await page.getByTestId("machine-first-open").click();
  await expect(page.getByTestId("machine-first-panel")).toBeVisible({ timeout: T });
  // COUNTING OPTIONS, not the control's presence: the dropdown also renders
  // disabled with only the empty option when the studio has nothing usable,
  // and that is the gate-CLOSED case wearing the same testid.
  const select = page.getByTestId("machine-select");
  const chosen = page.getByTestId("machine-chosen");
  if ((await select.count()) === 0) return (await chosen.count()) > 0;
  return (await select.locator("option").count()) > 1 || (await chosen.count()) > 0;
}

test("a machine or mode switch discards the draft, and an out-of-service unit refuses the save @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const unitA = await registerUnit(
    seed.studioId,
    "Room 1 multineedle",
    MULTI.profileId,
    MULTI.version,
    MULTI.channels,
    { [MULTI.modeKey]: MULTI.fields },
  );
  const unitB = await registerUnit(
    seed.studioId,
    "Room 2 single-probe",
    SINGLE.profileId,
    SINGLE.version,
    SINGLE.channels,
    SINGLE.modes,
  );
  await loginAsOwner(page, seed);

  let gateOpen = false;

  await test.step("1: the create form offers both units", async () => {
    await openCreateForm(page, clientId, sessionId);
    gateOpen = await openMachinePanel(page);
    await noOverflow(page);
  });

  if (!gateOpen) {
    await test.step("GATE CLOSED: no real model is offered, and nothing is recorded", async () => {
      await expect(
        page.getByText(/No verified machine is available to select yet/i),
      ).toBeVisible({ timeout: T });
      const sel = page.getByTestId("machine-select");
      const real =
        (await sel.count()) === 0 ? 0 : (await sel.locator("option").count()) - 1;
      expect(real, "a real machine was offered with the gate closed").toBe(0);
      // SCOPED TO THE STUDIO, because this branch has no block to name.
      expect(
        await readingsInStudio(seed.studioId),
        "a reading exists although no machine could be selected",
      ).toHaveLength(0);
    });
    test.info().annotations.push({
      type: "gate-closed",
      description:
        "HONE_SYNTHETIC_MACHINE_PROFILE is not in the server env, so the " +
        "switch cases did NOT run. Only the evidence-gating half above " +
        "executed. This run is not acceptance evidence for them.",
    });
    return;
  }

  test.info().annotations.push({
    type: "gate-open",
    description: "The unit-switch, mode-switch and out-of-service cases executed.",
  });

  // Both units must really be offered, or every switch below is vacuous.
  expect(
    await page.getByTestId("machine-select").locator("option").count(),
    "two units plus the empty option",
  ).toBe(3);

  let blockId = "";

  await test.step("2: unit A is chosen and its OWN contract is collected", async () => {
    await page.getByTestId("machine-select").selectOption(unitA);
    await expect(page.getByTestId("machine-chosen")).toContainText(
      "Room 1 multineedle",
      { timeout: T },
    );
    // A's contract, by testid rather than page text: a field's advisory notes
    // legitimately contain its own name.
    await expect(page.getByTestId("field-unit-current")).toHaveText("(µA)", {
      timeout: T,
    });
    await expect(page.getByTestId("field-unit-duration")).toHaveText("(s)");
    // ONE MODE, so A offers no mode picker. Asserted so the picker's
    // appearance under B below means something.
    await expect(
      page.getByTestId("machine-mode-picker"),
      "a single-mode unit must not render a picker",
    ).toHaveCount(0, { timeout: T });

    await page.getByTestId("reading-current").fill("99");
    await page.getByTestId("reading-duration").fill("111.1");
    await page.getByTestId("reading-energy_shown").fill("9.99");
    await noOverflow(page);
  });

  await test.step("3: switching to unit B discards A's draft, unit and precision", async () => {
    await page.getByTestId("machine-select").selectOption(unitB);
    await expect(page.getByTestId("machine-chosen")).toContainText(
      "Room 2 single-probe",
      { timeout: T },
    );

    // THE MODE PICKER, rendering in a browser for the first time: it appears
    // only when a unit offers a choice, and until this profile carried two
    // modes no run could reach it.
    await expect(page.getByTestId("machine-mode-picker")).toBeVisible({ timeout: T });
    await expect(page.getByTestId("machine-mode-blend")).toBeVisible();
    await expect(page.getByTestId("machine-mode-thermolysis")).toBeVisible();
    // Choosing a DEVICE resets the mode to that device's own first one, which
    // is what makes a remembered mode from another profile unreachable.
    await expect(page.getByTestId("machine-mode-blend")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // B'S CONTRACT, NOT A's, and all three ways it differs:
    await expect(page.getByTestId("field-unit-current")).toHaveText("(mA)", {
      timeout: T,
    });
    await expect(page.getByTestId("field-label-pulse_width")).toHaveText("Pulse width");
    // RETRYING, NOT A SNAPSHOT, and the first run of this spec on the synced
    // tree is why. `count()` samples ONE instant; these assertions run inside
    // the window where the server action that persists the selection replies
    // and Next re-renders the route's server components, so for a moment the
    // panel can show the PREVIOUSLY remembered unit before settling on the new
    // one. The spec passed alone in 24.4s and failed in the four-spec batch at
    // 7.6s - same code, different timing, which is the signature of sampling a
    // transition rather than a defect.
    //
    // IT DOES NOT MASK THE DEFECT IT IS CHECKING FOR. `toHaveCount(0)` retries
    // to the timeout and then fails, so a panel that genuinely reverts to A and
    // STAYS there still reds this step. What it tolerates is the flicker, not
    // the wrong end state - and the database was correct throughout: the owned
    // stack recorded `Room 2 single-probe / blend` as the persisted default.
    await expect(
      page.getByTestId("field-unit-duration"),
      "A's `duration` must be gone, not relabelled",
    ).toHaveCount(0, { timeout: T });
    await expect(
      page.getByTestId("field-label-energy_shown"),
      "A's `energy_shown` must be gone",
    ).toHaveCount(0, { timeout: T });

    // THE DEFECT THIS WHOLE FILE EXISTS FOR (Codex, db3373bc P1). `current`
    // is a key BOTH contracts declare, so a draft that survived the switch
    // would show 99 here - in millamps, on a unit she never read it off.
    await expect(
      page.getByTestId("reading-current"),
      "a draft typed under another unit survived the switch",
    ).toHaveValue("");
    await noOverflow(page);
  });

  await test.step("4: saving right now records NOTHING - not A's values, not B's", async () => {
    // SAM'S PROOF ITEM, and the shape that makes it falsifiable: she switched
    // and did NOT re-type, so there is nothing legitimate to store. If the
    // host form had kept A's draft it would be sent under A's own identity -
    // the draft carries the identity it was typed under - and a capture would
    // exist here with 99 in it.
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect
      .poll(
        async () => {
          blockId = await blockIdOf(sessionId);
          return blockId;
        },
        { timeout: T, message: "the create form saved no treatment area" },
      )
      .not.toBe("");

    // THE AREA IS SAVED - that is an ordinary save of an area with no machine
    // settings, and the command must not invent a reason to refuse it.
    expect(await capturesFor(blockId), "a capture was allocated with nothing entered")
      .toHaveLength(0);
    expect(await readingsFor(blockId)).toHaveLength(0);
    // STUDIO-WIDE, so this cannot pass by scoping to the wrong row: nowhere in
    // the studio is there a reading carrying either unit's numbers.
    expect(
      await readingsInStudio(seed.studioId),
      "a reading was recorded although nothing was re-entered after the switch",
    ).toHaveLength(0);
  });

  await test.step("5: a MODE switch discards the draft too, and writes nothing by itself", async () => {
    // Re-enter the saved area. The block exists now, so the panel offers the
    // RECORDING form rather than the collector.
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    // The unit chosen before the block existed is remembered.
    await expect(page.getByTestId("machine-chosen")).toContainText(
      "Room 2 single-probe",
      { timeout: T },
    );
    await expect(page.getByTestId("machine-reading-entry")).toBeVisible({ timeout: T });

    // Enter blend's fields - at blend's precision, 2 decimals.
    await page.getByTestId("reading-current").fill("1.25");
    await page.getByTestId("reading-pulse_width").fill("5");

    // NOW CHANGE THE MODE, nothing else. Same unit, same profile, same
    // version: only the field contract moves.
    await page.getByTestId("machine-mode-thermolysis").click();
    await expect(page.getByTestId("machine-mode-thermolysis")).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: T },
    );
    await expect(page.getByTestId("field-unit-current")).toHaveText("(µA)", {
      timeout: T,
    });
    await expect(page.getByTestId("field-label-intensity")).toHaveText("Intensity");
    // Retrying, for the same reason as step 3: a mode change also persists
    // through a server action, so this reads the settled state rather than an
    // instant inside the reply window.
    await expect(
      page.getByTestId("reading-pulse_width"),
      "blend's `pulse_width` must be gone under thermolysis",
    ).toHaveCount(0, { timeout: T });
    await expect(
      page.getByTestId("reading-current"),
      "a draft typed under another MODE survived the switch",
    ).toHaveValue("");

    // AND THE SWITCH ITSELF WROTE NOTHING CLINICAL. Changing mode persists a
    // UI preference; it must not allocate a capture.
    expect(await capturesFor(blockId), "a mode change recorded a capture").toHaveLength(
      0,
    );

    // Record under thermolysis, at ITS precision - 1 decimal.
    await page.getByTestId("reading-current").fill("4.5");
    await page.getByTestId("reading-intensity").fill("70");
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({ timeout: T });

    const caps = await capturesFor(blockId);
    expect(caps, "one save, one capture").toHaveLength(1);
    expect(caps[0]!.mode_key).toBe("thermolysis");
    expect(caps[0]!.studio_machine_id).toBe(unitB);
    expect(caps[0]!.machine_profile_id).toBe(SINGLE.profileId);
    expect(caps[0]!.setup_submission_id, "a capture must carry its save").not.toBeNull();

    const rows = await readingsFor(blockId);
    expect(rows).toHaveLength(2);
    const byField = new Map(rows.map((r) => [r.field_key, r]));
    // THE CONTRACT'S OWN UNIT AND PRECISION, derived from the published
    // contract rather than from anything the browser sent.
    expect(byField.get("current")!.native_unit).toBe("µA");
    expect(byField.get("current")!.decimals).toBe(1);
    expect(byField.get("current")!.value_numeric).toBe("4.5");
    expect(byField.get("intensity")!.native_unit).toBe("%");
    expect(byField.get("intensity")!.value_numeric).toBe("70");
    // AND BLEND'S DRAFT IS NOWHERE: neither its value nor its only field.
    expect(
      rows.some((r) => r.value_numeric === "1.25"),
      "the pre-switch draft was recorded under the new mode",
    ).toBe(false);
    expect(byField.has("pulse_width"), "a field of the abandoned mode was stored").toBe(
      false,
    );
  });

  await test.step("6: the SAME area then records under unit A, each capture its own", async () => {
    // The realistic case: she moves the client to the other room's unit
    // mid-treatment. Both captures stay, each carrying the machine, profile
    // and mode it was recorded under - which is why the capture holds them
    // rather than the block.
    await page.getByTestId("machine-select").selectOption(unitA);
    await expect(page.getByTestId("machine-chosen")).toContainText(
      "Room 1 multineedle",
      { timeout: T },
    );
    await expect(page.getByTestId("field-unit-current")).toHaveText("(µA)", {
      timeout: T,
    });
    // A's own contract is back, including the field only it has.
    await expect(page.getByTestId("field-label-energy_shown")).toBeVisible();
    // AND THE FORM IS EMPTY AGAIN - the thermolysis values were SAVED, not
    // carried: nothing is ever pre-filled from what is stored.
    await expect(page.getByTestId("reading-current")).toHaveValue("");

    await page.getByTestId("setting-group-g1-channel-1").click();
    await page.getByTestId("reading-current").fill("115");
    await page.getByTestId("reading-duration").fill("290.0");
    await page.getByTestId("reading-energy_shown").fill("1.10");
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({ timeout: T });

    const caps = await capturesFor(blockId);
    expect(caps, "the thermolysis capture plus this one").toHaveLength(2);
    const byMachine = new Map(caps.map((c) => [c.studio_machine_id, c]));
    expect(byMachine.get(unitB)!.mode_key).toBe("thermolysis");
    expect(byMachine.get(unitA)!.mode_key).toBe(MULTI.modeKey);
    expect(byMachine.get(unitA)!.machine_profile_id).toBe(MULTI.profileId);
    // TWO SAVES, so two submissions: they are separate acts minutes apart.
    expect(new Set(caps.map((c) => c.setup_submission_id)).size).toBe(2);
    // EACH UNIT'S OWN SEQUENCE STARTS AT 1, and this assertion used to say
    // the opposite.
    //
    // It read "APPEND-ONLY: the same group key, the next revision" and
    // required [1, 2] — but these two captures are on DIFFERENT MACHINES,
    // so they are not one setting history and the second is nobody's
    // revision 2. Rendering it as "capture 2" asserted an earlier capture
    // in a history that has none, and implied a mid-treatment change that
    // never happened (Codex, #860 4299434260).
    //
    // Append-only is unaffected and still proved: two captures, two
    // submissions, nothing overwritten. What changed is that the NUMBER
    // belongs to the unit, not to the block.
    expect(caps.map((c) => c.revision)).toEqual([1, 1]);
    expect(
      new Set(caps.map((c) => c.studio_machine_id)).size,
      "the two captures must be on different units for this to mean anything",
    ).toBe(2);

    const rows = await readingsFor(blockId);
    expect(rows, "2 thermolysis + 3 galvanic").toHaveLength(5);
    const galv = rows.filter((r) => r.mode_key === MULTI.modeKey);
    const current = galv.find((r) => r.field_key === "current")!;
    expect(current.native_unit).toBe("µA");
    expect(current.decimals, "A's precision, not B's").toBe(0);
    expect(current.value_numeric).toBe("115");
    // PER-FIELD PROVENANCE survives: A's contract says the machine shows this
    // one, and the record has to agree.
    expect(galv.find((r) => r.field_key === "energy_shown")!.observation_source).toBe(
      "machine-displayed",
    );
    // The thermolysis capture is untouched by a later save under another unit.
    expect(
      rows.filter((r) => r.mode_key === "thermolysis").map((r) => r.value_numeric).sort(),
      "an earlier capture changed when a second unit recorded",
    ).toEqual(["4.5", "70"]);
  });

  await test.step("6b: CLEARING the machine discards the draft too - the limb this file missed", async () => {
    // THE FOURTH LIMB, and the one my widening did not have (Codex, #860
    // 4288424506). Steps 3, 5 and 7 cover switching UNIT, switching MODE and
    // the unit going out of service. Clearing to NOTHING is a fourth, and it
    // was the only one that was actually broken: the panel renders its draft
    // reset inside the chosen-machine arm, so choosing "Choose machine..."
    // unmounted the reset along with everything else, nothing reported, and
    // the host form kept the draft it was last told about.
    //
    // WHY THE JOURNEY'S OWN CLEAR STEP DID NOT CATCH IT. That spec clears the
    // machine, re-selects it, and asserts the fields are empty - and the
    // re-selection remounts the collector, which reports an empty draft on
    // mount. The host is repaired by the re-selection, so the assertion passes
    // whether or not clearing did anything. The dangerous sequence is clear
    // and then SAVE, with no re-selection in between, which nothing exercised.
    //
    // A FRESH SESSION, so this is about an area that must not acquire
    // settings rather than a count on one that already has them.
    const cleared = await seedE2eDraftElectrolysisSession(seed);
    await openCreateForm(page, cleared.clientId, cleared.sessionId);
    expect(await openMachinePanel(page)).toBe(true);

    await page.getByTestId("machine-select").selectOption(unitA);
    await expect(page.getByTestId("machine-chosen")).toContainText(
      "Room 1 multineedle",
      { timeout: T },
    );
    await page.getByTestId("reading-current").fill("77");
    await page.getByTestId("reading-duration").fill("210.5");
    await page.getByTestId("reading-energy_shown").fill("3.33");

    // CLEAR IT. The collector vanishes with the chosen-machine block.
    await page.getByTestId("machine-select").selectOption("");
    await expect(page.getByTestId("machine-setting-draft")).toHaveCount(0, {
      timeout: T,
    });
    await expect(page.getByTestId("machine-chosen")).toHaveCount(0);

    // SAVE WITH NOTHING CHOSEN. The area is an ordinary save; the readings she
    // typed under a unit she then un-chose must not be recorded against it.
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect
      .poll(async () => await blockCountOf(cleared.sessionId), {
        timeout: T,
        message: "the create form saved no treatment area",
      })
      .toBe(1);

    const clearedBlock = await blockIdOf(cleared.sessionId);
    expect(
      await capturesFor(clearedBlock),
      "the draft survived the clear and was recorded under the un-chosen unit",
    ).toHaveLength(0);
    expect(await readingsFor(clearedBlock)).toHaveLength(0);
    // AND NOWHERE ELSE EITHER: 77 is a value this file records nowhere, so a
    // studio-wide search for it cannot pass by coincidence.
    const anywhere = await sql<{ n: string }>(
      `select count(*)::text as n from public.treatment_setup_readings
        where studio_id = $1 and value_numeric = 77`,
      [seed.studioId],
    );
    expect(Number(anywhere[0]!.n), "the cleared draft reached the record").toBe(0);
  });

  await test.step("7: a unit taken OUT OF SERVICE mid-draft refuses the save, and no area is created", async () => {
    // THE STRONGEST CLAIM IN THIS FILE, and it is only true because the area
    // and its settings are ONE transaction: refusing the settings must take
    // the AREA with them. Before 0223's initial-save command this case left a
    // treatment area behind with no settings on it.
    //
    // A NEW SESSION, so the assertion is about a block that must not exist
    // rather than about a count on a block that already does.
    const second = await seedE2eDraftElectrolysisSession(seed);
    await openCreateForm(page, second.clientId, second.sessionId);
    expect(await openMachinePanel(page)).toBe(true);
    await page.getByTestId("machine-select").selectOption(unitA);
    await expect(page.getByTestId("machine-chosen")).toContainText(
      "Room 1 multineedle",
      { timeout: T },
    );
    await page.getByTestId("reading-current").fill("130");
    await page.getByTestId("reading-duration").fill("240.0");
    await page.getByTestId("reading-energy_shown").fill("2.00");

    // RETIRED BEHIND THE RENDERED PAGE, which is the real race: the browser's
    // option list was built before the unit went out of service, so selecting
    // it was an ordinary action and only the server can refuse.
    await sql(`update public.studio_machines set retired_at = now() where id = $1`, [
      unitA,
    ]);

    expect(
      await blockCountOf(second.sessionId),
      "the new session starts with no area",
    ).toBe(0);
    // OBSERVED BEFORE THE SAVE, so what follows compares against what was
    // actually there. Unit A legitimately holds step 6's readings, so "nothing
    // was written" is a claim about the DELTA - a hard-coded total here would
    // have to be revisited every time an earlier step records one more thing,
    // which is exactly how the journey's counts went stale three times.
    const beforeOnUnitA = await readingsOnUnit(unitA);
    const beforeInStudio = (await readingsInStudio(seed.studioId)).length;

    await page.getByTestId("save-treatment-area").click({ timeout: T });

    // THE MESSAGE IS THE ONE THE CODE PRODUCES, not the one I would write.
    // The action resolves the unit against the studio's LIVE inventory, which
    // excludes retired units, so the refusal comes from that check and says
    // "not registered" - the same sentence the two editing paths use for an
    // unknown unit. It is the established convention here; that a retired unit
    // and an unknown one are reported identically on SAVE is worth a product
    // decision, and the accurate "was taken out of service" wording already
    // exists on the SELECTION path (lib/machines/selection.ts). Asserting what
    // I wish it said would make this step fail for the wrong reason.
    await expect(
      page.getByRole("alert").filter({ hasText: /not registered to this studio/i }),
    ).toBeVisible({ timeout: T });

    // NO AREA, which is the atomicity claim.
    expect(
      await blockCountOf(second.sessionId),
      "a refused save left a treatment area behind",
    ).toBe(0);
    // AND NOT ONE ROW WAS ADDED, against the retired unit or anywhere else.
    expect(
      await readingsOnUnit(unitA),
      "the refused save recorded against the retired unit",
    ).toBe(beforeOnUnitA);
    expect(
      (await readingsInStudio(seed.studioId)).length,
      "the refused save recorded somewhere in the studio",
    ).toBe(beforeInStudio);
    await noOverflow(page);
  });
});
