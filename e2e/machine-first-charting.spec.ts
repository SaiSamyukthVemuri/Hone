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
// VERSION 2: the synthetic contract gained a machine-displayed field so a
// readback can distinguish per-field provenance from a blanket
// "practitioner-entered". A published contract is immutable per version, so a
// changed field set is a new version (Codex, ebc69ff6).
const SYNTHETIC_VERSION = 2;
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
        // The mixed-source field. Its contract source is machine-displayed,
        // which is what makes the provenance readback in step 6 falsifiable.
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

async function readingsFor({ blockId }: { blockId: string }) {
  return sql<{
    field_key: string;
    value_numeric: string | null;
    native_unit: string;
    decimals: number;
    machine_profile_id: string;
    machine_profile_version: number;
    observation_source: string;
    group_key: string;
    channels: number[];
    recorded_by_practitioner_id: string | null;
  }>(
    `select field_key, value_numeric::text as value_numeric, native_unit, decimals,
            machine_profile_id, machine_profile_version, observation_source,
            group_key, channels, recorded_by_practitioner_id
       from public.treatment_setup_readings
      where session_block_id = $1
      order by group_key, field_key`,
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
    // THE MIXED-SOURCE FIELD. Its contract source is machine-displayed, and it
    // is the only reason the provenance assertion below can fail: with both
    // other fields practitioner-entered, a blanket "practitioner-entered"
    // would have satisfied every earlier version of this check
    // (Codex, ebc69ff6).
    await page.getByTestId("reading-energy_shown").fill("12.25");
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({ timeout: T });

    const rows = await readingsFor({ blockId });
    expect(rows.map((r) => r.field_key)).toEqual([
      "current",
      "duration",
      "energy_shown",
    ]);
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

    // PROVENANCE PER FIELD, end to end and falsifiable. The form used to send
    // "practitioner-entered" for every reading, which is false for a field the
    // contract marks machine-displayed - and the rows are immutable, so the
    // wrong provenance would be permanent.
    expect(byField.get("current")!.observation_source).toBe("practitioner-entered");
    expect(
      byField.get("energy_shown")!.observation_source,
      "a blanket practitioner-entered mutation must fail here",
    ).toBe("machine-displayed");

    // And a single group records no channel association, which is NOT the same
    // as every channel.
    expect(byField.get("current")!.group_key).toBe("g1");
    expect(byField.get("current")!.channels).toEqual([]);
  });

  await test.step("7: a reading cannot exist WITHOUT a capture", async () => {
    // THIS STEP ASSERTED THE WRONG LAW and the ops01 lane's gate-open run
    // caught it. It used to insert a second `current` reading and expect a
    // duplicate-key refusal from the old write-once index. That law was
    // replaced by append-only revisions and the index is correctly gone, so
    // the step was asserting something the approved design deliberately
    // permits.
    //
    // Worse, its failure exposed a real gap rather than only a stale test: the
    // insert carried NO capture_id and was ACCEPTED, because the column was
    // nullable. That orphan sat outside every capture's revision AND outside
    // the (capture_id, stage, field) uniqueness - escaping both halves of the
    // coherence design. `capture_id` is now NOT NULL and part of a composite
    // foreign key, so the same insert is refused.
    //
    // Kept as a step, re-aimed at what is actually true: a reading belongs to
    // a capture, and the schema says so rather than the command merely being
    // careful. This runs as postgres, i.e. the only role that can insert at
    // all, so it tests the constraint rather than a privilege.
    const before = await readingsFor({ blockId });
    let refused = false;
    try {
      await sql(
        `insert into public.treatment_setup_readings
           (studio_id, session_block_id, machine_profile_id, machine_profile_version,
            mode_key, group_key, field_key, value_numeric, native_unit, decimals,
            observation_source, revision)
         values ($1, $2, $3, $4, 'galvanic', 'g1', 'current', 999, 'µA', 0,
                 'practitioner-entered', 1)`,
        [seed.studioId, blockId, SYNTHETIC_PROFILE_ID, SYNTHETIC_VERSION],
      );
    } catch {
      refused = true;
    }
    expect(refused, "a reading with no capture was accepted").toBe(true);
    const after = await readingsFor({ blockId });
    expect(after).toEqual(before);

    // And no orphan exists in the whole studio, which is the invariant rather
    // than this one insert's outcome.
    const orphans = await sql<{ n: string }>(
      `select count(*)::text as n from public.treatment_setup_readings
        where capture_id is null`,
    );
    expect(orphans[0]!.n, "an orphan reading exists somewhere").toBe("0");
  });

  await test.step("7b: a mid-treatment change APPENDS a revision, through the UI", async () => {
    // The approved law, exercised by the control that exists for it. Finding
    // 4254341029 was that the form hid this path after the first save and sent
    // the practitioner to free-text notes; it now offers "Record a setting
    // change", and this is the proof that the structured path works end to end
    // rather than only that the button renders.
    await page.getByTestId("machine-reading-record-change").click({ timeout: T });

    // THE DRAFT DOES NOT SURVIVE THE TRANSITION, asserted here because this is
    // where the transition actually happens.
    //
    // The entry surface is keyed by the setup identity - device, profile
    // version and mode - so React remounts it rather than carrying values
    // across. The defect that motivated the key: two modes reusing a field
    // identity (the galvanic and adjunct fixtures both declare `current`)
    // shared draft keys of (group, stage, field) only, so a value typed under
    // the old mode stayed in the box and could be submitted under the NEW
    // mode's key without being re-read (Codex, ebc69ff6).
    //
    // A FIRST DRAFT PUT THIS IN A STEP OF ITS OWN, which broke this step: that
    // step clicked "Record a setting change" first, so the button 7b needs was
    // already consumed and 7b timed out on it. The per-mode case needs a
    // two-mode profile and is proved in the unit suite; the synthetic profile
    // declares one mode, so this is the transition available here.
    await expect(
      page.getByTestId("reading-current"),
      "a new capture must start empty, never from the capture just saved",
    ).toHaveValue("");
    await expect(page.getByTestId("reading-energy_shown")).toHaveValue("");

    await page.getByTestId("reading-current").fill("180");
    await page.getByTestId("reading-duration").fill("300.5");
    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({ timeout: T });

    // TWO captures, and the earlier observation is untouched.
    const caps = await sql<{ revision: number; fields: string }>(
      `select c.revision,
              (select count(*)::text from public.treatment_setup_readings r
                where r.capture_id = c.id) as fields
         from public.treatment_setup_captures c
        where c.session_block_id = $1 order by c.revision`,
      [blockId],
    );
    // THREE readings in revision 1, two in revision 2: step 6 now also fills
    // the mixed-source `energy_shown` field, and this step fills only the two
    // required ones. The counts are asserted rather than ignored because a
    // capture silently losing a field is exactly what the composite-setup bug
    // looked like.
    expect(caps.map((c) => [c.revision, c.fields])).toEqual([
      [1, "3"],
      [2, "2"],
    ]);

    const currents = await sql<{ revision: number; v: string }>(
      `select revision, value_numeric::text as v
         from public.treatment_setup_readings
        where session_block_id = $1 and field_key = 'current'
        order by revision`,
      [blockId],
    );
    expect(
      currents.map((r) => [r.revision, r.v]),
      "the earlier reading was overwritten instead of superseded",
    ).toEqual([
      [1, "135"],
      [2, "180"],
    ]);
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

    // THE PHYSICAL UNIT'S NAME, and this is the only assertion in the suite
    // that proves the whole chain is actually connected:
    //
    //   studio_machine_id on the capture -> latest_setup_for_client ->
    //   RecordedReading.deviceId -> machinesByIds in the loader ->
    //   context.priorUnitNames -> the connected wrapper's forward ->
    //   the panel's prop -> MachinePriorSetup's render
    //
    // Its absence is exactly how that lookup shipped INERT: I had added it at
    // every layer except the wrapper's forward, and the render tests pass the
    // prop themselves so they could not see the missing wire. A studio with
    // two units of the same model cannot otherwise tell which setup to
    // reproduce (Codex, 2351742d).
    await expect(prior.getByTestId("prior-setup-unit")).toHaveText("Room 1 demo", {
      timeout: T,
    });
    // THE LATEST CAPTURE'S VALUES, which is 180 and not 135.
    //
    // Step 7b changed the current mid-treatment, so revision 2 is what she was
    // actually working at when the treatment ended - and guidance is "what was
    // she working at", not "what did she start at". Asserting 135 here would be
    // asserting the superseded value, which is precisely the composite
    // behaviour the capture model removed.
    await expect(prior).toContainText("180");
    await expect(prior).toContainText("300.5");
    await expect(prior).toContainText("µA");
    // AND NOT the superseded reading. This is the assertion that would catch a
    // regression back to per-field "latest", which could pair 135 with a newer
    // duration and show a setting that never existed.
    await expect(prior).not.toContainText("135");
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

  await test.step("10: BOTH revisions survive the new visit, unchanged", async () => {
    // Keyed by (field, revision) rather than by field alone. A field->row map
    // silently kept whichever row came last once step 7b added a second
    // revision, so it would have asserted something while meaning nothing.
    const rows = await sql<{ field_key: string; revision: number; v: string }>(
      `select field_key, revision, value_numeric::text as v
         from public.treatment_setup_readings
        where session_block_id = $1
        order by field_key, revision`,
      [blockId],
    );
    expect(
      rows.map((r) => [r.field_key, r.revision, r.v]),
      "a revision was lost or rewritten by the next visit",
    ).toEqual([
      ["current", 1, "135"],
      ["current", 2, "180"],
      ["duration", 1, "300.5"],
      ["duration", 2, "300.5"],
      // The mixed-source field, recorded once in revision 1 and NOT carried
      // into revision 2 - step 7b did not re-read it, and a capture must hold
      // only what she actually entered for it. Its presence here is also what
      // makes step 6's provenance assertion meaningful: this is the row whose
      // observation_source is machine-displayed.
      ["energy_shown", 1, "12.25"],
    ]);
  });

  // ORDER MATTERS HERE, and getting it wrong cost a run. Step 11 RETIRES the
  // machine and step 12 depends on it having been retired, so anything needing
  // a working unit has to come first. Placed after 11, this step waited two
  // minutes for a channel control that could not exist: the unit was out of
  // service, so nothing was selectable and there was no entry surface at all.
  await test.step("13: TWO setting groups record distinct channels and values", async () => {
    // The approved channel-group slice, through the real UI. The synthetic
    // profile declares four independently controlled outputs and
    // `supportsDistinctSettingGroups: true`, so the controls are offered here
    // exactly as they would be for a real multi-needle model.
    //
    // NOTHING IS AUTO-FILLED. The second group starts empty, and its channels
    // start unselected: carrying either over would assert she ran the second
    // set of probes at the first set's settings.
    const fresh = await seedNextVisitForSameClient(seed.studioId, clientId);
    await page.goto(`/clients/${clientId}/sessions/${fresh.sessionId}`);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });

    // A block to record against, exactly as step 5 does it. The ids here were
    // invented on a first draft (`block-area-input`, `save-settings-block`)
    // and do not exist; reusing step 5's real control is the point.
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(
        async () => {
          const rows = await sql<{ id: string }>(
            `select id from public.session_blocks
              where session_id = $1 and deleted_at is null order by sort_order limit 1`,
            [fresh.sessionId],
          );
          return rows[0]?.id ?? "";
        },
        { timeout: T, message: "the second visit's settings block never saved" },
      )
      .not.toBe("");
    await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
    await openMachinePanel(page);
    if ((await page.getByTestId(`machine-pick-${machineId}`).count()) > 0) {
      await page.getByTestId(`machine-pick-${machineId}`).click();
    }

    // GROUP 1: probes 1 and 2 at one current.
    await page.getByTestId("setting-group-g1-channel-1").click();
    await page.getByTestId("setting-group-g1-channel-2").click();
    await page.getByTestId("reading-current").fill("120");
    await page.getByTestId("reading-duration").fill("300.0");

    // GROUP 2: probes 3 and 4 at another.
    await page.getByTestId("setting-group-add").click();
    await expect(page.getByTestId("setting-group-g2")).toBeVisible({ timeout: T });
    await expect(
      page.getByTestId("reading-g2-current"),
      "a new group must start empty - nothing is copied from its sibling",
    ).toHaveValue("");
    await page.getByTestId("setting-group-g2-channel-3").click();
    await page.getByTestId("setting-group-g2-channel-4").click();
    await page.getByTestId("reading-g2-current").fill("80");
    await page.getByTestId("reading-g2-duration").fill("240.0");

    await page.getByTestId("machine-reading-save").click();
    await expect(page.getByTestId("machine-reading-saved")).toBeVisible({ timeout: T });

    // READ BACK: two groups, each with its own channels and its own values.
    const second = await sql<{
      group_key: string;
      channels: number[];
      revision: number;
      v: string;
    }>(
      `select c.group_key, c.channels, c.revision, r.value_numeric::text as v
         from public.treatment_setup_captures c
         join public.treatment_setup_readings r on r.capture_id = c.id
        where c.studio_id = $1 and r.field_key = 'current'
          and c.session_block_id <> $2
        order by c.group_key`,
      [seed.studioId, blockId],
    );
    expect(second.map((r) => r.group_key)).toEqual(["g1", "g2"]);
    expect(second[0]!.channels).toEqual([1, 2]);
    expect(second[1]!.channels).toEqual([3, 4]);
    expect(second[0]!.v).toBe("120");
    expect(second[1]!.v).toBe("80");
    // Each group is the FIRST capture of its own group, not two revisions of
    // one thing.
    expect(second[0]!.revision).toBe(1);
    expect(second[1]!.revision).toBe(1);

    // AND NEXT-VISIT GUIDANCE SHOWS BOTH, which is the half the database rows
    // alone cannot prove.
    //
    // `latest_setup_for_client` used to select ONE capture, so after a
    // two-group save the next visit displayed only the last group and silently
    // omitted the other probes' settings - the rows were all there and the
    // read hid half of them (Codex, f175e732). It now returns every group of
    // the latest setup, each at its own newest revision.
    const after = await seedNextVisitForSameClient(seed.studioId, clientId);
    await page.goto(`/clients/${clientId}/sessions/${after.sessionId}`);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await openMachinePanel(page);

    const prior = page.getByTestId("machine-prior-setup");
    await expect(prior).toBeVisible({ timeout: T });
    await expect(prior, "group 1's probes").toContainText("Channels 1, 2", {
      timeout: T,
    });
    await expect(prior, "group 2's probes must not be hidden").toContainText(
      "Channels 3, 4",
      { timeout: T },
    );
    // Both values, so this is not one group rendered twice.
    await expect(prior).toContainText("120");
    await expect(prior).toContainText("80");
  });

  await test.step("11: a FAILED selection write is reported, and changes nothing stored", async () => {
    // THE MOUNTED PROOF of the status line that was wrong twice. It claimed a
    // selection was remembered when the write had failed, because it was
    // reading the optimistic selection rather than the stored fact.
    //
    // The failure is induced the way it would really happen: the machine is
    // retired behind an already-rendered page, so the browser's list is stale
    // and the server refuses the write the client thinks is routine. Nothing
    // is stubbed, and the refusal comes from 0223's own command.
    //
    // LAST STEP DELIBERATELY: it retires the machine, so no later assertion
    // can depend on it.
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByTestId(/^edit-area-/).first().click({ timeout: T });
    await openMachinePanel(page);
    await expect(page.getByTestId("machine-chosen")).toContainText("Room 1 demo", {
      timeout: T,
    });

    // POSITIVE CONTROL: the clear path genuinely works, so the refusal proved
    // below is the retirement and not a broken selection path.
    await page.getByTestId("machine-change").click({ timeout: T });
    await expect(page.getByTestId(`machine-pick-${machineId}`)).toBeVisible({
      timeout: T,
    });
    await expect(page.getByTestId("machine-first-status")).toContainText(
      "nothing yet",
      { timeout: T },
    );
    const cleared = await sql<{ default_machine_id: string | null }>(
      `select p.default_machine_id from public.practitioners p
        where p.studio_id = $1 and p.role = 'owner'`,
      [seed.studioId],
    );
    expect(cleared[0]?.default_machine_id, "the clear really persisted").toBeNull();

    // Now retire it, behind the rendered page.
    await sql(`update public.studio_machines set retired_at = now() where id = $1`, [
      machineId,
    ]);

    // The stale button is still there, and clicking it is an ordinary action.
    await page.getByTestId(`machine-pick-${machineId}`).click({ timeout: T });

    // THE NOTE MUST BE VISIBLE. It used to render only inside the
    // chosen-machine block, so the message a practitioner most needed could be
    // the one most reliably hidden.
    await expect(page.getByTestId("machine-selection-not-remembered")).toBeVisible({
      timeout: T,
    });

    // AND THE STORED FACT MUST NOT HAVE MOVED - in the UI...
    await expect(page.getByTestId("machine-first-status")).toContainText(
      "nothing yet",
      { timeout: T },
    );
    // ...and in the database, which is the only authority on it.
    const after = await sql<{ default_machine_id: string | null }>(
      `select p.default_machine_id from public.practitioners p
        where p.studio_id = $1 and p.role = 'owner'`,
      [seed.studioId],
    );
    expect(
      after[0]?.default_machine_id,
      "a refused write must leave the stored selection alone",
    ).toBeNull();
  });

  await test.step("12: the RETIRED unit is still NAMED in next-visit guidance", async () => {
    // Step 11 retired the machine, so this is the real production state that a
    // component fixture cannot create: `listStudioMachines` excludes retired
    // units in SQL, so they never reach the panel's device list. An earlier
    // version of this claim was a render test that injected a retired device
    // into that list directly - a state the loader cannot produce, which made
    // the test pass while proving nothing (Codex, 27061e88).
    //
    // What must hold: the unit is GONE from the picker and still NAMED in the
    // history, because the practitioner is reading what happened, not choosing
    // a machine.
    const next = await seedNextVisitForSameClient(seed.studioId, clientId);
    await page.goto(`/clients/${clientId}/sessions/${next.sessionId}`);
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });

    // The panel opens into its no-machine state now, which is correct and is
    // why `openMachinePanel`'s return is not asserted here.
    await openMachinePanel(page);

    const prior = page.getByTestId("machine-prior-setup");
    await expect(prior).toBeVisible({ timeout: T });
    await expect(
      prior.getByTestId("prior-setup-unit"),
      "a retired unit must still be nameable: that is what machinesByIds is for",
    ).toHaveText("Room 1 demo", { timeout: T });

    // AND IT IS NOT OFFERED. The SQL guard that hid it from the picker is
    // still doing its job; naming it did not re-expose it.
    await expect(page.getByTestId(`machine-pick-${machineId}`)).toHaveCount(0);

    const stillRetired = await sql<{ retired: boolean }>(
      `select retired_at is not null as retired from public.studio_machines where id = $1`,
      [machineId],
    );
    expect(stillRetired[0]?.retired, "the unit really is out of service").toBe(true);
  });
});
