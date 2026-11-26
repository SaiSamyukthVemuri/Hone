import { devices } from "@playwright/test";
import base from "./playwright.config";

// LOCAL RUN ONLY (deleted after the run): the base config plus one WebKit iPhone 13 project scoped to the Overview spec.
export default {
  ...base,
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-iphone-13", testMatch: /business-overview-mobile\.spec\.ts$/, use: { ...devices["iPhone 13"], bypassCSP: true } },
  ],
};
