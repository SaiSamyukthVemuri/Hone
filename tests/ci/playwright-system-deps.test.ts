import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Real-time bound, intrinsic: every case runs the real script (sudo, setsid, flock,
// timeout) as subprocesses. Under a loaded host (64 CPU burners) the healthy cases
// took 8-12 s against vitest's 5 s default and the lock-held case 42 s against its
// 30 s (FLAKE-SYSDEPS). Only ceilings move: the per-test and spawnSync limits. The
// `r.ms` bounds that assert the script itself is bounded are unchanged.
vi.setConfig({ testTimeout: 120_000 });

// scripts/ci/playwright-system-deps.sh, EXECUTED against fakes that model the
// PRIVILEGE BOUNDARY (Codex P1 r4362059036, #1059):
//   - fake `sudo` runs its command in a NEW SESSION (setsid -w), so a signal
//     from an unprivileged `timeout` outside it cannot reach what it started,
//     exactly as a user cannot signal root's apt-get;
//   - fake `npx` behaves like Playwright's install-deps: as "root" (inside
//     sudo) it runs apt-get itself, otherwise it calls `sudo apt-get`;
//   - fake `apt-get` holds an apt lock file open (flock) like dpkg does, and
//     refuses with "Could not get lock" (exit 100) when it is already held.
// Every apt path lives in a throwaway directory: the host's /etc/apt,
// /var/lib/dpkg and /var/cache/apt are never touched.

const SCRIPT = path.resolve(__dirname, "../../scripts/ci/playwright-system-deps.sh");
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    // Every fake apt process, including one that escaped its group (and the
    // stalled ones the OLD script could not kill), holds this test's lock file
    // open, so killing its holders reaps them all; then anything named by path.
    spawnSync("fuser", ["-k", "-KILL", path.join(dir, "lock-frontend")], { stdio: "ignore" });
    spawnSync("pkill", ["-KILL", "-f", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

type Mode = "ok" | "stall-then-ok" | "stall" | "stall-leak" | "fail";

function setup(mode: Mode, cached: string[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "hone-pw-deps-"));
  scratch.push(dir);
  const bin = path.join(dir, "bin");
  const archives = path.join(dir, "archives");
  const cache = path.join(dir, "apt-debs");
  const mirrors = path.join(dir, "apt-mirrors.txt");
  const lock = path.join(dir, "lock-frontend");
  const trace = path.join(dir, "trace");
  for (const d of [bin, archives]) mkdirSync(d);
  if (cached.length) {
    mkdirSync(cache);
    for (const f of cached) writeFileSync(path.join(cache, f), "deb");
  }
  writeFileSync(mirrors, "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n");
  writeFileSync(lock, "");
  const exe = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  exe("sudo", 'export FAKE_ROOT=1\nexec setsid -w "$@"');
  exe(
    "npx",
    `echo "npx $* | root=\${FAKE_ROOT:-0} | mirror=$(cut -f1 "${mirrors}")" >> "${trace}"
if [ "\${FAKE_ROOT:-0}" = 1 ]; then apt-get install; else sudo apt-get install; fi`,
  );
  exe(
    "apt-get",
    `n=$(( $(cat "${dir}/count" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/count"
exec 9>>"${lock}"
flock -n 9 || { echo "E: Could not get lock ${lock}" >&2; echo "apt-get #$n: lock busy" >> "${trace}"; exit 100; }
case "${mode}" in
  ok) ;;
  fail) exit 2 ;;
  stall) sleep 60 ;;
  stall-leak) setsid sleep 60 < /dev/null > /dev/null 2>&1 & sleep 60 ;;
  stall-then-ok) [ $n -eq 1 ] && sleep 60 ;;
esac
touch "${archives}/libnss3_$n.deb"`,
  );
  exe("dpkg", `echo "dpkg $*" >> "${trace}"`);
  // The script's busy check is host-wide (`pgrep -x apt-get`, `-x dpkg`), which is
  // right on a single-tenant runner. On a shared host another lane's REAL apt-get
  // made it refuse to retry (FLAKE-SYSDEPS), so scope the real pgrep to this
  // test's own directory, as afterEach already does when it reaps.
  // (`pgrep -f` also matches this wrapper, whose command line holds the directory.)
  exe("pgrep", `{ /usr/bin/pgrep "$@" || true; } | grep -F -- "${dir}" | grep -vF -- "${bin}/pgrep" || true`);
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    NODE_ENV: "test",
    HOME: dir,
    PW_DEB_CACHE_DIR: cache,
    APT_ARCHIVES_DIR: archives,
    APT_MIRROR_FILES: `${mirrors} ${path.join(dir, "absent.sources")}`,
    APT_LOCK_FILES: lock,
    PW_DEPS_FIRST_TIMEOUT: "1",
    PW_DEPS_RETRY_TIMEOUT: "2",
    PW_DEPS_KILL_AFTER: "1",
    PW_DEPS_SETTLE_SECONDS: "2",
  };
  const run = (args: string[] = []) => {
    const started = Date.now();
    const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", timeout: 90_000, env });
    const calls = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : [];
    const ls = (d: string) => (existsSync(d) ? readdirSync(d).sort() : []);
    // What is still alive from this test, and whether anything holds the lock.
    const alive = spawnSync("pgrep", ["-a", "-f", dir], { encoding: "utf8" }).stdout.trim();
    const lockHeld = spawnSync("fuser", [lock]).status === 0;
    return { ...r, ms: Date.now() - started, calls, archives: ls(archives), cache: ls(cache), mirror: readFileSync(mirrors, "utf8"), alive, lockHeld };
  };
  return { dir, lock, run };
}

describe("playwright-system-deps.sh: cached, bounded INSIDE sudo, retried once on a clean apt", () => {
  it("a healthy install runs once, inside sudo, keeps the mirror, and saves the .debs for the cache", () => {
    const r = setup("ok").run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual(["npx playwright install-deps chromium | root=1 | mirror=http://azure.archive.ubuntu.com/ubuntu/"]);
    expect(r.mirror).toContain("azure.archive.ubuntu.com");
    expect(r.cache).toEqual(["libnss3_1.deb"]);
  });

  it("cached .debs are put where apt looks BEFORE the install runs", () => {
    const r = setup("ok", ["libgbm1_1.deb", "libnss3_0.deb"]).run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.archives).toEqual(expect.arrayContaining(["libgbm1_1.deb", "libnss3_0.deb"]));
    expect(r.stdout).toContain("restored 2 cached .deb file(s)");
  });

  it("a STALLED privileged apt is killed within the bound and releases its lock; dpkg is repaired; the retry runs on archive.ubuntu.com", () => {
    const r = setup("stall-then-ok").run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.calls).toEqual([
      "npx playwright install-deps chromium | root=1 | mirror=http://azure.archive.ubuntu.com/ubuntu/",
      "dpkg --configure -a",
      "npx playwright install-deps chromium | root=1 | mirror=http://archive.ubuntu.com/ubuntu/",
    ]);
    expect(r.calls.join("\n"), "the retry never met a held lock").not.toContain("lock busy");
    expect(r.alive, "no apt process from the stalled attempt survives").toBe("");
    expect(r.lockHeld).toBe(false);
    expect(r.cache).toEqual(["libnss3_2.deb"]);
    expect(r.ms, "1 s limit + 1 s kill-after, not the 60 s stall").toBeLessThan(15_000);
  }, 120_000);

  it("a stall that outlasts the retry fails the step, bounded, and leaves nothing running", () => {
    const r = setup("stall").run();
    expect(r.status).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("npx"))).toHaveLength(2);
    expect(r.alive).toBe("");
    expect(r.lockHeld).toBe(false);
    expect(r.ms).toBeLessThan(20_000);
  }, 120_000);

  it("a lock still held after the kill window FAILS LOUDLY and never retries into it", () => {
    // The stalled apt leaves a child that escaped its process group (setsid)
    // still holding the inherited lock descriptor: something the timeout's
    // group kill cannot reach.
    const t = setup("stall-leak");
    const r = t.run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::apt is still busy 2s after the timed-out install was killed; not retrying into a held lock:");
    expect(r.stdout).toContain(`lock held: ${t.lock}`);
    expect(r.calls.filter((c) => c.startsWith("npx")), "no retry").toHaveLength(1);
    expect(r.calls, "no dpkg repair while apt is busy").not.toContain("dpkg --configure -a");
  }, 120_000);

  // Decoy: a long-lived process whose command name is `apt-get`.
  const decoy = (where: string) => {
    mkdirSync(where, { recursive: true });
    const exe = path.join(where, "apt-get");
    copyFileSync("/usr/bin/sleep", exe);
    chmodSync(exe, 0o755);
    const child = spawn(exe, ["120"], { stdio: "ignore", detached: true });
    child.unref();
    return child;
  };

  it("an apt-get belonging to ANOTHER tenant of the host does not make the stall test refuse to retry", () => {
    // Reproduces the shared-host failure deterministically: before the pgrep
    // scope, this decoy made the script exit 1 with "apt is still busy".
    const foreign = mkdtempSync(path.join(tmpdir(), "hone-pw-deps-foreign-"));
    const child = decoy(foreign);
    try {
      const r = setup("stall-then-ok").run();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.calls.filter((c) => c.startsWith("npx"))).toHaveLength(2);
    } finally {
      if (child.pid) process.kill(child.pid, "SIGKILL");
      rmSync(foreign, { recursive: true, force: true });
    }
  }, 120_000);

  it("CONTROL: an apt-get of THIS test that outlives the kill window still fails loudly (the scope hides only foreign processes)", () => {
    const t = setup("stall-then-ok");
    decoy(path.join(t.dir, "decoy"));
    const r = t.run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::apt is still busy 2s after the timed-out install was killed; not retrying into a held lock:");
    expect(r.calls.filter((c) => c.startsWith("npx")), "no retry").toHaveLength(1);
  }, 120_000);

  it("`webkit` installs WebKit's packages through the same bounded path (HON-62)", () => {
    const r = setup("ok").run(["webkit"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual(["npx playwright install-deps webkit | root=1 | mirror=http://azure.archive.ubuntu.com/ubuntu/"]);
  });

  it("an unknown browser fails before apt is touched", () => {
    const r = setup("ok").run(["firefox"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("unknown browser 'firefox'");
    expect(r.calls).toEqual([]);
  });

  it("a NON-timeout failure is returned as-is: no mirror switch, no retry", () => {
    const r = setup("fail").run();
    expect(r.status).toBe(2);
    expect(r.calls).toHaveLength(1);
    expect(r.mirror).toContain("azure.archive.ubuntu.com");
  });
});
