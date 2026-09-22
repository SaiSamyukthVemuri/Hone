import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { seedE2eStudio, sql } from "./helpers/seed";

// EMERG-PORTAL-REBOOK-01 — the ONE browser proof for portal rebooking.
//
// Unit and DB coverage for this slice is strong, but every unit test builds its
// own FormData and every DB test calls the command directly, so none of them
// proves the link that actually carries a returning client through:
//
//   portal session -> "Book another appointment" -> service -> slot
//     -> submit -> create_public_appointment -> the appointment appears
//        in the client's own upcoming list
//
// THE ORACLE IS THE DATABASE ROW, NEVER THE SUCCESS COPY. Every journey below
// asserts on public.appointments, and only then on what the page says.
//
// Portal auth: the portal is a magic-link realm and the raw link token is
// unrecoverable (hash-only at rest, and the local harness has no inbox for it).
// So the spec establishes a session with the REAL primitives — mint a raw
// token, store its SHA-256 in client_portal_sessions exactly as
// createPortalSession does, set the same hone_portal_session cookie — and the
// app's own getCurrentPortalSession then validates it exactly as it would in
// production. No auth code is bypassed or stubbed.

const COOKIE_NAME = "hone_portal_session";

async function seedClient(studioId: string, label: string): Promise<string> {
  const clientId = randomUUID();
  await sql(
    `insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`,
    [clientId, studioId, `E2E ${label}`, `rebook-${clientId.slice(0, 8)}@harness.local`],
  );
  return clientId;
}

/**
 * Put the client in the "all caught up" state.
 *
 * A client with NO intake row is reported `outstanding` (getPortalIntakeStatus
 * mints one), which alone sets hasNeedsYou. A SUBMITTED intake is what makes an
 * established client have nothing pending — which is precisely the population
 * the rebooking card used to be invisible to.
 */
async function seedSubmittedIntake(studioId: string, clientId: string) {
  await sql(
    `insert into public.client_intake_forms
       (studio_id, client_id, status, submitted_at)
     values ($1,$2,'submitted', now())`,
    [studioId, clientId],
  );
}

/** Establish a portal session using the real primitives (see file header). */
async function establishPortalSession(
  page: Page,
  studioId: string,
  clientId: string,
) {
  const raw = randomBytes(32).toString("base64url");
  await sql(
    `insert into public.client_portal_sessions
       (studio_id, client_id, session_token_hash, expires_at)
     values ($1,$2,$3, now() + interval '7 days')`,
    [studioId, clientId, createHash("sha256").update(raw, "utf8").digest("hex")],
  );
  await page.context().addCookies([
    {
      name: COOKIE_NAME,
      value: raw,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

async function appointmentsFor(studioId: string, clientId: string) {
  return sql<{ id: string; status: string; notes: string | null; service_id: string }>(
    `select id, status, notes, service_id
       from public.appointments
      where studio_id = $1 and client_id = $2
      order by starts_at`,
    [studioId, clientId],
  );
}

async function serviceIdFor(studioId: string): Promise<string> {
  const rows = await sql<{ id: string }>(
    `select id from public.services where studio_id = $1 and active = true limit 1`,
    [studioId],
  );
  return rows[0].id;
}

test.describe("portal rebooking", () => {
  test("an all-caught-up returning client books, and it lands in their upcoming list", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const clientId = await seedClient(seed.studioId, "Returning");
    // THE POPULATION THE P1 WAS ABOUT: nothing outstanding at all.
    await seedSubmittedIntake(seed.studioId, clientId);
    await establishPortalSession(page, seed.studioId, clientId);

    await page.goto("/portal");

    // M. The client is genuinely in the "all caught up" state AND can still
    // book. Asserting both together is the point: the card used to be rendered
    // only on the branch this copy replaces.
    await expect(page.getByText("You’re all caught up.")).toBeVisible();
    const card = page.getByTestId("portal-rebook");
    await expect(card).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Book another appointment" }),
    ).toBeVisible();

    // The studio's own service menu, from the portal-authorized admin read.
    const service = page.getByTestId("portal-rebook-service");
    await expect(service.locator("option")).toHaveCount(1);
    await expect(service.locator("option")).toContainText(seed.serviceName);

    // Slots for the selected service and the default (today) date.
    const slots = page.getByTestId("portal-rebook-slot");
    await expect(slots.first()).toBeVisible();
    const chosenStart = await slots.first().getAttribute("data-slot-start");
    expect(chosenStart).toBeTruthy();
    // P2-1, observed through the surface: nothing already elapsed is offered.
    const offered = await slots.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.slotStart as string),
    );
    for (const iso of offered) {
      expect(new Date(iso).getTime(), `offered a past start: ${iso}`).toBeGreaterThan(
        Date.now(),
      );
    }
    await slots.first().click();

    await page.getByTestId("portal-rebook-notes").fill("Please allow extra time.");

    // J. ONE PRESS. The double click is deliberate: the assertion below is that
    // it produced ONE appointment.
    await page.getByTestId("portal-rebook-submit").dblclick();

    // THE ORACLE: the database row.
    await expect(page.getByTestId("portal-rebook-confirmed")).toBeVisible();
    const rows = await appointmentsFor(seed.studioId, clientId);
    expect(rows, "one press, one appointment").toHaveLength(1);
    expect(rows[0].status).toBe("confirmed");
    expect(rows[0].notes).toBe("Please allow extra time.");
    expect(rows[0].service_id).toBe(await serviceIdFor(seed.studioId));

    const stored = await sql<{ starts_at: string }>(
      `select starts_at from public.appointments where id = $1`,
      [rows[0].id],
    );
    expect(new Date(stored[0].starts_at).toISOString()).toBe(
      new Date(chosenStart as string).toISOString(),
    );

    // The audit row the command writes in the same transaction.
    const audit = await sql<{ action: string }>(
      `select action from public.appointment_audit where appointment_id = $1`,
      [rows[0].id],
    );
    expect(audit.map((a) => a.action)).toContain("created");

    // N/O. The acknowledgement always offers a management link, whatever the
    // provider did — the local harness has a dummy Resend key, so this run
    // exercises the degraded path and must still report a committed booking.
    await expect(page.getByTestId("portal-rebook-manage-link")).toBeVisible();

    // THE JOURNEY CLOSES: the appointment is in the client's own list, WITHOUT
    // a reload.
    //
    // This assertion used to call `page.reload()` first, and that reload was
    // hiding a real defect: the action revalidates /portal but does not
    // re-render the page the client is already looking at, so the Appointments
    // section stayed stale and could read "No upcoming appointments" directly
    // beneath a confirmation saying the appointment was listed there. Reloading
    // made the test agree with the fix that had not been written yet. The card
    // now calls router.refresh(), and this proves it.
    //
    // Scoped to a paragraph on purpose. The service name also appears as an
    // <option> inside the rebooking card's own select, which Playwright reports
    // as hidden — a bare getByText would resolve to that and fail for a reason
    // that has nothing to do with the appointment.
    await expect(page.getByTestId("portal-rebook-confirmed")).toBeVisible();
    await expect(page.getByText("No upcoming appointments")).toHaveCount(0);
    await expect(
      page.locator("p").filter({ hasText: seed.serviceName }).first(),
    ).toBeVisible();
  });

  test("a client WITH pending tasks also sees the booking card", async ({ page }) => {
    // The mirror of the test above: rebooking must not depend on the
    // pending-actions zone in EITHER direction.
    const seed = await seedE2eStudio();
    const clientId = await seedClient(seed.studioId, "Busy");
    await establishPortalSession(page, seed.studioId, clientId);

    await page.goto("/portal");
    // No intake on file -> the intake task is outstanding -> hasNeedsYou.
    await expect(page.getByText("Complete intake")).toBeVisible();
    await expect(page.getByTestId("portal-rebook")).toBeVisible();
  });

  test("cross-studio isolation: a portal client of studio B is never offered studio A", async ({
    page,
  }) => {
    const studioA = await seedE2eStudio();
    const studioB = await seedE2eStudio();
    const clientB = await seedClient(studioB.studioId, "Studio B Client");
    const serviceA = await serviceIdFor(studioA.studioId);

    await establishPortalSession(page, studioB.studioId, clientB);
    await page.goto("/portal");

    // The menu is studio B's, and studio A's service is simply not in it.
    const service = page.getByTestId("portal-rebook-service");
    const values = await service.locator("option").evaluateAll((els) =>
      els.map((e) => (e as HTMLOptionElement).value),
    );
    expect(values).not.toContain(serviceA);
    expect(values).toHaveLength(1);
    expect(values[0]).toBe(await serviceIdFor(studioB.studioId));

    // NON-VACUITY: studio B's own service does produce slots, so the refusal
    // below is attributable to the tenancy check and not to an unavailable
    // studio.
    await expect(page.getByTestId("portal-rebook-slot").first()).toBeVisible();

    // FORGE THE CHOICE. Studio A's service id is injected into the select and
    // selected, which is exactly what a modified client would submit. The
    // server re-resolves the service under the SESSION's studio through the one
    // authorized read, so it is not found and no studio A availability is ever
    // returned.
    await page.evaluate((sid) => {
      const sel = document.querySelector(
        '[data-testid="portal-rebook-service"]',
      ) as HTMLSelectElement;
      const opt = document.createElement("option");
      opt.value = sid;
      opt.textContent = "forged";
      sel.appendChild(opt);
      sel.value = sid;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, serviceA);

    await expect(page.getByTestId("portal-rebook-error")).toBeVisible();
    await expect(page.getByTestId("portal-rebook-slot")).toHaveCount(0);

    // THE ORACLE: nothing was written anywhere.
    const inA = await sql<{ n: number }>(
      `select count(*)::int as n from public.appointments where studio_id = $1`,
      [studioA.studioId],
    );
    expect(inA[0].n).toBe(0);
    expect(await appointmentsFor(studioB.studioId, clientB)).toHaveLength(0);
  });

  test("a logged-out visitor is sent to the portal login, not to a booking form", async ({
    page,
  }) => {
    await page.goto("/portal");
    await expect(page).toHaveURL(/\/portal\/login/);
    await expect(page.getByTestId("portal-rebook")).toHaveCount(0);
  });

  test("an archived client cannot reach the booking card", async ({ page }) => {
    const seed = await seedE2eStudio();
    const clientId = await seedClient(seed.studioId, "Archived");
    await establishPortalSession(page, seed.studioId, clientId);

    // POSITIVE CONTROL FIRST: the card is reachable while the client is active,
    // so the redirect below is attributable to archiving and nothing else.
    await page.goto("/portal");
    await expect(page.getByTestId("portal-rebook")).toBeVisible();

    await sql(`update public.clients set archived_at = now() where id = $1`, [clientId]);

    // THE REFUSAL IS ASSERTED ON THE RESPONSE, NOT BY NAVIGATING.
    //
    // /portal redirects an archived client to /portal/login, and /portal/login
    // redirects anyone holding a live session back to /portal — so an archived
    // client whose portal session is still live bounces between the two and a
    // real navigation dies with ERR_TOO_MANY_REDIRECTS. Both halves of that
    // loop exist verbatim at production a7265e38 and neither is touched by this
    // change; it is a pre-existing portal session/archival defect, reported
    // separately rather than fixed in an emergency booking lane.
    //
    // Asserting the loop would pin a defect as a guarantee. Asserting the ONE
    // redirect is the true, durable statement: the archived client is refused
    // at the portal home and is never served a booking surface.
    const refused = await page.request.get("/portal", { maxRedirects: 0 });
    expect(refused.status(), "archived client must be redirected away").toBeGreaterThanOrEqual(300);
    expect(refused.status()).toBeLessThan(400);
    expect(refused.headers()["location"]).toContain("/portal/login");
    expect(await refused.text()).not.toContain("portal-rebook");

    // And nothing was booked along the way.
    expect(await appointmentsFor(seed.studioId, clientId)).toHaveLength(0);
  });
});
