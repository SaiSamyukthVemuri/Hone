import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eActiveCardOnFile,
  seedE2eDashboardClient,
  seedE2eTodayAppointment,
  sql,
  type E2eSeed,
  seedE2eCardOnFileCapability,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Chloe production feedback, on the real Dashboard against the local stack:
//
//   1. "dashboard should highlight current client"
//   2. "i want a button for consultation notes so i can start them immediately
//      from dashboard"
//   3. "tell me … next to my upcoming clients names if they have a card on
//      file or not"
//   4. "or maybe a one click reminder button that sends an email"
//
// Everything below is asserted on the RENDERED row, so the truth model is
// proved where the practitioner actually reads it. In particular: a live-mode
// card while this stack runs in TEST mode must NOT read as "Card on file", and
// a client who already has a card must NOT be offered the reminder.

const T = 30_000;

/** The Today row for one client, by the client's unique seeded name. */
function row(page: Page, clientName: string): Locator {
  return page.locator("li").filter({ hasText: clientName }).first();
}

async function openDashboard(page: Page) {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible({
    timeout: T,
  });
}

/** A client on today's roster, with a controllable appointment interval. */
async function seedRow(
  seed: E2eSeed,
  opts: {
    label: string;
    startsMinutesFromNow: number;
    endsMinutesFromNow: number;
    status?: "confirmed" | "completed" | "cancelled" | "no_show";
    withService?: boolean;
    withEmail?: boolean;
  },
) {
  const client = await seedE2eDashboardClient(seed, {
    label: opts.label,
    withEmail: opts.withEmail,
  });
  const { appointmentId } = await seedE2eTodayAppointment(seed, {
    clientId: client.clientId,
    startsMinutesFromNow: opts.startsMinutesFromNow,
    endsMinutesFromNow: opts.endsMinutesFromNow,
    status: opts.status,
    withService: opts.withService,
  });
  return { ...client, appointmentId };
}

test.describe("Today row: current client, card status, one-tap actions", () => {
  test("the client in the room NOW is highlighted, and nobody else is", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    // now IS inside this interval.
    const inRoom = await seedRow(seed, {
      label: "Now Client",
      startsMinutesFromNow: -20,
      endsMinutesFromNow: 40,
    });
    // Later today: not current.
    const later = await seedRow(seed, {
      label: "Later Client",
      startsMinutesFromNow: 120,
      endsMinutesFromNow: 180,
    });
    // A NO-SHOW whose booked interval also contains now. The clock alone would
    // light this up; the status rule must not.
    const noShow = await seedRow(seed, {
      label: "Noshow Client",
      startsMinutesFromNow: -20,
      endsMinutesFromNow: 40,
      status: "no_show",
    });

    await loginAsOwner(page, seed);
    await openDashboard(page);

    await test.step("the current appointment carries the Current pill", async () => {
      await expect(
        row(page, inRoom.name).getByTestId("today-current-pill"),
      ).toBeVisible({ timeout: T });
      // The highlight lives on the row container inside the <li>.
      await expect(
        row(page, inRoom.name).getByTestId("today-current-row"),
      ).toHaveCount(1);
    });

    await test.step("a future appointment is NOT current", async () => {
      await expect(
        row(page, later.name).getByTestId("today-current-pill"),
      ).toHaveCount(0);
    });

    await test.step("a NO-SHOW inside the interval is NOT current", async () => {
      // The clock alone would light this row up. The status rule is what stops
      // it sending the practitioner to an empty chair.
      await expect(row(page, noShow.name)).toBeVisible();
      await expect(
        row(page, noShow.name).getByTestId("today-current-pill"),
      ).toHaveCount(0);
    });

    await test.step("exactly ONE row is current on this non-overlapping schedule", async () => {
      await expect(page.getByTestId("today-current-pill")).toHaveCount(1);
    });
  });

  test("a COMPLETED visit that still spans now is not the client in the room", async ({
    page,
  }) => {
    // Its own studio: 0134 keys reservations STUDIO-WIDE while per-practitioner
    // capacity is off, so a completed visit spanning now cannot coexist with a
    // confirmed one. Alone, it is a schedule the database genuinely allows —
    // and the only appointment that could possibly be highlighted.
    //
    // (The two-practitioners-at-once case is proved where the rule lives:
    // tests/lib/dashboard/current-appointment.test.ts returns a SET and never
    // picks a winner. Expressing it here would mean turning on practitioner
    // capacity, which belongs to the separate scheduling work.)
    const seed = await seedE2eStudio();
    const finishedEarly = await seedRow(seed, {
      label: "Finished Client",
      startsMinutesFromNow: -20,
      endsMinutesFromNow: 40,
      status: "completed",
    });

    await loginAsOwner(page, seed);
    await openDashboard(page);

    await expect(row(page, finishedEarly.name)).toBeVisible({ timeout: T });
    await expect(
      row(page, finishedEarly.name).getByTestId("today-current-pill"),
    ).toHaveCount(0);
    await expect(page.getByTestId("today-current-pill")).toHaveCount(0);
  });

  test("Consultation notes is ONE tap to the existing consultation writer", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    // The seeded studio service is a CONSULTATION, so this row's action reads
    // "Start consultation notes".
    const consult = await seedRow(seed, {
      label: "Consult Client",
      startsMinutesFromNow: -10,
      endsMinutesFromNow: 50,
      withService: true,
    });
    const other = await seedRow(seed, {
      label: "Other Client",
      startsMinutesFromNow: 90,
      endsMinutesFromNow: 150,
    });

    await loginAsOwner(page, seed);
    await openDashboard(page);

    const consultAction = row(page, consult.name).getByTestId(
      "today-consultation-notes",
    );
    await expect(consultAction).toHaveText("Start consultation notes", {
      timeout: T,
    });
    await expect(
      row(page, other.name).getByTestId("today-consultation-notes"),
    ).toHaveText("Consultation notes");

    await consultAction.click();
    // The canonical practitioner route — not a Dashboard-local editor.
    await expect(page).toHaveURL(
      new RegExp(`/clients/${consult.clientId}\\?tab=consultation`),
      { timeout: T },
    );
    // It landed on the REAL writer, which already lives on that tab.
    await expect(
      page.getByRole("heading", { name: /consultation/i }).first(),
    ).toBeVisible({ timeout: T });
  });

  test("card status is truthful: on file / no card / wrong-mode is NOT on file", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    // The Dashboard asks CAPABILITY first: without an active card_authorization
    // template the studio has no card-on-file route and renders no card UI at all.
    await seedE2eCardOnFileCapability(seed);
    const withCard = await seedRow(seed, {
      label: "Hascard Client",
      startsMinutesFromNow: 60,
      endsMinutesFromNow: 120,
    });
    const withoutCard = await seedRow(seed, {
      label: "Nocard Client",
      startsMinutesFromNow: 180,
      endsMinutesFromNow: 240,
    });
    // A LIVE-mode card while this deployment runs in TEST mode. It exists, it
    // is active, and it is unchargeable here — so it must not be counted.
    const wrongMode = await seedRow(seed, {
      label: "Wrongmode Client",
      startsMinutesFromNow: 300,
      endsMinutesFromNow: 360,
    });

    await seedE2eActiveCardOnFile(seed, withCard.clientId);
    await seedE2eActiveCardOnFile(seed, wrongMode.clientId, { livemode: true });

    await loginAsOwner(page, seed);
    await openDashboard(page);

    await test.step("an active current-mode card reads Card on file", async () => {
      await expect(
        row(page, withCard.name).getByTestId("today-card-status"),
      ).toHaveAttribute("data-card-status", "card_on_file", { timeout: T });
      await expect(
        row(page, withCard.name).getByTestId("today-card-status"),
      ).toHaveText(/card on file/i);
    });

    await test.step("a client with no card reads No card", async () => {
      await expect(
        row(page, withoutCard.name).getByTestId("today-card-status"),
      ).toHaveAttribute("data-card-status", "no_card");
    });

    await test.step("a WRONG-MODE card never reads Card on file", async () => {
      const pill = row(page, wrongMode.name).getByTestId("today-card-status");
      await expect(pill).toHaveAttribute("data-card-status", "no_card");
      await expect(pill).not.toHaveText(/card on file/i);
    });
  });

  test("one client, two appointments today: both rows agree, from one lookup", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    // The Dashboard asks CAPABILITY first: without an active card_authorization
    // template the studio has no card-on-file route and renders no card UI at all.
    await seedE2eCardOnFileCapability(seed);
    const client = await seedRow(seed, {
      label: "Twice Client",
      startsMinutesFromNow: 60,
      endsMinutesFromNow: 120,
    });
    await seedE2eTodayAppointment(seed, {
      clientId: client.clientId,
      startsMinutesFromNow: 200,
      endsMinutesFromNow: 260,
    });
    await seedE2eActiveCardOnFile(seed, client.clientId);

    await loginAsOwner(page, seed);
    await openDashboard(page);

    const pills = page
      .locator("li")
      .filter({ hasText: client.name })
      .getByTestId("today-card-status");
    await expect(pills).toHaveCount(2, { timeout: T });
    // The single batched answer serves both rows — they cannot disagree.
    for (const pill of await pills.all()) {
      await expect(pill).toHaveAttribute("data-card-status", "card_on_file");
    }
  });

  test("the portal-link reminder appears only where it is useful, and really sends", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    // The Dashboard asks CAPABILITY first: without an active card_authorization
    // template the studio has no card-on-file route and renders no card UI at all.
    await seedE2eCardOnFileCapability(seed);
    const noCard = await seedRow(seed, {
      label: "Nudge Client",
      startsMinutesFromNow: 60,
      endsMinutesFromNow: 120,
    });
    const hasCard = await seedRow(seed, {
      label: "Cardholder Client",
      startsMinutesFromNow: 180,
      endsMinutesFromNow: 240,
    });
    const noEmail = await seedRow(seed, {
      label: "Noemail Client",
      startsMinutesFromNow: 300,
      endsMinutesFromNow: 360,
      withEmail: false,
    });
    await seedE2eActiveCardOnFile(seed, hasCard.clientId);

    await loginAsOwner(page, seed);
    await openDashboard(page);

    const sendButton = row(page, noCard.name).getByTestId(
      "today-send-portal-link",
    );

    await test.step("no card + email → visible and enabled", async () => {
      await expect(sendButton).toBeVisible({ timeout: T });
      await expect(sendButton).toBeEnabled();
      await expect(sendButton).toHaveText("Send portal link");
      // Truthful: this is a portal-access email, not a card-specific message.
      await expect(sendButton).not.toHaveText(/card reminder/i);
    });

    await test.step("a client who ALREADY has a card is never chased", async () => {
      await expect(
        row(page, hasCard.name).getByTestId("today-send-portal-link"),
      ).toHaveCount(0);
    });

    await test.step("no email on file → present but disabled, and it says why", async () => {
      const disabled = row(page, noEmail.name).getByTestId(
        "today-send-portal-link",
      );
      await expect(disabled).toBeDisabled();
      await expect(row(page, noEmail.name)).toContainText("No email on file");
    });

    await test.step("clicking drives the REAL existing portal-link authority", async () => {
      await sendButton.click();
      // The existing action issued a real, hashed, single-use, studio-scoped
      // link row. This is the proof the button reuses that authority rather
      // than reimplementing it.
      await expect
        .poll(
          async () =>
            (
              await sql<{ n: string }>(
                `select count(*)::text as n
                   from public.client_portal_magic_links
                  where studio_id = $1 and client_id = $2`,
                [seed.studioId, noCard.clientId],
              )
            )[0]!.n,
          { timeout: T },
        )
        .toBe("1");
      // Local stacks have no outbound email transport, so the practitioner
      // gets the action's own SAFE failure copy. What must never appear is a
      // raw link or token.
      await expect(row(page, noCard.name)).not.toContainText("/portal/verify/");
      const rowText = (await row(page, noCard.name).innerText()).toLowerCase();
      expect(rowText).not.toMatch(/pm_|cus_|seti_|acct_/);
    });
  });
});

test.describe("iPhone profile", () => {
  // ENGINE NOTE: iPhone dimensions on the Chromium engine (the repo E2E
  // engine), not real iOS Safari/WebKit.
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("at 390px the highlight, the card status and the actions all survive", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    // The Dashboard asks CAPABILITY first: without an active card_authorization
    // template the studio has no card-on-file route and renders no card UI at all.
    await seedE2eCardOnFileCapability(seed);
    const inRoom = await seedRow(seed, {
      label: "Mobile Now",
      startsMinutesFromNow: -15,
      endsMinutesFromNow: 45,
      withService: true,
    });

    await loginAsOwner(page, seed);
    await openDashboard(page);

    const target = row(page, inRoom.name);
    await expect(target.getByTestId("today-current-pill")).toBeVisible({
      timeout: T,
    });
    await expect(target.getByTestId("today-card-status")).toBeVisible();
    await expect(target.getByTestId("today-card-status")).toHaveText(
      /no card/i,
    );

    await test.step("the page does not scroll horizontally", async () => {
      const { scroll, client } = await page.evaluate(() => {
        const d = document.documentElement;
        return { scroll: d.scrollWidth, client: d.clientWidth };
      });
      expect(
        scroll,
        `no horizontal overflow (scrollWidth ${scroll} vs clientWidth ${client})`,
      ).toBeLessThanOrEqual(client);
    });

    await test.step("the new tap controls are real 44px targets", async () => {
      for (const testId of ["today-consultation-notes", "today-send-portal-link"]) {
        const box = await target.getByTestId(testId).boundingBox();
        expect(box, `${testId} must be laid out`).not.toBeNull();
        expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(44);
        // Inside the viewport, not pushed off the right edge.
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      }
    });

    await test.step("the actions WRAP below the content instead of colliding with it", async () => {
      const name = target.locator("span").filter({ hasText: inRoom.name }).first();
      const nameBox = await name.boundingBox();
      const actionBox = await target
        .getByTestId("today-consultation-notes")
        .boundingBox();
      expect(nameBox).not.toBeNull();
      expect(actionBox).not.toBeNull();
      // No overlap: the action starts below the name line.
      expect(actionBox!.y).toBeGreaterThanOrEqual(nameBox!.y);
    });
  });
});

// ===========================================================================
// CAPABILITY GATE — a studio with no card-on-file route says nothing about cards
// ===========================================================================
//
// Three adversarial reviewers converged: without this gate a studio that cannot
// collect a card at all rendered a solid column of amber NO CARD against every
// client on the day, each with a chase button pointing at a portal that has
// nowhere to send them. Every client is card-less by construction there, so the
// absence was an artefact of asking the wrong question first.
//
// This seeds NO card_authorization template, which is exactly what the portal
// itself treats as "no route", and proves the Dashboard stays silent.
test("a studio with no card-on-file route shows no card UI at all", async ({ page }) => {
  const seed = await seedE2eStudio();
  // Deliberately NO seedE2eCardOnFileCapability(seed): the capability read
  // SUCCEEDS and authoritatively reports no route. That is ABSENT, which is a
  // different answer from UNKNOWN — a failed capability read renders
  // "Card status unavailable" instead, and is proved at unit level because
  // inducing a read failure in the browser would need a production-reachable
  // failure seam, which this feature deliberately does not have.
  const client = await seedRow(seed, {
    label: "Nogate Client",
    startsMinutesFromNow: 60,
    endsMinutesFromNow: 120,
  });
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");

  const target = row(page, client.name);
  await expect(target).toBeVisible({ timeout: 20_000 });

  // No pill in ANY of its three states, and no nudge.
  await expect(target.getByTestId("today-card-status")).toHaveCount(0);
  await expect(target.getByTestId("today-send-portal-link")).toHaveCount(0);
  await expect(page.getByText(/card on file|no card|card status unavailable/i)).toHaveCount(0);

  // The rest of the row is untouched — this gate hides the card question only.
  await expect(target.getByTestId("today-consultation-notes")).toBeVisible();
});
