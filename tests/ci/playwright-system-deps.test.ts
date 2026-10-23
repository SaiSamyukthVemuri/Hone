import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// scripts/ci/playwright-system-deps.sh, EXECUTED: the real script against a fake
// `npx` and a pass-through `sudo`, with every apt path redirected into a
// throwaway directory. Never touches the host's /etc/apt or /var/cache/apt.

const SCRIPT = path.resolve(__dirname, "../../scripts/ci/playwright-system-deps.sh");
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Mode = "ok" | "stall-then-ok" | "stall" | "fail";

function run(mode: Mode, opts: { cached?: string[] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hone-pw-deps-"));
  scratch.push(dir);
  const bin = path.join(dir, "bin");
  const archives = path.join(dir, "archives");
  const cache = path.join(dir, "apt-debs");
  const mirrors = path.join(dir, "apt-mirrors.txt");
  const trace = path.join(dir, "trace");
  for (const d of [bin, archives]) mkdirSync(d);
  if (opts.cached) {
    mkdirSync(cache);
    for (const f of opts.cached) writeFileSync(path.join(cache, f), "deb");
  }
  writeFileSync(mirrors, "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n");
  // npx: records each call with the mirror it saw; "downloads" one .deb on success.
  writeFileSync(
    path.join(bin, "npx"),
    `#!/bin/bash
n=$(( $(cat "${dir}/count" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/count"
echo "npx $* | mirror=$(cut -f1 "${mirrors}")" >> "${trace}"
case "${mode}" in
  ok) ;;
  fail) exit 2 ;;
  stall) sleep 30 ;;
  stall-then-ok) [ $n -eq 1 ] && sleep 30 ;;
esac
touch "${archives}/libnss3_${"$"}{n}.deb"
`,
  );
  writeFileSync(path.join(bin, "sudo"), '#!/bin/bash\nexec "$@"\n');
  for (const f of ["npx", "sudo"]) chmodSync(path.join(bin, f), 0o755);
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      NODE_ENV: "test",
      HOME: dir,
      PW_DEB_CACHE_DIR: cache,
      APT_ARCHIVES_DIR: archives,
      APT_MIRROR_FILES: `${mirrors} ${path.join(dir, "absent.sources")}`,
      PW_DEPS_FIRST_TIMEOUT: "1",
      PW_DEPS_RETRY_TIMEOUT: "1",
    },
  });
  const calls = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : [];
  const ls = (d: string) => (existsSync(d) ? readdirSync(d).sort() : []);
  return { ...result, calls, archives: ls(archives), cache: ls(cache), mirror: readFileSync(mirrors, "utf8") };
}

describe("playwright-system-deps.sh: cached, bounded, retried once on a stall", () => {
  it("a healthy install runs once, keeps the mirror, and saves the downloaded .debs for the cache", () => {
    const r = run("ok");
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual(["npx playwright install-deps chromium | mirror=http://azure.archive.ubuntu.com/ubuntu/"]);
    expect(r.mirror).toContain("azure.archive.ubuntu.com");
    expect(r.cache).toEqual(["libnss3_1.deb"]);
  });

  it("cached .debs are put where apt looks BEFORE the install runs", () => {
    const r = run("ok", { cached: ["libgbm1_1.deb", "libnss3_0.deb"] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.archives).toEqual(expect.arrayContaining(["libgbm1_1.deb", "libnss3_0.deb"]));
    expect(r.stdout).toContain("restored 2 cached .deb file(s)");
  });

  it("a STALLED install is cut off, the mirror switches to archive.ubuntu.com, and the retry succeeds", () => {
    const r = run("stall-then-ok");
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([
      "npx playwright install-deps chromium | mirror=http://azure.archive.ubuntu.com/ubuntu/",
      "npx playwright install-deps chromium | mirror=http://archive.ubuntu.com/ubuntu/",
    ]);
    expect(r.stdout).toContain("::warning::Playwright system packages did not install within 1s");
    expect(r.cache).toEqual(["libnss3_2.deb"]);
  });

  it("a stall that outlasts the retry fails the step (bounded, never unbounded)", () => {
    const started = Date.now();
    const r = run("stall");
    expect(r.status).not.toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(Date.now() - started, "both attempts were cut off").toBeLessThan(20_000);
  });

  it("a NON-timeout failure is returned as-is: no mirror switch, no retry", () => {
    const r = run("fail");
    expect(r.status).toBe(2);
    expect(r.calls).toHaveLength(1);
    expect(r.mirror).toContain("azure.archive.ubuntu.com");
  });
});
