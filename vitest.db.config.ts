import { defineConfig } from "vitest/config";
import path from "node:path";

// DB/RLS integration lane (PR #220). Runs ONLY tests/db/**, against
// the LOCAL Supabase Postgres started by `supabase db start` and
// migrated by `supabase db reset --local`. It is deliberately a
// separate config so the fast unit/static lane (`npm test`) never
// needs Docker and never touches a database.
//
// Run with:   npm run test:db
// Prereq:     supabase db start && supabase db reset --local
//
// Safety: tests/db/helpers/harness.ts refuses any connection string
// that is not localhost and any URL matching hosted-database host
// patterns; it reads no production env vars. See
// docs/09_DATABASE_AND_RLS.md for the harness documentation.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/db/**/*.db.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    pool: "forks",
    // The suites share one local database; run files serially so
    // seeded fixtures and pool teardown cannot interleave.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    reporters: "default",
  },
  // The repo tsconfig sets `jsx: "preserve"` because the Next compiler owns the
  // transform in the app. This lane invokes a real SERVER COMPONENT (the Client
  // Profile page) to observe the queries it issues, so the .tsx has to compile
  // here too. Same setting the unit lane uses, and for the same reason: Vite 8
  // transforms with oxc and ignores esbuild options when both are present.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      // Mirror the unit config: `server-only` is a bundler-only marker Next
      // consumes at build; stub it so DB tests can import server-only worker
      // modules (Google Calendar sync core) against the local stack.
      "server-only": path.resolve(__dirname, "./tests/stubs/server-only.ts"),
    },
  },
});
