import { defineConfig, devices } from "@playwright/test";
import { E2E_APP_ORIGIN } from "./e2e/helpers/local-env";

// HON-8 practitioner preview proof: runs against an ALREADY RUNNING preview server (started by the operator, bound to 127.0.0.1).
// No webServer here, so this config can never start or restart the long-lived server. One worker, local stack only.
export default defineConfig({
  testDir: "./e2e",
  testMatch: /hon8-(practitioner-preview|preview-seed)\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: E2E_APP_ORIGIN, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
