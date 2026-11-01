import { test, expect, type Browser, type Page } from "@playwright/test";
import { seedE2eStudio, seedE2eMember, seedNoStudioAuthUser, type E2eSeed } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { E2E_APP_ORIGIN } from "./helpers/local-env";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { shot } from "./helpers/settings-shots";

// WS-E · settings redesign verification, part 1: who sees which rail entries,
// what a direct URL does for each role, and that restricted settings are absent
// from the SERVER response (not merely hidden in the DOM).
//
// Roles: owner, practitioner, and the receptionist stand-in. practitioners.role
// has no 'receptionist' value yet, so the receptionist case here is a signed-in
// user with NO practitioner row (the position a receptionist would hold): no
// studio resolves for them and no settings content may reach them.
// Synthetic studio only. Every negative sits beside a positive control.

const T = 20_000;
const BOTH_LABELS = ["Profile", "Forms & Postcare"];
const OWNER_ONLY_LABELS = [
  "Calendar",
  "Studio",
  "Team",
  "Booking",
  "Availability",
  "Services",
  "Machines",
  "Consent forms",
  "Payments",
  "Integrations",
  "Marketing & analytics",
  "Import",
  "Data",
];
const OWNER_ONLY_HREFS = [
  "/settings/calendar",
  "/settings/studio",
  "/settings/team",
  "/settings/booking",
  "/settings/availability",
  "/settings/services",
  "/settings/machines",
  "/settings/consent",
  "/settings/payments",
  "/settings/integrations",
  "/settings/tracking",
  "/settings/import",
  "/settings/data",
];

let seed: E2eSeed;
let member: Awaited<ReturnType<typeof seedE2eMember>>;

function rail(page: Page) {
  return page.getByRole("navigation", { name: "Settings sections" });
}

/** Top-level rail entries: expandable groups (their summary) and plain links, in order. */
async function railLabels(page: Page): Promise<string[]> {
  return rail(page).evaluate((nav) => {
    const out: string[] = [];
    for (const el of Array.from(nav.querySelectorAll("summary, a"))) {
      if (el.tagName === "A" && el.closest("li")) continue; // a section link, not an entry
      out.push((el.textContent ?? "").replace(/\s+/g, " ").trim());
    }
    return out;
  });
}

async function loginAny(page: Page, email: string): Promise<void> {
  // loginByMagicLink waits for /dashboard, which a user without a studio never reaches.
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
  await page.waitForURL((u) => !/\/(login|auth)/.test(u.pathname), { timeout: 30_000 });
}

async function asPractitioner(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await loginByMagicLink(p, member.email);
  return p;
}

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  member = await seedE2eMember(seed);
});

test.describe("rail per role", () => {
  test("owner sees every entry, grouped PERSONAL then STUDIO, with the active entry marked", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/settings/profile");
    await expect(rail(page)).toBeVisible({ timeout: T });
    const labels = await railLabels(page);
    for (const l of [...BOTH_LABELS, ...OWNER_ONLY_LABELS]) {
      expect(labels.some((t) => t.startsWith(l)), `owner rail has ${l}`).toBe(true);
    }
    const nav = await rail(page).innerText();
    expect(nav.indexOf("PERSONAL")).toBeGreaterThanOrEqual(0);
    expect(nav.indexOf("STUDIO")).toBeGreaterThan(nav.indexOf("PERSONAL"));
    // Which entry is active is asserted in settings-shell-interactions.spec.ts.
    await shot(page, "owner-nav-desktop");
  });

  test("a practitioner sees only Profile and Forms & Postcare, and none of the owner-only entries", async ({ browser }) => {
    const page = await asPractitioner(browser);
    await page.goto("/settings/profile");
    await expect(rail(page)).toBeVisible({ timeout: T });
    const labels = await railLabels(page);
    for (const l of BOTH_LABELS) {
      expect(labels.some((t) => t.startsWith(l)), `practitioner rail has ${l}`).toBe(true);
    }
    for (const l of OWNER_ONLY_LABELS) {
      expect(labels.some((t) => t.startsWith(l)), `practitioner rail lacks ${l}`).toBe(false);
    }
    await shot(page, "practitioner-nav-desktop");
    await page.context().close();
  });

  test("Forms & Postcare: owner sees three subsections, a practitioner only the intake preview", async ({ browser, page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/settings/intake");
    const sections = async (pg: Page) =>
      (await rail(pg).locator("li a").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(await sections(page)).toEqual(["Postcare", "Intake form preview", "Cancellation & no-show policy"]);
    await shot(page, "owner-forms-and-postcare");

    const p = await asPractitioner(browser);
    await p.goto("/settings/intake");
    await expect(rail(p)).toBeVisible({ timeout: T });
    expect(await sections(p)).toEqual(["Intake form preview"]);
    await shot(p, "practitioner-forms-and-postcare");
    await p.context().close();
  });
});

test.describe("direct URLs", () => {
  test("a practitioner who opens an owner-only URL gets no settings content, the owner gets the page", async ({ browser, page }) => {
    await loginAsOwner(page, seed);
    const p = await asPractitioner(browser);
    // Pages that render an in-place refusal for a non-owner, and the sentence they use.
    const REFUSAL: Array<[string, RegExp]> = [
      ["/settings/payments", /only the studio owner can manage payments/i],
      ["/settings/studio", /only studio owners can change studio settings/i],
      ["/settings/machines", /only studio owners can register machines/i],
      ["/settings/tracking", /only studio owners can manage marketing/i],
    ];
    for (const [href, sentence] of REFUSAL) {
      await p.goto(href);
      await expect(p.getByText(sentence), `practitioner at ${href}`).toBeVisible({ timeout: T });
      await page.goto(href);
      await expect(page.getByText(sentence), `owner at ${href} must not see the refusal`).toHaveCount(0);
    }
    // Every owner-only URL answers a practitioner without a server error.
    for (const href of OWNER_ONLY_HREFS) {
      const res = await p.request.get(href);
      expect(res.status(), `practitioner status for ${href}`).toBeLessThan(500);
    }
    await p.context().close();
  });

  test("the old Calendar redirect to Availability is gone: the owner opens a Calendar page; a practitioner is sent to Profile", async ({ browser, page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/settings/calendar");
    await expect(page).toHaveURL(/\/settings\/calendar$/);
    await expect(page.getByRole("heading", { name: "Display preferences" })).toBeVisible({ timeout: T });
    const p = await asPractitioner(browser);
    await p.goto("/settings/calendar");
    await expect(p).toHaveURL(/\/settings\/profile/, { timeout: T });
    await expect(p.getByRole("heading", { name: "Display preferences" })).toHaveCount(0);
    await p.context().close();
  });

  test("an unauthenticated visitor is sent to login from every settings URL", async ({ browser }) => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    for (const href of ["/settings", ...OWNER_ONLY_HREFS.slice(0, 4)]) {
      await p.goto(href);
      await expect(p).toHaveURL(/\/login/, { timeout: T });
    }
    await ctx.close();
  });
});

test.describe("restricted data is absent from the SERVER response", () => {
  test("owner-only rail entries are in the owner's page payload and not in the practitioner's", async ({ browser, page }) => {
    await loginAsOwner(page, seed);
    const ownerHtml = await (await page.request.get("/settings/profile")).text();
    const p = await asPractitioner(browser);
    const prHtml = await (await p.request.get("/settings/profile")).text();
    for (const href of OWNER_ONLY_HREFS) {
      expect(ownerHtml, `positive control: owner payload carries ${href}`).toContain(href);
      expect(prHtml, `practitioner payload must not carry ${href}`).not.toContain(href);
    }
    // The same via the RSC flight request the client router issues.
    const prRsc = await (await p.request.get("/settings/profile", { headers: { RSC: "1" } })).text();
    for (const href of OWNER_ONLY_HREFS) {
      expect(prRsc, `practitioner RSC payload must not carry ${href}`).not.toContain(href);
    }
    for (const l of OWNER_ONLY_LABELS.filter((x) => x.length > 6)) {
      expect(prHtml, `practitioner payload must not carry the label ${l}`).not.toContain(`"label":"${l}"`);
    }
    await p.context().close();
  });
});

test.describe("receptionist stand-in (signed in, no practitioner row)", () => {
  test("is kept out of every settings URL and receives no rail", async ({ browser }) => {
    const nostudio = await seedNoStudioAuthUser();
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await loginAny(p, nostudio.email);
    for (const href of ["/settings", "/settings/profile", ...OWNER_ONLY_HREFS]) {
      await p.goto(href);
      await expect(p.getByRole("navigation", { name: "Settings sections" }), `rail at ${href}`).toHaveCount(0);
      const body = await p.content();
      expect(body, `no owner nav payload at ${href}`).not.toContain("/settings/payments");
    }
    await ctx.close();
  });
});
