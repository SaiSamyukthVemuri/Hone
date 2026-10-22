#!/usr/bin/env node
// HON-50 G6: evaluate a studio sender's inbound STOP path and, only with
// --record, record exactly the evaluator's version-1 output through 0230.
//
// Runbook: docs/runbooks/sms-stop-preflight-record.md. Operator-run, local,
// service_role. DRY RUN is the default. Refuses a hosted Supabase unless
// --allow-hosted AND HONE_STOP_PREFLIGHT_HOSTED_APPROVED=yes (a Sam-approved
// cutover only). Prints codes and ids only.
//
//   node scripts/sms/record-stop-preflight.mjs --studio <uuid> --facts <file.json>
//        [--record] [--context evidence|cutover] [--credentials-epoch <value>]
//        [--allow-hosted]
import { register } from "node:module";
import { readFile } from "node:fs/promises";

register("./ts-loader-hooks.mjs", import.meta.url);
const { runStopPreflight, targetAllowed } = await import("./stop-preflight/run.ts");

function parseArgs(argv) {
  const out = { record: false, allowHosted: false, context: "evidence" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--record") out.record = true;
    else if (a === "--allow-hosted") out.allowHosted = true;
    else if (a === "--studio") out.studio = argv[++i];
    else if (a === "--facts") out.facts = argv[++i];
    else if (a === "--context") out.context = argv[++i];
    else if (a === "--credentials-epoch") out.epoch = argv[++i];
    else return { error: "unknown_argument" };
  }
  if (!out.studio || !out.facts) return { error: "missing_argument" };
  return out;
}

const print = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const args = parseArgs(process.argv.slice(2));
if (args.error) {
  print({ result: "invalid_arguments", code: args.error });
  process.exit(2);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const target = targetAllowed(url, args.allowHosted, process.env);
if (!target.ok) {
  print({ result: "target_refused", code: target.code });
  process.exit(2);
}
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) {
  print({ result: "target_refused", code: "no_service_role_key" });
  process.exit(2);
}

let raw;
try {
  raw = JSON.parse(await readFile(args.facts, "utf8"));
} catch {
  print({ result: "facts_refused", code: "unreadable_facts_file" });
  process.exit(2);
}

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const result = await runStopPreflight({
  admin,
  studioId: args.studio,
  raw,
  mode: args.record ? "record" : "dry_run",
  context: args.context,
  nowMs: Date.now(),
  credentialsEpoch: args.epoch ?? null,
});
print({ ...result, mode: args.record ? "record" : "dry_run", hosted: target.hosted });
process.exit(result.result === "evaluated" || result.result === "recorded" ? 0 : result.result === "outcome_unknown" ? 3 : 2);
