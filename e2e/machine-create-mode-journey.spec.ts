import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { seedE2eStudio, seedE2eDraftElectrolysisSession, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// MPX-03 — THE CREATE-MODE JOURNEY, end to end, in a real browser.
//
// *** UNEXECUTED AT THE TIME OF WRITING. *** Authored against 269362db with no
// stack available. Nothing below has been run. A Playwright spec that has
// never executed is a specification, not evidence, and this one is especially
// easy to be wrong about: it drives a surface whose save path changed in the
// same change that added it.
//
// WHAT THIS FILE ADDS over machine-first-charting.spec.ts. That file is a
// feature matrix - retirement, cross-client isolation, failed selection,
// per-field provenance - entered on a settings block that already exists.
// This one walks the path a practitioner actually takes on a NEW treatment,
// in order, and asserts the thing that path alone can show: what the panel
// may and may not do BEFORE the block exists, and that the save which follows
// is ONE atomic submission rather than one call per settings group.
//
// THE SEQUENCE IS SAM'S ACCEPTANCE BAR (#825): dropdown, then native fields,
// then save; database readback, then reload; a second capture; next-visit
// history showing both, honestly timed. Plus the gate-closed twin, because a
// spec that returns early when the gate is shut must prove something in that
// half too or a green run means nothing.
//
// ---------------------------------------------------------------------------
// WHY THE GATE EXISTS AND WHY BOTH HALVES ARE REAL
// ---------------------------------------------------------------------------
// Every REAL machine profile is evidence-gated and `blocked`, so the picker is
// empty by design. The only active profile is the synthetic demo one, behind a
// gate read in the NEXT SERVER PROCESS: `HONE_SYNTHETIC_MACHINE_PROFILE` must
// be exactly "1" in `webServer.env` (`E2E_WEB_SERVER_ENV`), not in this
// process. Setting it here does nothing.
//
//   GATE OPEN   - the whole journey runs.
//   GATE CLOSED - the journey is undemonstrable, and the claim that matters
//                 most is asserted instead: no real model is offered, and
//                 nothing is recorded anywhere in the studio.
//
// A GATE-CLOSED PASS IS NOT A FEATURE PROOF, and this file says which half ran
// in an annotation so an acceptance report cannot count a gate-closed skip as
// evidence (Codex, #860 6155096366).

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 20_000;

const SYNTHETIC_PROFILE_ID = "synthetic:demo-multineedle";
const SYNTHETIC_VERSION = 2;
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
 * Seed one unit and publish its contract, through the COMMAND.
 *
 * The owner-registration UI is not part of this journey, so the row is
 * seeded. The CONTRACT is published through `sync_machine_profile_contract`
 * rather than by raw insert: the field contract has an FK to the mode
 * contract and a NOT NULL `quantity`, and an earlier raw insert elsewhere
 * broke on both the moment the schema grew. `sql()` runs as postgres, which
 * is the deployment authority the command requires.
 */
async function registerMachine(studioId: string, displayName: string) {
  const id = randomUUID();
  await sql(
    `insert into public.studio_machines
       (id, studio_id, machine_profile_id, machine_profile_version, display_name)
     values ($1, $2, $3, $4, $5)`,
    [id, studioId, SYNTHETIC_PROFILE_ID, SYNTHETIC_VERSION, displayName],
  );
  await sql(
    `select public.sync_machine_profile_contract($1, $2, 'galvanic', $3, null, $4::jsonb)`,
    [
      SYNTHETIC_PROFILE_ID,
      SYNTHETIC_VERSION,
      SYNTHETIC_CHANNELS,
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

/** The captures of one block, with the save each belongs to. */
async function capturesFor(blockId: string) {
  return sql<{
    group_key: string;
    revision: number;
    setup_submission_id: string | null;
    channels: number[];
    recorded_at: string;
  }>(
    `select group_key, revision, setup_submission_id, channels,
            recorded_at::text as recorded_at
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
    observation_source: string;
  }>(
    `select group_key, field_key, value_numeric::text as value_numeric,
            native_unit, decimals, observation_source
       from public.treatment_setup_readings
      where session_block_id = $1
      order by group_key, field_key`,
    [blockId],
  );
}

/** Every reading in a studio — for the "nothing was recorded" claim. */
async function readingsInStudio(studioId: string) {
  return sql<{ field_key: string }>(
    `select field_key from public.treatment_setup_readings where studio_id = $1`,
    [studioId],
  );
}

/**
 * ANOTHER session for a client who ALREADY EXISTS — the next visit.
 *
 * Deliberately not `seedE2eDraftElectrolysisSession`, which inserts a fresh
 * client on every call: using it here would navigate to a different person's
 * chart, and `latest_setup_for_client` filters by client, so the step would
 * hang until timeout and read like a broken feature (Codex, a66f5ec9).
 */
async function seedNextVisit(studioId: string, clientId: string) {
  const prac = (
    await sql<{ id: string }>(
      `select id from public.practitioners
        where studio_id = $1 and role = 'owner' limit 1`,
      [studioId],
    )
  )[0]!;
  const rows = await sql<{ id: string }>(
    `insert into public.sessions (studio_id, client_id, practitioner_id, modality)
     values ($1, $2, $3, 'electrolysis') returning id`,
    [studioId, clientId, prac.id],
  );
  return rows[0]!.id;
}

/**
 * The settings block this session now has, polled.
 *
 * READ THROUGH expect.poll, not once. The save is a server action and the
 * row appears after the click resolves; a single read immediately afterwards
 * is a race that fails intermittently and reads like a broken feature.
 */
async function blockIdOf(sessionId: string) {
  const rows = await sql<{ id: string }>(
    `select id from public.session_blocks
      where session_id = $1 and deleted_at is null
      order by sort_order limit 1`,
    [sessionId],
  );
  return rows[0]?.id ?? "";
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
  // ON DEMAND, which is load-bearing: an on-mount request once broke
  // repeat-client-fast-charting, which classifies any server-action POST
  // without an idempotencyKey as a source re-read.
  await expect(page.getByTestId("machine-first-trigger")).toBeVisible({ timeout: T });
  await page.getByTestId("machine-first-open").click();
  await expect(page.getByTestId("machine-first-panel")).toBeVisible({ timeout: T });

  // COUNTING OPTIONS, not the control's presence. The dropdown also renders
  // DISABLED with only the empty option when the studio has nothing usable,
  // and that is the gate-CLOSED case wearing the same testid.
  const select = page.getByTestId("machine-select");
  const chosen = page.getByTestId("machine-chosen");
  if ((await select.count()) === 0) return (await chosen.count()) > 0;
  return (await select.locator("option").count()) > 1 || (await chosen.count()) > 0;
}

test("create mode: choose the machine, save the block, record one save, retrieve it next visit @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const machineId = await registerMachine(seed.studioId, "Room 1 demo");
  await loginAsOwner(page, seed);

  let gateOpen = false;

  await test.step("1: a NEW treatment opens its create form and its machine panel", async () => {
    await openCreateForm(page, clientId, sessionId);
    gateOpen = await openMachinePanel(page);
    await noOverflow(page);
  });

  if (!gateOpen) {
    await test.step("GATE CLOSED: no real model is offered, and nothing is recorded", async () => {
      // Not a skip and not vacuous: this IS the evidence-gating rule, in a
      // real browser, on the surface a practitioner would use.
      await expect(
        page.getByText(/No verified machine is available to select yet/i),
      ).toBeVisible({ timeout: T });
      const sel = page.getByTestId("machine-select");
      const real =
        (await sel.count()) === 0 ? 0 : (await sel.locator("option").count()) - 1;
      expect(real, "a real machine was offered with the gate closed").toBe(0);

      // SCOPED TO THE STUDIO, not to a block id. The gate-closed branch has
      // no block to name, and reaching for the nearest id in scope is exactly
      // how the sibling spec's version of this assertion became vacuous: it
      // filtered by a machine id against a session_block_id column, so an
      // empty result was guaranteed and the expectation could not fail.
      expect(
        await readingsInStudio(seed.studioId),
        "a reading exists although no machine could be selected",
      ).toHaveLength(0);
    });
    test.info().annotations.push({
      type: "gate-closed",
      description:
        "HONE_SYNTHETIC_MACHINE_PROFILE is not in the server env, so the " +
        "create-mode journey did NOT run. Only the evidence-gating half above " +
        "executed. This run is not acceptance evidence for the journey.",
    });
    return;
  }

  // ---- GATE OPEN: the journey ------------------------------------------
  test.info().annotations.push({
    type: "gate-open",
    description: "The full create-mode journey executed.",
  });

  let blockId = "";
  let firstSubmission: string | null = null;
  // OBSERVED, NOT ASSUMED. Later steps compare against what was actually
  // recorded, because a hard-coded total has to be revisited every time an
  // earlier step records one more thing - which is exactly how steps 5, 6
  // and 7 all came to hold stale numbers at once.
  let capturesAfterEdit = 0;
  let submissionsAfterEdit = new Set<string>();

  await test.step("2: BEFORE the block exists, the settings are COLLECTED for the same save", async () => {
    // THIS STEP ASSERTED THE OPPOSITE UNTIL `create_block_with_initial_setup`,
    // AND THE CHANGE IS DELIBERATE RATHER THAN A REPAIR.
    //
    // It required that no reading could be entered in create mode, which was
    // the honest behaviour while it was true: a new settings block has no row,
    // so there was nowhere to put a reading, and a form that collected one
    // would have had to discard it. She saved the area, re-opened it, and
    // recorded - two steps for one act.
    //
    // 0223's initial-save command writes the area AND its settings in one
    // transaction, so there IS somewhere to put them now: the save that
    // creates the block carries them. The old assertion is not weakened here,
    // it is replaced by the claim that is now true - and the old one still
    // holds wherever no host can carry a draft, where the panel shows the
    // contract read-only (proved in tests/components/machine-setting-draft).
    //
    // THE SQL HAS NOT RUN. This step is a specification until it does.
    await page.getByTestId("machine-select").selectOption(machineId);
    await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
      timeout: T,
    });

    // The model's own fields ARE shown - that is the "machine first" promise,
    // and this is the read-only contract view rather than an entry form.
    //
    // TARGETED BY TESTID. A page-wide getByText("Current") is a three-way
    // strict-mode violation here: the field's own advisory notes legitimately
    // contain its name ("Current is documented in microamps..."). Targeting
    // the label also makes the claim mean what it says - the MACHINE'S OWN
    // label and unit are rendered, which prose mentioning the word cannot
    // satisfy (found by the ops01 lane's first gate-open run).
    await expect(page.getByTestId("field-label-current")).toHaveText("Current", {
      timeout: T,
    });
    await expect(page.getByTestId("field-unit-current")).toHaveText("(µA)");

    // THE FIELDS ARE COLLECTABLE, and this is the COLLECTOR, not the
    // recorder: it offers no save, because the area's Save is the only one.
    await expect(page.getByTestId("machine-setting-draft")).toBeVisible({
      timeout: T,
    });
    await expect(page.getByTestId("setting-draft-note")).toContainText(
      /saved together with the treatment area/i,
    );
    expect(
      await page.getByTestId("machine-reading-save").count(),
      "the collector must not offer a save of its own",
    ).toBe(0);
    expect(
      await page.getByTestId("machine-reading-entry").count(),
      "the RECORDING form belongs to a block that already exists",
    ).toBe(0);

    // DELIBERATELY DIFFERENT NUMBERS from the ones re-entered in step 2b.
    // If a machine switch left this draft live, step 5's readback would find
    // THESE values rather than the re-entered ones - so the staleness is
    // visible as a wrong number, not as a coincidence.
    await page.getByTestId("reading-current").fill("99");
    await page.getByTestId("reading-duration").fill("111.1");
    await page.getByTestId("reading-energy_shown").fill("9.99");
    await noOverflow(page);
  });

  await test.step("2b: SWITCHING AWAY AND BACK discards what was typed", async () => {
    // SAM'S PROOF ITEM, and the defect Codex found at db3373bc P1.
    //
    // The panel remounts the collector when the machine or mode changes, so
    // its fields clear - but the HOST FORM held the draft it was last told
    // about, and the collector said nothing until the next keystroke. So a
    // Save after a switch could send the PREVIOUS machine's values: numbers
    // she never read off the unit now chosen, recorded permanently.
    //
    // There is only one registered unit in this journey, so the switch is
    // through "Choose machine…" - the empty option, which is how a selection
    // is cleared - and back. That exercises BOTH shapes of the fix: the
    // collector vanishing while nothing is chosen (the panel clears the host),
    // and the collector remounting when it is chosen again (it reports empty).
    await page.getByTestId("machine-select").selectOption("");
    await expect(page.getByTestId("machine-setting-draft")).toHaveCount(0, {
      timeout: T,
    });

    await page.getByTestId("machine-select").selectOption(machineId);
    await expect(page.getByTestId("machine-setting-draft")).toBeVisible({
      timeout: T,
    });
    // THE FIELDS ARE EMPTY AGAIN, which is the visible half.
    await expect(page.getByTestId("reading-current")).toHaveValue("");

    // AND THE INVISIBLE HALF: re-enter the values so step 3 has something to
    // save. If the host had kept the stale draft, step 5's readback would
    // find the values typed BEFORE the switch - and they are deliberately
    // different numbers, so it would fail rather than coincide.
    await page.getByTestId("reading-current").fill("120");
    await page.getByTestId("reading-duration").fill("300.5");
    await page.getByTestId("reading-energy_shown").fill("1.25");
  });

  await test.step("3: saving the settings block creates it, and the panel becomes recordable", async () => {
    await page.getByTestId("save-treatment-area").click({ timeout: T });
    await expect
      .poll(
        async () => {
          blockId = await blockIdOf(sessionId);
          return blockId;
        },
        { timeout: T, message: "the create form saved no settings block" },
      )
      .not.toBe("");

    // THE SETTINGS LANDED WITH IT, in that one save. This is the claim the
    // atomic command exists for: no second action, no window in which the
    // area exists and its settings do not.
    const firstCaps = await capturesFor(blockId);
    expect(
      firstCaps.length,
      "the area saved but its machine settings did not",
    ).toBeGreaterThan(0);
    expect(
      firstCaps[0]!.setup_submission_id,
      "an initial save must carry its submission",
    ).not.toBeNull();
    // HELD FOR STEP 5, which distinguishes this save from the edit's.
    firstSubmission = firstCaps[0]!.setup_submission_id;

    // Re-enter the block being charted and open the panel again.
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    // The machine chosen before the block existed is still the chosen one.
    await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
      timeout: T,
    });
    await expect(page.getByTestId("machine-reading-entry")).toBeVisible({
      timeout: T,
    });
  });

  await test.step("4: TWO setting groups are entered and saved in ONE action", async () => {
    // The practitioner has probes at different settings. She enters both and
    // presses Save once - and that is one atomic fact in the record, not two
    // independent calls that can half-succeed.
    await page.getByTestId("setting-group-add").click({ timeout: T });
    await expect(page.getByTestId("setting-group-g2")).toBeVisible({ timeout: T });

    // THE INPUT TESTIDS CHANGE WITH THE GROUP COUNT, which is easy to get
    // wrong from the outside: the entry form emits `reading-<field>` while
    // there is one group and `reading-<groupId>-<field>` once there are
    // several, because two groups render the same field twice and a shared
    // testid would be ambiguous. Group ids are `g1`, `g2`, ... and are
    // monotonic for the life of the mount - a removed group's id is retired,
    // never reused, because reuse would corrupt a group's revision history.
    //
    // DISJOINT CHANNELS. The command refuses a channel claimed by two groups
    // of one save outright, so an overlap here would fail the save rather
    // than record a probe under two settings.
    await page.getByTestId("setting-group-g1-channel-1").click();
    await page.getByTestId("setting-group-g2-channel-2").click();

    for (const [group, current] of [
      ["g1", "120"],
      ["g2", "80"],
    ] as const) {
      await page.getByTestId(`reading-${group}-current`).fill(current);
      await page.getByTestId(`reading-${group}-duration`).fill("300.5");
      await page.getByTestId(`reading-${group}-energy_shown`).fill("1.25");
    }

    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({
      timeout: T,
    });
    await noOverflow(page);
  });

  await test.step("5: the DATABASE holds TWO saves — the initial one, then the edit", async () => {
    // GROUND TRUTH. The UI saying "saved" is not the claim; the record is.
    //
    // THIS STEP EXPECTED TWO CAPTURES AND THE FIRST RUN FOUND THREE, which is
    // my arithmetic rather than a defect - and the extra one is the evidence
    // the atomic command works. When I rewrote step 2 to ENTER values in
    // create mode, that save became real: one group, no channel, recorded
    // atomically WITH the block. Step 4 then added channels and a second
    // group on the saved block, which is a SECOND submission. Three captures,
    // two saves, exactly as designed - and the old count was written before
    // step 2 collected anything.
    const caps = await capturesFor(blockId);
    expect(caps, "initial save + the edit's two groups").toHaveLength(3);

    const submissions = [...new Set(caps.map((c) => c.setup_submission_id))];
    expect(
      submissions.every((s) => s !== null),
      "every capture must carry the save that produced it",
    ).toBe(true);
    expect(
      submissions.length,
      "the initial save and the edit are two distinct saves",
    ).toBe(2);

    // THE INITIAL SAVE'S OWN CAPTURE: g1 at revision 1, recorded with the
    // block in step 3, with no channel because step 2 named none.
    const initial = caps.find((c) => c.revision === 1 && c.group_key === "g1")!;
    expect(initial.setup_submission_id).toBe(firstSubmission);
    expect(initial.channels, "step 2b selected no probe").toEqual([]);

    // THE STALE-DRAFT PROOF. Step 2 typed 99 and then switched machines; step
    // 2b re-entered 120. The record must hold 120 - the value entered under
    // the machine that was actually chosen when she saved.
    const initialReadings = (await readingsFor(blockId)).filter(
      (r) => r.group_key === initial.group_key,
    );
    const initialCurrent = initialReadings.find((r) => r.field_key === "current")!;
    expect(
      initialCurrent.value_numeric,
      "a draft typed before a machine switch was saved",
    ).toBe("120");

    // HELD FOR STEP 6, so a reload is compared against what was actually
    // there rather than against a number written earlier in the file.
    capturesAfterEdit = caps.length;
    submissionsAfterEdit = new Set(
      caps.map((c) => c.setup_submission_id).filter((id): id is string => !!id),
    );

    // THE EDIT'S TWO GROUPS share ONE submission - the claim the whole-save
    // command exists for.
    const edit = caps.filter((c) => c.setup_submission_id !== firstSubmission);
    expect(edit).toHaveLength(2);
    expect(new Set(edit.map((c) => c.setup_submission_id)).size).toBe(1);
    // Each keeps its own channels, unmerged and non-overlapping.
    const channels = edit.flatMap((c) => c.channels);
    expect(channels).toHaveLength(new Set(channels).size);

    // THE MACHINE'S OWN UNITS AND PRECISION, derived from the published
    // contract rather than from anything the browser sent.
    const rows = await readingsFor(blockId);
    // Three captures x three fields.
    expect(rows).toHaveLength(9);
    const current = rows.filter((r) => r.field_key === "current");
    expect(current).toHaveLength(3);
    expect(current.every((r) => r.native_unit === "µA")).toBe(true);
    expect(current.every((r) => r.decimals === 0)).toBe(true);
    // 120 from create mode, then 120 and 80 from the edit's two groups.
    expect(current.map((r) => r.value_numeric).sort()).toEqual([
      "120",
      "120",
      "80",
    ]);
    // PER-FIELD PROVENANCE: the contract says this one is read off the
    // machine's own display, and the record has to agree.
    expect(
      rows.find((r) => r.field_key === "energy_shown")!.observation_source,
    ).toBe("machine-displayed");
  });

  await test.step("6: RELOAD — the save survives and the machine is still remembered", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
      timeout: T,
    });
    // THE RECORD IS UNCHANGED BY A RELOAD, which is the claim - not the
    // absolute number. Stated as a count because a re-save on mount would be
    // invisible in the UI and permanent in the record.
    //
    // CAPTURED BEFORE AND COMPARED, rather than hard-coded. The literal 2
    // here was the same slip as step 5's: it predated step 2 collecting
    // anything, and a fixed total has to be revisited every time an earlier
    // step records one more thing. What this step cares about is that the
    // reload added nothing.
    expect(await capturesFor(blockId)).toHaveLength(capturesAfterEdit);
  });

  await test.step("7: after the reload, a SECOND capture appends — it never edits", async () => {
    // A setting changed mid-treatment. The earlier captures are immutable and
    // stay; this appends.
    // NO "RECORD A SETTING CHANGE" CLICK HERE, and the run is what taught me
    // why. That control belongs to the SAVED view, which is state held in the
    // mount that did the saving. Step 6 RELOADED the page, so this is a fresh
    // mount: it shows an empty entry form directly, and the control the first
    // spelling waited twenty seconds for does not exist.
    //
    // THAT IS THE RIGHT PRODUCT BEHAVIOUR, not a gap. After a reload she is
    // ready to record the next capture without asking for permission to - and
    // it is precisely why the "Recorded this treatment" surface matters, since
    // the only other thing telling her what is already stored died with that
    // earlier mount.
    await expect(page.getByTestId("machine-reading-entry")).toBeVisible({
      timeout: T,
    });
    // WHAT IS ALREADY RECORDED IS ON SCREEN, which is the point of the
    // surface: she can see the earlier capture before adding another.
    await expect(page.getByTestId("machine-recorded-setups")).toBeVisible({
      timeout: T,
    });

    // ONE group on a fresh mount, so the input testids are unsuffixed - and
    // EMPTY, because nothing is ever pre-filled from what is stored.
    await expect(page.getByTestId("reading-current")).toHaveValue("");
    await page.getByTestId("setting-group-g1-channel-1").click();
    await page.getByTestId("reading-current").fill("150");
    await page.getByTestId("reading-duration").fill("280.0");
    await page.getByTestId("reading-energy_shown").fill("1.40");
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({
      timeout: T,
    });

    // EXACTLY ONE NEW SAVE APPEARED, and everything that was there still is.
    //
    // THE FIRST SPELLING COUNTED "every submission that is not the initial
    // one" and expected ONE - which was true only while the initial save was
    // the sole earlier save. Once step 2 began collecting in create mode
    // there were two earlier saves, so the assertion failed on arithmetic
    // rather than on behaviour. Comparing the SETS before and after says what
    // the step actually means.
    const caps = await capturesFor(blockId);
    expect(caps.length).toBe(capturesAfterEdit + 1);
    const after = new Set(
      caps.map((c) => c.setup_submission_id).filter((id): id is string => !!id),
    );
    const added = [...after].filter((id) => !submissionsAfterEdit.has(id));
    expect(added, "a mid-treatment change is ONE new save").toHaveLength(1);
    // EVERY EARLIER SAVE IS STILL THERE, unchanged. Append-only is the whole
    // clinical contract of this table, and "the earlier one stays" is what
    // the confirmation copy promises her.
    for (const id of submissionsAfterEdit) {
      expect(after.has(id), `an earlier save vanished: ${id}`).toBe(true);
    }
    // Including the INITIAL save specifically, which is the one the atomic
    // command wrote alongside the block.
    expect(after.has(firstSubmission!)).toBe(true);
  });

  await test.step("8: NEXT VISIT — guidance shows the groups, as PREVIOUS values", async () => {
    const nextSession = await seedNextVisit(seed.studioId, clientId);
    await page.goto(`/clients/${clientId}/sessions/${nextSession}`);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await openMachinePanel(page);

    const prior = page.getByTestId("machine-prior-setup");
    await expect(prior).toBeVisible({ timeout: T });
    // IT READS AS HISTORY, which is the correction Sam asked for: labelled,
    // dated, and saying outright that it is not today's entries.
    await expect(prior).toContainText(/Previous treatment/i);
    await expect(page.getByTestId("prior-setup-reference-note")).toContainText(
      /reference only/i,
    );
    await expect(page.getByTestId("prior-setup-when")).toBeVisible();

    // A DATE AND NO CLOCK TIME. Two groups of one save are recorded at
    // different instants, so a time of day would invite reading the rows as
    // "the settings at that moment", which they are not.
    const when = (await page.getByTestId("prior-setup-when").innerText()).trim();
    expect(when, `prior setup showed a time of day: ${when}`).not.toMatch(
      /\d{1,2}:\d{2}/,
    );

    // NOTHING IS PRE-FILLED from it. A value she has not re-read off the
    // machine is not a reading, and the record must not be able to acquire
    // one by her failing to notice a filled box.
    //
    // ASSERTED ON THE COLLECTOR, which is what this surface renders now. The
    // first spelling looked for `machine-reading-entry` behind an
    // `if (count() > 0)` - and on THIS step that count is zero, because the
    // next visit opens the CREATE form and create mode renders
    // `machine-setting-draft` instead. The claim would have been silently
    // skipped: the exact shape of assertion that cannot fail.
    const draft = page.getByTestId("machine-setting-draft");
    await expect(draft).toBeVisible({ timeout: T });
    await expect(draft.getByTestId("reading-current")).toHaveValue("");
    // AND THE PRIOR VALUES ARE ON SCREEN at the same time, so this is a real
    // juxtaposition rather than an empty form with nothing to be tempted by.
    //
    // I FIRST ASSERTED "180", a value this journey never records - copied from
    // the sibling spec's fixture. The run handed me the real content, and it
    // is a far stronger claim than the one I guessed at:
    //
    //   BOTH GROUPS appear, each at its OWN HIGHEST REVISION. g1 shows 150 -
    //   the mid-treatment change from step 7 - and NOT the 120 it held
    //   before; g2 shows 80 from the step-4 save. That is the multi-group
    //   guidance repair working mounted: a single-capture read would have
    //   shown one group and silently omitted the other probe's settings.
    await expect(prior).toContainText("Channels 1");
    await expect(prior).toContainText("Channels 2");
    await expect(prior, "g1's LATEST value, not its first").toContainText("150");
    await expect(prior).toContainText("80");
    expect(
      (await prior.innerText()).includes("120"),
      "a superseded value must not be offered back as guidance",
    ).toBe(false);
    // PER-FIELD PROVENANCE survives the round trip: this field's contract says
    // the machine displays it, and the record says so too.
    await expect(prior).toContainText("device-display");
    await noOverflow(page);
  });
});
