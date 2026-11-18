import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { cacheDirProblems, guardProblems, syntheticProblems } from "../../scripts/db-baseline/guard.mjs";

const owned = {
  container: "supabase_db_g-base-a",
  destructive: true,
  env: { E2E_SUPABASE_URL: "http://127.0.0.1:60471", HONE_LOCAL_DB_URL: "postgresql://postgres:postgres@127.0.0.1:60472/postgres" } as Record<string, string | undefined>,
  dockerContext: "default",
  contextEndpoint: "unix:///var/run/docker.sock",
  publishedDbPort: 60472,
};
const g = (over: Record<string, unknown> = {}) => guardProblems({ ...owned, ...over }) as string[];

describe("a destructive restore or seal must be owned and local", () => {
  it("goes ahead for the paired guard env of the stack that owns the container", () => {
    expect(g()).toEqual([]);
  });

  it("goes ahead with an explicit --confirm-owned that names the stack, without the env pair", () => {
    expect(g({ env: {}, confirmOwned: "g-base-a" })).toEqual([]);
  });

  it("REFUSES with neither the paired env nor --confirm-owned", () => {
    expect(g({ env: {} }).join(" ")).toMatch(/paired E2E_SUPABASE_URL and HONE_LOCAL_DB_URL/);
  });

  it("REFUSES with only one of the pair", () => {
    expect(g({ env: { E2E_SUPABASE_URL: "http://127.0.0.1:60471" } }).length).toBeGreaterThan(0);
  });

  it("REFUSES a --confirm-owned that names a different project", () => {
    expect(g({ env: {}, confirmOwned: "team-pr1586" }).join(" ")).toMatch(/does not name this stack/);
  });

  it("REFUSES a pair that points at another stack's database port (the shared stack)", () => {
    expect(g({ publishedDbPort: 59722 }).join(" ")).toMatch(/not this container's published database port/);
  });

  it("REFUSES a pair that is not one stack", () => {
    const env = { E2E_SUPABASE_URL: "http://127.0.0.1:60471", HONE_LOCAL_DB_URL: "postgresql://postgres:postgres@127.0.0.1:59722/postgres" };
    expect(g({ env, publishedDbPort: 59722 }).join(" ")).toMatch(/not one stack/);
  });

  it("REFUSES a non-loopback pair", () => {
    const env = { E2E_SUPABASE_URL: "http://db.example.com:60471", HONE_LOCAL_DB_URL: "postgresql://postgres:x@db.example.com:60472/postgres" };
    expect(g({ env }).join(" ")).toMatch(/loopback/);
  });

  it("REFUSES whenever DOCKER_HOST is set, even with --confirm-owned", () => {
    expect(g({ env: { DOCKER_HOST: "tcp://10.0.0.5:2375" }, confirmOwned: "g-base-a" }).join(" ")).toMatch(/DOCKER_HOST is set/);
    expect(g({ env: { ...owned.env, DOCKER_HOST: "ssh://host" } }).join(" ")).toMatch(/DOCKER_HOST is set/);
  });

  it("REFUSES a docker context that is not the local default", () => {
    expect(g({ dockerContext: "remote-box", contextEndpoint: "ssh://box" }).join(" ")).toMatch(/not the local default/);
    expect(g({ contextEndpoint: "tcp://10.0.0.5:2375" }).join(" ")).toMatch(/not the local default/);
  });

  it("REFUSES a container that is not a local supabase_db_ container", () => {
    expect(g({ container: "postgres" }).join(" ")).toMatch(/supabase_db_<project>/);
    expect(g({ container: "supabase_db_x; rm -rf /" }).join(" ")).toMatch(/supabase_db_<project>/);
  });

  it("a read-only build needs only the local-daemon checks, not ownership proof", () => {
    expect(g({ destructive: false, env: {} })).toEqual([]);
    expect(g({ destructive: false, env: { DOCKER_HOST: "tcp://x" } }).length).toBeGreaterThan(0);
  });
});

describe("build refuses a database that is not synthetic", () => {
  const ok = { authUsers: 0, rowCounts: { permission_catalog: 40, clients: 0 }, allowedSeeded: ["permission_catalog"] };

  it("accepts no auth user and rows only in the allowed reference tables", () => {
    expect(syntheticProblems(ok)).toEqual([]);
  });

  it("refuses an auth user", () => {
    expect(syntheticProblems({ ...ok, authUsers: 2 }).join(" ")).toMatch(/auth\.users has 2/);
  });

  it("refuses rows in any other table and names every one", () => {
    const p = syntheticProblems({ ...ok, rowCounts: { ...ok.rowCounts, clients: 3, studios: 1 } }).join(" ");
    expect(p).toContain("clients (3)");
    expect(p).toContain("studios (1)");
  });

  it("an empty allowed list means any row is refused", () => {
    expect(syntheticProblems({ ...ok, allowedSeeded: [] }).join(" ")).toContain("permission_catalog (40)");
  });
});

describe("the cache directory is an owner-set directory outside the repo", () => {
  it("refuses an unset directory", () => {
    expect(cacheDirProblems(undefined, "/repo").join(" ")).toMatch(/HONE_DB_BASELINE_CACHE/);
  });

  it("refuses a directory inside the repository, or the repository itself", () => {
    expect(cacheDirProblems("/repo/.cache/baseline", "/repo").length).toBeGreaterThan(0);
    expect(cacheDirProblems("/repo", "/repo").length).toBeGreaterThan(0);
    expect(cacheDirProblems("/repo/../repo/x", "/repo").length).toBeGreaterThan(0);
  });

  it("accepts a directory outside it", () => {
    expect(cacheDirProblems("/var/cache/owner-set", "/repo")).toEqual([]);
  });
});
