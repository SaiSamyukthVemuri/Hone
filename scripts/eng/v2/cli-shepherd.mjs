// ---------------------------------------------------------------------------
// ENG-LOOP V1 05C: `npm run --silent eng -- shepherd <pr> [--json] [--no-receipt]`
//
// JSON mode writes ONLY JSON to stdout — a usage error and an internal error
// included — and diagnostics go to stderr. Exit codes are shepherd.mjs's EXIT.
// A diagnostic receipt is written before the report is printed, under
// HONE_ENG_RECEIPTS_DIR or `.eng/receipts/` (gitignored); a receipt failure is
// reported on stderr and never changes the decision or the exit code.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import path from "node:path";

import { LOCAL_ROOT, loadLocalCi } from "./adapter/local-ci.mjs";
import { receiptFrom, writeReceipt } from "./receipts.mjs";
import { EXIT, REPORT_SCHEMA, renderText, runShepherd } from "./shepherd.mjs";

export const RECEIPTS_ENV = "HONE_ENG_RECEIPTS_DIR";
export const USAGE = "usage: npm run --silent eng -- shepherd <pr> [--json] [--no-receipt]";
const FLAGS = ["--json", "--no-receipt"];

/** `eng-loop-v1@<checkout HEAD>`, `+dirty` when the tool or its CI inputs differ from it, or `@unknown`. */
export function detectToolVersion({ root = LOCAL_ROOT, exec = execFileSync } = {}) {
  const opts = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  try {
    const sha = String(exec("git", ["-C", root, "rev-parse", "HEAD"], opts)).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return "eng-loop-v1@unknown";
    const paths = ["scripts/eng", "scripts/classify-changes.mjs", ".github/workflows/ci.yml"];
    const dirty = String(exec("git", ["-C", root, "status", "--porcelain", "--", ...paths], opts)).trim() !== "";
    return `eng-loop-v1@${sha}${dirty ? "+dirty" : ""}`;
  } catch {
    return "eng-loop-v1@unknown";
  }
}

/** The shepherd's own CI definition; unreadable, it can certify nothing (ci_definition_mismatch). */
function localCi() {
  try {
    return loadLocalCi();
  } catch {
    return Object.freeze({
      classify: () => {
        throw new Error("the local classifier is unavailable");
      },
      blobs: Object.freeze({}),
      tablePinned: false,
    });
  }
}

/**
 * @param {{ argv: string[], env: object, out: { write(s: string): void }, err: { write(s: string): void },
 *           now?: () => number, spawn?: Function, local?: object, toolVersion?: string, receiptsDir?: string }} io
 * @returns {number} the exit code
 */
export function runShepherdCli({ argv, env, out, err, now, spawn, local, toolVersion, receiptsDir }) {
  const json = argv.includes("--json");
  const flags = argv.filter((a) => a.startsWith("--"));
  const [command, pr, ...rest] = argv.filter((a) => !a.startsWith("--"));
  if (command !== "shepherd" || !/^[1-9]\d{0,8}$/.test(pr ?? "") || rest.length > 0 || flags.some((f) => !FLAGS.includes(f))) {
    if (json) out.write(`${JSON.stringify({ schema: REPORT_SCHEMA, error: "usage", usage: USAGE })}\n`);
    else err.write(`${USAGE}\n`);
    return EXIT.USAGE;
  }
  try {
    const { exitCode, report } = runShepherd({
      prNumber: Number(pr),
      env,
      ...(now ? { now } : {}),
      ...(spawn ? { spawn } : {}),
      local: local ?? localCi(),
      toolVersion: toolVersion ?? detectToolVersion(),
    });
    let receipt = "disabled";
    if (!argv.includes("--no-receipt")) {
      const built = receiptFrom(report);
      const dir = receiptsDir ?? env?.[RECEIPTS_ENV] ?? path.join(LOCAL_ROOT, ".eng", "receipts");
      const written = built.ok ? writeReceipt(dir, built.receipt) : built;
      receipt = written.ok ? "written" : "failed";
      if (!written.ok) err.write(`shepherd: diagnostic receipt not written: ${written.detail}\n`);
    }
    const full = { ...report, receipt };
    out.write(json ? `${JSON.stringify(full, null, 2)}\n` : renderText(full));
    return exitCode;
  } catch (e) {
    err.write(`shepherd: internal error: ${e instanceof Error ? e.name : "error"}\n`);
    if (json) {
      out.write(`${JSON.stringify({ schema: REPORT_SCHEMA, error: "internal", decision: "UNKNOWN", humanMergeRequired: true })}\n`);
    }
    return EXIT.INTERNAL;
  }
}
