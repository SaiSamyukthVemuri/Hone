import path from "node:path";
import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import base from "../playwright.config";

// SLOT-ONLY Roles proofs (e2e/roles-r6-*.slot.ts). They are NOT named *.spec.ts on purpose: the CI lanes' spec map (scripts/browser-groups.mjs)
// and Playwright's default testMatch do not see them, so no CI job runs them against a stack that has not been prepared for them.
// They need an owned stack with the Roles migrations and the permission keys RELEASED (the files skip with a BLOCKED reason otherwise).
// Run: ROLES_R6_OUT=<dir> E2E_SUPABASE_URL=... HONE_LOCAL_DB_URL=... npx playwright test -c e2e/roles-slot.playwright.config.ts --project=chromium
export default defineConfig({
  ...base,
  // The base config's relative paths resolve against ITS directory (the repo root); this file lives in e2e/, so name them explicitly.
  globalSetup: path.resolve(__dirname, "global-setup"),
  globalTeardown: path.resolve(__dirname, "global-teardown"),
  webServer: { ...(base.webServer as Exclude<PlaywrightTestConfig["webServer"], unknown[] | undefined>), cwd: path.resolve(__dirname, "..") },
  testDir: path.resolve(__dirname),
  testMatch: /roles-r6-.*\.slot\.ts$/,
});
