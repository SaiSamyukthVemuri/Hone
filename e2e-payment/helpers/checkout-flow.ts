import { expect, type Locator, type Page } from "@playwright/test";

// Shared quick-checkout UI steps for the payment browser E2E specs. These drive
// the REAL modal + the REAL prepare/execute server actions; nothing bypasses the
// UI or calls a server action directly.

export function modalOf(page: Page): Locator {
  return page.getByTestId("quick-checkout-modal");
}

// Open checkout from the current surface (dashboard or calendar — same testid on
// both) and wait for the modal.
export async function openCheckout(page: Page): Promise<Locator> {
  await page.getByTestId("checkout-button").click();
  const modal = modalOf(page);
  await expect(modal).toBeVisible();
  return modal;
}

export async function closeModal(page: Page): Promise<void> {
  const modal = modalOf(page);
  await modal.getByTestId("quick-checkout-close").click();
  await expect(modal).toHaveCount(0);
}

// Prepare a payment from an OPEN modal: fill the required internal note, submit,
// and wait for the in-modal prepared confirmation. The 'ready' row now exists.
export async function prepareInModal(modal: Locator): Promise<void> {
  await modal
    .getByPlaceholder(/note explaining the session payment/i)
    .fill("E2E concurrency-safety session payment");
  await modal.getByRole("button", { name: /prepare session payment/i }).click();
  await expect(modal.getByText(/session payment prepared/i)).toBeVisible();
}

// Open checkout (fresh context load), advance through the explicit confirmation,
// and return the modal + the armed "Confirm: run charge" control. Used once the
// attempt is already 'ready' (the modal reopens to the Ready panel).
export async function armReady(page: Page): Promise<{ modal: Locator; confirm: Locator }> {
  const modal = await openCheckout(page);
  const runCharge = modal.getByRole("button", { name: /^run charge$/i });
  await expect(runCharge).toBeVisible();
  await runCharge.click(); // arm the two-click confirm
  const confirm = modal.getByRole("button", { name: /confirm: run charge/i });
  await expect(confirm).toBeVisible();
  return { modal, confirm };
}
