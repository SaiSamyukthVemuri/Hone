import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// DAT-002 (E-GAPS). "Dashboard database errors are displayed as zero activity."
//
// #981 and #1095 made the dashboard, /records and global search refuse a failed
// read instead of rendering it as 0 or as an empty list. Both were proved with
// fakes. This spec forces a REAL read failure on the disposable local stack (a
// revoked SELECT grant for `authenticated`, the role every signed-in read runs
// as) and drives the real pages in a real browser.
//
// Each case first proves the healthy rendering for the SAME studio (the
// control), so a refusal cannot pass by the page simply never loading, and an
// empty-but-healthy studio shows exactly the empty copy the refusal must never
// be confused with.
//
// THE GRANT IS ALWAYS RESTORED. The lane runs one worker, serially, against one
// stack, so a leaked revoke would break every later spec in the shard. Each
// revoke is inside try/finally, the restore re-reads the privilege and fails
// loudly if it did not come back, and afterAll restores again. GRANT/REVOKE
// change neither the migration history nor pg_class, so the global-teardown
// schema fingerprint is unaffected.

const TABLES = ["payment_charge_attempts", "record_keeping_sterile_items", "clients"] as const;
type Table = (typeof TABLES)[number];

async function selectHeld(table: Table): Promise<boolean> {
  const [row] = await sql<{ held: boolean }>(
    "select has_table_privilege('authenticated', $1, 'SELECT') as held",
    [`public.${table}`],
  );
  return row.held;
}

async function restore(table: Table): Promise<void> {
  await sql(`grant select on table public.${table} to authenticated`);
  if (!(await selectHeld(table))) {
    throw new Error(`DAT-002 spec could not restore SELECT on public.${table} for authenticated`);
  }
}

async function withSelectRevoked(table: Table, body: () => Promise<void>): Promise<void> {
  // Non-vacuity: the grant must exist before it can be taken away.
  expect(await selectHeld(table)).toBe(true);
  await sql(`revoke select on table public.${table} from authenticated`);
  try {
    expect(await selectHeld(table)).toBe(false);
    await body();
  } finally {
    await restore(table);
  }
}

function boundary(page: Page) {
  return page.getByTestId("route-error-boundary");
}

function searchInput(page: Page) {
  return page.locator('input[type="search"][aria-label="Search Hone"]:visible');
}

let seed: E2eSeed;
// seedE2eStudio carries a client NAME for booking flows but inserts no client
// row, so the search case seeds its own synthetic client.
let searchName = "";

test.beforeAll(async () => {
  // A crash in an earlier attempt of this spec must not leave a revoke behind.
  for (const t of TABLES) if (!(await selectHeld(t))) await restore(t);
  seed = await seedE2eStudio();
  searchName = `DAT002 Searchable ${seed.runId}`;
  await sql("insert into public.clients (studio_id, name) values ($1, $2)", [seed.studioId, searchName]);
});

test.afterAll(async () => {
  for (const t of TABLES) if (!(await selectHeld(t))) await restore(t);
});

test.describe("DAT-002: a failed read is refused, never shown as 0 or empty", () => {
  test("dashboard: a failed practice-metrics read shows the refusal, not a zero snapshot", async ({ page }) => {
    await loginAsOwner(page, seed);

    // Control: healthy, the snapshot renders.
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Practice snapshot" })).toBeVisible({ timeout: 30_000 });
    await expect(boundary(page)).toHaveCount(0);

    await withSelectRevoked("payment_charge_attempts", async () => {
      await page.goto("/dashboard");
      await expect(boundary(page)).toBeVisible({ timeout: 30_000 });
      await expect(boundary(page).getByRole("heading", { name: "Something went wrong", level: 1 })).toBeVisible();
      await expect(boundary(page)).toContainText("Hone could not finish loading this page.");
      // Not a zero snapshot, and no database text on screen.
      await expect(page.getByRole("heading", { name: "Practice snapshot" })).toHaveCount(0);
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/permission denied|payment_charge_attempts|PGRST|42501/i);
    });
  });

  test("records: a failed sterile-items read shows 'could not be loaded', not 'no records'", async ({ page }) => {
    await loginAsOwner(page, seed);

    // Control: a healthy studio with no sterile items shows the EMPTY copy.
    await page.goto("/records?section=sterile");
    await expect(page.getByRole("heading", { name: "Record Keeping" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("No sterile item records yet.")).toBeVisible();
    await expect(page.getByTestId("records-section-unavailable")).toHaveCount(0);

    await withSelectRevoked("record_keeping_sterile_items", async () => {
      await page.goto("/records?section=sterile");
      await expect(page.getByRole("heading", { name: "Record Keeping" })).toBeVisible({ timeout: 30_000 });
      const unavailable = page.getByTestId("records-section-unavailable");
      await expect(unavailable).toBeVisible();
      await expect(unavailable).toContainText("This section could not be loaded.");
      await expect(page.getByText("No sterile item records yet.")).toHaveCount(0);
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/permission denied|record_keeping_sterile_items|PGRST|42501/i);
    });
  });

  test("search: a failed client read shows 'could not be loaded', not 'no results'", async ({ page }) => {
    await loginAsOwner(page, seed);
    // Any authenticated page carries the shell search; /records reads no
    // clients itself, so the page stays healthy while the grant is gone.
    await page.goto("/records?section=sterile");
    await expect(page.getByRole("heading", { name: "Record Keeping" })).toBeVisible({ timeout: 30_000 });

    // Control: the seeded client is found.
    await searchInput(page).fill(searchName);
    await expect(page.getByText(searchName).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Search could not be loaded.")).toHaveCount(0);
    await searchInput(page).fill("");

    await withSelectRevoked("clients", async () => {
      await searchInput(page).fill(searchName);
      await expect(page.getByText("Search could not be loaded.")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("No results found.")).toHaveCount(0);
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/permission denied|PGRST|42501/i);
    });
  });
});
