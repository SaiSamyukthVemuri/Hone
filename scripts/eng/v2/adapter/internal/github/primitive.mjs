// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A: the one module permitted to reach GitHub (CAP-01 §4).
//
// It runs `gh api` with the DEDICATED read-only token named by TOKEN_ENV, in a
// child environment built from nothing: a fresh, empty GH_CONFIG_DIR and HOME,
// so the operator's stored, write-scoped `gh` session is unreachable, and no
// inherited GH_TOKEN, GITHUB_TOKEN or enterprise token. Without the dedicated
// token it makes no request at all. Live (gh 2.97.0): with an empty config
// directory and no token, `gh` refuses with exit 4 rather than finding a
// session somewhere else.
//
// The token travels only in the child's environment: never in an argument,
// never in a result, never in a detail. Any echo of it is redacted.
//
// One request per call, no pagination, a hard timeout. A non-zero exit is
// `read_failed` with gh's first stderr line as the detail (live: "gh: Not
// Found (HTTP 404)", "gh: Bad credentials (HTTP 401)", or the GraphQL error's
// message), which names the missing capability when a permission is absent.
// Every call is counted and timed for the shepherd's instrumentation.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The environment variable holding the dedicated read-only fine-grained token. */
export const TOKEN_ENV = "HONE_ENG_READ_TOKEN";

const API_VERSION = "2022-11-28";
const MAX_BUFFER = 64 * 1024 * 1024;
const TOKEN_SHAPES = [/github_pat_[A-Za-z0-9_]{20,}/g, /gh[pousr]_[A-Za-z0-9]{20,}/g];

const readFailed = (detail) => Object.freeze({ ok: false, reason: "read_failed", detail });

/** Remove the token, and anything shaped like a GitHub token, from text that may be shown. */
function redactor(token) {
  return (text) => {
    let s = String(text);
    if (token) s = s.split(token).join("[redacted]");
    for (const shape of TOKEN_SHAPES) s = s.replace(shape, "[redacted]");
    return s;
  };
}

/** `gh api` arguments for one request. No argument ever carries the token. */
function argsFor(req) {
  if (typeof req.rest === "string") {
    return [
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      `X-GitHub-Api-Version: ${API_VERSION}`,
      req.rest,
    ];
  }
  const args = ["api", "graphql", "-f", `query=${req.graphql}`];
  for (const [name, value] of Object.entries(req.variables ?? {})) {
    // -F sends a number as a number; -f always sends a string.
    if (typeof value === "number") args.push("-F", `${name}=${value}`);
    else args.push("-f", `${name}=${value}`);
  }
  return args;
}

/**
 * @param {{ env: Record<string, string | undefined>, spawn?: typeof spawnSync, now?: () => number,
 *           timeoutMs?: number, gh?: string, makeHome?: () => string, removeHome?: (dir: string) => void }} deps
 * @returns {{ ok: true, request, stats, close } | { ok: false, reason: "read_failed", detail: string }}
 */
export function createPrimitive({
  env,
  spawn = spawnSync,
  now = Date.now,
  timeoutMs = 30_000,
  gh = "gh",
  makeHome = () => mkdtempSync(path.join(tmpdir(), "hone-eng-gh-")),
  removeHome = (dir) => rmSync(dir, { recursive: true, force: true }),
} = {}) {
  const token = env && typeof env[TOKEN_ENV] === "string" ? env[TOKEN_ENV].trim() : "";
  if (token === "") {
    return readFailed(`${TOKEN_ENV} is not set: live collection needs the dedicated read-only token, never the gh session`);
  }
  const redact = redactor(token);
  const home = makeHome();
  const childEnv = Object.freeze({
    PATH: env.PATH ?? "",
    HOME: home,
    GH_CONFIG_DIR: home,
    GH_TOKEN: token,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
  });
  const log = [];
  let closed = false;

  function request(req) {
    const label = typeof req?.label === "string" ? req.label : "unlabelled";
    if (closed) return readFailed("the transport is closed");
    const started = now();
    const done = (result) => {
      log.push(Object.freeze({ label, ms: Math.max(0, now() - started), ok: result.ok }));
      return result;
    };
    let r;
    try {
      r = spawn(gh, argsFor(req), {
        env: childEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER,
      });
    } catch (e) {
      return done(readFailed(redact(`gh could not be started: ${e?.message ?? "unknown error"}`)));
    }
    if (r.error) {
      const why = r.error.code === "ETIMEDOUT" ? `timed out after ${timeoutMs} ms` : (r.error.code ?? r.error.message);
      return done(readFailed(redact(`gh ${label}: ${why}`)));
    }
    if (r.status !== 0) {
      const first = String(r.stderr ?? "").trim().split("\n")[0] || `exit ${r.status ?? r.signal}`;
      return done(readFailed(redact(`${label}: ${first}`)));
    }
    try {
      return done(Object.freeze({ ok: true, body: JSON.parse(r.stdout) }));
    } catch {
      return done(Object.freeze({ ok: false, reason: "malformed", detail: `${label}: the answer is not JSON` }));
    }
  }

  return Object.freeze({
    ok: true,
    request,
    /** Requests made so far: label, milliseconds and outcome. Never a body, never a credential. */
    stats: () => Object.freeze([...log]),
    close: () => {
      if (!closed) {
        closed = true;
        removeHome(home);
      }
    },
  });
}
