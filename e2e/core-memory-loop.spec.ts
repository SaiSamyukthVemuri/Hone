import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  getIntakeTokenForClient,
  getClientIdByEmail,
  getAppointmentsForClient,
  type E2eSeed,
} from "./helpers/seed";
import { waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// PR #227: the core treatment-memory loop, end to end in a real
// browser against the LOCAL stack: public booking -> intake ->
// practitioner magic-link login (real GoTrue email via Mailpit, no
// auth bypass) -> dashboard -> charting with clinical-memory fields
// -> second appointment -> Before Today / Treatment Intelligence
// show the recorded memory -> Record Keeping procedure record +
// filtered print -> anonymous access stays locked out.
//
// Deterministic by construction: unique e2e-prefixed seed per run,
// disposable local DB (no cleanup; supabase db reset wipes it),
// dummy provider keys so no real email/SMS/charge can occur.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let clientId: string;
let firstAppointmentId: string;

async function bookAppointment(page: Page, s: E2eSeed): Promise<void> {
  await page.goto(`/book/${s.slug}`);
  await expect(page.getByText(s.studioName).first()).toBeVisible();
  await page.getByRole("button", { name: /new client/i }).click();
  // Single seeded consultation service is preselected; pick the first
  // available slot, jumping forward if the default day has none.
  const slotButton = page.getByRole("button", {
    name: /^\d{1,2}:\d{2} (AM|PM)$/,
  });
  const nextDay = page.getByRole("button", { name: /next available day/i });
  await expect(async () => {
    const slots = await slotButton.count();
    const next = await nextDay.count();
    expect(slots + next).toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });
  if ((await slotButton.count()) === 0) {
    await nextDay.click();
    await expect(slotButton.first()).toBeVisible({ timeout: 20_000 });
  }
  await slotButton.first().click();
  await page.getByLabel(/your name/i).fill(s.clientName);
  await page.getByLabel(/^email/i).fill(s.clientEmail);
  await page.getByLabel(/phone/i).fill("+1 555 555 0123");
  await page.getByRole("button", { name: /book appointment/i }).click();
  // Confirmation state replaces the form.
  await expect(
    page.getByRole("heading", { name: /your appointment is booked/i }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(s.clientEmail).first()).toBeVisible();
}

test("core memory loop: booking to next-appointment memory", async ({
  page,
  browser,
}) => {
  await test.step("seed studio, owner, service, availability", async () => {
    seed = await seedE2eStudio();
  });

  await test.step("public booking succeeds", async () => {
    await bookAppointment(page, seed);
    clientId = (await getClientIdByEmail(seed.studioId, seed.clientEmail))!;
    expect(clientId).toBeTruthy();
    const appointments = await getAppointmentsForClient(seed.studioId, clientId);
    expect(appointments.length).toBe(1);
    expect(appointments[0].status).toBe("confirmed");
    firstAppointmentId = appointments[0].id;
  });

  await test.step("intake completes via the token link", async () => {
    const token = await getIntakeTokenForClient(seed.studioId, seed.clientEmail);
    expect(token).toBeTruthy();
    await page.goto(`/intake/${token}`);
    await expect(page.getByText(/intake/i).first()).toBeVisible();
    // Error-driven walker: try to advance; every validation alert
    // identifies its own question container, which we answer with a
    // safe generic value ("No" for yes/no, first option for selects,
    // check for acknowledgements, generic text/date otherwise).
    for (let stepAttempt = 0; stepAttempt < 40; stepAttempt += 1) {
      if (page.url().includes("thank-you")) break;
      // Pre-fill visible empty text/date/textarea fields on the step.
      for (const input of await page
        .locator("input[type=text]:visible, input:not([type]):visible, textarea:visible")
        .all()) {
        if ((await input.inputValue()) === "") {
          const id = (await input.getAttribute("id")) ?? "";
          await input.fill(id.includes("email") ? seed.clientEmail : "E2E answer");
        }
      }
      for (const input of await page.locator("input[type=date]:visible").all()) {
        if ((await input.inputValue()) === "") await input.fill("1990-01-01");
      }
      const advance = page.getByRole("button", {
        name: /submit intake|next|continue/i,
      });
      await advance.first().click();
      await page.waitForTimeout(400);
      const alerts = await page.getByRole("alert").all();
      for (const alert of alerts) {
        const container = alert.locator("..");
        const no = container.getByRole("button", { name: /^No$/ });
        const checkbox = container.locator("input[type=checkbox]");
        const anyOption = container.getByRole("button").first();
        if ((await no.count()) > 0) {
          await no.first().click();
        } else if ((await checkbox.count()) > 0) {
          await checkbox.first().check();
        } else if ((await anyOption.count()) > 0) {
          await anyOption.click();
        }
      }
    }
    await expect(page).toHaveURL(/thank-you/, { timeout: 20_000 });
  });

  await test.step("practitioner logs in via REAL magic link", async () => {
    await page.goto("/login");
    await page
      .getByLabel("Agree to Terms of Service and Privacy Policy")
      .check();
    await page.locator("#login-email").fill(seed.ownerEmail);
    await page.getByRole("button", { name: /send magic link/i }).click();
    const link = await waitForMagicLink(seed.ownerEmail, E2E_APP_ORIGIN);
    await page.goto(link);
    await page.waitForURL(/dashboard/, { timeout: 30_000 });
  });

  await test.step("dashboard renders snapshot + charted-24h card", async () => {
    await expect(page.getByText("Charted within 24h").first()).toBeVisible();
    // The only appointment is still upcoming, so the metric is in its
    // empty state; the card must use the safe wording.
    await expect(
      page.getByText("No recent completed sessions yet.").first(),
    ).toBeVisible();
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/compliance|ranking|monitoring|\bscore\b/i);
  });

  await test.step("client page shows understandable pre-charting states", async () => {
    await page.goto(`/clients/${clientId}`);
    await expect(page.getByText(seed.clientName).first()).toBeVisible();
  });

  await test.step("chart the appointment with clinical memory fields", async () => {
    await page.goto(
      `/clients/${clientId}/sessions/new?appointment_id=${firstAppointmentId}`,
    );
    await page.getByRole("button", { name: /electrolysis/i }).click();
    await page.waitForURL(/sessions\//, { timeout: 20_000 });

    // The "New treatment area" form renders directly on the session
    // page. Record the clinical-memory fields the app models today:
    // area, machine frequency, probe brand + lot, minutes, tolerance,
    // reaction chip. (Per-area caution inputs were deliberately
    // retired; the session-level "For next visit" note below is the
    // caution/watch mechanism.)
    await expect(
      page.getByRole("heading", { name: /new treatment area/i }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await page.getByRole("button", { name: "13.56 MHz" }).click();
    await page.getByRole("button", { name: "Sterex" }).click();
    await page.getByPlaceholder("e.g. 460941").fill(`E2E-LOT-${seed.runId}`);
    await page
      .getByRole("spinbutton", { name: /minutes performed/i })
      .fill("15");
    await page.getByRole("button", { name: "4", exact: true }).click();
    await page.getByRole("button", { name: "+ Mild redness" }).click();
    await page.getByRole("button", { name: /save treatment area/i }).click();
    await expect(page.getByText(`E2E-LOT-${seed.runId}`).first()).toBeVisible({
      timeout: 20_000,
    });

    // Session-level memory: the "For next visit" watch/plan note.
    await page
      .getByPlaceholder(/start lower and check sensitivity/i)
      .fill("E2E caution: shorter intervals next visit");
    await page.getByRole("button", { name: /save note/i }).click();
    await expect(
      page.getByText("E2E caution: shorter intervals next visit").first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  await test.step("book a second appointment for the same client", async () => {
    const bookingPage = await browser.newPage();
    await bookAppointment(bookingPage, seed);
    await bookingPage.close();
    const appointments = await getAppointmentsForClient(seed.studioId, clientId);
    expect(appointments.length).toBeGreaterThanOrEqual(2);
  });

  await test.step("Before Today shows the recorded memory", async () => {
    await page.goto(`/clients/${clientId}`);
    await expect(
      page.getByText(/E2E caution: shorter intervals next visit/).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  await test.step("Record Keeping shows the procedure record, filtered print works", async () => {
    await page.goto(`/records?section=procedures&clientId=${clientId}`);
    await expect(
      page.getByText(
        new RegExp(`Showing 1 recorded session for\\s+${seed.clientName}`),
      ),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`E2E-LOT-${seed.runId}`).first()).toBeVisible();

    // Mark risks/aftercare explained from the procedure record row.
    await page
      .getByRole("button", { name: /mark risks explained|risks explained/i })
      .first()
      .click();
    await expect(
      page.getByText(/✓ Risks explained and aftercare provided/).first(),
    ).toBeVisible({ timeout: 20_000 });

    await page.goto(
      `/records/print?section=procedures&clientId=${clientId}`,
    );
    await expect(page.getByText(seed.studioName).first()).toBeVisible();
    await expect(
      page.getByText(new RegExp(`Filtered: client\\s+${seed.clientName}`)),
    ).toBeVisible();
    await expect(
      page.getByText(/Client Records for Invasive Procedures/i).first(),
    ).toBeVisible();
    await expect(page.getByText(`E2E-LOT-${seed.runId}`).first()).toBeVisible();
    await expect(
      page.getByText(/Risks explained and aftercare information provided/i),
    ).toBeVisible();
  });

  await test.step("anonymous access to Records and print redirects to login", async () => {
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    for (const path of [
      "/records",
      `/records/print?section=procedures&clientId=${clientId}`,
      "/dashboard",
    ]) {
      await anonPage.goto(path);
      await anonPage.waitForURL(/login/, { timeout: 15_000 });
    }
    await anonContext.close();
  });
});
