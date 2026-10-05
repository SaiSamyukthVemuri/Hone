import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSentryEgressGuardArmed,
  localE2eBuildSentryOverrides,
  SENTRY_EGRESS_GUARD_MARK,
} from "@/lib/observability/e2e-build-sentry-overrides";

// SENTRY-E2E-NOISE-02 (Codex P2 at de43cb15). A local browser lane's
// `next build` must not create releases or upload source maps in the
// operational Sentry project. Those calls are made by the native sentry-cli
// binary, so the lane's Node-level egress guard cannot see them; this proves
// the build-option override that stops them, on the build plugin's real code.

const ROOT = path.resolve(__dirname, "../../..");
const GUARD = path.join(ROOT, "e2e", "helpers", "sentry-egress-guard.cjs");
const BACKSTOP = path.join(ROOT, "tests", "fixtures", "sentry-dns-backstop.cjs");
const HELPER = path.join(ROOT, "lib", "observability", "e2e-build-sentry-overrides.ts");
const PLUGIN_CORE = path.join(ROOT, "node_modules", "@sentry", "bundler-plugin-core");

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "VERCEL",
    "VERCEL_ENV",
    "AWS_REGION",
    "AWS_EXECUTION_ENV",
    "KUBERNETES_SERVICE_HOST",
    "NODE_OPTIONS",
    "SENTRY_AUTH_TOKEN",
    "SENTRY_URL",
  ]) {
    delete env[key];
  }
  return env;
}

function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

describe("the override exists only where the lane's egress guard armed", () => {
  it("no mark: no override, so a deployed build's options are unchanged", () => {
    expect(isSentryEgressGuardArmed({})).toBe(false);
    expect(localE2eBuildSentryOverrides({})).toEqual({});
  });

  it("an armed mark: an empty token", () => {
    const scope = { [SENTRY_EGRESS_GUARD_MARK]: { active: true } };
    expect(isSentryEgressGuardArmed(scope)).toBe(true);
    expect(localE2eBuildSentryOverrides(scope)).toEqual({ authToken: "" });
  });

  it.each([
    ["an inactive mark", { active: false }],
    ["a truthy non-boolean", { active: "true" }],
    ["a non-object mark", true],
    ["null", null],
  ])("%s: no override", (_label, mark) => {
    expect(localE2eBuildSentryOverrides({ [SENTRY_EGRESS_GUARD_MARK]: mark })).toEqual({});
  });

  it("reads the key the guard actually sets", () => {
    expect(SENTRY_EGRESS_GUARD_MARK).toBe(Symbol.for("hone.e2e.sentryEgressGuard"));
    expect(readFileSync(GUARD, "utf8")).toContain('Symbol.for("hone.e2e.sentryEgressGuard")');
  });

  it("in a real process: the override appears with the guard preloaded, and only then", () => {
    const script = `
      const createJiti = require(${JSON.stringify(path.join(ROOT, "node_modules", "jiti"))});
      const jiti = createJiti(${JSON.stringify(path.join(ROOT, "probe.cjs"))});
      const m = jiti(${JSON.stringify(HELPER)});
      console.log(JSON.stringify(m.localE2eBuildSentryOverrides()));
    `;
    const run = (preload: string[]) =>
      spawnSync(process.execPath, [...preload, "-e", script], {
        cwd: ROOT,
        env: cleanEnv(),
        encoding: "utf8",
        timeout: 60_000,
      });

    const armed = run(["--require", BACKSTOP, "--require", GUARD]);
    expect(armed.status, armed.stderr).toBe(0);
    expect(lastJson(armed.stdout)).toEqual({ authToken: "" });

    const plain = run([]);
    expect(plain.status, plain.stderr).toBe(0);
    expect(lastJson(plain.stdout)).toEqual({});
  });
});

describe("the build plugin's real code: the explicit token outranks every credential source", () => {
  // The threat, exercised: `.env.sentry-build-plugin` carries a token, and the
  // lane has ALSO blanked SENTRY_AUTH_TOKEN in its environment. The plugin
  // applies the file over process.env, so blanking does not hold. child_process
  // is stubbed in the probe, so sentry-cli is RECORDED, never run, and the
  // file points SENTRY_URL at a closed loopback port besides. Node-level egress
  // is covered by the backstop and the guard.
  function probe(override: Record<string, unknown>): Record<string, unknown> {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "sentry-build-plugin-"));
    try {
      writeFileSync(
        path.join(cwd, ".env.sentry-build-plugin"),
        "SENTRY_AUTH_TOKEN=e2e-fake-token-never-valid\nSENTRY_URL=http://127.0.0.1:9\n",
      );
      const script = `
        const cp = require("node:child_process");
        const { EventEmitter } = require("node:events");
        const launched = [];
        const blocked = () => Object.assign(new Error("blocked by test"), { code: "EBLOCKED" });
        for (const k of ["spawn", "execFile", "exec", "fork"]) {
          cp[k] = function (...args) {
            launched.push(k);
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.stdin = { write() {}, end() {} };
            child.kill = () => {};
            const cb = args.find((a) => typeof a === "function");
            setImmediate(() => {
              if (cb) cb(blocked(), "", "");
              if (child.listenerCount("error") > 0) child.emit("error", blocked());
              child.emit("close", 1);
            });
            return child;
          };
        }
        for (const k of ["spawnSync", "execFileSync", "execSync"]) {
          cp[k] = function () { launched.push(k); throw blocked(); };
        }
        process.env.SENTRY_AUTH_TOKEN = "";
        const core = require(${JSON.stringify(PLUGIN_CORE)});
        const manager = core.createSentryBuildPluginManager(
          {
            org: "hone-w1",
            project: "javascript-nextjs",
            telemetry: false,
            silent: true,
            release: { name: "e2e-build-probe", create: true, finalize: true },
            errorHandler: () => {},
            ...JSON.parse(process.env.PROBE_OVERRIDE),
          },
          { buildTool: "webpack", loggerPrefix: "[probe]" },
        );
        const t = manager.normalizedOptions.authToken;
        const token = t === "" ? "explicit-empty" : t ? "present" : "absent";
        Promise.resolve()
          .then(() => manager.createRelease())
          .catch(() => {})
          .then(() => manager.uploadSourcemaps([]))
          .catch(() => {})
          .then(() => console.log(JSON.stringify({ token, launched: launched.length })));
      `;
      const res = spawnSync(
        process.execPath,
        ["--require", BACKSTOP, "--require", GUARD, "-e", script],
        {
          cwd,
          env: { ...cleanEnv(), NODE_ENV: "production", PROBE_OVERRIDE: JSON.stringify(override) },
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      expect(res.status, res.stderr).toBe(0);
      return lastJson(res.stdout);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it("WITHOUT the override, the file's token wins over the blanked env and sentry-cli would run", () => {
    // The negative control, and the detector's own proof: if this did not
    // record a launch, the clean result below would mean nothing.
    const result = probe({});
    expect(result.token).toBe("present");
    expect(result.launched).toBeGreaterThan(0);
  });

  it("WITH the override, no token reaches the plugin and sentry-cli never runs", () => {
    const result = probe(localE2eBuildSentryOverrides({ [SENTRY_EGRESS_GUARD_MARK]: { active: true } }));
    expect(result).toEqual({ token: "explicit-empty", launched: 0 });
  });
});

describe("next.config.ts passes the override to withSentryConfig", () => {
  it("spreads it into the build options, outside any comment", () => {
    const code = readFileSync(path.join(ROOT, "next.config.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const call = code.slice(code.indexOf("withSentryConfig(nextConfig, {"));
    expect(call.length).toBeGreaterThan(0);
    expect(call).toMatch(/\n\s*\.\.\.localE2eBuildSentryOverrides\(\),\n/);
    expect(code).toContain(
      'import { localE2eBuildSentryOverrides } from "./lib/observability/e2e-build-sentry-overrides";',
    );
  });
});
