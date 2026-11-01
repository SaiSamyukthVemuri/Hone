import { test, expect } from "@playwright/test";
import {
  getOwnerPractitionerId,
  seedConfirmedAppointment,
  seedE2eMember,
  seedE2eStudio,
  sql,
} from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// ===========================================================================
// HON-58 identity (migration 0258): preferred and legal names on ONE client.
//
// Real browser, real stack with 0258 applied, SYNTHETIC names only. The unit
// lane proves each branch against fakes and tests/db proves the RLS; this
// proves the whole path a practitioner takes: create a client with a preferred
// name, record the legal name, find the SAME record by the name shown (the preferred name; legal and stored names behind it are not searched, Privacy S8),
// see the right identity on the calendar, the profile and the clinical print,
// and that another studio sees none of it. The tester never improvises a
// fixture: every record below is created by this spec in its own studio.
// ===========================================================================

type ClientRow = { id: string; name: string; preferred_name: string | null };

test("preferred and legal names on one client: create, record, search, display, isolate", async ({
  page,
  browser,
}) => {
  const seed = await seedE2eStudio();
  const run = seed.runId.replace(/[^a-z0-9]/gi, "").slice(-6);
  const storedName = `Margaret Nowak${run}`;
  const preferred = `Maggie${run}`;
  const legalFamily = `Okafor-Reyes${run}`;
  let clientId = "";

  const clientsBefore = Number(
    (await sql<{ n: string }>(`select count(*)::text n from public.clients where studio_id = $1`, [seed.studioId]))[0].n,
  );

  await loginAsOwner(page, seed);

  await test.step("create a client with a preferred name: ONE record, both names stored", async () => {
    await page.goto("/clients/new");
    await page.getByLabel(/^name/i).first().fill(storedName);
    await page.getByLabel(/^preferred name/i).fill(preferred);
    await page.getByRole("button", { name: /^save client$/i }).click();
    await page.waitForURL(/\/clients\/[0-9a-f-]{36}(\?|$)/, { timeout: 30_000 });
    clientId = /\/clients\/([0-9a-f-]{36})/.exec(page.url())![1];
    const rows = await sql<ClientRow>(`select id, name, preferred_name from public.clients where id = $1`, [clientId]);
    expect(rows[0]).toMatchObject({ name: storedName, preferred_name: preferred });
    const after = Number(
      (await sql<{ n: string }>(`select count(*)::text n from public.clients where studio_id = $1`, [seed.studioId]))[0].n,
    );
    expect(after).toBe(clientsBefore + 1);
  });

  await test.step("the profile heading shows the preferred name, not the stored one", async () => {
    await expect(page.getByRole("heading", { level: 1, name: preferred })).toBeVisible({ timeout: 20_000 });
  });

  await test.step("record the legal name on the edit page; it is staff-entered on the same client", async () => {
    await page.goto(`/clients/${clientId}/edit`);
    await expect(page.getByRole("heading", { name: /^legal name$/i })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel(/^given name/i).fill("Margaret");
    await page.getByLabel(/^middle name/i).fill("Anne");
    await page.getByLabel(/^family name/i).fill(legalFamily);
    await page.getByRole("button", { name: /^save legal name$/i }).click();
    await expect(page.getByText("Legal name saved.")).toBeVisible({ timeout: 20_000 });
    const rows = await sql<{ client_id: string; source: string; legal_family_name: string }>(
      `select client_id, source, legal_family_name from public.client_legal_identities where client_id = $1`,
      [clientId],
    );
    expect(rows).toEqual([{ client_id: clientId, source: "staff_entry", legal_family_name: legalFamily }]);
    // Still exactly one client record for this person.
    const n = (await sql<{ n: string }>(`select count(*)::text n from public.clients where studio_id = $1`, [seed.studioId]))[0].n;
    expect(Number(n)).toBe(clientsBefore + 1);
  });

  await test.step("the profile shows the legal name beside the preferred name after a reload", async () => {
    await page.goto(`/clients/${clientId}`);
    await expect(page.getByRole("heading", { level: 1, name: preferred })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`Legal name: Margaret Anne ${legalFamily}`)).toBeVisible();
  });

  await test.step("the client list finds the record by the NAME SHOWN (the preferred name) and by nothing behind it", async () => {
    // Directory search rule (Privacy S8, production #1292): the name shown on the row, the email and the
    // phone, and nothing else. The stored name behind a preferred name and every legal name are NOT searched.
    await page.goto("/clients");
    const search = page.getByRole("searchbox", { name: "Search clients" });
    await expect(search).toBeVisible({ timeout: 20_000 });
    const link = page.locator(`a[href="/clients/${clientId}"]`);
    const submit = async (query: string) => {
      await search.fill(query);
      await search.press("Enter");
      await expect(page).toHaveURL(/[?&]q=/, { timeout: 20_000 });
    };
    for (const query of [preferred, preferred.toUpperCase(), `  ${preferred.toLowerCase()}  `]) {
      await submit(query);
      await expect(link, `query ${JSON.stringify(query)} must find the record`).toBeVisible({ timeout: 20_000 });
      await expect(link).toHaveCount(1);
    }
    for (const query of [legalFamily, legalFamily.replace("-", " "), `Nowak${run}`, `margaret anne`, "nobody-by-this-name"]) {
      await submit(query);
      await expect(link, `query ${JSON.stringify(query)} must NOT find the record`).toHaveCount(0, { timeout: 20_000 });
    }
  });

  await test.step("the calendar appointment page shows the preferred name", async () => {
    const practitionerId = await getOwnerPractitionerId(seed.studioId);
    const start = new Date(Date.now() + 36 * 3600_000);
    const end = new Date(start.getTime() + 3600_000);
    const apptId = await seedConfirmedAppointment(seed.studioId, practitionerId, clientId, start.toISOString(), end.toISOString());
    await page.goto(`/calendar/${apptId}`);
    await expect(page.getByRole("link", { name: preferred }).first()).toBeVisible({ timeout: 20_000 });
  });

  await test.step("the clinical-notes print carries the legal name with the preferred name in parentheses", async () => {
    await page.goto(`/clients/${clientId}/clinical-notes/print`);
    await expect(
      page.getByRole("heading", { level: 1, name: `Clinical notes: Margaret Anne ${legalFamily} (${preferred})` }),
    ).toBeVisible({ timeout: 20_000 });
  });

  await test.step("an active non-owner practitioner of the same studio sees the same identity", async () => {
    const member = await seedE2eMember(seed);
    const ctx = await browser.newContext();
    const memberPage = await ctx.newPage();
    try {
      await loginByMagicLink(memberPage, member.email);
      await memberPage.goto(`/clients/${clientId}`);
      await expect(memberPage.getByRole("heading", { level: 1, name: preferred })).toBeVisible({ timeout: 20_000 });
      await expect(memberPage.getByText(`Legal name: Margaret Anne ${legalFamily}`)).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  await test.step("another studio's owner finds nothing by either name and cannot open the client", async () => {
    const other = await seedE2eStudio();
    const ctx = await browser.newContext();
    const otherPage = await ctx.newPage();
    try {
      await loginAsOwner(otherPage, other);
      await otherPage.goto("/clients");
      const search = otherPage.getByRole("searchbox", { name: "Search clients" });
      await expect(search).toBeVisible({ timeout: 20_000 });
      for (const query of [preferred, legalFamily]) {
        await search.fill(query);
        await search.press("Enter");
        await expect(otherPage).toHaveURL(/[?&]q=/, { timeout: 20_000 });
        await expect(otherPage.locator(`a[href="/clients/${clientId}"]`)).toHaveCount(0);
      }
      const response = await otherPage.goto(`/clients/${clientId}`);
      expect(response?.status()).toBe(404);
      const rows = await sql<{ n: string }>(`select count(*)::text n from public.client_legal_identities where studio_id = $1`, [other.studioId]);
      expect(rows[0].n).toBe("0");
    } finally {
      await ctx.close();
    }
  });
});
