import { expect, type Locator } from "@playwright/test";

// practitioner feedback (26 Nov 2026): a dashboard visit card shows its last visit details by default, with no click. The "Last visit
// details" button is only a secondary hide / show. Specs that need the details on screen call this instead of clicking
// blindly, so they assert the expanded state rather than toggle it (a blind click would now CLOSE it).
export async function ensureLastVisitDetailsOpen(toggle: Locator, timeout = 15_000): Promise<void> {
  await expect(toggle).toBeVisible({ timeout });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout });
}

// The inverse, for the specs that prove hide: close it and assert it is closed.
export async function closeLastVisitDetails(toggle: Locator, timeout = 15_000): Promise<void> {
  await expect(toggle).toBeVisible({ timeout });
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false", { timeout });
}
