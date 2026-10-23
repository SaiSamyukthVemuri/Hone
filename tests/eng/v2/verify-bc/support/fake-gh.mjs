// Independent fake GitHub for the 05B/05C verifier.
//
// Written from SPEC-05A §5.1's reader table and README "Shepherd" alone: each route below is one row of
// that table. It answers from recorded fixture bodies (tests/eng/v2/fixtures/), never from the implementation.
// It serves two call shapes:
//   - request level: `{ label, rest }` or `{ label, graphql, variables }` (the createReaders transport);
//   - gh level: `gh api …` argv plus the child environment (an injected spawn, or the executable shim).
// Every call is logged with the facts the no-mutation and token-hygiene checks need.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const OWNER = "SaiSamyukthVemuri";
export const NAME = "Hone";
export const PRODUCTION_REF = "claude/build-hone-saas-hOex7";
export const WORKFLOW_ID = 289443461;

const PREFIX = `repos/${OWNER}/${NAME}/`;

// ---------------------------------------------------------------------------------------------------------------
// gh argv parsing (gh api semantics: -X/--method, -f/--raw-field, -F/--field, -H/--header, --input, --paginate …)

const VALUE_FLAGS = new Map([
  ["-X", "method"], ["--method", "method"],
  ["-H", "header"], ["--header", "header"],
  ["-f", "raw"], ["--raw-field", "raw"],
  ["-F", "field"], ["--field", "field"],
  ["--input", "input"], ["-q", "jq"], ["--jq", "jq"], ["-t", "template"], ["--template", "template"],
  ["--cache", "cache"], ["--hostname", "hostname"], ["-p", "preview"], ["--preview", "preview"],
]);
const BOOL_FLAGS = new Set(["--paginate", "--slurp", "-i", "--include", "--silent", "--verbose"]);

export function parseGhArgv(argv) {
  const out = { command: argv[0], endpoint: null, method: null, headers: [], fields: {}, fieldKinds: {}, flags: [], unknown: [], positionals: [] };
  if (argv[0] !== "api") return out;
  for (let i = 1; i < argv.length; i += 1) {
    let a = String(argv[i]);
    let inlineValue;
    if (a.startsWith("--") && a.includes("=")) { inlineValue = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
    if (VALUE_FLAGS.has(a)) {
      const v = inlineValue ?? String(argv[++i]);
      const kind = VALUE_FLAGS.get(a);
      out.flags.push(a);
      if (kind === "method") out.method = v.toUpperCase();
      else if (kind === "header") out.headers.push(v);
      else if (kind === "raw" || kind === "field") {
        const eq = v.indexOf("=");
        const k = eq < 0 ? v : v.slice(0, eq);
        out.fields[k] = eq < 0 ? "" : v.slice(eq + 1);
        out.fieldKinds[k] = kind;
      } else out[kind] = v;
    } else if (BOOL_FLAGS.has(a)) out.flags.push(a);
    else if (a.startsWith("-")) out.unknown.push(a);
    else out.positionals.push(a);
  }
  out.endpoint = out.positionals[0] ?? null;
  // gh's own rule: no explicit method → POST when any field or --input is present, else GET.
  const effective = out.method ?? (Object.keys(out.fields).length > 0 || out.input !== undefined ? "POST" : "GET");
  out.effectiveMethod = effective;
  return out;
}

/** True when a GraphQL document is a read-only query: operation type `query` (or the anonymous `{` shorthand), and
 * no `mutation`/`subscription` keyword anywhere. Deliberately stricter than GraphQL's grammar. */
export function isReadOnlyQuery(doc) {
  if (typeof doc !== "string") return false;
  const stripped = doc.replace(/#[^\n]*/g, "").trim();
  if (!(/^query\b/.test(stripped) || stripped.startsWith("{"))) return false;
  return !/\b(mutation|subscription)\b/i.test(stripped);
}

// ---------------------------------------------------------------------------------------------------------------
// Routing: SPEC-05A §5.1, one entry per reader.

export function routeRest(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.startsWith(PREFIX)) return null;
  const rest = endpoint.slice(PREFIX.length);
  let m;
  if ((m = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest))) return { kind: "compare", base: m[1], head: m[2] };
  if ((m = /^pulls\?head=([^&]+)&state=all&per_page=100$/.exec(rest))) {
    const decoded = decodeURIComponent(m[1]);
    if (!decoded.startsWith(`${OWNER}:`)) return null;
    return { kind: "head-branch-prs", headRef: decoded.slice(OWNER.length + 1) };
  }
  if (rest === `rules/branches/${PRODUCTION_REF}`) return { kind: "branch-rules" };
  if ((m = /^activity\?ref=([^&]+)&activity_type=(force_push|branch_deletion|branch_creation)&time_period=year&per_page=100$/.exec(rest))) {
    if (decodeURIComponent(m[1]) !== `refs/heads/${PRODUCTION_REF}`) return null;
    return { kind: "activity", activityType: m[2] };
  }
  if ((m = new RegExp(`^actions/workflows/${WORKFLOW_ID}/runs\\?head_sha=([0-9a-f]{40})&event=pull_request&per_page=100$`).exec(rest))) {
    return { kind: "candidate-runs", headSha: m[1] };
  }
  if ((m = /^actions\/runs\/([1-9][0-9]*)\/jobs\?filter=latest&per_page=100$/.exec(rest))) return { kind: "run-jobs", runId: m[1] };
  if ((m = /^contents\/(\.github\/workflows\/ci\.yml|scripts\/classify-changes\.mjs)\?ref=([0-9a-f]{40})$/.exec(rest))) {
    return { kind: "file-blob", path: m[1], ref: m[2] };
  }
  return null;
}

export function routeGraphql(query, variables) {
  if (!isReadOnlyQuery(query)) return null;
  if (variables?.owner !== OWNER || variables?.name !== NAME) return null;
  if (query.includes("statusCheckRollup")) return { kind: "commit-rollup", headSha: variables.h };
  if (query.includes("reviewThreads")) return { kind: "review-evidence", number: Number(variables.n) };
  if (query.includes("associatedPullRequests")) return { kind: "pr-context", number: Number(variables.n), headSha: variables.h };
  if (query.includes("headRefOid")) return { kind: "pr-key", number: Number(variables.n) };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The world: recorded bodies keyed by route kind. A value is a body, `{ fail: { status, stderr, stdout } }`, or an
// array of those (one per successive call, the last repeating), or (in process only) a function of the route.

const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../fixtures");

export function fixture(rel) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), "utf8"));
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../..");

/** Git's blob id of a file in the checkout under test: sha1("blob <size>\0" + bytes), computed here, not imported. */
function localBlob(rel) {
  const bytes = fs.readFileSync(path.join(REPO_ROOT, rel));
  return crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");
}

/** The recorded blob answers carry production's CI definition at 6cdd830b. The fake answers with the checkout's own
 * definition instead, so production "is" this checkout's CI wherever the suite runs (archive, checkout, CI merge ref). */
function blobAnswer(rel, recorded) {
  const bytes = fs.statSync(path.join(REPO_ROOT, rel)).size;
  return { ...recorded, sha: localBlob(rel), size: bytes };
}

/** The recorded #800 world exactly as captured (2026-10-07): an open draft at fe62f51f, production 6cdd830b. */
export function world800() {
  return {
    "pr-key": fixture("pr-key/pr-800-open-draft.json"),
    compare: fixture("base/compare-800.json"),
    "pr-context": fixture("base/pr-context-800.json"),
    "head-branch-prs": fixture("base/head-branch-prs-800.json"),
    "branch-rules": fixture("base/rules-production-unprotected.json"),
    "activity:force_push": fixture("base/activity-force-push-none.json"),
    "activity:branch_deletion": fixture("base/activity-branch-deletion-none.json"),
    "activity:branch_creation": fixture("base/activity-branch-creation-initial.json"),
    "candidate-runs": fixture("ci/runs-800.json"),
    "run-jobs": fixture("ci/jobs-800.json"),
    "review-evidence": fixture("review/review-800.json"),
    "commit-rollup": fixture("rollup/rollup-800.json"),
    "file-blob:.github/workflows/ci.yml": blobAnswer(".github/workflows/ci.yml", fixture("blob/contents-ci.yml-6cdd830b.json")),
    "file-blob:scripts/classify-changes.mjs": blobAnswer("scripts/classify-changes.mjs", fixture("blob/contents-classify-changes.mjs-6cdd830b.json")),
  };
}

function worldKey(route) {
  if (route.kind === "activity") return `activity:${route.activityType}`;
  if (route.kind === "file-blob") return `file-blob:${route.path}`;
  return route.kind;
}

/** Pick the world's answer for a route. `counts` tracks successive calls per key; `{ __seq: [...] }` answers per
 * call, the last element repeating. */
function answer(world, route, counts) {
  const key = worldKey(route);
  const n = counts[key] ?? 0;
  counts[key] = n + 1;
  let v = world[key];
  if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.__seq)) v = v.__seq[Math.min(n, v.__seq.length - 1)];
  if (typeof v === "function") v = v(route, n);
  if (v === undefined) return { fail: { status: 1, stderr: `gh: Not Found (HTTP 404) [fake: no ${key}]` } };
  return v;
}

/** Consistency the fake enforces itself, so a reader asking for the wrong thing gets a 404 like GitHub would. */
function consistent(world, route) {
  const key = world["pr-key"];
  const first = key && typeof key === "object" && Array.isArray(key.__seq) ? key.__seq[0] : key;
  const pr = first?.data?.repository?.pullRequest;
  if (!pr || typeof pr !== "object") return true;
  switch (route.kind) {
    case "pr-key": case "review-evidence": return route.number === pr.number;
    case "pr-context": return route.number === pr.number && route.headSha === pr.headRefOid;
    case "compare": return route.head === pr.headRefOid;
    case "candidate-runs": case "commit-rollup": return route.headSha === pr.headRefOid;
    case "head-branch-prs": return route.headRef === pr.headRefName;
    default: return true;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The two entry points.

/**
 * Request-level fake (the createReaders transport): `request({ label, rest } | { label, graphql, variables })`.
 * Returns `{ ok: true, body }` or `{ ok: false, reason: "read_failed", detail }`.
 */
export function makeFakeRequest(world, log = []) {
  const counts = {};
  const request = (req) => {
    const entry = { via: "request", label: req?.label, rest: req?.rest, graphql: req?.graphql, variables: req?.variables };
    let route = null;
    if (typeof req?.rest === "string") route = routeRest(req.rest);
    else if (typeof req?.graphql === "string") route = routeGraphql(req.graphql, req.variables);
    entry.route = route;
    entry.readOnly = typeof req?.rest === "string" ? true : isReadOnlyQuery(req?.graphql);
    log.push(entry);
    if (!route) return { ok: false, reason: "read_failed", detail: `${req?.label}: fake: unrouted request` };
    if (!world.__lenient && !consistent(world, route)) return { ok: false, reason: "read_failed", detail: `${req?.label}: gh: Not Found (HTTP 404)` };
    const a = answer(world, route, counts);
    if (a && typeof a === "object" && "fail" in a && Object.keys(a).length === 1) {
      return { ok: false, reason: "read_failed", detail: `${req?.label}: ${a.fail.stderr ?? "fail"}` };
    }
    return { ok: true, body: JSON.parse(JSON.stringify(a)) };
  };
  return request;
}

/**
 * gh-level fake: `(argv, env) → { status, stdout, stderr }`. Logs method, endpoint, query, environment facts.
 */
export function makeGhResponder(world, log = [], opts = {}) {
  const counts = opts.counts ?? {};
  return (argv, env = {}) => {
    const p = parseGhArgv(argv);
    const entry = {
      via: "gh",
      argv: argv.map(String),
      command: p.command,
      endpoint: p.endpoint,
      effectiveMethod: p.effectiveMethod,
      explicitMethod: p.method,
      flags: p.flags,
      unknownFlags: p.unknown,
      headers: p.headers,
      fieldKinds: p.fieldKinds,
      query: p.fields.query,
      envKeys: Object.keys(env).sort(),
      env: { HOME: env.HOME, GH_CONFIG_DIR: env.GH_CONFIG_DIR, GH_HOST: env.GH_HOST, PATH: env.PATH },
      ghTokenPresent: typeof env.GH_TOKEN === "string" && env.GH_TOKEN.length > 0,
      ghTokenValue: env.GH_TOKEN,
      configDirEntries: null,
    };
    try { if (env.GH_CONFIG_DIR) entry.configDirEntries = fs.readdirSync(env.GH_CONFIG_DIR); } catch { entry.configDirEntries = "unreadable"; }
    let route = null;
    if (p.command === "api" && p.endpoint === "graphql") {
      const vars = {};
      for (const [k, v] of Object.entries(p.fields)) if (k !== "query") vars[k] = p.fieldKinds[k] === "field" && /^-?\d+$/.test(v) ? Number(v) : v;
      entry.variables = vars;
      entry.readOnly = isReadOnlyQuery(p.fields.query) && p.input === undefined && !p.flags.includes("--paginate");
      route = routeGraphql(p.fields.query, vars);
    } else if (p.command === "api") {
      entry.readOnly = p.effectiveMethod === "GET" && p.input === undefined && !p.flags.includes("--paginate");
      route = entry.readOnly ? routeRest(p.endpoint) : null;
    } else entry.readOnly = false;
    entry.route = route;
    log.push(entry);
    const tok = env.GH_TOKEN;
    const echo = opts.echoToken && tok ? ` token=${tok}` : "";
    if (!route) return { status: 1, stdout: "", stderr: `gh: Not Found (HTTP 404) [fake: unrouted]${echo}\n` };
    if (!world.__lenient && !consistent(world, route)) return { status: 1, stdout: "", stderr: `gh: Not Found (HTTP 404)${echo}\n` };
    const a = answer(world, route, counts);
    if (a && typeof a === "object" && "fail" in a && Object.keys(a).length === 1) {
      const f = a.fail;
      return { status: f.status ?? 1, stdout: f.stdout ?? "", stderr: (f.stderr ?? "gh: failure") + echo + "\n", signal: f.signal ?? null, error: f.error };
    }
    if (a && typeof a === "object" && "__raw" in a) return { status: 0, stdout: a.__raw, stderr: opts.echoToken ? `note${echo}\n` : "" };
    return { status: 0, stdout: JSON.stringify(a), stderr: opts.echoToken ? `gh: notice${echo}\n` : "" };
  };
}

/** An injected `spawn` (spawnSync-shaped) around the gh responder. Anything but `gh` is refused and logged. */
export function makeFakeSpawn(world, log = [], opts = {}) {
  const gh = makeGhResponder(world, log, opts);
  return (cmd, args, options = {}) => {
    if (cmd !== "gh") {
      log.push({ via: "spawn", command: String(cmd), argv: (args ?? []).map(String), readOnly: false, route: null, nonGh: true });
      return { status: 127, stdout: "", stderr: `fake: refused ${cmd}\n`, signal: null, pid: 0, output: [] };
    }
    const r = gh(args ?? [], options.env ?? {});
    const enc = options.encoding;
    const wrap = (s) => (enc ? s : Buffer.from(s ?? ""));
    return { pid: 4242, status: r.status, signal: r.signal ?? null, stdout: wrap(r.stdout), stderr: wrap(r.stderr), output: [null, wrap(r.stdout), wrap(r.stderr)], error: r.error };
  };
}

/**
 * Write an executable `gh` shim into `dir` that answers from `world` (JSON-serializable form) and appends one JSON
 * line per invocation to `logFile`. The shim needs nothing from its environment: the child environment the
 * collector builds holds only PATH, HOME, GH_CONFIG_DIR, GH_TOKEN and fixed settings.
 */
export function writeGhShim({ dir, world, logFile, nodePath, opts = {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const worldFile = path.join(dir, "world.json");
  fs.writeFileSync(worldFile, JSON.stringify({ world, opts }));
  const runner = path.join(dir, "fake-gh-main.mjs");
  const self = new URL(import.meta.url).pathname;
  fs.writeFileSync(
    runner,
    `import fs from "node:fs";\n` +
      `import { makeGhResponder } from ${JSON.stringify(self)};\n` +
      `const { world, opts } = JSON.parse(fs.readFileSync(${JSON.stringify(worldFile)}, "utf8"));\n` +
      `const countsFile = ${JSON.stringify(path.join(dir, "counts.json"))};\n` +
      `let counts = {}; try { counts = JSON.parse(fs.readFileSync(countsFile, "utf8")); } catch {}\n` +
      `const log = [];\n` +
      `const respond = makeGhResponder(world, log, { ...opts, counts });\n` +
      `const r = respond(process.argv.slice(2), process.env);\n` +
      `fs.writeFileSync(countsFile, JSON.stringify(counts));\n` +
      `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(log[0]) + "\\n");\n` +
      `if (r.stdout) process.stdout.write(r.stdout);\n` +
      `if (r.stderr) process.stderr.write(r.stderr);\n` +
      `process.exitCode = r.status ?? 0;\n`,
  );
  const shim = path.join(dir, "gh");
  fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(nodePath)} ${JSON.stringify(runner)} "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

export function readShimLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
