/* eslint-disable @typescript-eslint/no-explicit-any -- recorded child environments are untyped JSON */
// Independent verifier support: the verifier's own fake `gh` executables (SPEC-05A §5.1).
// Each fake records its argv, its whole environment and its HOME's entries to one
// JSONL file, then runs its scripted answer. The shebang is this process's node
// binary: the primitive gives the child its own PATH and an empty HOME, so a PATH
// `node` wrapper that reads $HOME (as on the verifier's host) would not start.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FakeGhKit {
  root: string;
  /** writes <root>/<name>/gh with the given JS answer and returns its directory */
  make(name: string, answer: string): string;
  records(): any[];
  clear(): void;
  cleanup(): void;
}

export function fakeGhKit(): FakeGhKit {
  const root = mkdtempSync(path.join(os.tmpdir(), "verify-05a-gh-"));
  const rec = path.join(root, "record.jsonl");
  return {
    root,
    make(name, answer) {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      const src = [
        `#!${process.execPath}`,
        `const fs = require("fs");`,
        `let home = null; try { home = fs.readdirSync(process.env.HOME); } catch (e) { home = "unreadable: " + e.code; }`,
        `fs.appendFileSync(${JSON.stringify(rec)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, home }) + "\\n");`,
        answer,
      ].join("\n");
      writeFileSync(path.join(dir, "gh"), src);
      chmodSync(path.join(dir, "gh"), 0o755);
      return dir;
    },
    records: () => (existsSync(rec) ? readFileSync(rec, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    clear: () => rmSync(rec, { force: true }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const DEDICATED = `ghp_${"V".repeat(36)}`; // synthetic, token-shaped
export const OPERATOR = `gho_${"O".repeat(36)}`; // synthetic: the operator's interactive session token
export const REST_REQ = {
  label: "candidate-runs",
  rest: "repos/SaiSamyukthVemuri/Hone/actions/workflows/289443461/runs?head_sha=958b9d536e055e746499262cdc1a740e13501bf2&event=pull_request&per_page=100",
};

/** Sets process-environment canaries for the duration of f, then restores them. */
export function withProcessEnv<T>(vars: Record<string, string>, f: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return f();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * Named primitive rows (SPEC-05A §5.1), parametrized by createPrimitive so the mutants
 * can be judged by the same rows. Each returns null when the row holds, else why not.
 */
export function primitiveRows(kit: FakeGhKit, jsonDir: string) {
  return {
    /** "Without it, it makes no request … The operator's gh session is never a fallback." */
    "PT-no-dedicated-token": (createPrimitive: any): string | null => {
      for (const env of [
        { GH_TOKEN: OPERATOR, PATH: `${jsonDir}:/usr/bin:/bin` },
        { PATH: `${jsonDir}:/usr/bin:/bin` },
      ]) {
        kit.clear();
        const r: any = withProcessEnv({ GH_TOKEN: OPERATOR }, () => {
          const p = createPrimitive({ env, timeoutMs: 3000 });
          return p.ok ? p.request(REST_REQ) : p;
        });
        if (r?.ok !== false || r?.reason !== "read_failed") return `no dedicated token: ${JSON.stringify(r).slice(0, 120)}`;
        if (kit.records().length) return "gh was invoked without the dedicated token";
      }
      return null;
    },
    /** "a child environment built from nothing … No credential is inherited." */
    "PT-child-env-from-nothing": (createPrimitive: any): string | null => {
      kit.clear();
      const out: any = withProcessEnv({ GITHUB_TOKEN: OPERATOR, VERIFY_CANARY_PROCESS: "process-canary" }, () => {
        const p = createPrimitive({ env: { HONE_ENG_READ_TOKEN: DEDICATED, PATH: `${jsonDir}:/usr/bin:/bin`, VERIFY_CANARY_PARAM: "param-canary", GH_TOKEN: OPERATOR }, timeoutMs: 3000 });
        return p.ok ? p.request(REST_REQ) : p;
      });
      if (!out?.ok) return `request failed: ${JSON.stringify(out).slice(0, 120)}`;
      const rec = kit.records();
      if (rec.length !== 1) return `expected one gh invocation, saw ${rec.length}`;
      const env = rec[0].env;
      for (const k of ["GITHUB_TOKEN", "VERIFY_CANARY_PROCESS", "VERIFY_CANARY_PARAM"]) if (k in env) return `${k} inherited`;
      if (env.GH_TOKEN !== DEDICATED) return "GH_TOKEN is not the dedicated token";
      if (env.HOME !== env.GH_CONFIG_DIR || !Array.isArray(rec[0].home) || rec[0].home.length) return "HOME is not a fresh empty GH_CONFIG_DIR";
      return null;
    },
  };
}
