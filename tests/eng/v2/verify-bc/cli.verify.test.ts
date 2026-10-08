// 05C through the real CLI process: `node scripts/eng/cli.mjs shepherd <pr> [--json] [--no-receipt]`, spawned with the
// real node binary and an environment built here. PATH holds only a fake `gh` shim (and git), HOME and
// GH_CONFIG_DIR are empty directories, so no route to the operator's gh session exists.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error untyped support module
import { writeGhShim, readShimLog, routeRest, isReadOnlyQuery } from "./support/fake-gh.mjs";
// @ts-expect-error untyped support module
import { world } from "./support/worlds.mjs";
import { parseOnlyJson, REQUIRED_FIELDS } from "./checks-shepherd";
import { cleanupTmp, tmp } from "./support/tmp";

afterAll(cleanupTmp);

const ROOT = path.resolve(__dirname, "../../../..");
const TOKEN = "ghp_VERIFYbcFakeToken0Canary0000000000000"; // token-shaped, not a credential
const PARENT_CANARIES = { GITHUB_TOKEN: "ghp_PARENTcanaryGITHUBTOKEN000000000000000", GH_DEBUG: "api", GH_REPO: "evil/repo", SECRET_CANARY: "do-not-inherit" };

type CliRun = { status: number | null; stdout: string; stderr: string; log: any[]; receiptsDir: string; home: string };

/** The spawned CLI reads the real clock, so the recorded run is re-dated to an hour ago: SPEC-05A §3.4 step 8's
 * 360-day window would otherwise turn every CI-dependent world into base_history_unverified a year after recording. */
function freshRuns(w: any) {
  const x = JSON.parse(JSON.stringify(w));
  const recent = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  for (const r of x["candidate-runs"]?.workflow_runs ?? []) r.created_at = recent;
  return x;
}

function setup(w: any, opts: any = {}) {
  const t = tmp("cli-");
  const bin = path.join(t, "bin");
  writeGhShim({ dir: bin, world: freshRuns(w), logFile: path.join(t, "gh.log"), nodePath: process.execPath, opts });
  fs.symlinkSync("/usr/bin/git", path.join(bin, "git"));
  for (const d of ["home", "ghconf", "rc", "tmp"]) fs.mkdirSync(path.join(t, d));
  return t;
}
function envFor(t: string, token: string | null, extra: any = {}) {
  return {
    PATH: path.join(t, "bin"),
    HOME: path.join(t, "home"),
    GH_CONFIG_DIR: path.join(t, "ghconf"),
    TMPDIR: path.join(t, "tmp"),
    HONE_ENG_RECEIPTS_DIR: path.join(t, "rc"),
    ...PARENT_CANARIES,
    ...(token === null ? {} : { HONE_ENG_READ_TOKEN: token }),
    ...extra,
  };
}
function runCli(args: string[], w: any, o: { token?: string | null; extraEnv?: any; cwd?: string } = {}): CliRun {
  const t = setup(w);
  const r = spawnSync(process.execPath, [path.join(o.cwd ?? ROOT, "scripts/eng/cli.mjs"), "shepherd", ...args], {
    cwd: o.cwd ?? ROOT,
    env: envFor(t, o.token === undefined ? TOKEN : o.token, o.extraEnv),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: readShimLog(path.join(t, "gh.log")), receiptsDir: path.join(t, "rc"), home: t };
}
const label = (r: any) => (r.decision === "UNKNOWN" ? `UNKNOWN(${r.reasonCodes[0]})` : r.decision);
const receiptsText = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n") : "");

describe("CLI: the real process", { timeout: 180_000 }, () => {
  test("CLI-NOTOKEN: without HONE_ENG_READ_TOKEN: exit 3, UNKNOWN(read_failed), zero requests, JSON only", () => {
    const r = runCli(["800", "--json"], world("ready", "protectedRules", "resolveOpenThread"), { token: null, extraEnv: { GH_TOKEN: "ghp_SESSIONcanary00000000000000000000000" } });
    expect(r.log, "gh invocations").toEqual([]);
    expect(r.status).toBe(3);
    const j = parseOnlyJson(r.stdout);
    expect(j.ok, j.why).toBe(true);
    expect(label(j.value)).toBe("UNKNOWN(read_failed)");
    expect(j.value.instrumentation.requests).toBe(0);
    expect(j.value.humanMergeRequired).toBe(true);
  });

  const cases: [string, any, number, string][] = [
    ["CANDIDATE", world("ready", "protectedRules", "resolveOpenThread"), 0, "CANDIDATE_READY_FOR_HUMAN_REVIEW"],
    ["FINDINGS_OPEN", world("ready", "protectedRules"), 4, "FINDINGS_OPEN"],
    ["DRAFT_HOLD (recorded)", world(), 4, "DRAFT_HOLD"],
    ["UNKNOWN row (production unprotected)", world("ready"), 3, "UNKNOWN(base_history_unverified)"],
  ];
  for (const [n, w, code, want] of cases) {
    test(`CLI-RUN ${n}: exit ${code}, JSON only, every field, read-only requests, clean child env, no token anywhere`, () => {
      const r = runCli(["800", "--json"], w);
      expect(r.status, r.stderr).toBe(code);
      const j = parseOnlyJson(r.stdout);
      expect(j.ok, j.why).toBe(true);
      expect(label(j.value)).toBe(want);
      expect(REQUIRED_FIELDS.filter(([, has]) => !has(j.value)).map(([f]) => f)).toEqual([]);
      expect(r.log.length).toBeGreaterThan(0);
      for (const c of r.log) {
        expect(c.readOnly, JSON.stringify(c.argv).slice(0, 200)).toBe(true);
        expect(c.endpoint === "graphql" ? isReadOnlyQuery(c.query) : routeRest(c.endpoint) !== null).toBe(true);
        for (const k of Object.keys(PARENT_CANARIES)) expect(c.envKeys, `child env inherits ${k}`).not.toContain(k);
        expect(c.envKeys).not.toContain("HONE_ENG_READ_TOKEN");
        expect(c.ghTokenValue).toBe(TOKEN);
        expect(c.env.HOME).toBe(c.env.GH_CONFIG_DIR);
        expect(c.env.HOME).not.toBe(path.join(r.home, "home"));
        expect(c.configDirEntries).toEqual([]);
        expect(c.argv.join(" ")).not.toContain(TOKEN);
      }
      expect(r.stdout + r.stderr + receiptsText(r.receiptsDir)).not.toContain(TOKEN);
      expect(fs.readdirSync(r.receiptsDir).length).toBe(1);
    });
  }

  test("CLI-TEXT: text mode has the same exit code and is not JSON", () => {
    const w = world("ready", "protectedRules");
    const j = runCli(["800", "--json"], w);
    const t = runCli(["800"], w);
    expect(t.status).toBe(j.status);
    expect(parseOnlyJson(t.stdout).ok).toBe(false);
    expect(t.stdout).toContain("FINDINGS_OPEN");
    expect(t.stdout + t.stderr).not.toContain(TOKEN);
  });

  test("CLI-USAGE: a usage error in --json mode is exit 2 with one JSON document and no request", () => {
    const r = runCli(["abc", "--json"], world());
    expect(r.status).toBe(2);
    expect(parseOnlyJson(r.stdout).ok).toBe(true);
    expect(r.log).toEqual([]);
  });

  test("CLI-RECEIPT-FAIL: an unwritable receipts directory leaves stdout JSON-only and the decision's exit code", () => {
    const t = setup(world("ready", "protectedRules", "resolveOpenThread"));
    const file = path.join(t, "rc-file");
    fs.writeFileSync(file, "x");
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/eng/cli.mjs"), "shepherd", "800", "--json"], { cwd: ROOT, env: envFor(t, TOKEN, { HONE_ENG_RECEIPTS_DIR: file }), encoding: "utf8", timeout: 120_000 });
    expect(r.status).toBe(0);
    const j = parseOnlyJson(r.stdout);
    expect(j.ok, j.why).toBe(true);
    expect(j.value.receipt).toBe("failed");
  });

  test("CLI-TMP: the gh HOME/GH_CONFIG_DIR scratch directory does not outlive the run", () => {
    const r = runCli(["800", "--json"], world());
    const homes = [...new Set(r.log.map((c: any) => c.env.HOME))] as string[];
    expect(homes.length).toBeGreaterThan(0);
    const left = homes.filter((h) => fs.existsSync(h));
    expect(left, `left behind: ${left.join(", ")}`).toEqual([]);
  });

  test("CLI-TOOLVERSION: a checkout whose HEAD cannot be established reports toolVersion null, never a placeholder (README)", () => {
    const r = runCli(["800", "--json"], world());
    const j = parseOnlyJson(r.stdout);
    expect(j.ok).toBe(true);
    const v = j.value.toolVersion;
    expect(v === null || /^eng-loop-v1@[0-9a-f]{40}(\+dirty)?$/.test(v), `toolVersion ${v}`).toBe(true);
  });

  test("CLI-RECEIPT-ROOT: by default receipts land under .eng/receipts/, gitignored, and never make the tool +dirty", () => {
    // A git checkout copy of this tree (scripts/, .github/, .gitignore, package.json) committed in a scratch repo.
    const repo = tmp("git-");
    for (const p of ["scripts", ".github", ".gitignore", "package.json"]) fs.cpSync(path.join(ROOT, p), path.join(repo, p), { recursive: true });
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=verifier@example.invalid", "-c", "user.name=verifier", ...a], { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "scratch");
    const head = git("rev-parse", "HEAD").stdout.trim();
    const t = setup(world("ready", "protectedRules", "resolveOpenThread"));
    const env: any = envFor(t, TOKEN);
    delete env.HONE_ENG_RECEIPTS_DIR;
    const run = () => spawnSync(process.execPath, [path.join(repo, "scripts/eng/cli.mjs"), "shepherd", "800", "--json"], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });
    const a = run();
    const b = run();
    expect(a.status, a.stderr).toBe(0);
    const ja = parseOnlyJson(a.stdout).value, jb = parseOnlyJson(b.stdout).value;
    expect(ja.receipt).toBe("written");
    expect(ja.toolVersion).toBe(`eng-loop-v1@${head}`);
    expect(jb.toolVersion, "receipts from the first run must not make the second run +dirty").toBe(`eng-loop-v1@${head}`);
    const files = fs.readdirSync(path.join(repo, ".eng/receipts"));
    expect(files.length).toBe(2);
    expect(git("check-ignore", "-q", path.join(".eng/receipts", files[0])).status, "receipt is gitignored").toBe(0);
    expect(git("status", "--porcelain").stdout.trim(), "tree stays clean").toBe("");
  });

  test("CLI-CONCURRENT: eight shepherds writing receipts at once all land, distinct and valid", async () => {
    const w = world("ready", "protectedRules", "resolveOpenThread");
    const t = setup(w);
    const env = envFor(t, TOKEN);
    const runs = await Promise.all(
      Array.from({ length: 8 }, () =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          const c = spawn(process.execPath, [path.join(ROOT, "scripts/eng/cli.mjs"), "shepherd", "800", "--json"], { cwd: ROOT, env });
          let out = "";
          c.stdout.on("data", (d) => (out += d));
          c.on("close", (code) => resolve({ code, out }));
        }),
      ),
    );
    for (const r of runs) {
      expect(r.code).toBe(0);
      expect(parseOnlyJson(r.out).value.receipt).toBe("written");
    }
    const { readReceipts } = await import(path.join(ROOT, "scripts/eng/v2/receipts.mjs"));
    const read = readReceipts(path.join(t, "rc"));
    expect(read.complete).toBe(true);
    expect(read.receipts.length).toBe(8);
    expect(new Set(fs.readdirSync(path.join(t, "rc"))).size).toBe(8);
  }, 240_000);
});
