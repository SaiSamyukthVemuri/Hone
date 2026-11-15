#!/usr/bin/env node
// Explicit operator tool. No .env loading, synthetic catalogue, hosted mode,
// server, or dependency installation. TypeScript is already a declared devDependency.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const apply = args.includes("--apply-local");
const owned = args.includes("--owned-target");
if (!(args.length === 1 && args[0] === "--dry-run") &&
    !(apply && args.length === (owned ? 3 : 2) && args.some((a) => /^--expect-plan=[a-f0-9]{64}$/.test(a)))) {
  console.error("Usage: node scripts/publish-machine-contracts.mjs --dry-run\nLocal only: --apply-local --expect-plan=<dry-run sha256> [--owned-target]\n  --owned-target: your OWN stack, named by the paired E2E_SUPABASE_URL + HONE_LOCAL_DB_URL (CLAUDE.md section 5) and HONE_SLOT_HOLDER=<the name in heavy-slot>.\nHosted publication is disabled pending Sam's privileged-write mechanism decision and per-change authorization.");
  process.exit(1);
}
const output = mkdtempSync(join(tmpdir(), "hone-machine-publication-"));
try {
  const { default: ts } = await import("typescript");
  const program = ts.createProgram([join(root, "lib/machines/contract-publication.ts")], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, strict: true,
    skipLibCheck: true, types: [], outDir: output, noEmitOnError: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => "\n",
  }));
  program.emit();
  const { planContractPublication, publishContracts } = createRequire(import.meta.url)(join(output, "contract-publication.js"));
  const plan = planContractPublication();
  const sha256 = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  // This output contains the exact RPC arguments and all skip reasons. No credentials.
  console.log(JSON.stringify({ sha256, ...plan }, null, 2));
  if (apply) {
    if (!args.includes(`--expect-plan=${sha256}`)) throw new Error("Catalogue plan changed; review a new dry-run before applying.");
    // A missing slot file is "no holder", refused below with its own message, never a raw ENOENT.
    let holder = "";
    try { holder = readFileSync(join(homedir(), "hone-handoffs/heavy-slot"), "utf8").trim(); } catch { /* no slot file */ }
    for (const name of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST"]) {
      if (process.env[name]) throw new Error("Local publication refuses a deployed environment.");
    }
    // The lane stack by default; with --owned-target, the paired owned stack. Either way the daemon mapping is READ, never inferred
    // from adjacent ports, and the API and SQL endpoints must be loopback containers of ONE Supabase project.
    let apiPort = "64821", dbPort = "64822", project = "hone-mpx-0223";
    if (owned) {
      if (!holder) throw new Error("--owned-target refused: there is no heavy-slot file or it is empty, so nobody holds the heavy-test slot.");
      // HONE_SLOT_HOLDER is an ATTESTATION that the operator is the holder, checked only against the slot file. The stack itself is
      // checked below by READING BACK the container mapping and project label for the paired ports, which proves the endpoints are one
      // local Supabase project and not the shared stack. NEITHER proves the stack is the holder's own; that cannot be established here.
      if (process.env.HONE_SLOT_HOLDER !== holder) throw new Error("--owned-target refused: HONE_SLOT_HOLDER must equal the current heavy-slot holder (an attestation; this tool cannot prove whose stack it is).");
      const api = process.env.E2E_SUPABASE_URL, db = process.env.HONE_LOCAL_DB_URL;
      if (!api || !db) throw new Error("--owned-target needs BOTH E2E_SUPABASE_URL and HONE_LOCAL_DB_URL (a run-scoped pair).");
      const a = new URL(api), d = new URL(db);
      const loop = (h) => h === "127.0.0.1" || h === "localhost";
      if (!loop(a.hostname) || !loop(d.hostname) || !a.port || !d.port) throw new Error("--owned-target endpoints must be loopback with explicit ports.");
      apiPort = a.port; dbPort = d.port;
      const names = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" }).split("\n");
      const kong = names.find((n) => n.startsWith("supabase_kong_") && execFileSync("docker", ["port", n, "8000/tcp"], { encoding: "utf8" }).includes(`:${apiPort}`));
      if (!kong) throw new Error("No local Supabase API container maps the given API port; publication refused.");
      project = kong.slice("supabase_kong_".length);
      if (project.toLowerCase() === "hone-0162") throw new Error("--owned-target must not be the shared stack.");
      const label = (container) => execFileSync("docker", ["inspect", "-f", '{{index .Config.Labels "com.supabase.cli.project"}}', container], { encoding: "utf8" }).trim();
      if (label(kong) !== project || label(`supabase_db_${project}`) !== project) throw new Error("--owned-target refused: the API and SQL containers do not carry the same Supabase project label.");
    } else if (holder !== "machines") {
      throw new Error("Machines does not hold the heavy-test slot. Ask ops01; do not change the holder yourself.");
    }
    for (const [container, internal, host] of [
      [`supabase_kong_${project}`, "8000/tcp", apiPort],
      [`supabase_db_${project}`, "5432/tcp", dbPort],
    ]) {
      const ports = execFileSync("docker", ["port", container, internal], { encoding: "utf8" }).trim().split("\n");
      if (!ports.some((p) => p === `0.0.0.0:${host}` || p === `127.0.0.1:${host}`)) throw new Error("Stack container/endpoint mapping does not match; publication refused.");
    }
    const key = process.env.HONE_MACHINE_PUBLICATION_SERVICE_ROLE_KEY;
    if (!key) throw new Error("Supply the lane-local service_role key as HONE_MACHINE_PUBLICATION_SERVICE_ROLE_KEY; no environment files are read.");
    const results = await publishContracts(plan, async (contract) => {
      // Fixed loopback endpoint (lane, or the owned pair). No user-controlled URL, redirects or automatic retry.
      const response = await fetch(`http://127.0.0.1:${apiPort}/rest/v1/rpc/sync_machine_profile_contract`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(contract),
      });
      if (!response.ok) throw new Error(`Publication refused (HTTP ${response.status}); inspect the local target before retrying.`);
      return response.json();
    });
    console.log(JSON.stringify({ results }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Publication failed; inspect the target before retrying.");
  process.exitCode = 1;
} finally {
  rmSync(output, { recursive: true, force: true });
}
