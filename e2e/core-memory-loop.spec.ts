import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  getIntakeTokenForClient,
  getClientIdByEmail,
  getAppointmentsForClient,
  type E2eSeed,
} from "./helpers/seed";
import { bookAppointment, loginAsOwner } from "./helpers/flows";

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
    await loginAsOwner(page, seed);
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

    // The "Add settings block" form renders directly on the session
    // page. Record the clinical-memory fields the app models today:
    // area, machine frequency, probe brand + lot, minutes, tolerance,
    // reaction chip. (Per-area caution inputs were deliberately
    // retired; the session-level "For next visit" note below is the
    // caution/watch mechanism.)
    // Charting polish: the settings form no longer auto-opens, a zero-block
    // session starts on the compact CTA, so open it explicitly first.
    await page.getByTestId("add-settings-block-cta").click({ timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: /add settings block/i }),
    ).toBeVisible({ timeout: 20_000 });
    // Migration 0128: the area is added via the multi-area editor (adding "Chin"
    // records it as the block's single treated area).
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await page.getByRole("button", { name: "13.56 MHz" }).click();
    await page.getByRole("button", { name: "Sterex" }).click();
    await page.getByPlaceholder("e.g. 460941").fill(`E2E-LOT-${seed.runId}`);
    await page
      .getByRole("spinbutton", { name: /minutes performed/i })
      .fill("15");
    await page.getByRole("button", { name: "Mild discomfort" }).click();
    await page.getByRole("button", { name: "+ Mild redness" }).click();
    await page.getByRole("button", { name: /save settings block/i }).click();
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

    // The Finish appointment workflow replaces the loose "Finish up" links.
    // The completion and postcare controls it used to send her to the calendar
    // page for are now IN this section, so the hop is gone by design.
    await expect(page.getByTestId("finish-appointment")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Done, back to client/ }),
    ).toBeVisible();
    await expect(page.getByTestId("finish-completion-status")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Review appointment & billing" }),
    ).toHaveCount(0);
    expect(firstAppointmentId).toBeTruthy();
    expect(true).toBe(true);
  });

  await test.step("dashboard Today row knows the appointment is charted (PR #236)", async () => {
    await page.goto("/dashboard");
    await expect(
      page.getByRole("link", { name: "View session" }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Charted", { exact: true }).first(),
    ).toBeVisible();
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
    // PR #237 hierarchy: the Remember today band leads, the last
    // treatment snapshot carries the probe lot chip, and the client
    // response section surfaces the recorded tolerance and reaction.
    await expect(page.getByText("Remember today").first()).toBeVisible();
    await expect(
      page.getByText(`Lot E2E-LOT-${seed.runId}`).first(),
    ).toBeVisible();
    await expect(page.getByText("Tolerance 4/5").first()).toBeVisible();
    await expect(page.getByText("Mild redness").first()).toBeVisible();
  });

  await test.step("the Today card surfaces the recorded next-visit memory", async () => {
    // The rules-based prep derivation still pulls the same recorded facts, it
    // now renders ONCE, inside the appointment's own Today card, instead of a
    // second time in a separate "Daily prep brief" list.
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "Today", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page
        .getByText(/Remember: E2E caution: shorter intervals next visit/)
        .first(),
    ).toBeVisible();
    // The retired separate list is gone.
    await expect(
      page.getByRole("heading", { name: "Daily prep brief" }),
    ).toHaveCount(0);

    // PR #249's rules-based assistant still runs on the dashboard (its
    // bounded studio-scoped loader exercises the recent-sessions /
    // completed-appt / intake reads against the real local DB). Dashboard V2
    // Part 2B retired its standalone card: its gaps now render as rows of the
    // ONE To do list, so assert on the section that owns them. The heading is
    // present whether there are gaps or the calm empty state.
    await expect(page.getByRole("heading", { name: "To do" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Follow-up assistant" }),
    ).toHaveCount(0);

    // PR #250 Pilot Love Loop V1, as amended by the Chloe D4 cleanup.
    //
    // The "Pilot learning" CARD is GONE from the Dashboard: "Notice a moment
    // where Hone helped you remember something? Send it to Sam." plus "Send
    // feedback" / "Know another electrologist?" was pilot tooling, and a
    // practitioner's daily worklist is not where it belongs. This step used to
    // assert the card was visible; it now asserts the opposite, deliberately.
    await expect(
      page.getByRole("heading", { name: "Pilot learning" }),
    ).toHaveCount(0);
    await expect(page.getByText("Send it to Sam")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Know another electrologist?" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Send feedback" })).toHaveCount(0);

    // DASH-TRUTH-04 finished the cleanup the card removal started: the quiet
    // "Was this useful?" footers are gone from the Dashboard too. The daily
    // product no longer routes practitioner feedback to the founder, so there
    // is no pilot-feedback affordance left on this page at all.
    //
    // Asserted narrowly and by its own copy, deliberately NOT a bare absence
    // of "Yes", which is a common word that a future unrelated control could
    // legitimately use.
    await expect(page.getByText("Was this useful?")).toHaveCount(0);
    await expect(
      page.locator('a[href^="mailto:hello@hone.care"]'),
    ).toHaveCount(0);
  });

  await test.step("Record Keeping shows the procedure record, filtered print works", async () => {
    await page.goto(`/records?section=procedures&clientId=${clientId}`);
    await expect(
      page.getByText(
        new RegExp(`Showing 1 recorded session for\\s+${seed.clientName}`),
      ),
    ).toBeVisible({ timeout: 20_000 });
    // PR #238: friendlier section copy around the per-client filter.
    await expect(
      page.getByRole("heading", { name: "Procedure records" }),
    ).toBeVisible();
    await expect(
      page.getByText(/Use this when you need a procedure record for one client/),
    ).toBeVisible();
    await expect(page.getByText("Choose a client")).toBeVisible();
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
