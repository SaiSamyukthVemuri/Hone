import { test, expect } from "@playwright/test";
import { seedE2eStudio, sql } from "./helpers/seed";
import { closeTeam, openDrawerForColumn, setupFiveUserTeam, DRAWER, SLOT, TZ, type Team } from "./hon48-support/five-user-team";
import { randomUUID } from "node:crypto";

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
// Appointment-reference lookup is a separate requirement and is not covered here.

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
