import { test, expect, type Page } from "@playwright/test";

import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-109 (Codex P2 x2 on #1832): the Period and Team member selects must always show what the figures use. They are uncontrolled, and the same bug
// came back once per control (series toggle, then sort / chip / page), so the fix is the mechanism: PendingGetForm remounts on EVERY change of the
// applied address. This loops over every kind of navigation Clients offers and proves each one resets an unsubmitted edit.
const T = 30_000;
const CLIENTS = 30; // one more page than CLIENTS_PAGE_SIZE (25), so the page links exist

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function seedClientsSeen(seed: E2eSeed) {
  await sql(
    `with p as (select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1),
          c as (insert into public.clients (id, studio_id, name, email)
                  select gen_random_uuid(), $1, 'Applied Filter ' || lpad(n::text, 2, '0'), 'applied-' || n || '-' || $2 || '@harness.local' from generate_series(1, $3::int) n returning id, name),
          a as (insert into public.appointments (id, studio_id, client_id, practitioner_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
                  select gen_random_uuid(), $1, c.id, (select id from p),
                         date_trunc('day', now()) - make_interval(days => (row_number() over (order by c.name))::int) + interval '14 hours',
                         date_trunc('day', now()) - make_interval(days => (row_number() over (order by c.name))::int) + interval '15 hours', 60, 0,
                         date_trunc('day', now()) - make_interval(days => (row_number() over (order by c.name))::int) + interval '15 hours', 'completed'
                    from c returning id, client_id, practitioner_id, starts_at)
     insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, appointment_id, started_at)
       select gen_random_uuid(), $1, a.client_id, a.practitioner_id, 'electrolysis', a.id, a.starts_at from a`,
    [seed.studioId, seed.runId, CLIENTS],
  );
}

const period = (page: Page) => page.locator('main select[name="period"]');
const member = (page: Page) => page.locator('main select[name="practitioner"]');

test.describe("HON-109 filters always show what is applied", () => {
  test("every navigation kind on Clients resets an unsubmitted Period / Team member edit", async ({ page }) => {
    test.setTimeout(240_000);
    const seed = await seedE2eStudio();
    await seedClientsSeen(seed);
    await loginAsOwner(page, seed);
    const base = `/financials/analytics/clients?period=custom&from=${day(-60)}&to=${day(0)}`;
    await page.goto(base);
    await expect(period(page)).toHaveValue("custom", { timeout: T });
    await expect(member(page)).toHaveValue("all");

    async function editThen(kind: string, navigate: () => Promise<void>, expectUrl: (u: URL) => boolean) {
      await period(page).selectOption("previous_month");
      await member(page).selectOption("unattributed");
      expect(await period(page).inputValue(), `${kind}: the edit is showing before the navigation`).toBe("previous_month");
      await navigate();
      await expect(page).toHaveURL((u) => expectUrl(new URL(u)), { timeout: T });
      await expect(period(page), `${kind}: Period shows the APPLIED value again`).toHaveValue("custom", { timeout: T });
      await expect(member(page), `${kind}: Team member shows the APPLIED value again`).toHaveValue("all", { timeout: T });
    }

    await editThen("sort header", () => page.locator('main thead a[href*="sort="]').first().click(), (u) => u.searchParams.has("sort"));
    await editThen("chip", () => page.locator('nav[aria-label="Filter clients"] a[href*="chip="]').first().click(), (u) => u.searchParams.has("chip"));
    await editThen("next page", () => page.locator('nav[aria-label="Pages"] a[rel="next"]').click(), (u) => u.searchParams.get("page") === "2");
    await editThen("previous page", () => page.locator('nav[aria-label="Pages"] a[rel="prev"]').click(), (u) => (u.searchParams.get("page") ?? "1") === "1");
    await editThen("browser Back", async () => { await page.goBack(); }, (u) => u.searchParams.get("page") === "2");
  });
});
