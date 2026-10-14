import { defineConfig } from "@playwright/test";

// PAY-CCY-09 OPERATOR CONFIG for e2e-payment/fake-stripe-webhook-replay.tool.spec.ts
// (Codex P2 4265382410). NOT a browser lane, and deliberately absent from the
// lane lists the e2e guardrail tests pin:
//
//   * NO webServer. The tool replays signed webhooks at a twin that is ALREADY
//     running (HONE_E2E_WEBHOOK_ORIGIN). The payment lane's config would start
//     its own server, and with reuseExistingServer:false it throws when the twin
//     already holds that URL.
//   * NO schema preflight. That preflight checks local-env's stack; the tool
//     reads the twin's database (HONE_LOCAL_DB_URL), which may be another one.
//   * NO browser, NO seeding: the tool reads one attempt and POSTs events.
//
// The tool refuses to run under any other config (HONE_E2E_REPLAY_TOOL_CONFIG).
process.env.HONE_E2E_REPLAY_TOOL_CONFIG = "1";

export default defineConfig({
  testDir: ".",
  testMatch: /fake-stripe-webhook-replay\.tool\.spec\.ts$/,
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
});
