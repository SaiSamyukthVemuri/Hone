import { test, expect } from "@playwright/test";
import { seedE2eStudio, seedE2eMember, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { shot } from "./helpers/settings-shots";

// WS-E · settings redesign verification, part 2: the studio-wide display
// preferences (time format, birthday colour) under Calendar.
// Sam's ruling for the first release: OWNER-ONLY, labelled exactly
// "Applies to the whole studio.", enforced on the server, no "default view".
// A practitioner has no control, and a DIRECT call to the save action (replayed
// from the owner's own request with the practitioner's session) is refused and
// changes nothing, read back from the database. Synthetic studio only.

const T = 20_000;
const REFUSAL = "Only studio owners can change studio display preferences.";

let seed: E2eSeed;
let member: Awaited<ReturnType<typeof seedE2eMember>>;

async function prefs() {
  const rows = await sql<{ c: string; t: string | null }>(
    `select birthday_reminder_color c, time_format_preference t from public.studios where id = $1`,
    [seed.studioId],
  );
  return { color: rows[0].c, time: rows[0].t };
}

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  member = await seedE2eMember(seed);
});

test("owner sees the exact studio-wide label, no 'default view', and saves both preferences", async ({ page }) => {
  await loginAsOwner(page, seed);
  await page.goto("/settings/calendar");
  await expect(page.getByRole("heading", { name: "Display preferences" })).toBeVisible({ timeout: T });
  await expect(page.getByText("Applies to the whole studio.", { exact: true })).toBeVisible();
  await expect(page.getByText(/default view/i)).toHaveCount(0);
  await shot(page, "owner-calendar-display-prefs");

  const before = await prefs();
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save, "nothing to save until something changes").toBeDisabled();
  await page.getByRole("button", { name: /24-hour/ }).click();
  await page.getByRole("button", { name: "Green" }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: T });
  const after = await prefs();
  expect(after).toEqual({ color: "green", time: "24h" });
  expect(after).not.toEqual(before);

  await page.reload();
  await expect(page.getByRole("button", { name: /24-hour/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Green" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("a practitioner has no control, and a direct action call is refused and changes nothing", async ({ browser, page }) => {
  await loginAsOwner(page, seed);
  await page.goto("/settings/calendar");
  await expect(page.getByRole("heading", { name: "Display preferences" })).toBeVisible({ timeout: T });

  // Capture the owner's real save request so it can be replayed verbatim.
  const captured = new Promise<{ action: string; contentType: string; body: string }>((resolve) => {
    page.on("request", (req) => {
      const h = req.headers();
      if (req.method() === "POST" && h["next-action"]) {
        resolve({ action: h["next-action"], contentType: h["content-type"] ?? "", body: req.postData() ?? "" });
      }
    });
  });
  await page.getByRole("button", { name: /12-hour/ }).click();
  await page.getByRole("button", { name: "Purple" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const req = await captured;
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: T });
  const ownerState = await prefs();
  expect(ownerState).toEqual({ color: "purple", time: "12h" });

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await loginByMagicLink(p, member.email);

  // No control: the page sends a practitioner to Profile, and nothing on it names the preference.
  await p.goto("/settings/calendar");
  await expect(p).toHaveURL(/\/settings\/profile/, { timeout: T });
  await expect(p.getByText("Applies to the whole studio.")).toHaveCount(0);
  await expect(p.getByRole("button", { name: /24-hour/ })).toHaveCount(0);

  // Replay with a CHANGED payload where the owner's was: flip the values in the body.
  const flipped = req.body.replace("purple", "orange").replace("12h", "24h");
  expect(flipped, "the replayed body differs from the owner's").not.toBe(req.body);
  const res = await p.request.post("/settings/profile", {
    headers: { "next-action": req.action, "content-type": req.contentType },
    data: flipped,
  });
  const text = await res.text();
  expect(text, "the action answers with its own refusal").toContain(REFUSAL);
  expect(await prefs(), "nothing changed").toEqual(ownerState);

  // Positive control: the very same replay with the owner's session DOES change it.
  const ownerRes = await page.request.post("/settings/calendar", {
    headers: { "next-action": req.action, "content-type": req.contentType },
    data: flipped,
  });
  expect(await ownerRes.text()).not.toContain(REFUSAL);
  expect(await prefs()).toEqual({ color: "orange", time: "24h" });
  await ctx.close();
});

test("the owner's settings payload carries the preference and a practitioner's never does", async ({ browser, page }) => {
  await loginAsOwner(page, seed);
  const ownerBody = await (await page.request.get("/settings/calendar")).text();
  expect(ownerBody).toContain("Applies to the whole studio.");
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await loginByMagicLink(p, member.email);
  for (const path of ["/settings/profile", "/settings/calendar", "/settings/intake"]) {
    for (const headers of [{}, { RSC: "1" }] as Array<Record<string, string>>) {
      const body = await (await p.request.get(path, { headers })).text();
      expect(body, `${path} ${JSON.stringify(headers)}`).not.toContain("Applies to the whole studio.");
      expect(body).not.toContain("birthday_reminder_color");
    }
  }
  await ctx.close();
});
