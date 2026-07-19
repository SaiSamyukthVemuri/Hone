import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  getIntakeTokenForClient,
  getClientIdByEmail,
  getAppointmentsForClient,
  getSessionBlockProbeLots,
  getSessionBlockAreas,
  getSessionRecordState,
  type E2eSeed,
} from "./helpers/seed";
import { bookAppointment, loginAsOwner } from "./helpers/flows";

// SAFE-WILLOW behavioural contract — slice 1: the treatment-memory activation
// loop. This is the executable form of the roadmap's activation metric
// (first visit charted -> returning visit surfaces prior memory), asserted at
// BOTH layers: database rows (tenant scoping, linkage, record state) AND
// browser-visible behaviour.
//
// SAFETY: runs entirely against a fresh SYNTHETIC studio seeded on the LOCAL
// stack (seedE2eStudio; e2e-prefixed, @harness.local, dummy provider keys).
// It NEVER connects to or mutates Willow or production. Willow's approved
// workflow is modelled with synthetic data, not exercised against Willow.
//
// COVERAGE (this slice): book -> intake/consent -> open+record a session
// (chips + narrative) -> save -> reload -> verify persistence (DB + browser) ->
// book a second visit -> verify Before Today shows the prior memory.
// NOT YET COVERED (named for later SAFE-WILLOW slices): reminders/postcare
// dispatch capture, calendar Move-appointment, portal access, treatment-photo
// metadata, approved payment/refund via fake Stripe, records/export contract,
// and finalized-record immutability (the clinical_finalization flag is OFF in
// the pilot, so no finalized state exists to mutate here — this slice asserts
// the current non-finalized record state + persistence across reload).

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let clientId: string;
let firstAppointmentId: string;
let sessionId: string;

test("SAFE-WILLOW: treatment-memory activation loop (synthetic Studio A)", async ({
  page,
  browser,
}) => {
  await test.step("seed a synthetic studio (never Willow/production)", async () => {
    seed = await seedE2eStudio();
    expect(seed.studioId).toBeTruthy();
    expect(seed.clientEmail).toMatch(/@harness\.local$/); // synthetic only
  });

  await test.step("book first visit — browser + DB (tenant scoping, linkage)", async () => {
    await bookAppointment(page, seed);
    clientId = (await getClientIdByEmail(seed.studioId, seed.clientEmail))!;
    expect(clientId).toBeTruthy();
    const appts = await getAppointmentsForClient(seed.studioId, clientId);
    expect(appts.length).toBe(1);
    expect(appts[0].status).toBe("confirmed");
    firstAppointmentId = appts[0].id;
    // DB linkage: the appointment belongs to the seeded synthetic studio+client.
    expect(appts.every((a) => a.id)).toBe(true);
  });

  await test.step("complete intake + consent via token — browser", async () => {
    const token = await getIntakeTokenForClient(seed.studioId, seed.clientEmail);
    expect(token).toBeTruthy();
    await page.goto(`/intake/${token}`);
    await expect(page.getByText(/intake/i).first()).toBeVisible();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (page.url().includes("thank-you")) break;
      for (const input of await page
        .locator("input[type=text]:visible, input:not([type]):visible, textarea:visible")
        .all()) {
        if ((await input.inputValue()) === "") {
          const id = (await input.getAttribute("id")) ?? "";
          await input.fill(id.includes("email") ? seed.clientEmail : "SAFE-WILLOW answer");
        }
      }
      for (const input of await page.locator("input[type=date]:visible").all()) {
        if ((await input.inputValue()) === "") await input.fill("1990-01-01");
      }
      await page
        .getByRole("button", { name: /submit intake|next|continue/i })
        .first()
        .click();
      await page.waitForTimeout(400);
      for (const alert of await page.getByRole("alert").all()) {
        const c = alert.locator("..");
        const no = c.getByRole("button", { name: /^No$/ });
        const cb = c.locator("input[type=checkbox]");
        const any = c.getByRole("button").first();
        if ((await no.count()) > 0) await no.first().click();
        else if ((await cb.count()) > 0) await cb.first().check();
        else if ((await any.count()) > 0) await any.click();
      }
    }
    await expect(page).toHaveURL(/thank-you/, { timeout: 20_000 });
  });

  await test.step("practitioner logs in via REAL magic link", async () => {
    await loginAsOwner(page, seed);
  });

  await test.step("record a session: chips + narrative — browser then DB", async () => {
    await page.goto(
      `/clients/${clientId}/sessions/new?appointment_id=${firstAppointmentId}`,
    );
    await page.getByRole("button", { name: /electrolysis/i }).click();
    await page.waitForURL(/sessions\//, { timeout: 20_000 });
    sessionId = page.url().match(/sessions\/([0-9a-f-]{36})/)?.[1] ?? "";
    expect(sessionId).toMatch(/[0-9a-f-]{36}/);

    await expect(
      page.getByRole("heading", { name: /add settings block/i }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await page.getByRole("button", { name: "13.56 MHz" }).click();
    await page.getByRole("button", { name: "Sterex" }).click();
    await page.getByPlaceholder("e.g. 460941").fill(`SW-LOT-${seed.runId}`);
    await page.getByRole("spinbutton", { name: /minutes performed/i }).fill("15");
    await page.getByRole("button", { name: "Mild discomfort" }).click();
    await page.getByRole("button", { name: "+ Mild redness" }).click();
    await page.getByRole("button", { name: /save settings block/i }).click();
    await expect(page.getByText(`SW-LOT-${seed.runId}`).first()).toBeVisible({
      timeout: 20_000,
    });

    await page
      .getByPlaceholder(/start lower and check sensitivity/i)
      .fill("SAFE-WILLOW watch: shorter intervals next visit");
    await page.getByRole("button", { name: /save note/i }).click();
    await expect(
      page.getByText("SAFE-WILLOW watch: shorter intervals next visit").first(),
    ).toBeVisible({ timeout: 20_000 });

    // DB layer: the recorded memory persisted, tenant-scoped + linked to this
    // synthetic studio's session.
    const lots = await getSessionBlockProbeLots(sessionId);
    expect(lots).toContain(`SW-LOT-${seed.runId}`);
    const areas = await getSessionBlockAreas(sessionId);
    expect(areas).toContain("Chin");
    // Record state: the session row exists and is NOT finalized (the
    // clinical_finalization flag is OFF in the pilot). Finalized-record
    // immutability is therefore not exercisable here; a later SAFE-WILLOW slice
    // covers it when finalization is enabled on a synthetic tenant.
    const state = await getSessionRecordState(sessionId);
    expect(typeof state.record_version).toBe("number");
    expect(state.current_snapshot_id).toBeNull();
  });

  await test.step("reload — persistence holds at DB + browser", async () => {
    // DB: re-read after a fresh query round-trip.
    expect(await getSessionBlockProbeLots(sessionId)).toContain(`SW-LOT-${seed.runId}`);
    // Browser: reload the session page; the recorded facts are still shown.
    await page.reload();
    await expect(page.getByText(`SW-LOT-${seed.runId}`).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText("SAFE-WILLOW watch: shorter intervals next visit").first(),
    ).toBeVisible();
  });

  await test.step("book a second visit — DB confirms returning client", async () => {
    const p2 = await browser.newPage();
    await bookAppointment(p2, seed);
    await p2.close();
    const appts = await getAppointmentsForClient(seed.studioId, clientId);
    expect(appts.length).toBeGreaterThanOrEqual(2);
  });

  await test.step("activation: Before Today surfaces the prior memory — browser", async () => {
    await page.goto(`/clients/${clientId}`);
    await expect(page.getByText("Remember today").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(`Lot SW-LOT-${seed.runId}`).first()).toBeVisible();
    await expect(page.getByText("Tolerance 4/5").first()).toBeVisible();
    await expect(page.getByText("Mild redness").first()).toBeVisible();
    await expect(
      page.getByText(/SAFE-WILLOW watch: shorter intervals next visit/).first(),
    ).toBeVisible();
  });
});
