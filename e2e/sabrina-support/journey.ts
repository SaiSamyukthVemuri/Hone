import { expect, type Page } from "@playwright/test";
import { Client as PgClient } from "pg";
import { E2E_APP_ORIGIN, E2E_DB_URL } from "../helpers/local-env";
import { listMessageIds, waitForMagicLink } from "../helpers/mail";
import { readResendLedger, type ResendLedgerMark, type ResendLedgerRecord } from "../helpers/resend-ledger";
import { sql } from "../helpers/seed";
import { dayUrl } from "../hon48-support/calendar-urls";
import { DRAWER, SLOT, type User } from "../hon48-support/five-user-team";

// The connected Sabrina journey: shared steps. Synthetic users, a local stack, captured transport only. Nothing here sends a
// real message, invitation or charge: app email goes to the fake Resend ledger, sign-in mail goes to the local Mailpit.

export const T = 20_000;

/** Sign in through the REAL magic-link path and follow the link, without asserting where it lands (each case lands elsewhere). */
export async function signInAnywhere(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
}

/** Owner invites a practitioner through Settings > Team. Returns once the product says the invite was created. */
export async function inviteViaTeamPage(ownerPage: Page, email: string, displayName: string): Promise<void> {
  await ownerPage.goto("/settings/team");
  await ownerPage.getByPlaceholder("teammate@example.com").fill(email);
  await ownerPage.getByPlaceholder("Optional").fill(displayName);
  await ownerPage.getByRole("button", { name: "Create invite" }).click();
  await expect(ownerPage.getByText(`Invite created for ${email.toLowerCase()}.`)).toBeVisible({ timeout: T });
}

/** Poll the capture ledger for what the app tried to email to `to` since `mark`. The ledger records an attempt BEFORE its outcome. */
export async function ledgerFor(mark: ResendLedgerMark, to: string, minCount = 1, timeoutMs = 20_000): Promise<ResendLedgerRecord[]> {
  const deadline = Date.now() + timeoutMs;
  let found: ResendLedgerRecord[] = [];
  while (Date.now() < deadline) {
    found = readResendLedger(mark).filter((r) => r.to.toLowerCase() === to.toLowerCase());
    if (found.length >= minCount) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  return found;
}

export async function practitionerByEmail(studioId: string, email: string) {
  const rows = await sql<{ id: string; user_id: string; active: boolean; display_name: string }>(
    "select id, user_id, active, display_name from public.practitioners where studio_id=$1 and lower(email)=lower($2)",
    [studioId, email],
  );
  return rows[0] ?? null;
}

export async function authUserId(email: string): Promise<string> {
  const rows = await sql<{ id: string }>("select id::text as id from auth.users where lower(email)=lower($1)", [email]);
  if (!rows[0]) throw new Error("no auth user for the synthetic email");
  return rows[0].id;
}

/**
 * Run ONE read as a signed-in database user, with row-level security applied (role `authenticated`, the user's id in the JWT
 * claims), in a transaction that is always rolled back. This is the direct-API read a removed user could still try: it does not
 * go through any page, so a hidden button or a redirect proves nothing about it.
 */
export async function asAuthenticated<T = Record<string, unknown>>(userId: string, text: string, params: unknown[] = []): Promise<T[]> {
  const client = new PgClient({ connectionString: E2E_DB_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    const result = await client.query(text, params);
    return result.rows as T[];
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

/** Open the Day view for `day` and the quick-book drawer in `target`'s column. */
export async function openColumnDrawer(page: Page, day: string, everyone: string[], target: User, yOffset = 6 * 60 + 5) {
  await page.goto(dayUrl(day, everyone));
  const col = page.locator(`[data-testid="team-day-column"][data-practitioner-id="${target.practitionerId}"]`);
  await col.scrollIntoViewIfNeeded();
  const box = (await col.boundingBox())!;
  await col
    .getByRole("button", { name: `Open quick-book draft for ${target.name} on ${day}` })
    .click({ position: { x: box.width / 2, y: yOffset } });
  await expect(DRAWER(page)).toBeVisible({ timeout: T });
}

/** Staff books manually: pick the client, the service and the practitioner, then a slot; returns the (unclicked) submit button. */
export async function fillManualBooking(page: Page, clientName: string, serviceId: string, target: User) {
  const d = DRAWER(page);
  await d.getByPlaceholder("Find existing client").fill(clientName);
  await d.getByRole("button", { name: new RegExp(clientName) }).first().click();
  await d.getByRole("combobox").first().selectOption(serviceId);
  const selector = d.getByLabel("Practitioner");
  if (await selector.count()) await selector.selectOption(target.practitionerId);
  const slot = d.getByRole("button", { name: SLOT });
  await expect(slot.first()).toBeVisible({ timeout: T });
  await slot.last().click();
  const submit = d.getByRole("button", { name: /^Book appointment$/ });
  await expect(submit).toBeEnabled();
  return submit;
}

/** Chart one electrolysis settings block through the real session UI (the same steps core-memory-loop drives). */
export async function chartOneBlock(page: Page, clientId: string, appointmentId: string, lot: string): Promise<void> {
  await page.goto(`/clients/${clientId}/sessions/new?appointment_id=${appointmentId}`);
  await page.getByRole("button", { name: /electrolysis/i }).click();
  await page.waitForURL(/sessions\//, { timeout: T });
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByRole("heading", { name: /add settings block/i })).toBeVisible({ timeout: T });
  await page.getByRole("button", { name: "Chin", exact: true }).click();
  await page.getByRole("button", { name: "13.56 MHz" }).click();
  await page.getByRole("button", { name: "Sterex" }).click();
  await page.getByPlaceholder("e.g. 460941").fill(lot);
  await page.getByRole("spinbutton", { name: /minutes performed/i }).fill("15");
  await page.getByRole("button", { name: "Mild discomfort" }).click();
  await page.getByRole("button", { name: /save settings block/i }).click();
  await expect(page.getByText(lot).first()).toBeVisible({ timeout: T });
}

/** What a charge would leave behind for one appointment. The journey asserts there is none: finishing care is not a payment. */
export async function paymentFootprint(studioId: string, appointmentId: string, sessionId: string) {
  const [pay] = await sql<{ n: number }>("select count(*)::int as n from public.appointment_payments where appointment_id=$1", [appointmentId]);
  const [att] = await sql<{ n: number }>("select count(*)::int as n from public.payment_charge_attempts where studio_id=$1 and session_id=$2", [studioId, sessionId]);
  const [paid] = await sql<{ price_paid_cents: number | null }>("select price_paid_cents from public.sessions where id=$1", [sessionId]);
  return { appointmentPaymentRows: pay.n, chargeAttempts: att.n, pricePaidCents: paid?.price_paid_cents ?? null };
}
