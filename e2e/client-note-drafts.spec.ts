import { test, expect, type Page, type BrowserContext } from "@playwright/test";

import { E2E_NOTE_DRAFTS_STUDIO_ID } from "./helpers/local-env";
import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-130: autosaved note drafts, in a real browser. Autosave is OFF except for the ONE synthetic studio this spec seeds
// (E2E_NOTE_DRAFTS_STUDIO_ID, enabled in the app server's env AND in the database allow-list below). Synthetic data only.
//   * type in each of the three note types, open another section at once, come back and refresh: the latest text is there, no Save pressed;
//   * a failed save keeps the text and says so, Retry saves; a lost response retried is NOT a conflict;
//   * switching clients never lands text in the other client; two tabs conflict instead of overwriting;
//   * saving the real note clears the draft.
test.describe.configure({ mode: "serial" });

const T = 20_000;
let seed: E2eSeed;
let clientId: string;
let otherClientId: string;

test.beforeAll(async () => {
  // The studio id is FIXED (the app server's env names it), so a re-run on the same stack reuses the studio that is already there.
  const existing = await sql<{ owner_email: string; name: string }>(`select owner_email, name from public.studios where id = $1`, [E2E_NOTE_DRAFTS_STUDIO_ID]);
  if (existing.length === 1) {
    seed = { studioId: E2E_NOTE_DRAFTS_STUDIO_ID, ownerEmail: existing[0].owner_email, studioName: existing[0].name, runId: "rerun", slug: "", serviceName: "", clientName: "", clientEmail: "" } as E2eSeed;
  } else {
    seed = await seedE2eStudio(E2E_NOTE_DRAFTS_STUDIO_ID);
  }
  await sql(`insert into public.client_note_draft_enabled_studios (studio_id) values ($1) on conflict do nothing`, [E2E_NOTE_DRAFTS_STUDIO_ID]);
  const tag = Math.random().toString(36).slice(2, 8);
  const rows = await sql<{ id: string }>(
    `insert into public.clients (id, studio_id, name, email) values (gen_random_uuid(), $1, $2, $3), (gen_random_uuid(), $1, $4, $5) returning id`,
    [seed.studioId, `Synthetic Draft ${tag}`, `draft-${tag}@harness.local`, `Synthetic Other ${tag}`, `other-${tag}@harness.local`],
  );
  clientId = rows[0].id;
  otherClientId = rows[1].id;
});

const treatment = (id: string) => `/clients/${id}?tab=treatment`;
const card = (page: Page, heading: string) => page.locator("section", { has: page.getByRole("heading", { name: heading }) });

async function openNoteForm(page: Page, heading: string) {
  const c = card(page, heading);
  await c.getByRole("button", { name: "Add note" }).click();
  return c.locator("textarea[name=body]");
}

async function login(page: Page) {
  await loginAsOwner(page, seed);
}

test("each note type keeps the latest text across a section switch and a refresh, without pressing Save", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  await page.goto(treatment(clientId));
  for (const [heading, text] of [
    ["Consultation notes", "consult draft text"],
    ["Skin & hair analysis", "skin draft text"],
  ] as const) {
    const box = await openNoteForm(page, heading);
    await box.fill(text);
    await expect(card(page, heading).getByText(/Draft saved \d\d:\d\d/)).toBeVisible({ timeout: T });
  }
  const budget = page.locator("#client-budget-notes");
  await budget.fill("budget draft text");
  await expect(page.locator("form", { has: page.locator("#client-budget-notes") }).getByText(/Draft saved \d\d:\d\d/)).toBeVisible({ timeout: T });

  // Open another section at once, come back, refresh.
  await page.goto(`/clients/${clientId}?tab=overview`);
  await page.goto(treatment(clientId));
  await page.reload();
  await expect(card(page, "Consultation notes").locator("textarea[name=body]")).toHaveValue("consult draft text", { timeout: T });
  await expect(card(page, "Skin & hair analysis").locator("textarea[name=body]")).toHaveValue("skin draft text", { timeout: T });
  await expect(page.locator("#client-budget-notes")).toHaveValue("budget draft text", { timeout: T });
  await expect(page.getByText(/Draft restored \(saved \d\d:\d\d\)/).first()).toBeVisible();
});

test("a budget chip is a draft change: tap, switch away, come back, refresh, and it is still pressed without Save", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto(treatment(clientId));
  const form = page.locator("form", { has: page.locator("#client-budget-notes") });
  const chip = form.getByRole("button", { name: /^somewhat limited$/i });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(form.getByText(/Draft saved \d\d:\d\d/)).toBeVisible({ timeout: T });
  await page.goto(`/clients/${clientId}?tab=overview`);
  await page.goto(treatment(clientId));
  await page.reload();
  await expect(page.locator("form", { has: page.locator("#client-budget-notes") }).getByRole("button", { name: /^somewhat limited$/i })).toHaveAttribute("aria-pressed", "true", { timeout: T });
  await expect(page.getByText(/Draft restored \(saved \d\d:\d\d\)/).first()).toBeVisible();
});

test("a failed save keeps the text and says so; Retry saves", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto(treatment(clientId));
  // A restored draft from the previous test: discard it and wait until the discard has finished (it resets the form after the server answers).
  const restoredBanner = card(page, "Consultation notes").getByText(/Draft restored/);
  if (await restoredBanner.first().isVisible().catch(() => false)) {
    await card(page, "Consultation notes").getByRole("button", { name: "Discard draft" }).click();
    await expect(restoredBanner).toHaveCount(0, { timeout: T });
  }
  const box = card(page, "Consultation notes").locator("textarea[name=body]");
  if (!(await box.isVisible().catch(() => false))) await openNoteForm(page, "Consultation notes");
  let failing = true;
  await page.route("**/clients/**", async (route) => {
    if (failing && route.request().method() === "POST") return route.abort();
    return route.continue();
  });
  await box.fill("typed while offline");
  await expect(page.getByText("Couldn't save the draft. Your text is still here.").first()).toBeVisible({ timeout: T });
  await expect(box).toHaveValue("typed while offline");
  failing = false;
  await page.getByRole("button", { name: "Retry" }).first().click();
  await expect(page.getByText(/Draft saved \d\d:\d\d/).first()).toBeVisible({ timeout: T });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a lost response is retried without a false conflict", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto(treatment(clientId));
  const box = card(page, "Skin & hair analysis").locator("textarea[name=body]");
  if (!(await box.isVisible().catch(() => false))) await openNoteForm(page, "Skin & hair analysis");
  let dropped = false;
  await page.route("**/clients/**", async (route) => {
    if (!dropped && route.request().method() === "POST") {
      dropped = true;
      await route.fetch(); // the write reaches the server...
      return route.abort(); // ...but the response is lost
    }
    return route.continue();
  });
  await box.fill(`lost response ${Date.now()}`);
  await expect(page.getByText(/Draft saved \d\d:\d\d/).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Another window changed this draft.")).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("switching clients never lands text in the other client", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto(treatment(clientId));
  const box = card(page, "Consultation notes").locator("textarea[name=body]");
  if (!(await box.isVisible().catch(() => false))) await openNoteForm(page, "Consultation notes");
  await box.fill("belongs to the first client");
  await page.goto(treatment(otherClientId)); // leaves at once, before the debounce
  await expect(card(page, "Consultation notes")).toBeVisible({ timeout: T });
  await expect(page.locator("textarea[name=body]")).toHaveCount(0); // no draft restored here
  const other = await sql<{ n: string }>(`select count(*)::text as n from public.client_note_drafts where client_id = $1`, [otherClientId]);
  expect(other[0].n, "nothing was stored under the other client").toBe("0");
  const mine = await sql<{ n: string }>(`select count(*)::text as n from public.client_note_drafts where client_id = $1 and kind = 'consultation'`, [clientId]);
  expect(Number(mine[0].n)).toBeGreaterThanOrEqual(1);
});

test("two tabs: the second tab's older draft conflicts instead of overwriting; Keep mine then saves", async ({ browser }) => {
  test.setTimeout(150_000);
  const ctx: BrowserContext = await browser.newContext();
  const a = await ctx.newPage();
  await login(a);
  await a.goto(treatment(clientId));
  const b = await ctx.newPage();
  await b.goto(treatment(clientId));
  const boxA = card(a, "Consultation notes").locator("textarea[name=body]");
  const boxB = card(b, "Consultation notes").locator("textarea[name=body]");
  if (!(await boxA.isVisible().catch(() => false))) await openNoteForm(a, "Consultation notes");
  await boxA.fill(`from tab A ${Date.now()}`);
  await expect(a.getByText(/Draft saved \d\d:\d\d/).first()).toBeVisible({ timeout: T });
  if (!(await boxB.isVisible().catch(() => false))) await openNoteForm(b, "Consultation notes");
  await boxB.fill("from tab B, older view");
  await expect(b.getByText("Another window changed this draft.")).toBeVisible({ timeout: T });
  await expect(boxB).toHaveValue("from tab B, older view"); // never reset
  await b.getByRole("button", { name: "Keep mine" }).click();
  await expect(b.getByText(/Draft saved \d\d:\d\d/).first()).toBeVisible({ timeout: T });
  await ctx.close();
});

test("saving the real note clears the draft: nothing is restored afterwards and no draft text remains", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto(treatment(clientId));
  const box = card(page, "Consultation notes").locator("textarea[name=body]");
  if (!(await box.isVisible().catch(() => false))) await openNoteForm(page, "Consultation notes");
  const text = `final note ${Date.now()}`;
  await box.fill(text);
  await expect(page.getByText(/Draft saved \d\d:\d\d/).first()).toBeVisible({ timeout: T });
  await card(page, "Consultation notes").getByRole("button", { name: "Save note" }).click();
  // The editor closes only after the save returned (a textarea can also match getByText on its own value, so wait on it closing).
  await expect(card(page, "Consultation notes").locator("textarea[name=body]")).toHaveCount(0, { timeout: T });
  await expect(card(page, "Consultation notes").getByText(text).first()).toBeVisible({ timeout: T });
  const left = await sql<{ live: string }>(
    `select count(*) filter (where fields is not null)::text as live from public.client_note_drafts where client_id = $1 and kind = 'consultation' and practitioner_id is not null`,
    [clientId],
  );
  expect(left[0].live).toBe("0");
  await page.reload();
  await expect(card(page, "Consultation notes").getByText(/Draft restored/)).toHaveCount(0);
});
