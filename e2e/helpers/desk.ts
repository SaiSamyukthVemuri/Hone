import { expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { E2E_APP_ORIGIN, E2E_DB_URL } from "./local-env";
import { listMessageIds, waitForMagicLink } from "./mail";
import { createLocalAuthUser, getE2eServiceId, getOwnerPractitionerId, seedE2eClient, seedE2eMember, seedE2eStudio, sql } from "./seed";
import { installWebkitLocalhostFix, isWebKit } from "./webkit-localhost";

// Shared helpers for the receptionist-desk specs. Everything here is synthetic and local-only.
//
// WebKit: the receptionist signs in through a magic link and then lands on /accept-invitation or /no-access. e2e/helpers/webkit-localhost.ts documents why
// WebKit needs the header-stripping route on the app's documents, and why a magic link is followed with the context's request API and never navigated.
// followMagicLinkWebkit (flows.ts) asserts the owner's /dashboard landing, so the desk variant below lands wherever the link actually goes. Chromium takes the
// original path untouched.

/** Registers the WebKit route (no-op elsewhere). Call it on a context before the first navigation of a receptionist page. */
export async function prepareDeskPage(page: Page): Promise<void> {
  if (isWebKit(page)) await installWebkitLocalhostFix(page.context());
}

/** Follows a magic link to wherever it lands. WebKit: the link is requested through the context (never navigated), then its landing page is opened. */
export async function followDeskMagicLink(page: Page, link: string): Promise<void> {
  if (!isWebKit(page)) {
    await page.goto(link);
    return;
  }
  const landed = await page.context().request.get(link);
  const url = new URL(landed.url());
  await page.goto(url.pathname + url.search);
}

/** Signs a receptionist in with a real magic link from Mailpit. */
export async function signInWithMagicLink(page: Page, email: string): Promise<void> {
  await prepareDeskPage(page);
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  await followDeskMagicLink(page, await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen }));
}

/** A receptionist already on the books of the studio (a row, no practitioner), signed in and on the desk. Returns the auth user id. */
export async function signInAsDesk(page: Page, studio: Awaited<ReturnType<typeof seedE2eStudio>>): Promise<string> {
  const deskEmail = `desk-${studio.runId}@harness.local`;
  const userId = await createLocalAuthUser(deskEmail);
  await sql("insert into public.studio_receptionists (studio_id,user_id,display_name,active) values ($1,$2,'Front desk',true)", [studio.studioId, userId]);
  await signInWithMagicLink(page, deskEmail);
  await page.getByRole("link", { name: "Open the front desk" }).click();
  await page.waitForURL(/\/desk(?:\?|$)/);
  return userId;
}

/**
 * Asserts that a practitioner-only path is closed to the signed-in receptionist: it ends on /no-access. In WebKit the redirect is read from the response
 * instead of navigated: a navigated redirect chain is not intercepted by the header-stripping route (only the first URL is), so the document it lands
 * on would carry Strict-Transport-Security and make the rest of the test's pages load over https.
 */
export async function expectPathRefused(page: Page, pathname: string): Promise<void> {
  if (!isWebKit(page)) {
    await page.goto(pathname);
    await expect(page).toHaveURL(/\/no-access/);
    return;
  }
  const res = await page.context().request.get(pathname, { maxRedirects: 0 });
  expect(res.status(), `${pathname} redirects a receptionist`).toBeGreaterThanOrEqual(300);
  expect(res.status()).toBeLessThan(400);
  expect(res.headers()["location"] ?? "").toMatch(/\/no-access/);
}

export type DeskFixture = {
  studio: Awaited<ReturnType<typeof seedE2eStudio>>;
  member: Awaited<ReturnType<typeof seedE2eMember>>;
  serviceId: string;
  /** The local calendar day (YYYY-MM-DD) of the owner's one seeded visit. */
  date: string;
  returningClientId: string;
  returningEmail: string;
  returningPhone: string;
  other: Awaited<ReturnType<typeof seedE2eStudio>>;
  otherClientId: string;
  otherOwnerId: string;
  otherServiceId: string;
  otherAppointmentId: string;
};

/**
 * A studio with an owner and a member practitioner, one visit for the owner tomorrow ("Ari Rowan", whose account name is different), a returning client
 * "Morgan Vale" (account name different, real email and phone that must never reach the desk's finder) and ANOTHER studio with its own client and visit.
 */
export async function seedDeskFixture(): Promise<DeskFixture> {
  const studio = await seedE2eStudio();
  const member = await seedE2eMember(studio);
  const ownerId = await getOwnerPractitionerId(studio.studioId);
  const serviceId = await getE2eServiceId(studio.studioId);
  const { clientId } = await seedE2eClient(studio);
  await sql("update public.clients set name='Ari Account', preferred_name='Ari Rowan' where id=$1", [clientId]);
  const { clientId: returningClientId } = await seedE2eClient(studio);
  const returningEmail = `morgan.${studio.runId}@harness.local`;
  const returningPhone = "+14165550188";
  await sql("update public.clients set name='Morgan Account', preferred_name='Morgan Vale', email=$2, phone=$3 where id=$1", [returningClientId, returningEmail, returningPhone]);
  const [{ local_day: date }] = await sql<{ local_day: string }>(
    `with slot as (select ((now() at time zone timezone)::date + 1 + time '13:00') at time zone timezone as starts, timezone from public.studios where id = $1),
          booked as (insert into public.appointments (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, blocked_ends_at, duration_minutes, buffer_minutes_snapshot, status)
                     select $1, $2, $3, $4, starts, starts + interval '30 minutes', starts + interval '30 minutes', 30, 0, 'confirmed' from slot returning starts_at)
     select to_char(booked.starts_at at time zone slot.timezone, 'YYYY-MM-DD') as local_day from booked, slot`,
    [studio.studioId, ownerId, clientId, serviceId],
  );
  const other = await seedE2eStudio();
  const otherOwnerId = await getOwnerPractitionerId(other.studioId);
  const otherServiceId = await getE2eServiceId(other.studioId);
  const otherClient = await seedE2eClient(other);
  await sql("update public.clients set name='Other Studio Person', preferred_name='Other Studio Person' where id=$1", [otherClient.clientId]);
  const [{ id: otherAppointmentId }] = await sql<{ id: string }>(
    `insert into public.appointments (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, blocked_ends_at, duration_minutes, buffer_minutes_snapshot, status)
     select $1,$2,$3,$4, a.starts_at, a.ends_at, a.blocked_ends_at, 30, 0, 'confirmed' from public.appointments a where a.studio_id=$5 limit 1 returning id`,
    [other.studioId, otherOwnerId, otherClient.clientId, otherServiceId, studio.studioId],
  );
  return { studio, member, serviceId, date, returningClientId, returningEmail, returningPhone, other, otherClientId: otherClient.clientId, otherOwnerId, otherServiceId, otherAppointmentId };
}

/** Runs a query as the signed-in receptionist would reach the database: role authenticated with that user's claims, inside a transaction that is rolled back. */
export async function asReceptionist<T>(
  userId: string,
  fn: (client: Client) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; code: string; message: string }> {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    const value = await fn(client);
    await client.query("rollback");
    return { ok: true, value };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    const e = error as { code?: string; message?: string };
    return { ok: false, code: e.code ?? "?", message: e.message ?? "" };
  } finally {
    await client.end();
  }
}
