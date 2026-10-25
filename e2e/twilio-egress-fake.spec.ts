import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";
import { markTwilioEgress, readTwilioEgress, type TwilioEgressRecord } from "./helpers/twilio-egress";
import { TWILIO_FAKE_AMBIGUOUS_503_LAST4 } from "./helpers/twilio-egress-config";

// TWILIO-EGRESS-FAKE (MSG-006). The browser half of the fence: the REAL lane
// server, reached through a REAL public booking whose client ticks the SMS
// consent box, sends its confirmation SMS through lib/sms/twilio.ts - and the
// preload (e2e/helpers/twilio-egress-fake.cjs, loaded through
// E2E_WEB_SERVER_ENV.NODE_OPTIONS) answers it in-process. The request never
// leaves the server: the fake records it, and the app's own delivery ledger
// shows it read the fake's answer. Unit proof on every request stack, with a
// socket backstop: tests/scripts/twilio-egress-fake.test.ts.
//
// Synthetic studio, client and numbers only (+1 604 555 01xx, a fictional range).

async function bookWithSmsConsent(page: Page, s: E2eSeed, phone: string): Promise<void> {
  await page.goto(`/book/${s.slug}`);
  await expect(page.getByText(s.studioName).first()).toBeVisible();
  await page.getByRole("button", { name: /new client/i }).click();
  const slotButton = page.getByRole("button", { name: /^\d{1,2}:\d{2} (AM|PM)$/ });
  const nextDay = page.getByRole("button", { name: /^next available( day)?$/i });
  await expect(async () => {
    expect((await slotButton.count()) + (await nextDay.count())).toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });
  if ((await slotButton.count()) === 0) {
    await nextDay.click();
    await expect(slotButton.first()).toBeVisible({ timeout: 20_000 });
  }
  await slotButton.first().click();
  await page.getByLabel(/your name/i).fill(s.clientName);
  await page.getByLabel(/^email/i).fill(s.clientEmail);
  await page.getByLabel(/phone/i).fill(phone);
  await page.getByRole("checkbox", { name: /text me appointment confirmations/i }).check();
  await page.getByRole("button", { name: /book appointment/i }).click();
  await expect(page.getByRole("heading", { name: /your appointment is booked/i })).toBeVisible({
    timeout: 20_000,
  });
}

async function seedSmsStudio(): Promise<E2eSeed> {
  const seed = await seedE2eStudio();
  await sql(`update public.studios set send_confirmation_sms = true where id = $1`, [seed.studioId]);
  return seed;
}

function messagesTo(records: TwilioEgressRecord[], last4: string): TwilioEgressRecord[] {
  return records.filter((r) => r.kind === "message" && r.toLast4 === last4);
}

async function confirmationLedgerStatus(studioId: string): Promise<string | null> {
  const rows = await sql<{ status: string }>(
    `select status from public.sms_outbound_messages
      where studio_id = $1 and purpose = 'appointment_confirmation'
      order by created_at desc limit 1`,
    [studioId],
  );
  return rows[0]?.status ?? null;
}

test.describe("TWILIO-EGRESS-FAKE: the lane's server never reaches Twilio", () => {
  test("DEFAULT: the confirmation SMS is refused before connecting, and the app records a definite refusal", async ({
    page,
  }) => {
    const seed = await seedSmsStudio();
    const mark = markTwilioEgress();

    await bookWithSmsConsent(page, seed, "+1 604 555 0199");

    // The send happened, and the fake - not Twilio - answered it.
    await expect.poll(() => messagesTo(readTwilioEgress(mark), "0199").length, { timeout: 30_000 }).toBe(1);
    const [record] = messagesTo(readTwilioEgress(mark), "0199");
    expect(record).toMatchObject({
      via: "fetch",
      host: "api.twilio.com",
      path: "/2010-04-01/Accounts/{sid}/Messages.json",
      mode: "refuse",
    });
    // Nothing else bound for Twilio went any other way during this booking.
    expect(readTwilioEgress(mark).every((r) => r.mode === "refuse")).toBe(true);

    // lib/sms/twilio.ts read the refusal as a definite non-send.
    await expect.poll(() => confirmationLedgerStatus(seed.studioId), { timeout: 30_000 }).toBe("refused");
  });

  test(`...${TWILIO_FAKE_AMBIGUOUS_503_LAST4}: a 503 is read as ambiguous (unknown), never as a refusal`, async ({
    page,
  }) => {
    const seed = await seedSmsStudio();
    const mark = markTwilioEgress();

    await bookWithSmsConsent(page, seed, `+1 604 555 ${TWILIO_FAKE_AMBIGUOUS_503_LAST4}`);

    await expect
      .poll(() => messagesTo(readTwilioEgress(mark), TWILIO_FAKE_AMBIGUOUS_503_LAST4).length, { timeout: 30_000 })
      .toBe(1);
    expect(messagesTo(readTwilioEgress(mark), TWILIO_FAKE_AMBIGUOUS_503_LAST4)[0]).toMatchObject({
      via: "fetch",
      host: "api.twilio.com",
      mode: "ambiguous_503",
    });
    await expect.poll(() => confirmationLedgerStatus(seed.studioId), { timeout: 30_000 }).toBe("unknown");
  });
});
