import { test, expect, type Browser, type Page } from "@playwright/test";
import { seedE2eStudio, seedE2eMember, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { R2_SEQUENCE, clickRail, observe, isMobile, type Observation } from "./helpers/settings-r2";

// Settings R2 (HON-68) behaviours, asserted on the exact click sequence at desktop
// 1280 and mobile 390. Each assertion states the requirement it proves. These are
// expected RED on production bc01ab05 (that is the BEFORE state) and GREEN on a
// candidate that meets R2. Synthetic studio only; never marks anything accepted.

const T = 20_000;
let seed: E2eSeed;
let member: Awaited<ReturnType<typeof seedE2eMember>>;

/** Headings each step must show, and headings of its neighbours it must NOT show. */
const CONTENT: Record<string, { own: RegExp; never: RegExp[] }> = {
  "02-personal-details": { own: /personal details|profile/i, never: [] },
  "04-display-preferences": { own: /display preferences/i, never: [] },
  "05-studio-details": { own: /^studio( details)?$/i, never: [/email notifications/i, /text.?message/i, /client self-service/i] },
  "06-email-notifications": { own: /email notifications/i, never: [/studio details/i, /text.?message/i, /client self-service/i] },
  "07-text-messages": { own: /text.?message/i, never: [/studio details/i, /email notifications/i, /client self-service/i] },
  "08-client-self-service": { own: /client self-service/i, never: [/studio details/i, /email notifications/i, /text.?message/i] },
  "09-postcare": { own: /postcare/i, never: [/intake form preview/i, /cancellation/i] },
  "10-intake-form-preview": { own: /intake form preview/i, never: [/^postcare$/i, /cancellation/i] },
  "11-cancellation-policy": { own: /cancellation/i, never: [/^postcare$/i, /intake form preview/i] },
};

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  member = await seedE2eMember(seed);
});

async function walk(page: Page): Promise<Observation[]> {
  await page.goto("/settings/profile");
  const rows: Observation[] = [];
  for (const step of R2_SEQUENCE) {
    await clickRail(page, step.entry, step.section);
    rows.push(await observe(page, step.id));
  }
  return rows;
}

for (const width of [1280, 390]) {
  test.describe(`R2 at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });

    test("each menu item opens a focused view at the top of its section: no hash jump, heading visible, not under fixed chrome", async ({ page }) => {
      await loginAsOwner(page, seed);
      const rows = await walk(page);
      for (const r of rows) {
        expect(r.hash, `${r.step}: no anchor jump in the URL`).toBe("");
        expect(r.firstHeadingTop, `${r.step}: a heading is on screen`).not.toBeNull();
        expect(r.headingUnderFixedChrome, `${r.step}: heading not hidden under fixed chrome`).toBe(false);
        expect(r.firstHeadingTop!, `${r.step}: heading in the viewport (not scrolled past)`).toBeGreaterThanOrEqual(0);
        expect(r.firstHeadingTop!, `${r.step}: heading in the top half of the viewport`).toBeLessThan(r.viewportHeight / 2);
        expect(r.scrollY, `${r.step}: entered at the top, no delayed programmatic scroll`).toBeLessThanOrEqual(8);
      }
    });

    test("each view shows only its own content", async ({ page }) => {
      await loginAsOwner(page, seed);
      const rows = await walk(page);
      for (const r of rows) {
        const rule = CONTENT[r.step];
        if (!rule) continue;
        const heads = r.mainHeadings.map((h) => h.text);
        expect(heads.some((h) => rule.own.test(h)), `${r.step}: shows its own heading (${heads.join(" | ")})`).toBe(true);
        for (const never of rule.never) {
          expect(heads.some((h) => never.test(h)), `${r.step}: must not also show ${never} (${heads.join(" | ")})`).toBe(false);
        }
      }
    });

    test("opening a group closes the previous one; the active group stays open", async ({ page }) => {
      await loginAsOwner(page, seed);
      const rows = await walk(page);
      for (const r of rows) {
        expect(r.openGroups.length, `${r.step}: at most one group open (${r.openGroups.join(", ")})`).toBeLessThanOrEqual(1);
      }
      const calendar = rows.find((r) => r.step === "04-display-preferences")!;
      expect(calendar.openGroups, "Profile closed when Calendar opened").not.toContain("Profile");
    });

    test("navigation stays reachable without scrolling to the top", async ({ page }) => {
      await loginAsOwner(page, seed);
      await walk(page);
      for (const [path, label] of [["/settings/intake", "long page"], ["/settings/studio", "studio page"]] as const) {
        await page.goto(path);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(300);
        const o = await observe(page, `reach-${label}`);
        if (isMobile(page)) {
          expect(o.menuButton?.inViewport, `${label}: the menu button is on screen after scrolling to the bottom`).toBe(true);
        } else {
          expect(o.railInViewport, `${label}: the rail is on screen after scrolling to the bottom`).toBe(true);
        }
      }
    });

    test("keyboard focus lands on the section heading or the menu, never in a field", async ({ page }) => {
      await loginAsOwner(page, seed);
      const rows = await walk(page);
      for (const r of rows) {
        expect(r.focus.isField, `${r.step}: focus is not in a form field (${r.focus.tag})`).toBe(false);
        expect(r.focus.tag, `${r.step}: focus is on a real element, not the document body`).not.toBe("BODY");
      }
    });

    test("Back, Forward and direct links reproduce each view; old hash links redirect to focused routes", async ({ page, browser }) => {
      await loginAsOwner(page, seed);
      const rows = await walk(page);
      // Back/forward over the last three steps.
      const urls = rows.map((r) => r.url);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${urls[urls.length - 2].replace(/[?]/g, "\\?")}$`), { timeout: T });
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`${urls[urls.length - 1].replace(/[?]/g, "\\?")}$`), { timeout: T });
      // Direct link to every focused route in a fresh page lands on the same first heading.
      const fresh = await (await browser.newContext({ storageState: await page.context().storageState(), viewport: { width, height: width === 390 ? 844 : 900 } })).newPage();
      for (const r of rows) {
        await fresh.goto(r.url);
        const o = await observe(fresh, `deep-${r.step}`);
        expect(o.mainHeadings[0]?.text, `${r.step}: deep link opens the same first heading`).toBe(r.mainHeadings[0]?.text);
        expect(o.hash).toBe("");
      }
      // Old hash links redirect to the focused route (no hash left, only that content).
      for (const old of ["/settings/studio#email-notifications", "/settings/studio#sms-notifications", "/settings/studio#client-self-service", "/settings/intake#postcare", "/settings/intake#policies"]) {
        await fresh.goto(old);
        await fresh.waitForTimeout(500);
        const url = new URL(fresh.url());
        expect(url.hash, `${old}: redirected off the hash`).toBe("");
        expect(url.pathname + url.search, `${old}: moved to a focused route`).not.toBe(old.split("#")[0]);
      }
      await fresh.context().close();
    });

    test("unsaved edits are protected when leaving or switching group, and independent saves do not disturb each other", async ({ page }) => {
      await loginAsOwner(page, seed);
      await page.goto("/settings/profile");
      await clickRail(page, "Calendar", "Display preferences");
      await page.locator('button[aria-pressed="false"]', { hasText: /-hour/ }).click();
      // Switching to another group must ask, not silently discard or auto-close.
      await clickRail(page, "Studio", "Studio details").catch(() => undefined);
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Leave without saving?", { timeout: T });
      await dialog.getByRole("button", { name: "Stay" }).click();
      await expect(page).toHaveURL(/calendar|display/i);
      await expect(page.locator('button[aria-pressed="true"]', { hasText: /-hour/ })).toHaveCount(1);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: T });

      // Independent saves: saving Studio details leaves the saved display preference alone.
      const timeBefore = (await sql<{ t: string }>(`select time_format_preference t from public.studios where id=$1`, [seed.studioId]))[0].t;
      await clickRail(page, "Studio", "Studio details");
      const name = page.locator('input[name="name"], input[id*="name" i]').first();
      await name.fill(`${seed.studioName} R2`);
      await page.getByRole("button", { name: /^save/i }).first().click();
      await expect(page.getByRole("status").filter({ hasText: /saved/i })).toBeVisible({ timeout: T });
      const after = await sql<{ t: string; n: string }>(`select time_format_preference t, name n from public.studios where id=$1`, [seed.studioId]);
      expect(after[0].t, "a studio-details save does not touch display preferences").toBe(timeBefore);
      expect(after[0].n).toBe(`${seed.studioName} R2`);
    });
  });
}

test.describe("role refusals on the focused routes", () => {
  async function asPractitioner(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await loginByMagicLink(p, member.email);
    return p;
  }

  test("a practitioner is refused every owner-only focused route and the rail never lists them", async ({ browser, page }) => {
    await loginAsOwner(page, seed);
    const rows = await walk(page);
    const p = await asPractitioner(browser);
    for (const r of rows.filter((x) => !["01-profile", "02-personal-details", "10-intake-form-preview"].includes(x.step))) {
      const res = await p.request.get(r.url);
      const body = await res.text();
      expect(res.status(), `${r.step} ${r.url}`).toBeLessThan(500);
      // The owner's form fields for this route must not be in a practitioner's response.
      expect(body, `${r.step}: practitioner response carries no studio form values`).not.toContain(seed.studioName);
    }
    await p.goto("/settings/profile");
    const nav = await p.getByRole("navigation", { name: "Settings sections" }).innerText();
    for (const owner of ["Studio", "Booking", "Payments", "Integrations", "Calendar"]) {
      expect(nav.split(/\s+/).includes(owner), `practitioner rail lacks ${owner}`).toBe(false);
    }
    await p.context().close();
  });
});
