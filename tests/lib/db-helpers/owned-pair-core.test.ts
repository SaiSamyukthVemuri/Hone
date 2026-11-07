import { describe, expect, it } from "vitest";
import { apiUrlInForce, assertLoopbackPair } from "../../db/helpers/owned-pair-core";

// The guard must work in CI's exact environment: no E2E_SUPABASE_URL, the default local stack.
const DEFAULT_API = "http://127.0.0.1:54321";
const DEFAULT_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

describe("census trigger-disabling guard (loopback-only)", () => {
  it("passes with E2E_SUPABASE_URL UNSET, using the validated default (CI's db-integration environment)", () => {
    const api = apiUrlInForce({}, DEFAULT_API);
    expect(api).toBe(DEFAULT_API);
    expect(() => assertLoopbackPair(DEFAULT_DB, api)).not.toThrow();
  });

  it("an explicit E2E_SUPABASE_URL wins over the default", () => {
    expect(apiUrlInForce({ E2E_SUPABASE_URL: "http://127.0.0.1:59791" }, DEFAULT_API)).toBe("http://127.0.0.1:59791");
    expect(apiUrlInForce({ E2E_SUPABASE_URL: "" }, DEFAULT_API)).toBe(DEFAULT_API);
  });

  it("refuses a non-loopback API or DB, and lookalike hosts", () => {
    expect(() => assertLoopbackPair(DEFAULT_DB, "https://abc.supabase.co")).toThrow(/loopback/);
    expect(() => assertLoopbackPair("postgresql://u:p@db.example.com:5432/postgres", DEFAULT_API)).toThrow(/loopback/);
    expect(() => assertLoopbackPair(DEFAULT_DB, "http://127.0.0.1.attacker.example")).toThrow(/loopback/);
    expect(() => assertLoopbackPair(DEFAULT_DB, "")).toThrow(/loopback/);
  });
});
