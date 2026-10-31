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
if (!(args.length === 1 && args[0] === "--dry-run") &&
    !(apply && args.length === 2 && args.some((a) => /^--expect-plan=[a-f0-9]{64}$/.test(a)))) {
  console.error("Usage: node scripts/publish-machine-contracts.mjs --dry-run\nLocal only: --apply-local --expect-plan=<dry-run sha256>\nHosted publication is disabled pending Sam's privileged-write mechanism decision and per-change authorization.");
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
    if (readFileSync(join(homedir(), "hone-handoffs/heavy-slot"), "utf8").trim() !== "machines") throw new Error("Machines does not hold the heavy-test slot. Ask ops01; do not change the holder yourself.");
    for (const name of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST"]) {
      if (process.env[name]) throw new Error("Local publication refuses a deployed environment.");
    }
    // Read the daemon mapping, rather than inferring identity from adjacent ports.
    for (const [container, internal, host] of [
      ["supabase_kong_hone-mpx-0223", "8000/tcp", "64821"],
      ["supabase_db_hone-mpx-0223", "5432/tcp", "64822"],
    ]) {
      const ports = execFileSync("docker", ["port", container, internal], { encoding: "utf8" }).trim().split("\n");
      if (!ports.some((p) => p === `0.0.0.0:${host}` || p === `127.0.0.1:${host}`)) throw new Error("Lane container/endpoint mapping does not match; publication refused.");
    }
    const key = process.env.HONE_MACHINE_PUBLICATION_SERVICE_ROLE_KEY;
    if (!key) throw new Error("Supply the lane-local service_role key as HONE_MACHINE_PUBLICATION_SERVICE_ROLE_KEY; no environment files are read.");
    const results = await publishContracts(plan, async (contract) => {
      // Fixed lane endpoint. No user-controlled URL, redirects or automatic retry.
      const response = await fetch("http://127.0.0.1:64821/rest/v1/rpc/sync_machine_profile_contract", {
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
