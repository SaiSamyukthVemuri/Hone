import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Every migration PR must regenerate supabase/schema-snapshot.json (Photos F5).
// The command is `npm run schema:snapshot -- --write`; verify:prepush runs the
// check mode so a stale snapshot is caught before the push, with an actionable
// message, not first in CI.

const ROOT = path.resolve(__dirname, "../..");
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway root holding only the generator, the migrations and the committed snapshot. */
function copyRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hone-schema-cli-"));
  scratch.push(dir);
  mkdirSync(path.join(dir, "scripts"));
  cpSync(path.join(ROOT, "scripts/schema-snapshot.mjs"), path.join(dir, "scripts/schema-snapshot.mjs"));
  cpSync(path.join(ROOT, "supabase/migrations"), path.join(dir, "supabase/migrations"), { recursive: true });
  cpSync(path.join(ROOT, "supabase/schema-snapshot.json"), path.join(dir, "supabase/schema-snapshot.json"));
  return dir;
}

const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [path.join(dir, "scripts/schema-snapshot.mjs"), ...args], { encoding: "utf8", timeout: 30_000 });

describe("schema snapshot: the command every migration PR runs", () => {
  it("check mode passes on the committed snapshot, fails actionably on a new migration, and --write repairs it", () => {
    const dir = copyRoot();
    expect(cli(dir).status).toBe(0);

    writeFileSync(path.join(dir, "supabase/migrations/9999_zz_new.sql"), "begin;\ncreate table public.zz_new (id uuid);\ncommit;\n");
    const stale = cli(dir);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("supabase/schema-snapshot.json is stale against supabase/migrations: run npm run schema:snapshot -- --write");

    expect(cli(dir, "--write").status).toBe(0);
    expect(cli(dir).status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, "supabase/schema-snapshot.json"), "utf8")).public.tables).toContain("zz_new");
  });

  it("is wired: the npm script exists and verify:prepush runs the check", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["schema:snapshot"]).toBe("node scripts/schema-snapshot.mjs");
    const prepush = readFileSync(path.join(ROOT, "scripts/verify-prepush.mjs"), "utf8");
    expect(prepush).toMatch(/check\("schema snapshot matches supabase\/migrations"[\s\S]*?execFileSync\("node", \["scripts\/schema-snapshot\.mjs"\]/);
  });
});
