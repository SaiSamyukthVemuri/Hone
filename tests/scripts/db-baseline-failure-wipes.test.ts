import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { computeKey } from "../../scripts/db-baseline/key.mjs";

// Behavioural: runs the real cli.mjs against a FAKE `docker` on PATH that records every call and can be told to fail
// the ACL or the trigger replay. Once a restore has begun dropping schemas, ANY failure must leave the stack wiped
// (the schemas dropped again), because a half-restored stack carries the target's default ACLs, for example PUBLIC
// execute on functions the chain revoked.

let root: string;
let log: string;
const CLI = path.join(process.cwd(), "scripts/db-baseline/cli.mjs");

const FAKE_DOCKER = `#!/bin/bash
echo "ARGS: $*" >> "$FAKE_LOG"
if [ "$1" = context ] && [ "$2" = show ]; then echo default; exit 0; fi
if [ "$1" = context ] && [ "$2" = inspect ]; then echo unix:///var/run/docker.sock; exit 0; fi
if [ "$1" = port ]; then echo 0.0.0.0:60472; exit 0; fi
if [ "$1" = cp ]; then exit 0; fi
if [ "$1" = exec ]; then
  case " $* " in
    *" psql "*)
      if [[ " $* " == *" -f - "* ]]; then
        input=$(cat); echo "PSQL-STDIN: $(echo "$input" | head -c 160 | tr '\\n' ' ')" >> "$FAKE_LOG"
        if [ -n "$FAIL_ON" ] && echo "$input" | grep -q "$FAIL_ON"; then echo "ERROR: simulated failure" >&2; exit 3; fi
      fi;;
    *" pg_restore "*)
      if [[ " $* " == *" -l "* ]]; then printf '; toc\\n1; 1 1 SCHEMA - public x\\n2; 2 2 TABLE public t postgres\\n'; else cat > /dev/null; fi;;
  esac
fi
exit 0
`;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "hone-baseline-fail-"));
  log = path.join(root, "calls.log");
  mkdirSync(path.join(root, "bin"));
  writeFileSync(path.join(root, "bin", "docker"), FAKE_DOCKER);
  chmodSync(path.join(root, "bin", "docker"), 0o755);
  writeFileSync(log, "");
  // A sealed cache entry for exactly this checkout's inputs.
  const cache = path.join(root, "cache");
  const dir = path.join(cache, computeKey().key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "baseline.dump"), "not a real dump");
  writeFileSync(path.join(dir, "extensions.sql"), "create extension if not exists btree_gist schema public;\n");
  writeFileSync(path.join(dir, "acl.sql"), "revoke all on TABLE public.t from public;\ngrant SELECT on TABLE public.t to authenticated;\n");
  writeFileSync(path.join(dir, "triggers.sql"), "CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();\n");
  writeFileSync(path.join(dir, "chain-fingerprint.txt"), "");
  writeFileSync(path.join(dir, "restored-fingerprint.txt"), "");
  writeFileSync(path.join(dir, "verified.json"), "{}");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (failOn: string) =>
  spawnSync("node", [CLI, "restore", "--container", "supabase_db_g-test", "--confirm-owned", "g-test", "--cache", path.join(root, "cache")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, FAKE_LOG: log, FAIL_ON: failOn, DOCKER_HOST: "" },
  });
const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
const WIPE = "drop schema if exists supabase_migrations cascade";

describe("a failure after the restore began leaves the stack wiped", () => {
  it("a failed ACL replay: exits non-zero and the schemas are dropped again, after the failure", () => {
    const r = run("revoke all on");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/the stack was cleared/);
    const c = calls();
    const failed = c.findIndex((l) => l.startsWith("PSQL-STDIN: revoke all on"));
    expect(failed, "the ACL replay must have been attempted").toBeGreaterThan(-1);
    const wipes = c.map((l, i) => (l.includes(WIPE) && l.startsWith("ARGS:") ? i : -1)).filter((i) => i >= 0);
    expect(wipes.some((i) => i > failed), "a wipe must follow the failed ACL replay").toBe(true);
    expect(c.some((l) => l.includes("fingerprint") || l.includes("migrations:"))).toBe(false);
  });

  it("a failed trigger replay is wiped too", () => {
    const r = run("CREATE TRIGGER");
    expect(r.status).toBe(1);
    const c = calls();
    const failed = c.findIndex((l) => l.startsWith("PSQL-STDIN: CREATE TRIGGER"));
    expect(failed).toBeGreaterThan(-1);
    expect(c.some((l, i) => i > failed && l.startsWith("ARGS:") && l.includes(WIPE))).toBe(true);
  });

  it("a failed extension step (before the dump loads) is wiped as well", () => {
    const r = run("create extension");
    expect(r.status).toBe(1);
    const c = calls();
    const failed = c.findIndex((l) => l.startsWith("PSQL-STDIN: create extension"));
    expect(c.some((l, i) => i > failed && l.startsWith("ARGS:") && l.includes(WIPE))).toBe(true);
  });

  it("a guard refusal wipes nothing and touches no database", () => {
    const r = spawnSync("node", [CLI, "restore", "--container", "supabase_db_g-test", "--cache", path.join(root, "cache")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, FAKE_LOG: log, FAIL_ON: "", DOCKER_HOST: "", E2E_SUPABASE_URL: "", HONE_LOCAL_DB_URL: "" },
    });
    expect(r.status).toBe(4);
    expect(calls().some((l) => l.includes("psql") || l.includes("pg_restore"))).toBe(false);
  });
});
