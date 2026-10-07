// Named check rows for 05C (`runShepherdCli`, in process, with an injected fake `gh` spawn). Expected values
// come from README "Shepherd", CLAUDE.md §4, SPEC-05A §5.1/§5.4 and the operator's 05C list; never from the code.

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLOSED_REASONS, ALL_DECISIONS, PRODUCTION_REF } from "./oracle";
// @ts-expect-error untyped support module
import { makeFakeSpawn, isReadOnlyQuery, routeRest } from "./support/fake-gh.mjs";
// @ts-expect-error untyped support module
import { WORLDS, FAILING_WORLDS, world, HEAD, PROD_TIP } from "./support/worlds.mjs";

export const TOKEN = "ghp_VERIFYbcFakeToken0Canary0000000000000"; // token-shaped, not a credential
export const NOW = "2026-10-07T20:00:00Z";
export const TOOL = "eng-loop-v1@efc7e1865d434ed7ea44aba33cd12b0c2703bcd0";
const CANARIES = {
  GITHUB_TOKEN: "ghp_PARENTcanaryGITHUBTOKEN000000000000000",
  GH_ENTERPRISE_TOKEN: "ghp_PARENTcanaryENTERPRISE00000000000000",
  GH_DEBUG: "api",
  GH_REPO: "evil/repo",
  SECRET_CANARY: "do-not-inherit",
  HTTPS_PROXY: "http://127.0.0.1:9",
};

export type Run = { code: number | undefined; out: string; err: string; log: any[]; receiptsDir: string; threw?: any };
export type RunCli = (args: any) => any;

export function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** One in-process shepherd run against a fake world. */
export function runIn(runCli: RunCli, argv: string[], w: any, o: { token?: string | null; env?: any; receiptsDir?: string; spawnOpts?: any; params?: any } = {}): Run {
  const log: any[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const receiptsDir = o.receiptsDir ?? tmpDir("vbc-rc-");
  const env: any = { PATH: "/usr/bin:/bin", HOME: "/home/operator-session", ...CANARIES, ...(o.env ?? {}) };
  if (o.token !== null) env.HONE_ENG_READ_TOKEN = o.token ?? TOKEN;
  let code: number | undefined;
  let threw: any;
  try {
    code = runCli({
      argv,
      env,
      out: { write: (c: any) => (out.push(String(c)), true) },
      err: { write: (c: any) => (err.push(String(c)), true) },
      now: () => NOW,
      spawn: makeFakeSpawn(w, log, o.spawnOpts ?? {}),
      toolVersion: TOOL,
      receiptsDir,
      ...(o.params ?? {}),
    });
  } catch (e) {
    threw = e;
  }
  return { code, out: out.join(""), err: err.join(""), log, receiptsDir, threw };
}

const MAX = 25;
function rowResult(row: string, clause: string) {
  const r: any = { row, clause, checked: 0, violations: [] as any[], total: 0 };
  r.add = (id: string, msg: string) => {
    r.total += 1;
    if (r.violations.length < MAX) r.violations.push({ id, msg });
  };
  return r;
}

/** Exactly one JSON document on stdout, nothing else (surrounding whitespace allowed). */
export function parseOnlyJson(stdout: string): { ok: boolean; value?: any; why?: string } {
  const t = stdout.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return { ok: false, why: `stdout is not one JSON object: ${JSON.stringify(stdout.slice(0, 80))}` };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (e: any) {
    return { ok: false, why: `JSON.parse: ${e.message}` };
  }
}

// The operator's 05C list, mapped to README's report fields.
export const REQUIRED_FIELDS: [string, (r: any) => boolean][] = [
  ["pr (PR number)", (r) => "pr" in r],
  ["headSha (full head SHA)", (r) => "headSha" in r],
  ["production.ref", (r) => r.production && "ref" in r.production],
  ["production.tip", (r) => r.production && "tip" in r.production],
  ["baseRef (PR base ref)", (r) => "baseRef" in r],
  ["observedAt (observation time)", (r) => "observedAt" in r],
  ["toolVersion", (r) => "toolVersion" in r],
  ["evidenceHash", (r) => "evidenceHash" in r],
  ["decision", (r) => "decision" in r],
  ["reasonCodes (closed reason codes)", (r) => "reasonCodes" in r],
  ["blocking (blocking evidence)", (r) => "blocking" in r],
  ["sourceReferences", (r) => Array.isArray(r.sourceReferences)],
  ["nextAction (bounded next action)", (r) => "nextAction" in r],
  ["humanMergeRequired: true", (r) => r.humanMergeRequired === true],
];

const exitFor = (decision: string) => (decision === "CANDIDATE_READY_FOR_HUMAN_REVIEW" ? 0 : decision === "UNKNOWN" ? 3 : 4);
const want = (w: any) => (w.decision === "UNKNOWN" ? `UNKNOWN(${w.reason})` : w.decision);
const got = (r: any) => (r?.decision === "UNKNOWN" ? `UNKNOWN(${r?.reasonCodes?.[0]})` : String(r?.decision));

export type Scenario = { name: string; w: any; decision: string; reason?: string; expectTip: string | null; expectHead: string | null; expectBaseRef: string | null; collectedHash?: string | null };

export function scenarios(collect?: (w: any) => any): Scenario[] {
  const s: Scenario[] = [];
  for (const w of WORLDS) {
    const built = world(...w.steps);
    const terminal = w.steps.includes("merged");
    const feature = w.steps.includes("featureBase");
    s.push({
      name: w.name,
      w: built,
      decision: w.decision,
      reason: w.reason,
      // production.tip: production's tip is only established when the PR's base IS production and the key is open
      // (README: "Fields that could not be established are null, never guessed").
      expectTip: terminal || feature ? null : PROD_TIP,
      expectHead: HEAD,
      expectBaseRef: feature ? "feat/other-base" : PRODUCTION_REF,
      collectedHash: collect ? collect(built) : undefined,
    });
  }
  for (const f of FAILING_WORLDS) s.push({ name: f.name, w: f.build(), decision: f.decision, reason: f.reason, expectTip: null, expectHead: null, expectBaseRef: null, collectedHash: null });
  return s;
}

// ---------------------------------------------------------------------------------------------------------------

export function checkShepherd(runCli: RunCli, scen: Scenario[]) {
  const R = {
    json: rowResult("C-JSON", "operator/README: --json writes ONLY one JSON document to stdout; diagnostics to stderr"),
    fields: rowResult("C-FIELDS", "operator 05C output list; README report fields; humanMergeRequired true"),
    decision: rowResult("C-DECISION", "05C reports 05B's decision for 05A's evidence (SPEC-05B via the hand-derived world table)"),
    values: rowResult("C-VALUES", "README: full head SHA, production ref and tip, base ref, observedAt, toolVersion, evidenceHash; unestablished fields null, never guessed"),
    exit: rowResult("C-EXIT", "README exit codes: 0 candidate, 4 definite non-candidate, 3 UNKNOWN; a successful read is not READY"),
    nomut: rowResult("C-NOMUT", "operator/README: no GitHub mutation; every request a REST GET or a GraphQL query"),
    env: rowResult("C-ENV", "SPEC-05A §5.1: child env built from nothing (PATH, fresh empty HOME = GH_CONFIG_DIR, GH_TOKEN); no credential inherited"),
    token: rowResult("C-TOKEN", "operator: the token is never in stdout, stderr or a receipt; never an argument"),
    receipt: rowResult("C-RECEIPT", "README receipts: one write-once receipt per run; closed schema; receipt state reported"),
  };
  for (const sc of scen) {
    const run = runIn(runCli, ["shepherd", "800", "--json"], sc.w);
    for (const row of Object.values(R)) row.checked += 1;
    if (run.threw) {
      R.json.add(sc.name, `runShepherdCli threw ${String(run.threw?.message ?? run.threw)}`);
      continue;
    }
    const j = parseOnlyJson(run.out);
    if (!j.ok) {
      R.json.add(sc.name, j.why!);
      continue;
    }
    const rep = j.value;
    for (const [name, has] of REQUIRED_FIELDS) if (!has(rep)) R.fields.add(sc.name, `missing ${name}`);
    if (!ALL_DECISIONS.includes(rep.decision)) R.fields.add(sc.name, `decision ${rep.decision}`);
    if (!Array.isArray(rep.reasonCodes) || rep.reasonCodes.length !== 1 || (rep.decision === "UNKNOWN" ? !CLOSED_REASONS.includes(rep.reasonCodes[0]) : rep.reasonCodes[0] !== rep.decision)) R.fields.add(sc.name, `reasonCodes ${JSON.stringify(rep.reasonCodes)}`);
    if (typeof rep.nextAction !== "string" || rep.nextAction.length === 0 || rep.nextAction.length > 400) R.fields.add(sc.name, "nextAction unbounded or missing");
    for (const u of rep.sourceReferences ?? []) if (typeof u !== "string" || !u.startsWith("https://github.com/SaiSamyukthVemuri/Hone/")) R.fields.add(sc.name, `sourceReference ${u}`);
    if (got(rep) !== want(sc)) R.decision.add(sc.name, `reported ${got(rep)}, want ${want(sc)}`);
    // values
    if (rep.pr !== 800) R.values.add(sc.name, `pr ${rep.pr}`);
    if (rep.headSha !== sc.expectHead) R.values.add(sc.name, `headSha ${rep.headSha}, want ${sc.expectHead}`);
    if (rep.production?.ref !== PRODUCTION_REF) R.values.add(sc.name, `production.ref ${rep.production?.ref}`);
    if ((rep.production?.tip ?? null) !== sc.expectTip) R.values.add(sc.name, `production.tip ${rep.production?.tip}, want ${sc.expectTip}`);
    if ((rep.baseRef ?? null) !== sc.expectBaseRef) R.values.add(sc.name, `baseRef ${rep.baseRef}, want ${sc.expectBaseRef}`);
    if (rep.observedAt !== NOW) R.values.add(sc.name, `observedAt ${rep.observedAt}`);
    if (rep.toolVersion !== TOOL) R.values.add(sc.name, `toolVersion ${rep.toolVersion}`);
    if (sc.collectedHash !== undefined && (rep.evidenceHash ?? null) !== sc.collectedHash) R.values.add(sc.name, `evidenceHash ${rep.evidenceHash}, collector's ${sc.collectedHash}`);
    if (rep.evidenceHash !== null && !/^[0-9a-f]{64}$/.test(rep.evidenceHash)) R.values.add(sc.name, `evidenceHash shape ${rep.evidenceHash}`);
    if (run.code !== exitFor(rep.decision) || run.code !== exitFor(sc.decision)) R.exit.add(sc.name, `exit ${run.code} for ${got(rep)}`);
    // no mutation
    for (const c of run.log) {
      if (c.nonGh || c.command !== "api" || c.readOnly !== true) R.nomut.add(sc.name, `non-read request: ${JSON.stringify(c.argv ?? c).slice(0, 160)}`);
      if (c.endpoint && c.endpoint !== "graphql" && !routeRest(c.endpoint)) R.nomut.add(sc.name, `REST endpoint outside SPEC-05A §5.1: ${c.endpoint}`);
      if (c.endpoint === "graphql" && !isReadOnlyQuery(c.query)) R.nomut.add(sc.name, `GraphQL document is not a read-only query`);
      if ((c.unknownFlags ?? []).length) R.nomut.add(sc.name, `unknown gh flags ${c.unknownFlags.join(" ")}`);
    }
    // environment
    for (const c of run.log) {
      if (c.nonGh) continue;
      const keys: string[] = c.envKeys ?? [];
      for (const k of Object.keys(CANARIES)) if (keys.includes(k)) R.env.add(sc.name, `child env inherits ${k}`);
      if (keys.includes("HONE_ENG_READ_TOKEN")) R.env.add(sc.name, "child env carries HONE_ENG_READ_TOKEN");
      if (c.ghTokenValue !== TOKEN) R.env.add(sc.name, "GH_TOKEN is not the dedicated token");
      if (!c.env?.HOME || c.env.HOME !== c.env.GH_CONFIG_DIR) R.env.add(sc.name, `HOME ${c.env?.HOME} != GH_CONFIG_DIR ${c.env?.GH_CONFIG_DIR}`);
      if (c.env?.HOME === "/home/operator-session") R.env.add(sc.name, "HOME is the operator's");
      if (Array.isArray(c.configDirEntries) ? c.configDirEntries.length > 0 : true) R.env.add(sc.name, `GH_CONFIG_DIR not an empty directory: ${JSON.stringify(c.configDirEntries)}`);
      if (c.env?.PATH !== "/usr/bin:/bin") R.env.add(sc.name, `PATH ${c.env?.PATH}`);
      if ((c.argv ?? []).some((a: string) => a.includes(TOKEN))) R.token.add(sc.name, "token passed as an argument");
    }
    if (run.out.includes(TOKEN) || run.err.includes(TOKEN)) R.token.add(sc.name, "token printed");
    // receipt
    const files = fs.existsSync(run.receiptsDir) ? fs.readdirSync(run.receiptsDir) : [];
    if (rep.receipt !== "written") R.receipt.add(sc.name, `receipt ${rep.receipt}`);
    if (files.length !== 1) R.receipt.add(sc.name, `${files.length} files in the receipts directory`);
    for (const f of files) {
      const text = fs.readFileSync(path.join(run.receiptsDir, f), "utf8");
      if (text.includes(TOKEN)) R.token.add(sc.name, "token in a receipt");
      let rec: any;
      try {
        rec = JSON.parse(text);
      } catch {
        R.receipt.add(sc.name, `receipt ${f} is not JSON`);
        continue;
      }
      const KEYS = ["checksum", "decision", "evidenceHash", "head", "observed_at", "pr", "reasons", "schema", "tool_version"];
      if (JSON.stringify(Object.keys(rec).sort()) !== JSON.stringify(KEYS)) R.receipt.add(sc.name, `receipt keys ${Object.keys(rec).sort()}`);
      if (rec.pr !== rep.pr || rec.head !== rep.headSha || rec.evidenceHash !== rep.evidenceHash || rec.decision !== rep.decision || JSON.stringify(rec.reasons) !== JSON.stringify(rep.reasonCodes) || rec.observed_at !== rep.observedAt || rec.tool_version !== rep.toolVersion) {
        R.receipt.add(sc.name, `receipt disagrees with the report: ${text.slice(0, 160)}`);
      }
      if (/https?:\/\/|login|SaiSamyukthVemuri|chatgpt-codex|detail/i.test(text)) R.receipt.add(sc.name, "receipt holds a URL, login or detail");
    }
  }
  return Object.values(R);
}

/** C-TEXT: text mode carries the same facts and the same exit code, and is not JSON. */
export function checkText(runCli: RunCli, scen: Scenario[]) {
  const r = rowResult("C-TEXT", "README: `shepherd <pr>` prints the same facts as text; exit codes are the same");
  for (const sc of scen) {
    r.checked += 1;
    const tj = runIn(runCli, ["shepherd", "800", "--json"], sc.w, { receiptsDir: tmpDir("vbc-rc-") });
    const tt = runIn(runCli, ["shepherd", "800"], sc.w, { receiptsDir: tmpDir("vbc-rc-") });
    const j = parseOnlyJson(tj.out);
    if (!j.ok) {
      r.add(sc.name, "json run did not parse");
      continue;
    }
    const rep = j.value;
    if (tt.code !== tj.code) r.add(sc.name, `text exit ${tt.code} vs json exit ${tj.code}`);
    if (parseOnlyJson(tt.out).ok) r.add(sc.name, "text mode printed JSON");
    const text = tt.out;
    const need: [string, string | null][] = [
      ["decision", rep.decision],
      ["reason", rep.decision === "UNKNOWN" ? rep.reasonCodes[0] : null],
      ["headSha", rep.headSha],
      ["evidenceHash", rep.evidenceHash],
      ["nextAction", rep.nextAction],
      ["observedAt", rep.observedAt],
      ["toolVersion", rep.toolVersion],
      ["production tip", rep.production?.tip],
      ["receipt state", rep.receipt],
    ];
    for (const [n, v] of need) if (v !== null && v !== undefined && !text.includes(String(v))) r.add(sc.name, `text lacks ${n} (${String(v).slice(0, 40)})`);
    if (!/human/i.test(text)) r.add(sc.name, "text does not say a human authorizes the merge");
    if (/NaN/.test(text)) r.add(sc.name, `text renders an unestablished value as NaN: ${text.split("\n").find((l) => l.includes("NaN"))?.trim()}`);
    if (text.includes(TOKEN) || tt.err.includes(TOKEN)) r.add(sc.name, "token printed in text mode");
  }
  return r;
}

/** C-USAGE: exit 2; zero requests; in --json mode stdout is one JSON document carrying every required field. */
export const USAGE_ARGVS: string[][] = [
  ["shepherd", "--json"],
  ["shepherd", "abc", "--json"],
  ["shepherd", "800", "--json", "--bogus"],
  ["shepherd", "0", "--json"],
  ["shepherd", "-5", "--json"],
  ["shepherd", "800", "801", "--json"],
  ["shepherd", "1e3", "--json"],
  ["shepherd", "800.0", "--json"],
  ["shepherd", " 800", "--json"],
  ["shepherd", "99999999999999999999", "--json"],
  ["shepherd", "--json", "--no-receipt"],
];
export function checkUsage(runCli: RunCli) {
  const r = rowResult("C-USAGE", "README exit 2 = usage error, in --json mode still one JSON document; operator: every required field on every path");
  for (const argv of USAGE_ARGVS) {
    r.checked += 1;
    const run = runIn(runCli, argv, world());
    if (run.code !== 2) r.add(argv.join(" "), `exit ${run.code}`);
    if (run.log.length > 0) r.add(argv.join(" "), `${run.log.length} requests on a usage error`);
    const j = parseOnlyJson(run.out);
    if (!j.ok) {
      r.add(argv.join(" "), j.why!);
      continue;
    }
    const missing = REQUIRED_FIELDS.filter(([, has]) => !has(j.value)).map(([n]) => n);
    if (missing.length > 0) r.add(argv.join(" "), `usage JSON lacks: ${missing.join("; ")}`);
  }
  return r;
}

/** C-USAGE-EXIT: the part of C-USAGE the README states unambiguously (exit 2, one JSON document, no request). */
export function checkUsageExit(runCli: RunCli) {
  const r = rowResult("C-USAGE-EXIT", "README: exit 2 = usage error; in --json mode stdout is still one JSON document");
  for (const argv of [...USAGE_ARGVS, ["shepherd"], ["shepherd", "abc"]]) {
    r.checked += 1;
    const run = runIn(runCli, argv, world());
    if (run.code !== 2) r.add(argv.join(" "), `exit ${run.code}`);
    if (run.log.length > 0) r.add(argv.join(" "), "requests made");
    if (argv.includes("--json") && !parseOnlyJson(run.out).ok) r.add(argv.join(" "), "stdout is not one JSON document");
    if (!argv.includes("--json") && run.out.trim().startsWith("{")) r.add(argv.join(" "), "text-mode usage printed JSON");
  }
  return r;
}

/** C-NOTOKEN: without the dedicated token, no request is made: exit 3, UNKNOWN(read_failed). */
export function checkNoToken(runCli: RunCli) {
  const r = rowResult("C-NOTOKEN", "SPEC-05A §5.1 / CLAUDE.md §4: without HONE_ENG_READ_TOKEN no request; UNKNOWN(read_failed); never the gh session");
  for (const [n, env] of [
    ["unset", {}],
    ["empty", { HONE_ENG_READ_TOKEN: "" }],
    ["GH_TOKEN only", { GH_TOKEN: "ghp_SESSIONcanary00000000000000000000000" }],
  ] as [string, any][]) {
    r.checked += 1;
    const run = runIn(runCli, ["shepherd", "800", "--json"], world("ready", "protectedRules", "resolveOpenThread"), { token: null, env });
    const j = parseOnlyJson(run.out);
    if (run.log.length !== 0) r.add(n, `${run.log.length} requests without the token`);
    if (run.code !== 3) r.add(n, `exit ${run.code}`);
    if (!j.ok || got(j.value) !== "UNKNOWN(read_failed)") r.add(n, `reported ${j.ok ? got(j.value) : j.why}`);
    if (j.ok && j.value.instrumentation?.requests !== 0) r.add(n, `instrumentation.requests ${j.value.instrumentation?.requests}`);
  }
  return r;
}

/** C-TOKEN-ECHO: gh echoing the token (stderr on success and failure, non-JSON stdout, a GitHub body) never puts it
 * in stdout, stderr or a receipt. */
export function checkTokenEcho(runCli: RunCli) {
  const r = rowResult("C-TOKEN-ECHO", "SPEC-05A §5.1: an echo of the token is redacted; operator: never in stdout, stderr or a receipt");
  const cases: [string, any, any][] = [
    ["gh stderr echo on every call", world("ready", "protectedRules", "resolveOpenThread"), { echoToken: true }],
    ["gh failure stderr carries the token", { ...world(), "pr-key": { fail: { status: 1, stderr: `gh: HTTP 401: Bad credentials (Authorization: token ${TOKEN})` } } }, {}],
    ["gh non-JSON stdout carries the token", { ...world("ready"), compare: { __raw: `error: token ${TOKEN} rejected\n` } }, {}],
    ["review read fails mid-pass with the token", { ...world("ready"), "review-evidence": { fail: { status: 1, stderr: `${TOKEN}` } } }, {}],
    ["a GitHub body echoes the token into a failing context name", world("ready", "protectedRules", "resolveOpenThread", ["vercelContextName", `deploy ${TOKEN}`], ["vercelState", "FAILURE"]), {}],
  ];
  for (const [n, w, spawnOpts] of cases) {
    r.checked += 1;
    const run = runIn(runCli, ["shepherd", "800", "--json"], w, { spawnOpts });
    const files = fs.existsSync(run.receiptsDir) ? fs.readdirSync(run.receiptsDir).map((f) => fs.readFileSync(path.join(run.receiptsDir, f), "utf8")).join("\n") : "";
    const where = [run.out.includes(TOKEN) && "stdout", run.err.includes(TOKEN) && "stderr", files.includes(TOKEN) && "receipt"].filter(Boolean);
    if (where.length) r.add(n, `token in ${where.join(", ")}`);
    if (!parseOnlyJson(run.out).ok) r.add(n, "stdout not one JSON document");
  }
  return r;
}

/** C-RECEIPT-MODES: --no-receipt and an unwritable receipts directory. */
export function checkReceiptModes(runCli: RunCli) {
  const r = rowResult("C-RECEIPT-MODES", "README: receipt written | failed | disabled; a receipt failure never changes the decision or pollutes stdout");
  const w = world("ready", "protectedRules", "resolveOpenThread");
  {
    r.checked += 1;
    const dir = tmpDir("vbc-rc-");
    const run = runIn(runCli, ["shepherd", "800", "--json", "--no-receipt"], w, { receiptsDir: dir });
    const j = parseOnlyJson(run.out);
    if (!j.ok || j.value.receipt !== "disabled") r.add("--no-receipt", `receipt ${j.ok ? j.value.receipt : j.why}`);
    if (fs.readdirSync(dir).length !== 0) r.add("--no-receipt", "a receipt was written");
    if (run.code !== 0) r.add("--no-receipt", `exit ${run.code}`);
  }
  {
    r.checked += 1;
    const parent = tmpDir("vbc-rc-");
    const file = path.join(parent, "not-a-dir");
    fs.writeFileSync(file, "x");
    const run = runIn(runCli, ["shepherd", "800", "--json"], w, { receiptsDir: file });
    const j = parseOnlyJson(run.out);
    if (!j.ok) r.add("receipts dir is a file", j.why!);
    else {
      if (j.value.receipt !== "failed") r.add("receipts dir is a file", `receipt ${j.value.receipt}`);
      if (j.value.decision !== "CANDIDATE_READY_FOR_HUMAN_REVIEW" || run.code !== 0) r.add("receipts dir is a file", `decision ${j.value.decision} exit ${run.code}`);
    }
  }
  {
    r.checked += 1;
    const dir = tmpDir("vbc-rc-");
    const a = runIn(runCli, ["shepherd", "800", "--json"], w, { receiptsDir: dir });
    const b = runIn(runCli, ["shepherd", "800", "--json"], w, { receiptsDir: dir });
    const n = fs.readdirSync(dir).length;
    if (n !== 2) r.add("append", `${n} receipts after two runs`);
    const ja = parseOnlyJson(a.out), jb = parseOnlyJson(b.out);
    if (!ja.ok || !jb.ok || ja.value.decision !== jb.value.decision) r.add("append", "the second run decided differently with receipts present (decide must never read receipts)");
  }
  return r;
}
