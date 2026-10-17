import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// CI-BIND-RETRY-01. `supabase start` on a fresh runner occasionally dies with a
// host-port bind collision before any test runs (run 38490241652, job
// 115613879102, port 54324). The wrapper retries the START step once, and only
// for that signature. These cases drive the real script against a fake
// `supabase` whose behaviour is scripted per attempt.

const ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/ci/supabase-start-bind-retry.sh");

const BIND_ERROR =
  'failed to start docker container "supabase_inbucket_x": Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint supabase_inbucket_x (abc): failed to bind host port for 0.0.0.0:54324:172.18.0.5:8025/tcp: address already in use';

type Attempt = { out: string; rc: number };

function run(attempts: Attempt[], args = ["supabase", "start", "-x", "studio"]) {
  const dir = mkdtempSync(path.join(tmpdir(), "bind-retry-"));
  const calls = path.join(dir, "calls");
  writeFileSync(calls, "");
  attempts.forEach((a, i) => {
    writeFileSync(path.join(dir, `out${i + 1}`), a.out);
    writeFileSync(path.join(dir, `rc${i + 1}`), String(a.rc));
  });
  const fake = path.join(dir, "supabase");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
echo "$*" >> "${calls}"
if [ "$1" = "stop" ]; then exit 0; fi
n=$(grep -c '^start' "${calls}")
cat "${dir}/out$n" 2>/dev/null
exit "$(cat "${dir}/rc$n" 2>/dev/null || echo 0)"
`,
  );
  chmodSync(fake, 0o755);
  // Keep the diagnostics off the host's real Docker.
  const docker = path.join(dir, "docker");
  writeFileSync(docker, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(docker, 0o755);

  const res = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      SUPABASE_BIND_RETRY_DELAY_SECONDS: "0",
    },
  });
  const log = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  return {
    rc: res.status,
    out: `${res.stdout}${res.stderr}`,
    starts: log.filter((l) => l.startsWith("start")).length,
    stops: log.filter((l) => l.startsWith("stop")).length,
  };
}

describe("supabase start bind-collision retry", () => {
  it("a clean start runs once and never stops the stack", () => {
    const r = run([{ out: "Started supabase local development setup.", rc: 0 }]);
    expect(r).toMatchObject({ rc: 0, starts: 1, stops: 0 });
    expect(r.out).not.toMatch(/::warning/);
  });

  it("a bind collision is retried exactly once, loudly, and recovers", () => {
    const r = run([
      { out: BIND_ERROR, rc: 1 },
      { out: "Started supabase local development setup.", rc: 0 },
    ]);
    expect(r).toMatchObject({ rc: 0, starts: 2, stops: 1 });
    expect(r.out).toMatch(/::warning title=Supabase port-bind collision \(retrying once\)::.*54324/);
    expect(r.out).toMatch(/::warning title=Supabase port-bind collision \(recovered\)::/);
  });

  it("a second collision fails the step: one retry, never two", () => {
    const r = run([
      { out: BIND_ERROR, rc: 1 },
      { out: BIND_ERROR, rc: 1 },
      { out: "Started", rc: 0 },
    ]);
    expect(r.rc).toBe(1);
    expect(r.starts).toBe(2);
    expect(r.out).not.toMatch(/\(recovered\)/);
  });

  it("any other failure is NOT retried and keeps its own exit code", () => {
    const r = run([
      { out: "Applying migration 0099_x.sql...\nERROR: syntax error at or near", rc: 3 },
      { out: "Started", rc: 0 },
    ]);
    expect(r).toMatchObject({ rc: 3, starts: 1, stops: 0 });
    expect(r.out).not.toMatch(/::warning/);
  });

  it("an address-in-use on a non-Supabase port is NOT retried", () => {
    const r = run([
      { out: BIND_ERROR.replace("0.0.0.0:54324", "0.0.0.0:8080"), rc: 1 },
      { out: "Started", rc: 0 },
    ]);
    expect(r).toMatchObject({ rc: 1, starts: 1, stops: 0 });
  });

  it("refuses to wrap anything but `supabase start`", () => {
    expect(run([], ["supabase", "db", "reset", "--local"]).rc).toBe(2);
    expect(run([], ["npm", "run", "test:e2e"]).rc).toBe(2);
  });
});

describe("workflow wiring", () => {
  const workflows = [".github/workflows/ci.yml", ".github/workflows/nightly.yml"].map(
    (f) => [f, readFileSync(path.join(ROOT, f), "utf8")] as const,
  );

  it("every `supabase start` step goes through the wrapper", () => {
    let starts = 0;
    for (const [file, text] of workflows) {
      for (const line of text.split("\n")) {
        if (line.trim().startsWith("#")) continue;
        if (!/\bsupabase start\b/.test(line)) continue;
        starts += 1;
        expect(line, file).toMatch(
          /run: bash scripts\/ci\/supabase-start-bind-retry\.sh supabase start\b/,
        );
      }
    }
    expect(starts).toBeGreaterThanOrEqual(6);
  });

  it("the wrapper wraps nothing else: no reset or test step is retried", () => {
    for (const [file, text] of workflows) {
      for (const line of text.split("\n")) {
        const m = line.match(/supabase-start-bind-retry\.sh\s+(.*)$/);
        if (m) expect(m[1], file).toMatch(/^supabase start\b/);
      }
    }
  });
});
