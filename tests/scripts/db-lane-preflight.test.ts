import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const CONFIG = path.join(ROOT, "vitest.db.config.ts");
const READY = "DB_CONFIG_READY";

// Load the REAL DB-lane config in a fresh process. Vite evaluates its imports
// before returning it, but this does not collect tests, connect to Postgres or
// call GoTrue. A split target must fail here, before any fixture can run.
// Without the config's guard import, every refused case below loads normally.
const LOAD_CONFIG = `
  import { loadConfigFromFile } from "vite";
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "test" }, process.argv[1], process.cwd(), "silent"
  );
  if (!loaded) throw new Error("DB config was not loaded");
  process.stdout.write("${READY}");
`;

function loadConfig(api: string, database: string) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", LOAD_CONFIG, CONFIG],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: "",
        SUPABASE_DB_URL: "",
        STRIPE_SECRET_KEY: "sk_test_dummy",
        STRIPE_ALLOW_LIVE_MODE: "false",
        E2E_SUPABASE_URL: api,
        HONE_LOCAL_DB_URL: database,
      },
    },
  );
}

describe("DB lane validates its target before collecting fixtures", () => {
  it.each([
    ["", ""],
    ["http://127.0.0.1:63321", "postgresql://postgres:postgres@127.0.0.1:63322/postgres"],
  ])("loads with a coherent default or isolated pair (%s)", (api, database) => {
    const result = loadConfig(api, database);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(READY);
  }, 20_000);

  it.each([
    ["", "postgresql://postgres:postgres@127.0.0.1:63322/postgres", "HONE_LOCAL_DB_URL selects another local stack"],
    ["http://127.0.0.1:63321", "", "E2E_SUPABASE_URL selects another local stack"],
    ["http://127.0.0.1:65421", "postgresql://postgres:postgres@127.0.0.1:63322/postgres", "are not one stack"],
    ["http://127.0.0.1:63321", "postgresql://postgres:postgres@127.0.0.1:63322/postgres?port=54322", "HONE_LOCAL_DB_URL points away"],
  ])("refuses the unsafe pair before config is ready (%s)", (api, database, reason) => {
    const result = loadConfig(api, database);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(reason);
    expect(result.stdout).not.toContain(READY);
  }, 20_000);
});
