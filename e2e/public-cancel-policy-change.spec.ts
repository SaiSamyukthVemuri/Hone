import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  getCancellationToken,
  getClientIdByEmail,
  getAppointmentsForClient,
  sql,
} from "./helpers/seed";
import { bookAppointment } from "./helpers/flows";

// B7 / 0176 — the cancel flow on the real stack.
//
// The property is the one a unit test cannot reach: a studio that edits its
// policy WHILE a client is on the cancel page must not be able to collect
// acknowledgement for text the client never saw, and the client must be made to
// read the new text and consent again.
//
// No test-only UI backdoor: the policy is changed the way a studio would change
// it — a direct row update — and everything else is real browser interaction.

async function setPolicy(studioId: string, cancelText: string | null) {
  await sql(
    `update public.studios set cancellation_policy_text = $2 where id = $1`,
    [studioId, cancelText],
  );
}

async function apptState(appointmentId: string) {
  const rows = await sql<{ status: string; cancelled_at: string | null }>(
    `select status, cancelled_at::text from public.appointments where id = $1`,
    [appointmentId],
  );
  return rows[0];
}

async function counts(appointmentId: string) {
  const rows = await sql<{ audits: number; acks: number }>(
    `select
       (select count(*)::int from public.appointment_audit
         where appointment_id = $1 and action = 'cancelled') as audits,
       (select count(*)::int from public.appointment_policy_acknowledgements
         where appointment_id = $1) as acks`,
    [appointmentId],
  );
  return rows[0];
}

const POLICY_A = "E2E policy A: cancel at least 24 hours ahead.";
const POLICY_B = "E2E policy B: cancel at least 48 hours ahead.";

test.describe("public cancellation — a policy edited mid-flight fails closed", () => {
  test("changed policy is refused, re-presented, and requires a second consent", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await setPolicy(seed.studioId, POLICY_A);
    await bookAppointment(page, seed);

    const clientId = (await getClientIdByEmail(seed.studioId, seed.clientEmail))!;
    const appointments = await getAppointmentsForClient(seed.studioId, clientId);
    expect(appointments.length).toBe(1);
    const appointmentId = appointments[0].id;
    const token = await getCancellationToken(seed.studioId, appointmentId);
    expect(token).toBeTruthy();

    // A. the page renders policy A.
    await page.goto(`/cancel/${token}`);
    await expect(page.getByText(POLICY_A)).toBeVisible();

    // B. the acknowledgement starts unchecked.
    const ack = page.getByRole("checkbox", { name: /policy|policies|acknowledge/i });
    await expect(ack).not.toBeChecked();

    // C. the studio edits the policy AFTER the page rendered. The tab keeps the
    // old text and the old presented hash.
    await setPolicy(seed.studioId, POLICY_B);

    // D. the client consents to what they were shown and submits.
    await ack.check();
    await expect(ack).toBeChecked();
    await page.getByRole("button", { name: /cancel appointment/i }).click();

    // E. REFUSED, with copy that says why rather than a generic failure.
    await expect(
      page.getByText(/policies changed while you were on this page/i),
    ).toBeVisible({ timeout: 15_000 });

    // F/G. nothing happened: still confirmed, no audit, no acknowledgement.
    const mid = await apptState(appointmentId);
    expect(mid.status).toBe("confirmed");
    expect(mid.cancelled_at).toBeNull();
    const midCounts = await counts(appointmentId);
    expect(midCounts.audits).toBe(0);
    expect(midCounts.acks).toBe(0);

    // H. the surface re-presents the CURRENT policy...
    await expect(page.getByText(POLICY_B)).toBeVisible({ timeout: 15_000 });
    // I. ...and the acknowledgement was reset, so the refused consent cannot be
    // replayed against text the client has still not read.
    await expect(ack).not.toBeChecked();

    // J/K. a genuine second consent succeeds.
    await ack.check();
    await page.getByRole("button", { name: /cancel appointment/i }).click();
    await expect(page.getByText(/cancelled/i).first()).toBeVisible({ timeout: 15_000 });

    // L. and the record is correct: cancelled, exactly one audit event, and an
    // acknowledgement whose snapshot is the policy actually shown second.
    const after = await apptState(appointmentId);
    expect(after.status).toBe("cancelled");
    const afterCounts = await counts(appointmentId);
    expect(afterCounts.audits).toBe(1);
    expect(afterCounts.acks).toBe(1);

    const ackRow = (
      await sql<{ snapshot: string }>(
        `select cancellation_policy_text_snapshot as snapshot
           from public.appointment_policy_acknowledgements
          where appointment_id = $1`,
        [appointmentId],
      )
    )[0];
    expect(ackRow.snapshot).toBe(POLICY_B);
  });

  test("an unchanged policy still cancels normally, with evidence", async ({ page }) => {
    const seed = await seedE2eStudio();
    await setPolicy(seed.studioId, POLICY_A);
    await bookAppointment(page, seed);

    const clientId = (await getClientIdByEmail(seed.studioId, seed.clientEmail))!;
    const appointments = await getAppointmentsForClient(seed.studioId, clientId);
    const appointmentId = appointments[0].id;
    const token = await getCancellationToken(seed.studioId, appointmentId);

    await page.goto(`/cancel/${token}`);
    await expect(page.getByText(POLICY_A)).toBeVisible();
    await page.getByRole("checkbox", { name: /policy|policies|acknowledge/i }).check();
    await page.getByRole("button", { name: /cancel appointment/i }).click();
    await expect(page.getByText(/cancelled/i).first()).toBeVisible({ timeout: 15_000 });

    expect((await apptState(appointmentId)).status).toBe("cancelled");
    const c = await counts(appointmentId);
    expect(c.audits).toBe(1);
    expect(c.acks).toBe(1);
  });
});
