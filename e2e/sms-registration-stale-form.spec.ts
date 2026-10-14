import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { seedE2eStudio, seedOperatorAuthUser, sql } from "./helpers/seed";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// SMS-SENDER-REG-01 (#844): the MOUNTED proof of the registration form's
// no-lost-update contract, in a real browser against the local stack (Codex P2
// 4266275222, 4266543216, 4266641804).
//
//   Two operators open the same studio's registration form. A records a
//   decision; B, still showing the earlier record, submits an edit:
//     * B's submit is REFUSED (stale_record) and says so on screen;
//     * the refused form REFRESHES to the current record (the remount), and
//       the refusal message stays visible across that refresh;
//     * B's resubmit from the refreshed form is SAFE: it records against the
//       current record and never restores the decision A replaced.
//
// The database command, its lock and the version check are proved in
// tests/db/studio-sms-sender-registrations.db.test.ts; this spec proves the
// page wiring an operator actually uses. No provider is called: recording
// registration evidence is a database write only.

type Registration = { status: string; provider_reference: string | null };

async function registrationOf(studioId: string): Promise<Registration | null> {
  const rows = await sql<Registration>(
    "select status, provider_reference from public.studio_sms_sender_registrations where studio_id = $1",
    [studioId],
  );
  return rows[0] ?? null;
}

/** A studio whose live sender holds a US long code: what support records evidence against. */
async function seedStudioWithActiveUsSender(): Promise<{ studioId: string; phone: string }> {
  const seed = await seedE2eStudio();
  const [owner] = await sql<{ id: string }>(
    "select id from public.practitioners where studio_id = $1 order by created_at limit 1",
    [seed.studioId],
  );
  // A US 212 number, unique per run (exchange 555 keeps it fictional).
  const phone = `+1212555${String(Math.floor(1000 + Math.random() * 9000))}`;
  const hex = (n: number) => randomBytes(n / 2).toString("hex");
  await sql(
    `insert into public.studio_sms_senders
       (studio_id, provider, status, country,
        claimed_phone_number, phone_number, phone_number_sid, messaging_service_sid,
        provisioning_claim_key, provisioning_claim_at, provisioning_claim_by_practitioner_id,
        provisioning_lease_generation, provisioned_at, last_test_ok_at)
     values ($1, 'twilio', 'active', 'US', $2, $2, $3, $4, $5, now(), $6, 1, now(), now())`,
    [seed.studioId, phone, `PN${hex(32)}`, `MG${hex(32)}`, `hone-sms-${hex(32)}`, owner.id],
  );
  return { studioId: seed.studioId, phone };
}

/** Release a sender the way 0191's lifecycle does: active -> releasing -> released. */
async function releaseSender(studioId: string): Promise<void> {
  await sql("update public.studio_sms_senders set status = 'releasing' where studio_id = $1 and status <> 'released'", [studioId]);
  await sql("update public.studio_sms_senders set status = 'released', released_at = now() where studio_id = $1 and status = 'releasing'", [studioId]);
}

/** A new live sender with a new US number for the same studio (the replacement). */
async function addActiveUsSender(studioId: string): Promise<string> {
  const [owner] = await sql<{ id: string }>(
    "select id from public.practitioners where studio_id = $1 order by created_at limit 1",
    [studioId],
  );
  const phone = `+1212555${String(Math.floor(1000 + Math.random() * 9000))}`;
  const hex = (n: number) => randomBytes(n / 2).toString("hex");
  await sql(
    `insert into public.studio_sms_senders
       (studio_id, provider, status, country,
        claimed_phone_number, phone_number, phone_number_sid, messaging_service_sid,
        provisioning_claim_key, provisioning_claim_at, provisioning_claim_by_practitioner_id,
        provisioning_lease_generation, provisioned_at, last_test_ok_at)
     values ($1, 'twilio', 'active', 'US', $2, $2, $3, $4, $5, now(), $6, 1, now(), now())`,
    [studioId, phone, `PN${hex(32)}`, `MG${hex(32)}`, `hone-sms-${hex(32)}`, owner.id],
  );
  return phone;
}

/** One operator, signed in through the real magic link, in its own browser context. */
async function operatorPage(browser: Browser): Promise<Page> {
  const { email } = await seedOperatorAuthUser();
  const context = await browser.newContext({ baseURL: E2E_APP_ORIGIN });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
  return page;
}

const section = (page: Page) => page.getByTestId("admin-sms-registration");
const result = (page: Page) => page.getByTestId("admin-sms-registration-result");

async function submit(page: Page, phone: string, fields: { status?: string; reference?: string }): Promise<void> {
  const form = section(page);
  if (fields.status !== undefined) await form.getByLabel("Status").selectOption(fields.status);
  if (fields.reference !== undefined) await form.getByLabel("Provider reference").fill(fields.reference);
  await form.getByRole("button", { name: new RegExp(`(Record|Update the record) for ${phone.replace("+", "\\+")}`) }).click();
}

test.describe("SMS registration: a stale form never wins, mounted", () => {
  test("stale submit is refused and shown; the form refreshes to the current record; the resubmit is safe", async ({ browser }) => {
    test.setTimeout(180_000);
    const { studioId, phone } = await seedStudioWithActiveUsSender();
    const path = `/admin/studios/${studioId}`;
    const ref1 = `BN${randomUUID().slice(0, 8).toUpperCase()}`;
    const ref2 = `BN${randomUUID().slice(0, 8).toUpperCase()}`;

    // Operator A records the first decision.
    const a = await operatorPage(browser);
    await a.goto(path);
    await expect(section(a)).toBeVisible();
    await submit(a, phone, { status: "approved", reference: ref1 });
    await expect(result(a)).toHaveAttribute("data-result", "recorded");
    await expect(result(a)).toHaveText(`Recorded for ${phone}.`);
    expect(await registrationOf(studioId)).toEqual({ status: "approved", provider_reference: ref1 });

    // Operator B loads the page NOW: it shows "approved".
    const b = await operatorPage(browser);
    await b.goto(path);
    await expect(section(b).getByLabel("Status")).toHaveValue("approved");

    // A suspends it. The form A submitted from refreshes, and "Recorded." stays.
    await a.reload();
    await submit(a, phone, { status: "suspended" });
    await expect(result(a)).toHaveAttribute("data-result", "recorded");
    await expect(section(a).getByLabel("Status")).toHaveValue("suspended");
    expect(await registrationOf(studioId)).toEqual({ status: "suspended", provider_reference: ref1 });

    // B, still showing "approved", edits only the reference: REFUSED, and said so.
    await expect(section(b).getByLabel("Status")).toHaveValue("approved");
    await submit(b, phone, { reference: ref2 });
    await expect(result(b)).toHaveAttribute("data-result", "stale_record");
    await expect(result(b)).toHaveAttribute("role", "alert");
    await expect(result(b)).toContainText("changed after this page loaded");
    // Nothing was written: A's suspension and the old reference stand.
    expect(await registrationOf(studioId)).toEqual({ status: "suspended", provider_reference: ref1 });

    // THE REFRESH: the refused form now shows the CURRENT record (remounted),
    // and the refusal is still on screen (not discarded by the remount).
    await expect(section(b).getByLabel("Status")).toHaveValue("suspended");
    await expect(section(b).getByLabel("Provider reference")).toHaveValue(ref1);
    await expect(result(b)).toHaveAttribute("data-result", "stale_record");

    // THE SAFE RESUBMIT: B re-applies its reference edit to the current record.
    await submit(b, phone, { reference: ref2 });
    await expect(result(b)).toHaveAttribute("data-result", "recorded");
    // Recorded against the current record: suspended stays suspended.
    expect(await registrationOf(studioId)).toEqual({ status: "suspended", provider_reference: ref2 });
    await expect(section(b).getByLabel("Status")).toHaveValue("suspended");

    await a.context().close();
    await b.context().close();
  });

  // Codex P2 4270957975: the refusal must survive a refresh that REPLACES or
  // REMOVES the sender, not only one that changes the record version.
  test("a sender replaced or released after the page loaded: the refusal stays on screen, and the page shows the new state", async ({ browser }) => {
    test.setTimeout(180_000);
    const { studioId, phone } = await seedStudioWithActiveUsSender();
    const path = `/admin/studios/${studioId}`;
    const b = await operatorPage(browser);

    // REPLACED: B's page shows the old sender and number.
    await b.goto(path);
    await expect(b.getByTestId("admin-sms-registration-number")).toHaveText(phone);
    await releaseSender(studioId);
    const replacement = await addActiveUsSender(studioId);
    await submit(b, phone, { status: "approved" });
    await expect(result(b)).toHaveAttribute("data-result", "sender_changed");
    await expect(result(b)).toContainText("number changed after this page loaded");
    // The refreshed page shows the NEW sender and its fresh form; the refusal stays.
    await expect(b.getByTestId("admin-sms-registration-number")).toHaveText(replacement);
    await expect(section(b).getByRole("button", { name: new RegExp(`Record for ${replacement.replace("+", "\\+")}`) })).toBeVisible();
    await expect(result(b)).toHaveAttribute("data-result", "sender_changed");
    expect(await registrationOf(studioId)).toBeNull();

    // RELEASED: B's page (reloaded) shows the replacement; then it is released.
    await b.reload();
    await expect(b.getByTestId("admin-sms-registration-number")).toHaveText(replacement);
    await releaseSender(studioId);
    await submit(b, replacement, { status: "approved" });
    await expect(result(b)).toHaveAttribute("data-result", "no_live_sender");
    // The refreshed page has no sender and no form -- and the refusal is still shown.
    await expect(section(b)).toHaveAttribute("data-state", "no-live-sender");
    await expect(section(b).locator("form")).toHaveCount(0);
    await expect(result(b)).toHaveAttribute("data-result", "no_live_sender");
    expect(await registrationOf(studioId)).toBeNull();

    await b.context().close();
  });
});
