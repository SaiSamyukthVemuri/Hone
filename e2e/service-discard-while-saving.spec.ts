import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, getE2eServiceId, getServiceCalendarColor } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { SERVICE_COLOR_KEYS } from "../lib/calendar/service-colors";

// Codex finding on #1777: while "Saving…" shows, "Discard edits" for that service must be unavailable until the save settles; a refused save keeps the draft
// and lets the owner retry or discard; a newer edit must never be erased and the mobile editor must not close under the owner. The save is DELAYED at the
// network (a Next server action POST) so the in-flight window is long enough to act in. Viewports and rotation are EMULATION (no physical devices).

type Held = { release: () => void; fail: () => void; count: () => number };

// Holds every server-action POST (the Save) until the test lets it go or fails it, and counts them.
async function holdSaves(page: Page): Promise<Held> {
  let posts = 0;
  let decision: "go" | "fail" | null = null;
  await page.route(/\/settings\/services/, async (route) => {
    const req = route.request();
    if (req.method() !== "POST" || !req.headers()["next-action"]) return route.continue();
    posts += 1;
    const until = async () => { while (decision === null) await new Promise((r) => setTimeout(r, 50)); };
    await until();
    const d = decision;
    decision = null;
    if (d === "fail") return route.abort("failed");
    return route.continue();
  });
  return { release: () => { decision = "go"; }, fail: () => { decision = "fail"; }, count: () => posts };
}

async function noSidewaysScroll(page: Page, label: string) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, `${label}: no horizontal overflow (${w.s} vs ${w.c})`).toBeLessThanOrEqual(w.c);
}

async function openEditor(page: Page, serviceId: string, serviceName: string) {
  await page.goto("/settings/services");
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId(`service-row-${serviceId}`).getByRole("button", { name: `Edit ${serviceName}`, exact: true }).click();
  return page.getByRole("form", { name: `Edit ${serviceName}`, exact: true });
}

test("desktop: Violet with a delayed save: discard and a second submit are inert, success persists across reload; a refused save keeps the draft", async ({ page }) => {
  const seed = await seedE2eStudio();
  const serviceId = await getE2eServiceId(seed.studioId);
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAsOwner(page, seed);
  const held = await holdSaves(page);
  const editor = await openEditor(page, serviceId, seed.serviceName);
  const discard = page.getByTestId(`discard-edits-${serviceId}`);
  const save = editor.getByRole("button", { name: /^(Save( changes| service)?|Saving…)$/i });

  // success path
  const violet = editor.getByRole("button", { name: "Calendar color: violet" });
  await violet.click();
  await expect(violet).toHaveAttribute("aria-pressed", "true");
  await expect(discard).toBeEnabled();
  await save.click();
  await expect(editor).toHaveAttribute("aria-busy", "true");
  await expect(discard).toBeDisabled();
  await discard.click({ force: true, timeout: 2_000 }).catch(() => {});      // inert: a disabled control swallows the click
  await save.click({ force: true, timeout: 2_000 }).catch(() => {});         // a second submit is ignored too
  await expect.poll(() => held.count()).toBe(1);
  await expect(page.locator("p[role=status]").filter({ hasText: /discarded/i })).toHaveCount(0);
  await expect(violet).toHaveAttribute("aria-pressed", "true");               // the draft survived the clicks
  held.release();
  await expect(page.locator("p[role=status]")).toContainText(/Service changes saved/i, { timeout: 20_000 });
  await expect.poll(() => getServiceCalendarColor(serviceId), { timeout: 15_000 }).toBe("violet");
  expect(held.count()).toBe(1);

  // reload shows the saved colour
  await page.reload();
  const again = await openEditor(page, serviceId, seed.serviceName);
  await expect(again.getByRole("button", { name: "Calendar color: violet" })).toHaveAttribute("aria-pressed", "true");

  // refused save: the draft stays, Discard works again, retry works
  const other = SERVICE_COLOR_KEYS.find((k) => k !== "violet")!;
  const swatch = again.getByRole("button", { name: `Calendar color: ${other}` });
  await swatch.click();
  await expect(swatch).toHaveAttribute("aria-pressed", "true");
  await again.getByRole("button", { name: /^Save( changes| service)?$/i }).click();
  await expect(discard).toBeDisabled();
  held.fail();
  await expect(again.getByRole("alert")).toContainText(/Couldn.t save this service/i, { timeout: 20_000 });
  await expect(swatch).toHaveAttribute("aria-pressed", "true");               // the draft is still there
  await expect(discard).toBeEnabled();
  expect(await getServiceCalendarColor(serviceId)).toBe("violet");            // nothing was saved
  await again.getByRole("button", { name: /^Save( changes| service)?$/i }).click();
  held.release();
  await expect.poll(() => getServiceCalendarColor(serviceId), { timeout: 15_000 }).toBe(other);
  await page.reload();
  const last = await openEditor(page, serviceId, seed.serviceName);
  await expect(last.getByRole("button", { name: `Calendar color: ${other}` })).toHaveAttribute("aria-pressed", "true");
});

test("phone (emulated): a pending save survives rotation, the editor stays open, discard is inert, all ten colours and Save stay reachable with no sideways scroll", async ({ browser }) => {
  const seed = await seedE2eStudio();
  const serviceId = await getE2eServiceId(seed.studioId);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
  try {
    const page = await ctx.newPage();
    await loginAsOwner(page, seed);
    const held = await holdSaves(page);
    const editor = await openEditor(page, serviceId, seed.serviceName);
    expect(SERVICE_COLOR_KEYS).toHaveLength(10);
    const save = editor.getByRole("button", { name: /^(Save( changes| service)?|Saving…)$/i });
    for (const [w, h] of [[390, 844], [844, 390], [320, 568]]) {
      await page.setViewportSize({ width: w, height: h });
      for (const key of SERVICE_COLOR_KEYS) {
        const sw = editor.getByRole("button", { name: `Calendar color: ${key}`, exact: true });
        await sw.scrollIntoViewIfNeeded();
        await expect(sw, `${key} at ${w}x${h}`).toBeInViewport();
      }
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      await noSidewaysScroll(page, `service editor at ${w}x${h}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const violet = editor.getByRole("button", { name: "Calendar color: violet" });
    await violet.tap();
    await editor.getByRole("button", { name: /^Save( changes| service)?$/i }).tap();
    const discard = page.getByTestId(`discard-edits-${serviceId}`);
    await expect(discard).toBeDisabled();
    await page.setViewportSize({ width: 844, height: 390 });                 // rotate with the save in flight
    await expect(editor).toBeVisible();                                      // the editor did not close
    await expect(discard).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(editor).toBeVisible();
    await expect(violet).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => held.count()).toBe(1);
    held.release();
    await expect.poll(() => getServiceCalendarColor(serviceId), { timeout: 20_000 }).toBe("violet");
    await page.reload();
    const again = await openEditor(page, serviceId, seed.serviceName);
    await expect(again.getByRole("button", { name: "Calendar color: violet" })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await ctx.close();
  }
});
