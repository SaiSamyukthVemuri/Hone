import { expect, type Page } from "@playwright/test";
import type { E2eSeed } from "./seed";
import { listMessageIds, waitForMagicLink } from "./mail";
import { E2E_APP_ORIGIN } from "./local-env";
import { followMagicLinkWebkit, installWebkitLocalhostFix, isWebKit } from "./webkit-localhost";

// Shared UI flows for the E2E specs (PR #227/#228). Extracted from
// the core-memory-loop spec so the mobile spec reuses the exact same
// real flows (public booking; REAL magic-link login via Mailpit).

export async function bookAppointment(page: Page, s: E2eSeed): Promise<void> {
  await page.goto(`/book/${s.slug}`);
  await expect(page.getByText(s.studioName).first()).toBeVisible();
  await page.getByRole("button", { name: /new client/i }).click();
  // Single seeded consultation service is preselected; pick the first
  // available slot, jumping forward if the default day has none.
  const slotButton = page.getByRole("button", {
    name: /^\d{1,2}:\d{2} (AM|PM)$/,
  });
  // The form has TWO jump buttons that never render together: "Next
  // available" on a day with zero slots and "Next available day"
  // under a populated slot list. Match both: late-evening runs land
  // on the empty-day path once today's last slot is taken.
  const nextDay = page.getByRole("button", {
    name: /^next available( day)?$/i,
  });
  await expect(async () => {
    const slots = await slotButton.count();
    const next = await nextDay.count();
    expect(slots + next).toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });
  if ((await slotButton.count()) === 0) {
    await nextDay.click();
    await expect(slotButton.first()).toBeVisible({ timeout: 20_000 });
  }
  await slotButton.first().click();
  await page.getByLabel(/your name/i).fill(s.clientName);
  await page.getByLabel(/^email/i).fill(s.clientEmail);
  await page.getByLabel(/phone/i).fill("+1 555 555 0123");
  await page.getByRole("button", { name: /book appointment/i }).click();
  // Confirmation state replaces the form.
  await expect(
    page.getByRole("heading", { name: /your appointment is booked/i }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(s.clientEmail).first()).toBeVisible();
}

// Real magic-link login for any seeded studio member (owner or practitioner).
/**
 * Dashboard appointment rows keep their secondary content (Before today, latest setup, last treatment,
 * consultation notes, review intake, portal link) inside a server-rendered <details> that is CLOSED by
 * default (fidelity C). Playwright treats content in a closed <details> as hidden, so every spec that
 * reads that content opens the details as soon as they appear, including after a soft day navigation.
 * Applied at login so it covers each page of the run; it touches only the row details' `open` attribute.
 */
export async function openTodayRowDetailsOnLoad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const open = () => {
      document
        .querySelectorAll('details[data-testid="today-row-details"]:not([open])')
        .forEach((d) => d.setAttribute("open", ""));
    };
    document.addEventListener("DOMContentLoaded", () => {
      open();
      new MutationObserver(open).observe(document.documentElement, { childList: true, subtree: true });
    });
  });
}

export async function loginByMagicLink(page: Page, email: string): Promise<void> {
  await openTodayRowDetailsOnLoad(page);
  // WebKit only (non-required WebKit job): strip the https-upgrade headers
  // before the first document and follow the link by request. Chromium skips both.
  const webkit = isWebKit(page);
  if (webkit) await installWebkitLocalhostFix(page.context());
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  // Magic links are single-use: snapshot the inbox BEFORE requesting
  // so a repeat login (new context/device) waits for the fresh link.
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  if (webkit) await followMagicLinkWebkit(page, link);
  else await page.goto(link);
  await page.waitForURL(/dashboard/, { timeout: 30_000 });
}

export async function loginAsOwner(page: Page, s: E2eSeed): Promise<void> {
  await loginByMagicLink(page, s.ownerEmail);
}
