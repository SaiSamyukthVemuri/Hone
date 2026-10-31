import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Comparison screenshots for the settings redesign (WS-E). Written ONLY when
// SETTINGS_SHOTS_DIR is set, to that directory outside the repository; with it
// unset (CI) this is a no-op, so no image is ever committed or produced there.
// Synthetic fixture studio only; real reference screenshots are never used.
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SETTINGS_SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const w = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: path.join(dir, `${name}-${w}.png`), fullPage: true });
}
