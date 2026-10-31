import { defineConfig } from "vitest/config";
import path from "node:path";
// Same paired-target guard as the DB lane: the realtime proofs mutate the local database.
import "./e2e/helpers/local-env";

// HON-48 / 0271 protocol-level proofs against a stack that RUNS the Realtime service
// (CI's DB and browser lanes exclude it). Needs Node 22+ for the global WebSocket.
//
// Run with:   npm run test:realtime
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/realtime/**/*.realtime.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: "default",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      "server-only": path.resolve(__dirname, "./tests/stubs/server-only.ts"),
    },
  },
});
