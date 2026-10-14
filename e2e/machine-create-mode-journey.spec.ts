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

  await test.step("2: BEFORE the block exists, the machine is offered but nothing can be recorded", async () => {
    // THE CLAIM THIS SPEC EXISTS FOR, and nothing proved it mounted. A new
    // settings block has no row yet, so there is nowhere to put a reading -
    // and a form that collected one would have to discard it. The panel shows
    // the model's contract as a reference instead.
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

    // But there is no entry form and no save.
    expect(
      await page.getByTestId("machine-reading-entry").count(),
      "a reading could be entered against a block that does not exist yet",
    ).toBe(0);
    expect(await page.getByTestId("machine-reading-save").count()).toBe(0);
    await noOverflow(page);
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

  await test.step("5: the DATABASE holds ONE submission with both groups", async () => {
    // GROUND TRUTH. The UI saying "saved" is not the claim; the record is.
    const caps = await capturesFor(blockId);
    expect(caps, "two setting groups were entered").toHaveLength(2);

    const submissions = new Set(caps.map((c) => c.setup_submission_id));
    expect(
      submissions.size,
      "the two groups were recorded as separate saves, not one",
    ).toBe(1);
    firstSubmission = caps[0]!.setup_submission_id;
    expect(
      firstSubmission,
      "a save through the treatment form must carry its submission",
    ).not.toBeNull();

    // Each group keeps its own channels, unmerged.
    const byGroup = new Map(caps.map((c) => [c.group_key, c]));
    const channelSets = [...byGroup.values()].map((c) => c.channels);
    expect(channelSets.flat()).toHaveLength(
      new Set(channelSets.flat()).size,
    );

    // THE MACHINE'S OWN UNITS AND PRECISION, derived from the published
    // contract rather than from anything the browser sent.
    const rows = await readingsFor(blockId);
    expect(rows).toHaveLength(6);
    const current = rows.filter((r) => r.field_key === "current");
    expect(current).toHaveLength(2);
    expect(current.every((r) => r.native_unit === "µA")).toBe(true);
    expect(current.every((r) => r.decimals === 0)).toBe(true);
    expect(current.map((r) => r.value_numeric).sort()).toEqual(["120", "80"]);
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
    // The record is unchanged by a reload. Stated as a row count because a
    // re-save on mount would be invisible in the UI and permanent in the
    // record.
    expect(await capturesFor(blockId)).toHaveLength(2);
  });

  await test.step("7: a SECOND capture is a new save, not an edit of the first", async () => {
    // A setting changed mid-treatment. The earlier capture is immutable and
    // stays; this appends.
    // THROUGH THE EXPLICIT CONTROL. After a save the form shows the
    // confirmation, not the fields: recording again is a deliberate act, and
    // the draft is cleared rather than pre-filled - a value she has not
    // re-read off the machine is not a reading.
    await page.getByTestId("machine-reading-record-change").click({ timeout: T });
    await expect(page.getByTestId("machine-reading-entry")).toBeVisible({
      timeout: T,
    });

    // ONE group again, so the input testids revert to their unsuffixed form.
    await expect(page.getByTestId("reading-current")).toHaveValue("");
    await page.getByTestId("setting-group-g1-channel-1").click();
    await page.getByTestId("reading-current").fill("150");
    await page.getByTestId("reading-duration").fill("280.0");
    await page.getByTestId("reading-energy_shown").fill("1.40");
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({
      timeout: T,
    });

    const caps = await capturesFor(blockId);
    expect(caps.length).toBeGreaterThan(2);
    const second = caps
      .map((c) => c.setup_submission_id)
      .filter((id) => id !== firstSubmission);
    expect(
      new Set(second).size,
      "the second capture must belong to a DIFFERENT save",
    ).toBe(1);
    // The first capture is still there, unchanged. Append-only is the whole
    // clinical contract of this table.
    expect(
      caps.some((c) => c.setup_submission_id === firstSubmission),
    ).toBe(true);
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
    // machine is not a reading.
    const entry = page.getByTestId("machine-reading-entry");
    if ((await entry.count()) > 0) {
      await expect(entry.getByTestId("reading-current")).toHaveValue("");
    }
    await noOverflow(page);
  });
});
