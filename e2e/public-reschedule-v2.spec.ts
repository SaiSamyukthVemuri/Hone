import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  getCancellationToken,
  getClientIdByEmail,
  getAppointmentsForClient,
  getStudioTimezone,
  sql,
  type E2eSeed,
} from "./helpers/seed";
import { bookAppointment } from "./helpers/flows";

// ===========================================================================
// PUBLIC RESCHEDULE v2 (migration 0171) — browser contract.
// ===========================================================================
//
// This PR changes what the reschedule page POSTS and what the server does with
// it: a hidden server-generated policy hash, a new RPC with a new result
// vocabulary, the original's own reservation excluded from the offered slots,
// the ORIGINAL appointment's duration as the slot duration, and a post-commit
// contract where provider failures can no longer report failure.
//
// Those are all reachable only through the real form, so they are proven here
// against the real Next.js stack and the real migrated local Supabase, and then
// asserted in the DATABASE. Synthetic seed data only; nothing touches
// production.

/** Books a public appointment and returns its id + a working reschedule token. */
async function bookAndTokenise(
  page: Page,
  seed: E2eSeed,
): Promise<{ appointmentId: string; token: string }> {
  await bookAppointment(page, seed);
  const clientId = (await getClientIdByEmail(seed.studioId, seed.clientEmail))!;
  const appointments = await getAppointmentsForClient(seed.studioId, clientId);
  const confirmed = appointments.filter((a) => a.status === "confirmed");
  expect(confirmed.length).toBe(1);
  const token = (await getCancellationToken(seed.studioId, confirmed[0].id))!;
  expect(token).toBeTruthy();
  return { appointmentId: confirmed[0].id, token };
}

/** The slot buttons the page is currently offering. */
function slotButtons(page: Page) {
  return page.getByRole("button", { name: /^\d{1,2}:\d{2} (AM|PM)$/ });
}

async function openReschedule(page: Page, token: string) {
  await page.goto(`/reschedule/${token}`);
  await expect(
    page.getByText("Choose a new time that works better for you."),
  ).toBeVisible();
}

/**
 * Picks an offered slot on a day AFTER the original's own.
 *
 * Starting on the original's day is a trap the 0171 exclusion creates: the
 * original's own reservation is no longer a conflict against itself, so its
 * current start IS offered again — and picking it yields `same_time`, which is
 * a correct refusal but not what most of these tests are exercising. B4 asserts
 * that refusal deliberately.
 */
async function pickAnyOfferedSlot(page: Page): Promise<string> {
  const dateInput = page.locator('input[type="date"]');
  const startDate = await dateInput.inputValue();
  const skipTo = new Date(`${startDate}T12:00:00Z`);
  skipTo.setUTCDate(skipTo.getUTCDate() + 2);
  await dateInput.fill(skipTo.toISOString().slice(0, 10));

  for (let i = 0; i < 8; i += 1) {
    await expect(page.getByText(/Loading slots…/)).toHaveCount(0, { timeout: 15_000 });
    const count = await slotButtons(page).count();
    if (count > 0) {
      const label = (await slotButtons(page).first().innerText()).trim();
      await slotButtons(page).first().click();
      return label;
    }
    // Advance one day via the date input.
    const input = page.locator('input[type="date"]');
    const current = await input.inputValue();
    const next = new Date(`${current}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    await input.fill(next.toISOString().slice(0, 10));
  }
  throw new Error("no offered slot found within 8 days");
}

async function setStudioPolicy(studioId: string, cancellation: string | null) {
  await sql(`update public.studios set cancellation_policy_text = $2 where id = $1`, [
    studioId,
    cancellation,
  ]);
}

async function appointmentRow(id: string) {
  const rows = await sql<{
    id: string;
    status: string;
    duration_minutes: number;
    cancellation_kind: string | null;
    rescheduled_to_appointment_id: string | null;
    rescheduled_from_appointment_id: string | null;
  }>(
    `select id, status, duration_minutes, cancellation_kind,
            rescheduled_to_appointment_id, rescheduled_from_appointment_id
       from public.appointments where id = $1`,
    [id],
  );
  return rows[0];
}

async function successorOf(originalId: string) {
  const rows = await sql<{ id: string; status: string; duration_minutes: number }>(
    `select id, status, duration_minutes from public.appointments
      where rescheduled_from_appointment_id = $1`,
    [originalId],
  );
  return rows;
}

// ===========================================================================

test.describe("public reschedule v2", () => {
  // B1 ---------------------------------------------------------------------
  test("B1 successful reschedule writes the full boundary", async ({ page }) => {
    const seed = await seedE2eStudio();
    await setStudioPolicy(seed.studioId, "Cancel at least 24 hours ahead.");
    const { appointmentId, token } = await bookAndTokenise(page, seed);
    const before = await appointmentRow(appointmentId);

    await openReschedule(page, token);
    await pickAnyOfferedSlot(page);
    // The policy card is rendered, so the checkbox is required.
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /confirm new time/i }).click();

    await expect(page.getByText(/You.re rescheduled\./i)).toBeVisible({ timeout: 20_000 });

    // --- database boundary ---
    const orig = await appointmentRow(appointmentId);
    expect(orig.status).toBe("cancelled");
    expect(orig.cancellation_kind).toBe("rescheduled");
    expect(orig.rescheduled_to_appointment_id).toBeTruthy();

    const successors = await successorOf(appointmentId);
    expect(successors).toHaveLength(1);
    const succ = successors[0];
    expect(succ.status).toBe("confirmed");
    // The ORIGINAL's duration, not the service default.
    expect(succ.duration_minutes).toBe(before.duration_minutes);
    expect(orig.rescheduled_to_appointment_id).toBe(succ.id);

    // The reschedule adds exactly ONE audit per row. The original ALSO carries
    // the 'created' audit that create_public_appointment wrote when it was
    // booked, so counting every audit on both rows would expect 3 and prove
    // nothing about this command.
    const origAudits = await sql<{ action: string }>(
      `select action from public.appointment_audit where appointment_id = $1 order by created_at`,
      [appointmentId],
    );
    expect(origAudits.map((a) => a.action)).toEqual(["created", "cancelled"]);
    const succAudits = await sql<{ action: string; source: string }>(
      `select action, details->>'source' as source from public.appointment_audit
        where appointment_id = $1`,
      [succ.id],
    );
    expect(succAudits).toHaveLength(1);
    expect(succAudits[0].action).toBe("created");
    expect(succAudits[0].source).toBe("reschedule_link");

    // The acknowledgement, atomic with the reschedule, linked to the ORIGINAL.
    const acks = await sql<{ appointment_id: string; action: string }>(
      `select appointment_id, action from public.appointment_policy_acknowledgements
        where studio_id = $1`,
      [seed.studioId],
    );
    expect(acks).toHaveLength(1);
    expect(acks[0].appointment_id).toBe(appointmentId);
    expect(acks[0].action).toBe("reschedule");

    // B7 (PROVIDER FAILURE AFTER COMMIT). The local stack has no valid Resend
    // key, so the confirmation email genuinely FAILS on every run — and the
    // browser above still saw success. That is the post-commit contract: the
    // attempt is recorded truthfully (attempts incremented, sent_at NOT
    // stamped) and the reschedule is not reported as failed.
    const send = await sql<{ attempts: number; sent_at: string | null }>(
      `select confirmation_send_attempts as attempts, confirmation_sent_at as sent_at
         from public.appointments where id = $1`,
      [succ.id],
    );
    expect(Number(send[0].attempts)).toBeGreaterThanOrEqual(1);
    expect(send[0].sent_at).toBeNull();

    // The reservation moved.
    const res = await sql<{ source_id: string }>(
      `select source_id from public.studio_calendar_reservations
        where source_kind = 'appointment' and studio_id = $1`,
      [seed.studioId],
    );
    expect(res.map((r) => r.source_id)).toEqual([succ.id]);
  });

  // B2 ---------------------------------------------------------------------
  test("B2 policy acknowledgement is required and blocks submission", async ({ page }) => {
    const seed = await seedE2eStudio();
    await setStudioPolicy(seed.studioId, "Cancel at least 24 hours ahead.");
    const { appointmentId, token } = await bookAndTokenise(page, seed);

    await openReschedule(page, token);
    await pickAnyOfferedSlot(page);

    // A slot is picked but the box is not ticked: submit stays disabled.
    const submit = page.getByRole("button", { name: /confirm new time/i });
    await expect(submit).toBeDisabled();

    // Nothing mutated.
    expect((await appointmentRow(appointmentId)).status).toBe("confirmed");
    expect(await successorOf(appointmentId)).toHaveLength(0);
  });

  // B3 ---------------------------------------------------------------------
  test("B3 a policy edited after render is refused, then succeeds after refresh", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await setStudioPolicy(seed.studioId, "POLICY VERSION A.");
    const { appointmentId, token } = await bookAndTokenise(page, seed);

    await openReschedule(page, token);
    await expect(page.getByText(/POLICY VERSION A\./)).toBeVisible();
    await pickAnyOfferedSlot(page);
    await page.getByRole("checkbox").check();

    // The studio edits its policy while this page is open. The hidden hash the
    // page posts now describes text nobody is showing any more.
    await setStudioPolicy(seed.studioId, "POLICY VERSION B — MATERIALLY DIFFERENT.");

    await page.getByRole("button", { name: /confirm new time/i }).click();
    await expect(page.getByText(/policies changed/i)).toBeVisible({ timeout: 20_000 });

    // No mutation, and no acknowledgement of unseen text.
    expect((await appointmentRow(appointmentId)).status).toBe("confirmed");
    expect(await successorOf(appointmentId)).toHaveLength(0);
    const acks = await sql(
      `select 1 from public.appointment_policy_acknowledgements where studio_id = $1`,
      [seed.studioId],
    );
    expect(acks).toHaveLength(0);

    // After a refresh the NEW policy renders and the submission path works.
    await openReschedule(page, token);
    await expect(page.getByText(/POLICY VERSION B/)).toBeVisible();
    await pickAnyOfferedSlot(page);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /confirm new time/i }).click();
    await expect(page.getByText(/You.re rescheduled\./i)).toBeVisible({ timeout: 20_000 });
    expect(await successorOf(appointmentId)).toHaveLength(1);
  });

  // B4 ---------------------------------------------------------------------
  test("B4 rescheduling to the SAME time is refused as a no-op", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { appointmentId, token } = await bookAndTokenise(page, seed);
    const original = await sql<{ starts_at: string }>(
      `select starts_at from public.appointments where id = $1`,
      [appointmentId],
    );

    await openReschedule(page, token);

    // 0171 EXCLUSION, VISIBLE IN THE BROWSER: the original's own reservation no
    // longer conflicts with itself, so its current start is OFFERED again. That
    // is deliberate — and it is exactly why the command needs a same-time guard,
    // because without one this click would cancel and recreate the booking
    // purely to rotate its token.
    const tz = await getStudioTimezone(seed.studioId);
    const label = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(original[0].starts_at));
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(original[0].starts_at));

    await page.locator('input[type="date"]').fill(localDate);
    await expect(page.getByText(/Loading slots…/)).toHaveCount(0, { timeout: 15_000 });

    const own = page.getByRole("button", { name: label, exact: true });
    await expect(own).toBeVisible();
    await own.click();
    await page.getByRole("button", { name: /confirm new time/i }).click();

    await expect(
      page.getByText(/already booked for/i),
    ).toBeVisible({ timeout: 20_000 });

    // Nothing mutated.
    expect((await appointmentRow(appointmentId)).status).toBe("confirmed");
    expect(await successorOf(appointmentId)).toHaveLength(0);
  });

  // B5 ---------------------------------------------------------------------
  test("B5 a slot taken after display is refused and the original survives", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { appointmentId, token } = await bookAndTokenise(page, seed);

    await openReschedule(page, token);
    await pickAnyOfferedSlot(page);

    // Steal the displayed slot out from under the visitor by dropping a
    // timed-block reservation across the whole offered day. A reservation is
    // used rather than an appointment so no appointment CHECK/exclusion has to
    // be satisfied — and crucially there is NO .catch() here: a fixture that
    // fails to block must fail the test, not let it pass vacuously.
    const dateStr = await page.locator('input[type="date"]').inputValue();
    await sql(
      `insert into public.studio_calendar_reservations
         (studio_id, practitioner_id, resource_key, source_kind, source_id,
          starts_at, ends_at)
       values ($1, null, $1, 'timed_block', gen_random_uuid(),
               ($2::date)::timestamptz - interval '1 day',
               ($2::date)::timestamptz + interval '2 days')`,
      [seed.studioId, dateStr],
    );
    const blocked = await sql<{ n: string }>(
      `select count(*)::int n from public.studio_calendar_reservations
        where studio_id = $1 and source_kind = 'timed_block'`,
      [seed.studioId],
    );
    expect(Number(blocked[0].n)).toBe(1);

    await page.getByRole("button", { name: /confirm new time/i }).click();
    await expect(page.getByText(/no longer available|can't be used/i)).toBeVisible({
      timeout: 20_000,
    });

    expect((await appointmentRow(appointmentId)).status).toBe("confirmed");
    expect(await successorOf(appointmentId)).toHaveLength(0);
  });

  // B6 ---------------------------------------------------------------------
  test("B6 a duplicate submit creates exactly one successor", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const seed = await seedE2eStudio();
    const { appointmentId, token } = await bookAndTokenise(pageA, seed);

    await openReschedule(pageA, token);
    await pickAnyOfferedSlot(pageA);
    await openReschedule(pageB, token);
    await pickAnyOfferedSlot(pageB);

    await Promise.all([
      pageA.getByRole("button", { name: /confirm new time/i }).click(),
      pageB.getByRole("button", { name: /confirm new time/i }).click(),
    ]);

    // Whichever won, the database must show exactly one successor and no
    // duplicate audits.
    await pageA.waitForTimeout(3000);
    const successors = await successorOf(appointmentId);
    expect(successors).toHaveLength(1);

    // Exactly ONE cancellation audit — the loser must not have written a second.
    // (The original also carries its original booking 'created' audit.)
    const audits = await sql<{ n: string }>(
      `select count(*)::int n from public.appointment_audit
        where appointment_id = $1 and action = 'cancelled'`,
      [appointmentId],
    );
    expect(Number(audits[0].n)).toBe(1);

    await ctxA.close();
    await ctxB.close();
  });

  // B9 ---------------------------------------------------------------------
  test("B9 the ORIGINAL duration survives a service-default change", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { appointmentId, token } = await bookAndTokenise(page, seed);
    const before = await appointmentRow(appointmentId);

    // The studio lengthens the service AFTER the client booked.
    await sql(
      `update public.services set default_duration_minutes = $2 where studio_id = $1`,
      [seed.studioId, before.duration_minutes + 15],
    );

    await openReschedule(page, token);
    await pickAnyOfferedSlot(page);
    await page.getByRole("button", { name: /confirm new time/i }).click();
    await expect(page.getByText(/You.re rescheduled\./i)).toBeVisible({ timeout: 20_000 });

    const successors = await successorOf(appointmentId);
    expect(successors).toHaveLength(1);
    expect(successors[0].duration_minutes).toBe(before.duration_minutes);
  });
});
