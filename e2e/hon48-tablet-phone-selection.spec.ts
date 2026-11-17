import { test, expect, devices, type Page } from "@playwright/test";
import {
  seedE2eStudio, seedE2eMember, seedE2eClient, setStudioCapacityEnabled, setStudioCapacityBookingEnabled,
  seedPractitionerDefault, seedServiceEligibility, getE2eServiceId, getOwnerPractitionerId, setStudioTimezone, sql,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { clientNameOf, TZ } from "./hon48-support/five-user-team";

// HON-48 tablet and phone appointment selection. Chromium EMULATION of an iPad Pro 11 (landscape and portrait) and an
// iPhone 13: touch input, a coarse pointer, the device viewport. It is NOT a physical iPad and NOT the WebKit engine; the
// human recheck on a real device stays open.
//
// Opt-in: HON48_FIVE_USER_E2E=1.
//
// The report: on an iPad, nearby appointments in the day calendar were hidden in one "multiple appointments" bubble. A
// calendar of 15-minute appointments back to back is the case that crowds: each card is drawn at least 44 px tall, so
// neighbours overlap on the screen even though the database holds them apart.
//
// Proved per device, with three back-to-back 15-minute appointments in one practitioner's column:
//   * every one of the three clients is individually reachable (a card of its own, or a row in the chooser that names it);
//   * every tap target that stands for them (card, chooser button, chooser row) is at least 44 x 44 CSS px;
//   * choosing each opens THAT appointment (the preview drawer, or the appointment's own page), never a neighbour;
//   * the chooser, when used, lists all three: nothing is hidden behind a count alone.

test.skip(process.env.HON48_FIVE_USER_E2E !== "1", "opt-in HON-48 tablet/phone proof; set HON48_FIVE_USER_E2E=1");
test.describe.configure({ mode: "serial" });

const { defaultBrowserType: _a, ...IPAD } = devices["iPad Pro 11"];
const { defaultBrowserType: _b, ...IPAD_LAND } = devices["iPad Pro 11 landscape"];
const { defaultBrowserType: _c, ...IPHONE } = devices["iPhone 13"];
void _a; void _b; void _c;

let seed: Awaited<ReturnType<typeof seedE2eStudio>>;
let day: string;
let cluster: Array<{ id: string; name: string }> = [];
let practitionerId = "";

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  await setStudioTimezone(seed.studioId, TZ);
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);
  const serviceId = await getE2eServiceId(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const member = await seedE2eMember(seed);
  await seedServiceEligibility(seed.studioId, serviceId, member.practitionerId);
  for (const p of [ownerId, member.practitionerId]) for (let wd = 0; wd <= 6; wd++) await seedPractitionerDefault(seed.studioId, p, wd, true, "06:00", "22:00");
  practitionerId = member.practitionerId;
  const [d] = await sql<{ day: string }>("select ((now() at time zone $1)::date+3)::text as day", [TZ]);
  day = d.day;
  for (const local of ["10:00", "10:15", "10:30"]) {
    const { clientId } = await seedE2eClient(seed);
    const [row] = await sql<{ id: string }>(
      "insert into public.appointments (id,studio_id,client_id,practitioner_id,service_id,starts_at,ends_at,duration_minutes,buffer_minutes_snapshot,blocked_ends_at,status) " +
        "select gen_random_uuid(),$1,$2,$3,$4,s,s+interval '15 minutes',15,0,s+interval '15 minutes','confirmed' " +
        "from (select (($5::date + $6::time) at time zone $7) as s) t returning id",
      [seed.studioId, clientId, practitionerId, serviceId, day, local, TZ],
    );
    cluster.push({ id: row.id, name: await clientNameOf(seed, clientId) });
  }
});

async function size(page: Page, loc: ReturnType<Page["locator"]>) {
  const box = await loc.boundingBox();
  expect(box, "the target is on screen").not.toBeNull();
  return box!;
}

async function openByName(page: Page, name: string, tapped: string[]) {
  // A card of its own for this client, or the chooser that stands for the cluster.
  const card = page.getByRole("button").filter({ hasText: name }).first();
  if (await card.isVisible().catch(() => false)) {
    const b = await size(page, card);
    expect(b.width, `${name} card width`).toBeGreaterThanOrEqual(43.5);
    expect(b.height, `${name} card height`).toBeGreaterThanOrEqual(43.5);
    tapped.push("card");
    await card.click();
    return;
  }
  const bubble = page.getByRole("button", { name: /^Choose from \d+ appointments$/ }).first();
  await expect(bubble, `${name} must be reachable: neither a card nor a chooser button was found`).toBeVisible();
  const bb = await size(page, bubble);
  expect(bb.width).toBeGreaterThanOrEqual(43.5);
  expect(bb.height).toBeGreaterThanOrEqual(43.5);
  await bubble.click();
  const chooser = page.getByRole("dialog", { name: "Choose an appointment" });
  await expect(chooser).toBeVisible();
  // Nothing is hidden behind a count: every one of the three names is a row.
  for (const c of cluster) await expect(chooser.getByText(c.name), `chooser lists ${c.name}`).toBeVisible();
  const row = chooser.getByRole("button").filter({ hasText: name }).or(chooser.getByRole("link").filter({ hasText: name })).first();
  const rb = await size(page, row);
  expect(rb.width).toBeGreaterThanOrEqual(43.5);
  expect(rb.height).toBeGreaterThanOrEqual(43.5);
  tapped.push("chooser");
  await row.click();
}

async function expectOpened(page: Page, c: { id: string; name: string }) {
  await expect
    .poll(async () => {
      const preview = page.getByRole("dialog", { name: "Appointment preview" });
      if ((await preview.count()) > 0 && (await preview.first().innerText()).includes(c.name)) return "preview";
      if (page.url().includes(`/calendar/${c.id}`)) return "page";
      return "none";
    }, { message: `choosing ${c.name} opens that appointment`, timeout: 15_000 })
    .not.toBe("none");
}

for (const [label, device] of [["iPad portrait", IPAD], ["iPad landscape", IPAD_LAND], ["iPhone", IPHONE]] as const) {
  test(`${label}: every appointment in a crowded column is individually selectable`, async ({ browser }) => {
    const ctx = await browser.newContext({ ...device });
    const page = await ctx.newPage();
    await loginByMagicLink(page, seed.ownerEmail);
    const tapped: string[] = [];
    for (const c of cluster) {
      await page.goto(`/calendar?view=day&day=${day}&people=${practitionerId}`);
      await expect(page.getByRole("main")).toBeVisible();
      await openByName(page, c.name, tapped);
      await expectOpened(page, c);
    }
    test.info().annotations.push({ type: `${label}-path`, description: tapped.join(",") });
    console.log(`HON48_SELECTION ${label} paths=${tapped.join(",")}`);
    await ctx.close();
  });
}
