#!/usr/bin/env node
// HON-8 D4: hosted contract publication. OPERATOR'S OWN MACHINE ONLY. Design: machines/HON8-D4-HOSTED-RUNNER-DESIGN.md v2.
// Nothing runs without an approval token that Sam wrote and whose sha256 he quoted. --dry-run (the default) is what the VPS runs:
// it prints the plan and its sha256, never reads the key, and makes no network call. The logic and every refusal live in
// scripts/lib/hosted-publish.mjs and are tested against fakes; this file only wires the real effects.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, resolve, relative, isAbsolute } from "node:path";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { runHosted, makeHostedClient, makeFsLedger, sha256, Refusal } from "./lib/hosted-publish.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const PRODUCTION_BRANCH = "claude/build-hone-saas-hOex7";
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const publish = args.includes("--publish");
const known = (a) => a === "--dry-run" || a === "--publish" || /^--(approval|expect-token-sha256)=\S+$/.test(a);
if (!args.every(known) || (publish && args.includes("--dry-run")) || (publish && (!flag("approval") || !flag("expect-token-sha256")))) {
  console.error("Usage:\n  node scripts/publish-machine-contracts-hosted.mjs [--dry-run]\n  node scripts/publish-machine-contracts-hosted.mjs --publish --approval=<token file outside the repo> --expect-token-sha256=<sha256 Sam quoted>\nHosted key in HONE_HOSTED_SERVICE_KEY, URL in HONE_HOSTED_URL. Operator's own machine, a terminal, never CI.");
  process.exit(2);
}

function buildPlan() {
  const output = mkdtempSync(join(tmpdir(), "hone-machine-publication-"));
  try {
    const ts = createRequire(import.meta.url)("typescript");
    const program = ts.createProgram([join(root, "lib/machines/contract-publication.ts")], {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true, skipLibCheck: true, types: [], outDir: output, noEmitOnError: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
    program.emit();
    const plan = createRequire(import.meta.url)(join(output, "contract-publication.js")).planContractPublication();
    // Same hash as publish-machine-contracts.mjs --dry-run, so the operator compares it with the sha256 the VPS recorded.
    return { plan, planSha256: sha256(JSON.stringify(plan)) };
  } finally { rmSync(output, { recursive: true, force: true }); }
}

// Only the DECLARED git/fs/tty effects; every child process gets a scrubbed environment so the key can never be inherited.
const scrubbed = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
const git = (a) => execFileSync("git", a, { cwd: root, env: scrubbed, encoding: "utf8" }).trim();
const ledgerDir = join(homedir(), ".hone-publish-ledger");
const receiptsDir = join(root, "docs/production/hosted-publication-receipts");
function writeAtomic(dir, name, body) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
  renameSync(tmp, join(dir, name));
}

try {
  const dry = !publish;
  const out = await runHosted({
    dryRun: dry,
    env: process.env,
    execArgv: process.execArgv,
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    productionBranch: PRODUCTION_BRANCH,
    expectTokenSha256: flag("expect-token-sha256"),
    now: () => Date.now(),
    stdout: (s) => console.log(s),
    plan: buildPlan,
    vpsMarker: () => {
      if (existsSync(join(homedir(), "hone-handoffs/heavy-slot"))) return "heavy-slot file";
      if (process.env.HONE_SLOT_HOLDER) return "HONE_SLOT_HOLDER";
      try {
        const names = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { env: scrubbed, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        if (/supabase_db_hone-/.test(names)) return "a local hone-* Supabase container";
      } catch { /* no docker: not a VPS marker */ }
      return null;
    },
    readToken: () => {
      const file = resolve(flag("approval"));
      const rel = relative(root, file);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Refusal("the approval token must live OUTSIDE the repository");
      return readFileSync(file, "utf8");
    },
    git: (a) => (a[0] === "status" ? git(["status", "--porcelain", "--untracked-files=all"]) : git(a)),
    isAncestorOfProduction: (head) => {
      git(["fetch", "--quiet", "origin", PRODUCTION_BRANCH]);
      try { git(["merge-base", "--is-ancestor", head, `origin/${PRODUCTION_BRANCH}`]); return true; } catch { return false; }
    },
    systemRef: () => readFileSync(join(root, "supabase/.temp/project-ref"), "utf8").trim(),
    declaredMigrationMax: () => JSON.parse(readFileSync(join(root, "docs/production/migration-state.json"), "utf8")).hosted_migration_max,
    runtimeVersions: () => ({ node: process.version }),
    prompt: async (q) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } },
    client: ({ url, key }) => makeHostedClient({ url, key }),
    ledger: makeFsLedger(ledgerDir),
    committedReceiptExists: (tokenSha) => existsSync(join(receiptsDir, `${tokenSha}.json`)),
    writeRepoReceipt: (tokenSha, body) => writeAtomic(receiptsDir, `${tokenSha}.json`, body),
  });
  if (out.dryRun) {
    console.log(JSON.stringify({ mode: "dry-run", plan_sha256: out.planSha256, would_publish: out.planned, note: "no key read, no network call, nothing written" }, null, 2));
  } else {
    console.log(`complete. Receipt: docs/production/hosted-publication-receipts/${out.token_sha256}.json (commit it).`);
  }
} catch (e) {
  console.error(e instanceof Refusal ? `REFUSED: ${e.message}` : `FAILED: ${e.message}`);
  process.exit(e instanceof Refusal ? 3 : 1);
}
