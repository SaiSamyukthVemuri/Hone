import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  setStudioCapacityEnabled,
  setStudioCapacityBookingEnabled,
  seedPractitionerDefault,
  seedServiceEligibility,
  getE2eServiceId,
  getOwnerPractitionerId,
  setStudioTimezone,
  sql,
  type E2eSeed,
} from "../helpers/seed";
import { loginByMagicLink } from "../helpers/flows";

// HON-48 five-user proof: shared fixture. One synthetic team studio (owner + four members, capacity booking ON,
// America/Los_Angeles, every practitioner open 06:00-22:00 every weekday, eligible for the seeded service), a client per
// user, and FIVE separate browser contexts (five cookie jars, five authenticated sessions). Synthetic data only.

export const TZ = "America/Los_Angeles";
export const SLOT = /^\d{1,2}:\d{2}\s?(AM|PM)$/i;
export const DRAWER = (page: Page) => page.getByRole("dialog", { name: "New appointment" });

export type User = {
  key: string;
  practitionerId: string;
  name: string;
  email: string;
  clientId: string;
  clientName: string;
};

export type Team = {
  seed: E2eSeed;
  day: string;
  serviceId: string;
  users: User[];
  contexts: Array<{ ctx: BrowserContext; page: Page }>;
};

export async function clientNameOf(seed: E2eSeed, clientId: string): Promise<string> {
  const [row] = await sql<{ name: string }>("select name from public.clients where studio_id=$1 and id=$2", [seed.studioId, clientId]);
  return row.name;
}

/** `daysAhead` days from today in the studio's timezone, as YYYY-MM-DD. */
export async function setupFiveUserTeam(browser: Browser, daysAhead = 3): Promise<Team> {
  const seed = await seedE2eStudio();
  await setStudioTimezone(seed.studioId, TZ);
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);
  const [d] = await sql<{ day: string }>("select ((now() at time zone $1)::date+$2::int)::text as day", [TZ, daysAhead]);
  const serviceId = await getE2eServiceId(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const people = [{ key: "ana", practitionerId: ownerId, email: seed.ownerEmail, name: `Synthetic Ana ${seed.runId}` }];
  for (const key of ["bo", "cy", "di", "ed"]) {
    const m = await seedE2eMember(seed);
    people.push({ key, practitionerId: m.practitionerId, email: m.email, name: `Synthetic ${key[0].toUpperCase()}${key.slice(1)} ${seed.runId}` });
  }
  for (const p of people) {
    await sql("update public.practitioners set display_name=$3 where studio_id=$1 and id=$2", [seed.studioId, p.practitionerId, p.name]);
    if (p.practitionerId !== ownerId) await seedServiceEligibility(seed.studioId, serviceId, p.practitionerId);
    for (let wd = 0; wd <= 6; wd++) await seedPractitionerDefault(seed.studioId, p.practitionerId, wd, true, "06:00", "22:00");
  }
  const users: User[] = [];
  for (const p of people) {
    const { clientId } = await seedE2eClient(seed);
    users.push({ ...p, clientId, clientName: await clientNameOf(seed, clientId) });
  }
  // Logins run one after another: magic links are single use and the inbox is shared, so this is setup, not the
  // concurrency under test.
  const contexts: Team["contexts"] = [];
  for (const u of users) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginByMagicLink(page, u.email);
    contexts.push({ ctx, page });
  }
  return { seed, day: d.day, serviceId, users, contexts };
}

export async function closeTeam(t: Team | undefined): Promise<void> {
  if (!t) return;
  for (const c of t.contexts) await c.ctx.close();
}

export async function openDrawerForColumn(page: Page, day: string, u: User, yOffset = 6 * 60 + 5) {
  await page.goto(`/calendar?view=day&day=${day}`);
  const col = page.locator(`[data-testid="team-day-column"][data-practitioner-id="${u.practitionerId}"]`);
  await col.scrollIntoViewIfNeeded();
  const box = (await col.boundingBox())!;
  await col
    .getByRole("button", { name: `Open quick-book draft for ${u.name} on ${day}` })
    .click({ position: { x: box.width / 2, y: yOffset } });
  await expect(DRAWER(page)).toBeVisible({ timeout: 20_000 });
}

/** Fill the drawer for `client` and pick a slot (the last one by default); returns the submit button (not yet clicked). */
export async function prepareBooking(page: Page, client: string, serviceId: string, target?: User, slotIndex = -1) {
  const d = DRAWER(page);
  await d.getByPlaceholder("Find existing client").fill(client);
  await d.getByRole("button", { name: new RegExp(client) }).first().click();
  await d.getByRole("combobox").first().selectOption(serviceId);
  if (target) {
    const selector = d.getByLabel("Practitioner");
    if (await selector.count()) await selector.selectOption(target.practitionerId);
  }
  const slot = d.getByRole("button", { name: SLOT });
  await expect(slot.first()).toBeVisible({ timeout: 20_000 });
  await (slotIndex < 0 ? slot.last() : slot.nth(slotIndex)).click();
  const submit = d.getByRole("button", { name: /^Book appointment$/ });
  await expect(submit).toBeEnabled();
  return submit;
}

export async function rows(seed: E2eSeed, practitionerId: string, clientId?: string) {
  return sql<{ id: string; starts_at: string; ends_at: string; client_id: string }>(
    "select id, starts_at::text, ends_at::text, client_id from public.appointments where studio_id=$1 and practitioner_id=$2 " +
      "and status='confirmed' and ($3::uuid is null or client_id=$3) order by starts_at",
    [seed.studioId, practitionerId, clientId ?? null],
  );
}

export async function reservationCount(appointmentId: string): Promise<number> {
  const [r] = await sql<{ n: number }>(
    "select count(*)::int as n from public.studio_calendar_reservations where source_kind='appointment' and source_id=$1",
    [appointmentId],
  );
  return r.n;
}
