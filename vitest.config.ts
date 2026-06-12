import { defineConfig } from "vitest/config";
import path from "node:path";

// Minimal Vitest config introduced in PR #149.
//
// This is the floor of an automated test harness for Hone, not a full
// suite. Tests live alongside the code they exercise (`tests/`
// directory at the repo root). The harness focuses on:
//
//   * Pure helpers that can be exercised without a database or
//     a browser (e.g. filterFutureSlots, the submitted-start guard
//     logic, the cancellation-reason allowlist).
//   * Action-layer protection invariants we never want to lose
//     (e.g. raw DB error text MUST NOT leak from the public
//     reschedule actions).
//
// What this is NOT
// ----------------
// * Not an end-to-end browser test. Playwright / Cypress are not set
//   up; manual smoke remains the way we exercise the live system.
// * Not a database harness. DB-touching tests live in tests/db/ and
//   run through vitest.db.config.ts (`npm run test:db`, PR #220)
//   against a LOCAL Supabase stack only; they are excluded here so
//   the unit lane stays fast and Docker-free.
// * Not a coverage gate. The PR template's review checklist is the
//   gate; tests added here are spot checks, not a comprehensive
//   harness.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "tests/db/**"],
    pool: "forks",
    reporters: "default",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      // Next's `server-only` marker is consumed at compile time by
      // the Next bundler. Vitest's Node loader doesn't ship it, so
      // we stub to a virtual empty module. The actual server-only
      // enforcement is provided by Next itself at build, NOT by
      // the test harness.
      "server-only": path.resolve(__dirname, "./tests/stubs/server-only.ts"),
    },
  },
});
