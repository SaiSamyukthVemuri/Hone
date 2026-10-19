import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { seedE2eStudio, seedE2eDraftElectrolysisSession, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { APILUS_3G_NATIVE_FIXTURES } from "../lib/machines/apilus-3g-fixtures";
import { modeFields } from "../lib/machines/profile-contract";
import { planContractPublication } from "../lib/machines/contract-publication";

// MPX-03 — THE CREATE-MODE JOURNEY, end to end, in a real browser.
//
// *** EXECUTED 2026-10-15 *** on an isolated local stack (hone-mpx-0223 /
// 64822), as a GATE-OPEN / GATE-CLOSED PAIR: 22.3s with the flag set in
// webServer.env and 10.0s without, with zero readings and zero submissions in
// the studio afterwards in the closed half.
//
// IT WAS AUTHORED UNEXECUTED, against 269362db with no stack available, and
// the first run is why that distinction is written down rather than quietly
// dropped. A Playwright spec that has never run is a specification, not
// evidence - and this one was wrong in five places that only a run could
// find: a label I had renamed and not updated here, three hard-coded capture
// counts that predated step 2 collecting anything, a control that does not
// exist on a fresh mount after a reload, a value the journey never records,
// and one assertion that COULD NOT FAIL because it sat behind a count that is
// zero on this step. Every one of them read like a broken feature.
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
  // The second area, created in step 9 and CONTINUED in step 10 — the reload
  // case needs a block that already holds two groups.
  let secondBlock = "";
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
    // THE SQL HAS NOW RUN: 0223 applied to a fresh chain on the isolated
    // stack and this step passed against it, which is what moved this claim
    // from specification to evidence.
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

    // BOTH GROUPS ARE RESTORED, so the inputs are suffixed by group.
    //
    // THIS STEP USED TO ASSERT THE DEFECT. It read "ONE group on a fresh
    // mount, so the input testids are unsuffixed" and typed into
    // `reading-current` - which was true, and was the bug: step 4 saved g1
    // AND g2, so a reload offering one box meant the identities had been
    // thrown away, and this step's own change went in as a g1 revision
    // because g1 was the only thing on offer (Codex, #860 4294673722).
    //
    // The repair seeds the draft from the record, so the reload now shows
    // both probes and this step has to SAY which one it is changing. That it
    // reddened here, on its own long-standing setup, is the clearest evidence
    // the seed is load-bearing: the spec could not keep its old shape.
    await expect(page.getByTestId("setting-group-g1")).toBeVisible({ timeout: T });
    await expect(page.getByTestId("setting-group-g2")).toBeVisible();
    // EMPTY, because nothing is ever pre-filled from what is stored - the
    // identity is restored, the observations are not.
    await expect(page.getByTestId("reading-g1-current")).toHaveValue("");
    await expect(page.getByTestId("reading-g2-current")).toHaveValue("");
    await page.getByTestId("setting-group-g1-channel-1").click();
    await page.getByTestId("reading-g1-current").fill("150");
    await page.getByTestId("reading-g1-duration").fill("280.0");
    await page.getByTestId("reading-g1-energy_shown").fill("1.40");
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

  await test.step("7b: TODAY'S OWN CAPTURES ARE NOT OFFERED BACK AS HISTORY", async () => {
    // THE DEFECT'S INVERSE, MOUNTED (Codex, #860 4289974654). Guidance filtered
    // on client and studio and took the newest capture, so everything recorded
    // in steps 3 to 7 - minutes ago, in THIS session, on THIS screen - came
    // back as "Previous treatment" under copy that says it is reference only
    // and not today's entries.
    //
    // THIS CLIENT HAS NO EARLIER VISIT. Every capture she has is in the
    // session being charted, so the honest answer is NO guidance at all, and
    // the panel renders none. Before the fix this showed her own 150.
    //
    // STEP 8 COULD NOT HAVE CAUGHT IT, which is why this is its own step: it
    // opens a FRESH next-visit session, where the captures genuinely are in an
    // earlier one, so it passed either way. The dangerous case is the session
    // that holds the only captures, and nothing exercised it.
    await expect(
      page.getByTestId("machine-prior-setup"),
      "today's own captures were offered back as Previous treatment",
    ).toHaveCount(0, { timeout: T });

    // AND THE CAPTURES REALLY EXIST, so the absence above is the exclusion and
    // not an empty chart: the recorded-setups surface on this same screen
    // still shows what was saved.
    await expect(page.getByTestId("machine-recorded-setups")).toBeVisible({
      timeout: T,
    });
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
    // PER-FIELD UNITS survive the round trip, AND THE SENTINELS DO NOT.
    //
    // THIS ASSERTION USED TO REQUIRE "device-display" ON SCREEN, which was
    // pinning the defect rather than the behaviour: `device-display` and
    // `none` are provenance markers, not units, and rendering one put
    // "1.40 device-display" in front of a practitioner while the
    // recorded-history panel beside it showed the same reading as plain
    // "1.40" (Codex, #860 4296709059). The spec reddened here on its own
    // long-standing claim the moment the sentinel was suppressed, which is
    // the second time this lane has had a step encoding the bug it was
    // written around - see step 7.
    //
    // What it meant to prove is that each reading carries ITS OWN recorded
    // unit, so that is what it now proves: a real unit prints, a sentinel
    // does not, and the two are asserted together so neither can drift.
    await expect(prior, "a real recorded unit must still print").toContainText(
      "150µA",
    );
    await expect(
      prior,
      "a provenance sentinel is not a unit and must never reach the screen",
    ).not.toContainText("device-display");
    await expect(prior).not.toContainText("none");
    await noOverflow(page);
  });

  await test.step("9: changing the SECOND group revises g2, not g1", async () => {
    // SAM'S PROOF ITEM VIA CODEX (#860 4290452715), and the defect it closes
    // is the worst kind this lane has found: a revision attributed to the
    // WRONG PROBE.
    //
    // "Record a setting change" reset the draft to a single fresh g1. So after
    // a save of g1 AND g2, a practitioner changing what had been g2 submitted
    // it as a revision of g1. `latest_setup_for_client` returns the newest
    // capture PER GROUP KEY, so guidance then combined the repurposed g1 with
    // the stale g2: two settings for one probe, and the channel g1 originally
    // described dropped out of the record she reads next visit.
    //
    // IT HAS TO BE ONE MOUNT. The reset is what renumbers, so a reload between
    // the save and the change hides it - a fresh mount starts at one group
    // anyway. Step 7 reloads first, which is exactly why it could not catch
    // this.
    //
    // A FRESH AREA AT THE END, so no count in steps 5 to 8 moves. Those
    // assertions went stale three times already in this file; adding a save in
    // the middle would have been the fourth.
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    await page.getByTestId("machine-select").selectOption(machineId);
    await page.getByTestId("save-treatment-area").click({ timeout: T });

    // The SECOND area of this session, identified by EXCLUDING the first.
    //
    // NOT `order by sort_order desc limit 1`, which is what this did first and
    // which cannot fail: steps 3-7's area already satisfies "a row exists", so
    // the poll returned it on its first iteration, before the new area had
    // been written at all. Step 9 then asserted against a block carrying four
    // earlier captures and read that as the defect it was looking for. A poll
    // whose exit condition is already true when it starts is not a wait.

    await expect
      .poll(
        async () => {
          const rows = await sql<{ id: string }>(
            `select id from public.session_blocks
              where session_id = $1 and deleted_at is null and id <> $2
              order by sort_order desc limit 1`,
            [sessionId, blockId],
          );
          secondBlock = rows[0]?.id ?? "";
          return secondBlock;
        },
        { timeout: T, message: "the second treatment area was not created" },
      )
      .not.toBe("");

    // AND OPEN THAT ONE BY ID. `.first()` is the same mistake in the DOM: it
    // opens steps 3-7's area, so the save would have landed on the old block
    // whatever the poll resolved.
    await page.getByTestId(`edit-area-${secondBlock}`).click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    await expect(page.getByTestId("machine-reading-entry")).toBeVisible({
      timeout: T,
    });

    // TWO GROUPS, SAVED TOGETHER — the state the defect needs.
    await page.getByTestId("setting-group-add").click({ timeout: T });
    await expect(page.getByTestId("setting-group-g2")).toBeVisible({ timeout: T });
    await page.getByTestId("setting-group-g1-channel-1").click();
    await page.getByTestId("setting-group-g2-channel-2").click();
    for (const [group, current] of [
      ["g1", "101"],
      ["g2", "202"],
    ] as const) {
      await page.getByTestId(`reading-${group}-current`).fill(current);
      await page.getByTestId(`reading-${group}-duration`).fill("300.5");
      await page.getByTestId(`reading-${group}-energy_shown`).fill("1.25");
    }
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({
      timeout: T,
    });

    // NOW THE SETTING CHANGE, in the SAME mount.
    await page.getByTestId("machine-reading-record-change").click({ timeout: T });

    // BOTH GROUPS SURVIVE THE RESET. Before the fix there was one box here,
    // labelled g1, and typing in it revised the wrong probe.
    await expect(page.getByTestId("setting-group-g1")).toBeVisible({ timeout: T });
    await expect(page.getByTestId("setting-group-g2")).toBeVisible();
    // AND THEY ARE EMPTY: the identity is not an observation, the values are.
    await expect(page.getByTestId("reading-g1-current")).toHaveValue("");
    await expect(page.getByTestId("reading-g2-current")).toHaveValue("");

    // CHANGE g2 ONLY, leaving g1 untouched.
    await page.getByTestId("setting-group-g2-channel-2").click();
    await page.getByTestId("reading-g2-current").fill("250");
    await page.getByTestId("reading-g2-duration").fill("280.0");
    await page.getByTestId("reading-g2-energy_shown").fill("1.40");
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({
      timeout: T,
    });

    // THE RECORD. g2 gains a revision; g1 keeps exactly one.
    const caps = await capturesFor(secondBlock);
    const byGroup = new Map<string, number[]>();
    for (const c of caps) {
      byGroup.set(c.group_key, [...(byGroup.get(c.group_key) ?? []), c.revision]);
    }
    expect(
      byGroup.get("g1"),
      "the untouched group gained a revision — the change was attributed to it",
    ).toEqual([1]);
    expect(byGroup.get("g2"), "the changed group did not gain a revision").toEqual([
      1, 2,
    ]);

    // AND WHAT GUIDANCE WOULD SHOW: the newest capture per group key, which is
    // g1's ORIGINAL and g2's NEW. Asserted on the stored rows because that is
    // the contract `latest_setup_for_client` reads; the multi-group RENDER of
    // it is proved in step 8.
    const rows = await readingsFor(secondBlock);
    const latest = new Map<string, string | null>();
    for (const c of caps) {
      if (c.revision !== Math.max(...(byGroup.get(c.group_key) ?? [1]))) continue;
      const v = rows.find(
        (r) => r.group_key === c.group_key && r.field_key === "current",
      );
      if (v) latest.set(c.group_key, v.value_numeric);
    }
    expect(latest.get("g1"), "g1 must still read its original value").toBe("101");
    // g2 carries both revisions' rows; the newest is what guidance offers.
    const g2Values = rows
      .filter((r) => r.group_key === "g2" && r.field_key === "current")
      .map((r) => r.value_numeric)
      .sort();
    expect(g2Values).toEqual(["202", "250"]);
    await noOverflow(page);
  });

  await test.step("10: a RELOAD restores both groups, and the change lands on g2", async () => {
    // THE ROUND-5 P1 (Codex, #860 4294673722), and the one Codex asked to see
    // proved MOUNTED: "save g1+g2, reload the page, change g2 only, then check
    // the stored rows AND the next-visit guidance render".
    //
    // WHY STEP 9 COULD NOT CATCH IT. Step 9 never leaves the mount that saved,
    // so `clearedForNextCapture` carries the identities across in memory. A
    // reload throws that away: the initializer ran with no mount-local state
    // and offered a single fresh g1 while the recorded setup rendered below
    // it, so the screen showed two probes and accepted a change for one. The
    // repair seeds the draft from the RECORD instead, scoped to this mount's
    // device, version and mode.
    //
    // IT CONTINUES STEP 9'S AREA on purpose: that block already holds g1 at
    // revision 1 and g2 at revision 2, so this is the realistic case - a
    // practitioner returning to a treatment already part-recorded - rather
    // than a fixture built to suit the assertion.
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(`edit-area-${secondBlock}`).click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    await expect(page.getByTestId("machine-reading-entry")).toBeVisible({
      timeout: T,
    });

    // BOTH GROUPS ARE THERE, FROM THE RECORD ALONE. Before the repair this
    // was one box labelled g1, and typing in it revised the wrong probe.
    await expect(page.getByTestId("setting-group-g1")).toBeVisible({ timeout: T });
    await expect(page.getByTestId("setting-group-g2")).toBeVisible();
    // AND EMPTY. Identity is restored; observations are not. A value she has
    // not re-read off the machine must never be sitting in the box.
    await expect(page.getByTestId("reading-g1-current")).toHaveValue("");
    await expect(page.getByTestId("reading-g2-current")).toHaveValue("");

    // CHANGE g2 ONLY, exactly as step 9 did — but across the reload.
    await page.getByTestId("setting-group-g2-channel-2").click();
    await page.getByTestId("reading-g2-current").fill("300");
    await page.getByTestId("reading-g2-duration").fill("260.0");
    await page.getByTestId("reading-g2-energy_shown").fill("1.55");
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({
      timeout: T,
    });

    // THE STORED ROWS. g2 gains a THIRD revision; g1 still has exactly one,
    // the 101 it was given in step 9 and has never been touched since.
    const caps = await capturesFor(secondBlock);
    const byGroup = new Map<string, number[]>();
    for (const c of caps) {
      byGroup.set(c.group_key, [...(byGroup.get(c.group_key) ?? []), c.revision]);
    }
    expect(
      byGroup.get("g1"),
      "the untouched group gained a revision ACROSS A RELOAD — the identity was not restored",
    ).toEqual([1]);
    expect(byGroup.get("g2"), "the changed group did not gain a revision").toEqual([
      1, 2, 3,
    ]);
  });

  await test.step("10b: and the NEXT VISIT renders that revision, g2's not g1's", async () => {
    // GAP 1, which this journey previously left open and my own comment
    // misdescribed. Step 9 asserted the multi-group revision on stored rows
    // and deferred the render claim to step 8 — but step 8 runs EARLIER, on a
    // different block and single-group data, so the screen a practitioner
    // actually reads was never checked for this case at all.
    //
    // It is the render that carries the harm. The P1's consequence was
    // guidance combining a repurposed g1 with a stale g2: two settings for one
    // probe, with the channel g1 described dropped from the record. That is a
    // claim about this surface, so it is proved on this surface.
    // THE VISIT IS CREATED THROUGH THE APP, not seeded — GAP 3, the last of
    // the three I reported.
    //
    // `seedNextVisit` inserts straight into public.sessions, which bypasses
    // `start_session` (0167) and everything it does: the studio and
    // practitioner it resolves, the single-active-plan auto-attach, and the
    // reuse rule. Sam's requirement names a real
    // new-block -> record -> reload/retry -> mid-change -> same-client-next-visit
    // chain and says not to satisfy it with seeded work, so the terminus of
    // the chain goes through the route a practitioner actually uses.
    //
    // Step 8 still seeds, deliberately: it is an independent next-visit
    // assertion rather than part of this chain, and converting a passing step
    // to prove a point it does not make would only add a second way for it to
    // fail.
    // AGED FIRST, so "next visit" is what this asks for rather than what the
    // fixture happens to allow. `start_session` (0167) reuses an open session
    // for the same studio, client, practitioner and modality started within
    // 90 minutes - correctly, so that pressing "new session" twice during one
    // appointment cannot split a chart in two. Every session this spec has
    // made carries `started_at = now()`, so without this the step depends on
    // some other term of that predicate failing to match, which is exactly
    // the kind of accident that makes a proof stop proving anything.
    await sql(
      `update public.sessions
          set started_at = now() - interval '2 hours'
        where client_id = $1`,
      [clientId],
    );

    await page.goto(`/clients/${clientId}/sessions/new`);
    await page.locator('[data-modality="electrolysis"]').click({ timeout: T });
    // start_session redirects to the session it created. Waiting for the URL
    // rather than polling the table keeps the assertion on what the APP did.
    await page.waitForURL(/\/clients\/[^/]+\/sessions\/[0-9a-f-]{36}/, {
      timeout: T,
    });
    const thirdVisit = page.url().split("/sessions/")[1]!.split(/[?#]/)[0]!;
    expect(
      thirdVisit,
      "the app created a session distinct from the one just charted",
    ).not.toBe(sessionId);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await openMachinePanel(page);

    const prior = page.getByTestId("machine-prior-setup");
    await expect(prior).toBeVisible({ timeout: T });
    // BOTH PROBES, each at its own latest: g1's untouched 101 and g2's 300.
    await expect(prior).toContainText("Channels 1");
    await expect(prior).toContainText("Channels 2");
    await expect(prior, "g1's own value must survive a change made to g2").toContainText(
      "101",
    );
    await expect(prior, "g2's newest value is what guidance offers").toContainText("300");
    // AND THE SUPERSEDED ONES ARE GONE. 202 and 250 were g2's earlier
    // revisions; offering either back would be the stale-g2 half of the
    // defect. 101 must NOT have been replaced by 300 either - that is the
    // misattribution half, and it would show as g1 reading 300.
    //
    // ASKED PER PROBE, not searched for in the panel's text. Two attempts at
    // the latter failed on coincidences rather than on behaviour - "202"
    // inside the rendered year 2026, then "300" inside g1's own "300.5"
    // duration - and both would have been reported as the defect. A surface
    // that prints dates, units and several numbers cannot be interrogated by
    // substring; `prior-setup-<group>-<field>` was added so this claim can be
    // made exactly.
    const g1Current = page.getByTestId("prior-setup-g1-current");
    const g2Current = page.getByTestId("prior-setup-g2-current");
    await expect(g1Current, "g1 must still read its own 101").toContainText("101");
    await expect(g2Current, "g2 must read the change just made").toContainText("300");
    // THE MISATTRIBUTION, stated directly: the change must not appear on g1.
    await expect(
      g1Current,
      "the change was attributed to g1 as well — the identity was lost",
    ).not.toContainText("300");
    // AND THE SUPERSEDED REVISIONS ARE NOT OFFERED BACK as current guidance.
    await expect(g2Current).not.toContainText("202");
    await expect(g2Current).not.toContainText("250");
    await noOverflow(page);
  });

  await test.step("11: SAVE TWO GROUPS, SWITCH AWAY, SWITCH BACK — g2 survives", async () => {
    // THE ROUND-11 P1 (Codex, #860 4300386011), and the fifth way into one
    // invariant: a group identity must survive every remount.
    //
    // The entry form seeds its identities from `recordedSetup`, which the
    // panel loaded once when it opened. Save g1 and g2, switch machine or
    // mode, switch back — the remount seeds from a snapshot that PREDATES
    // those captures, finds nothing for this scope, and falls back to a
    // fresh g1. A change meant for g2 is then recorded as a g1 revision,
    // and guidance combines the repurposed g1 with the stale g2.
    //
    // WHY THE EARLIER STEPS COULD NOT CATCH IT. Step 9 never leaves the
    // mount, so `clearedForNextCapture` carries the identities in memory.
    // Step 10 reloads the PAGE, which re-reads the context from the server
    // and so happens to be current. Only switching away and back remounts
    // the form while the panel keeps its original snapshot — the one path
    // where the seed source is stale rather than absent.
    //
    // A FRESH AREA, so no count in steps 5 to 10 moves.
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    await page.getByTestId("machine-select").selectOption(machineId);
    await page.getByTestId("save-treatment-area").click({ timeout: T });

    let thirdBlock = "";
    await expect
      .poll(
        async () => {
          const rows = await sql<{ id: string }>(
            `select id from public.session_blocks
              where session_id = $1 and deleted_at is null
                and id <> $2 and id <> $3
              order by sort_order desc limit 1`,
            [sessionId, blockId, secondBlock],
          );
          thirdBlock = rows[0]?.id ?? "";
          return thirdBlock;
        },
        { timeout: T, message: "the third treatment area was not created" },
      )
      .not.toBe("");

    await page.getByTestId(`edit-area-${thirdBlock}`).click({ timeout: T });
    expect(await openMachinePanel(page)).toBe(true);
    await expect(page.getByTestId("machine-reading-entry")).toBeVisible({
      timeout: T,
    });

    // TWO GROUPS, SAVED TOGETHER.
    await page.getByTestId("setting-group-add").click({ timeout: T });
    await expect(page.getByTestId("setting-group-g2")).toBeVisible({ timeout: T });
    await page.getByTestId("setting-group-g1-channel-1").click();
    await page.getByTestId("setting-group-g2-channel-2").click();
    for (const [group, current] of [
      ["g1", "111"],
      ["g2", "222"],
    ] as const) {
      await page.getByTestId(`reading-${group}-current`).fill(current);
      await page.getByTestId(`reading-${group}-duration`).fill("300.5");
      await page.getByTestId(`reading-${group}-energy_shown`).fill("1.25");
    }
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({
      timeout: T,
    });

    // SWITCH AWAY AND BACK. Clearing the machine unmounts the entry form;
    // choosing it again mounts a new one, which is where the seed is read.
    await page.getByTestId("machine-select").selectOption("");
    await expect(page.getByTestId("machine-reading-entry")).toHaveCount(0, {
      timeout: T,
    });
    await page.getByTestId("machine-select").selectOption(machineId);
    await expect(page.getByTestId("machine-reading-entry")).toBeVisible({
      timeout: T,
    });

    // BOTH GROUPS ARE BACK. Before the fix there was one box labelled g1.
    await expect(page.getByTestId("setting-group-g1")).toBeVisible({ timeout: T });
    await expect(page.getByTestId("setting-group-g2")).toBeVisible();
    await expect(page.getByTestId("reading-g1-current")).toHaveValue("");
    await expect(page.getByTestId("reading-g2-current")).toHaveValue("");

    // CHANGE g2 ONLY.
    await page.getByTestId("setting-group-g2-channel-2").click();
    await page.getByTestId("reading-g2-current").fill("250");
    await page.getByTestId("reading-g2-duration").fill("280.0");
    await page.getByTestId("reading-g2-energy_shown").fill("1.40");
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({
      timeout: T,
    });

    // THE STORED ROWS: g2 gains a revision, g1 keeps exactly one.
    const caps = await capturesFor(thirdBlock);
    const byGroup = new Map<string, number[]>();
    for (const c of caps) {
      byGroup.set(c.group_key, [...(byGroup.get(c.group_key) ?? []), c.revision]);
    }
    expect(
      byGroup.get("g1"),
      "the untouched group gained a revision across a machine switch",
    ).toEqual([1]);
    expect(byGroup.get("g2"), "the changed group did not gain a revision").toEqual([
      1, 2,
    ]);
  });

  await test.step("11b: and the NEXT VISIT renders g2's change, not g1's", async () => {
    // The render half, on this path too: the harm the P1 does is what
    // guidance shows her next time.
    await sql(
      `update public.sessions set started_at = now() - interval '2 hours'
        where client_id = $1`,
      [clientId],
    );
    await page.goto(`/clients/${clientId}/sessions/new`);
    await page.locator('[data-modality="electrolysis"]').click({ timeout: T });
    await page.waitForURL(/\/clients\/[^/]+\/sessions\/[0-9a-f-]{36}/, {
      timeout: T,
    });
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await openMachinePanel(page);

    const prior = page.getByTestId("machine-prior-setup");
    await expect(prior).toBeVisible({ timeout: T });
    await expect(
      page.getByTestId("prior-setup-g1-current"),
      "g1 must still read its own 111",
    ).toContainText("111");
    await expect(
      page.getByTestId("prior-setup-g2-current"),
      "g2 must read the change made after the switch",
    ).toContainText("250");
    await expect(
      page.getByTestId("prior-setup-g1-current"),
      "the change was attributed to g1 as well",
    ).not.toContainText("250");
    await noOverflow(page);
  });
});

// Prepared source, NOT executed proof. Reuses this spec's existing seed, login,
// publication command, form and readback paths. Real model IDs stay blocked.
for (const device of [
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
  test.describe(`native 3G durability ${device.name}`, () => {
    test.use({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch });
    for (const profile of APILUS_3G_NATIVE_FIXTURES) for (const mode of profile.modes) {
      test(`${profile.model} / ${mode.key}: save, reload, history and next visit`, async ({ page }) => {
        test.skip(process.env.HONE_SYNTHETIC_MACHINE_PROFILE !== "1",
          "UNRUN native journey: existing synthetic server gate must explicitly be enabled; closed gate is not native acceptance.");
        const seed = await seedE2eStudio();
        const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
        const plan = planContractPublication([profile]);
        expect(plan.publish).toHaveLength(profile.modes.length);
        for (const contract of plan.publish) {
          await sql("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [
            contract.p_machine_profile_id, contract.p_machine_profile_version, contract.p_mode_key,
            contract.p_channels_max, contract.p_requires_installed_option, JSON.stringify(contract.p_fields),
          ]);
        }
        const machineId = randomUUID();
        await sql(`insert into public.studio_machines
          (id, studio_id, machine_profile_id, machine_profile_version, display_name)
          values ($1,$2,$3,$4,$5)`, [machineId, seed.studioId, profile.profileId, profile.version, profile.model]);
        const fields = modeFields(mode);
        const observations = fields.map(({ field, stageKey }, index) => ({
          stageKey, field,
          value: (index + 1 + 27 / 10 ** field.decimals).toFixed(field.decimals),
        }));
        const readStored = () => sql<{
          stage_key: string | null; field_key: string; value_numeric: string;
          native_unit: string; decimals: number; machine_profile_version: number;
          observation_source: string;
        }>(`select stage_key,field_key,value_numeric::text as value_numeric,native_unit,
          decimals,machine_profile_version,observation_source from public.treatment_setup_readings
          where session_block_id=$1 order by stage_key nulls first,field_key`, [blockId]);
        let blockId = "";
        await loginAsOwner(page, seed);
        await openCreateForm(page, clientId, sessionId);
        expect(await openMachinePanel(page), "enabled native fixture missing from server catalogue").toBe(true);
        await page.getByTestId("machine-select").selectOption(machineId);
        await page.getByTestId(`machine-mode-${mode.key}`).click({ timeout: T });
        for (const held of ["blend", "omniblend", "multiblend", "thermolysis", "snap"]) {
          await expect(page.getByTestId(`machine-mode-${held}`)).toHaveCount(0);
        }
        for (const stage of mode.stages) await expect(page.getByTestId("machine-setting-draft")).toContainText(stage.nativeLabel);
        for (const { field, value } of observations) {
          await expect(page.getByTestId(`field-label-${field.key}`)).toHaveText(field.nativeLabel);
          await expect(page.getByTestId(`field-unit-${field.key}`)).toHaveText(`(${field.unit})`);
          await expect(page.getByTestId(`reading-${field.key}`)).toHaveAttribute("step", String(10 ** -field.decimals));
          await page.getByTestId(`reading-${field.key}`).fill(value);
        }
        await noOverflow(page);
        await page.getByTestId("save-treatment-area").click({ timeout: T });
        await expect.poll(async () => (blockId = await blockIdOf(sessionId)), { timeout: T }).not.toBe("");
        // Separate SQL call after the application transaction commits: unlike
        // rollback-scoped DB helpers this checks the persisted durability boundary.
        await expect.poll(async () => (await readStored()).length, { timeout: T }).toBe(observations.length);
        const saved = await readStored();
        for (const { stageKey, field, value } of observations) {
          expect(saved.find((row) => row.stage_key === stageKey && row.field_key === field.key)).toMatchObject({
            value_numeric: value, native_unit: field.unit, decimals: field.decimals,
            machine_profile_version: 2, observation_source: field.expectedSource,
          });
        }
        const captures = await capturesFor(blockId);
        expect(captures).toHaveLength(1);
        expect(captures[0].setup_submission_id).not.toBeNull();

        await page.reload();
        await page.getByTestId(`edit-area-${blockId}`).click({ timeout: T });
        expect(await openMachinePanel(page)).toBe(true);
        const history = page.getByTestId("machine-recorded-setups");
        await expect(history).toBeVisible({ timeout: T });
        for (const { field, value } of observations) {
          await expect(history).toContainText(field.nativeLabel);
          await expect(history).toContainText(field.unit);
          await expect(history).toContainText(value);
          await expect(page.getByTestId(`reading-${field.key}`)).toHaveValue("");
        }
        expect(await readStored()).toEqual(saved);
        expect(await capturesFor(blockId)).toEqual(captures);
        await noOverflow(page);

        await sql("update public.sessions set started_at=now()-interval '2 hours' where client_id=$1", [clientId]);
        await page.goto(`/clients/${clientId}/sessions/new`);
        await page.locator('[data-modality="electrolysis"]').click({ timeout: T });
        await page.waitForURL(/\/clients\/[^/]+\/sessions\/[0-9a-f-]{36}/, { timeout: T });
        expect(page.url().split("/sessions/")[1]!.split(/[?#]/)[0]).not.toBe(sessionId);
        await page.getByTestId("add-settings-block-cta").click({ timeout: T });
        expect(await openMachinePanel(page)).toBe(true);
        await page.getByTestId("machine-select").selectOption(machineId);
        await page.getByTestId(`machine-mode-${mode.key}`).click({ timeout: T });
        await expect(page.getByTestId("machine-prior-setup")).toContainText(profile.model);
        for (const { stageKey, field, value } of observations) {
          const suffix = stageKey ? `${stageKey}-${field.key}` : field.key;
          const prior = page.getByTestId(`prior-setup-g1-${suffix}`);
          await expect(page.getByTestId(`reading-${field.key}`)).toHaveValue("");
          await expect(prior).toContainText(field.nativeLabel);
          await expect(prior).toContainText(value);
          await expect(prior).toContainText(field.unit);
        }
        expect(await readStored()).toEqual(saved);
        expect(await capturesFor(blockId)).toEqual(captures);
        await noOverflow(page);
      });
    }
  });
}
