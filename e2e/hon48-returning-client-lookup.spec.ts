import { test, expect } from "@playwright/test";
import { seedE2eStudio, sql } from "./helpers/seed";
import { closeTeam, openDrawerForColumn, setupFiveUserTeam, DRAWER, SLOT, TZ, type Team } from "./hon48-support/five-user-team";
import { randomUUID } from "node:crypto";
import { emailBookingReference } from "../lib/email/booking-reference";

// HON-48 returning-client lookup and manual scheduling, in a browser, on synthetic data.
//
// Opt-in: HON48_FIVE_USER_E2E=1.
//
// A client who is already in the studio is found by typing their name into the booking drawer, is listed BEST MATCH FIRST,
// is chosen, and is booked into a time the user picks, for the practitioner whose column was opened.
//
//   L1  the exact name ranks first, then the longer name that starts with it, then the name that merely contains it
//   L2  a client of ANOTHER studio with the same exact name is never listed
//   L3  choosing the exact match and booking a picked slot creates one appointment for THAT client (not a neighbour in the
//       list), for the column's practitioner, at the picked time
//
//   R1  the six-character reference from a booking or cancellation email, pasted in any case with a label and spaces, finds
//       that appointment (a confirmed and a cancelled one), opens it, and is found by a second practitioner too
//   R2  another studio's appointment reference finds nothing, and an unknown reference finds nothing (no error)

test.skip(process.env.HON48_FIVE_USER_E2E !== "1", "opt-in HON-48 lookup proof; set HON48_FIVE_USER_E2E=1");
test.describe.configure({ mode: "serial" });

let t: Team;
let tok = "";
let exact = { id: "", name: "" };
let prefix = { id: "", name: "" };
let looser = { id: "", name: "" };

async function addClient(studioId: string, name: string): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  await sql("insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)", [id, studioId, name, `lookup-${id.slice(0, 8)}@harness.local`]);
  return { id, name };
}

test.beforeAll(async ({ browser }) => {
  t = await setupFiveUserTeam(browser, 3);
  tok = t.seed.runId.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  exact = await addClient(t.seed.studioId, `Wren Marlow ${tok}`);
  prefix = await addClient(t.seed.studioId, `Wren Marlow ${tok} Junior`);
  looser = await addClient(t.seed.studioId, `Zed Wren Marlow ${tok}`);
  const other = await seedE2eStudio();
  await addClient(other.studioId, `Wren Marlow ${tok}`);
});
test.afterAll(async () => { await closeTeam(t); });

test("L1 and L2: the best match is first, and another studio's client with the same name is never listed", async () => {
  const owner = t.contexts[0].page;
  await openDrawerForColumn(owner, t.day, t.users[2]);
  const d = DRAWER(owner);
  await d.getByPlaceholder("Find existing client").fill(`Wren Marlow ${tok}`);
  const rows = d.getByRole("button", { name: new RegExp(tok) });
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const texts = (await rows.allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim());
  const idx = (n: string) => texts.findIndex((x) => x.includes(n));
  expect(idx(exact.name), "exact match is listed").toBeGreaterThanOrEqual(0);
  expect(idx(exact.name), "exact before prefix").toBeLessThan(idx(prefix.name));
  expect(idx(prefix.name), "prefix before the looser match").toBeLessThan(idx(looser.name));
  // L2: the three names above are each listed once. Another studio's same-named client would make the exact name appear twice.
  expect(texts.filter((x) => x.startsWith(`Wren Marlow ${tok}`) && !x.includes("Junior")).length, "the exact name appears once").toBe(1);
});

test("L3: choosing the exact match and a picked time books THAT client for the column's practitioner", async () => {
  const owner = t.contexts[0].page;
  const target = t.users[2];
  await openDrawerForColumn(owner, t.day, target);
  const d = DRAWER(owner);
  await d.getByPlaceholder("Find existing client").fill(`Wren Marlow ${tok}`);
  await d.getByRole("button", { name: new RegExp(`^Wren Marlow ${tok}(?! Junior)`) }).first().click();
  await d.getByRole("combobox").first().selectOption(t.serviceId);
  const sel = d.getByLabel("Practitioner");
  if (await sel.count()) await sel.selectOption(target.practitionerId);
  const slots = d.getByRole("button", { name: SLOT });
  await expect(slots.first()).toBeVisible({ timeout: 20_000 });
  const pick = slots.nth(4);
  const label = (await pick.innerText()).trim();
  await pick.click();
  await d.getByRole("button", { name: /^Book appointment$/ }).click();
  await expect(d).toBeHidden({ timeout: 30_000 });

  const booked = await sql<{ client_id: string; practitioner_id: string; hhmm: string }>(
    "select client_id::text, practitioner_id::text, to_char(starts_at at time zone $2,'HH24:MI') as hhmm from public.appointments " +
      "where studio_id=$1 and client_id = any($3::uuid[]) and status='confirmed'",
    [t.seed.studioId, TZ, [exact.id, prefix.id, looser.id]],
  );
  expect(booked, "exactly one appointment, for exactly one of the three similar clients").toHaveLength(1);
  expect(booked[0].client_id).toBe(exact.id);
  expect(booked[0].practitioner_id).toBe(target.practitionerId);
  const [h12, mer] = label.split(/\s+/);
  const [hh, mm] = h12.split(":").map(Number);
  const hour24 = (hh % 12) + (/pm/i.test(mer) ? 12 : 0);
  expect(booked[0].hhmm, "booked at the time that was picked").toBe(`${String(hour24).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
});

async function addAppointment(studioId: string, clientId: string, practitionerId: string, serviceId: string, day: string, local: string, status: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    "insert into public.appointments (id,studio_id,client_id,practitioner_id,service_id,starts_at,ends_at,duration_minutes,buffer_minutes_snapshot,blocked_ends_at,status) " +
      "select gen_random_uuid(),$1,$2,$3,$4,s,s+interval '30 minutes',30,0,s+interval '30 minutes',$8 " +
      "from (select (($5::date + $6::time) at time zone $7) as s) t returning id",
    [studioId, clientId, practitionerId, serviceId, day, local, TZ, status],
  );
  return row.id;
}

async function searchFor(page: import("@playwright/test").Page, text: string) {
  await page.goto("/calendar");
  const input = page.locator('input[aria-label="Search Hone"]:visible');
  if (!(await input.count())) await page.getByRole("button", { name: "Search Hone" }).first().click();
  await input.first().fill(text);
}

test("R1: the emailed reference finds the appointment, cancelled included, for the owner and a member, and opens it", async () => {
  const c1 = await addClient(t.seed.studioId, `Ref Confirmed ${tok}`);
  const c2 = await addClient(t.seed.studioId, `Ref Cancelled ${tok}`);
  const live = await addAppointment(t.seed.studioId, c1.id, t.users[0].practitionerId, t.serviceId, t.day, "09:00", "confirmed");
  const gone = await addAppointment(t.seed.studioId, c2.id, t.users[1].practitionerId, t.serviceId, t.day, "10:00", "cancelled");

  for (const [who, page] of [["owner", t.contexts[0].page], ["member", t.contexts[1].page]] as const) {
    await searchFor(page, `  Ref ${emailBookingReference(live).toLowerCase()} `);
    const hit = page.getByRole("link", { name: new RegExp(`Ref Confirmed ${tok}`) }).first();
    await expect(hit, `${who} finds the confirmed appointment`).toBeVisible({ timeout: 20_000 });
    expect(await hit.getAttribute("href")).toBe(`/calendar/${live}`);
  }
  const owner = t.contexts[0].page;
  await searchFor(owner, `#${emailBookingReference(gone)}`);
  const cancelled = owner.getByRole("link", { name: new RegExp(`Ref Cancelled ${tok}`) }).first();
  await expect(cancelled, "a cancelled appointment is found by its reference").toBeVisible({ timeout: 20_000 });
  await cancelled.click();
  await expect(owner).toHaveURL(new RegExp(`/calendar/${gone}`), { timeout: 20_000 });
});

test("R2: another studio's reference and an unknown reference find nothing", async () => {
  const other = await seedE2eStudio();
  const [svc] = await sql<{ id: string }>("select id from public.services where studio_id=$1 limit 1", [other.studioId]);
  const [prac] = await sql<{ id: string }>("select id from public.practitioners where studio_id=$1 limit 1", [other.studioId]);
  const oc = await addClient(other.studioId, `Ref Foreign ${tok}`);
  const foreign = await addAppointment(other.studioId, oc.id, prac.id, svc.id, t.day, "11:00", "confirmed");
  const owner = t.contexts[0].page;
  for (const ref of [emailBookingReference(foreign), "ZZZZZZ"]) {
    await searchFor(owner, ref);
    await expect(owner.getByText("No results found.")).toBeVisible({ timeout: 20_000 });
    await expect(owner.getByRole("link", { name: new RegExp(`Ref Foreign ${tok}`) })).toHaveCount(0);
  }
});
