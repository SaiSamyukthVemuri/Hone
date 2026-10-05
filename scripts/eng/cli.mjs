#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CP-005a: `npm run eng -- status <pr>`
//
// Answers ONE question: what does GitHub say about this PR, at its exact head?
// It exists so delivery state is read rather than reconstructed from
// screenshots. On PR #610 an operator recorded "no review came back for
// 3859f636" 43 minutes after a clean verdict for that exact head had been
// posted; this command shows that verdict immediately.
//
// It REPORTS. It does not decide, does not persist, and cannot merge. Its
// output is pinned byte-for-byte to its pre-ENG-LOOP-01 form by
// tests/eng/shepherd.test.ts.
//
//   npm run eng -- status 613
//   npm run eng -- status 613 --json
//
// ENG-LOOP-01: `npm run eng -- shepherd <pr> [--json] [--watch]`
//
// Interprets the same facts into one next step. The interpretation lives in
// shepherd.mjs and the bounded loop in watch.mjs; this file only parses
// arguments and wires them to the process.
// ---------------------------------------------------------------------------

import { collectFacts, collectShepherdFacts, UNKNOWN } from "./github-facts.mjs";
import { reviewCompletionAtHead, ciAtHead, summarize } from "./review-provenance.mjs";
import { SHEPHERD_USAGE, interpret, renderShepherd, renderTransition } from "./shepherd.mjs";
import { WATCH_DEFAULTS, WATCH_LIMITS, describeWatchEnd, watchExitCode, watchPr } from "./watch.mjs";

const DIM = "[2m";
const RESET = "[0m";

function usage() {
  console.log(`
eng - read delivery state for one pull request, at its exact head

  npm run eng -- status <pr> [--json]

Reports GitHub facts only. It does not decide release readiness, does not
record findings, and cannot merge.
${SHEPHERD_USAGE}`);
}

/** `shepherd` arguments. Anything unrecognized is an error, never ignored. */
export function parseShepherdArgs(argv) {
  const opts = {
    pr: null,
    json: false,
    watch: false,
    tier: null,
    intervalMs: WATCH_DEFAULTS.intervalMs,
    maxMs: WATCH_DEFAULTS.maxMs,
  };
  const watchOnly = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--watch") opts.watch = true;
    else if (arg === "--tier") {
      const tier = argv[++i];
      if (!["T0", "T1", "T2", "T3"].includes(tier)) return { error: "--tier takes T0, T1, T2 or T3" };
      opts.tier = tier;
    } else if (arg === "--interval" || arg === "--max-minutes") {
      const value = Number(argv[++i]);
      const [lo, hi] = arg === "--interval" ? WATCH_LIMITS.intervalSeconds : WATCH_LIMITS.maxMinutes;
      if (!Number.isInteger(value) || value < lo || value > hi) return { error: `${arg} takes a whole number from ${lo} to ${hi}` };
      if (arg === "--interval") opts.intervalMs = value * 1000;
      else opts.maxMs = value * 60_000;
      watchOnly.push(arg);
    } else if (/^[1-9]\d*$/.test(arg) && opts.pr === null) opts.pr = Number(arg);
    else return { error: `unrecognized argument "${arg}"` };
  }
  if (opts.pr === null) return { error: "a pull request number is required" };
  if (!opts.watch && watchOnly.length) return { error: `${watchOnly.join(" and ")} only apply with --watch` };
  return opts;
}

async function shepherdCommand(argv) {
  const opts = parseShepherdArgs(argv);
  if (opts.error) {
    console.error(`eng shepherd: ${opts.error}`);
    usage();
    return 2;
  }
  const observe = (now) => interpret(collectShepherdFacts({ pr: opts.pr }), { now, tier: opts.tier });
  if (!opts.watch) {
    const result = observe(Date.now());
    console.log(opts.json ? JSON.stringify(result, null, 2) : renderShepherd(result));
    return result.exitCode;
  }
  const ended = await watchPr({
    observe,
    intervalMs: opts.intervalMs,
    maxMs: opts.maxMs,
    onChange: (result, at) => {
      if (!opts.json) console.log(renderTransition(result, at));
    },
  });
  if (opts.json) {
    console.log(JSON.stringify({ ...ended.result, watch: ended.watch }, null, 2));
  } else {
    if (ended.result) console.log(renderShepherd(ended.result));
    console.log(describeWatchEnd(ended));
  }
  return watchExitCode(ended);
}

function renderHuman(facts) {
  const s = summarize(facts);
  const review = reviewCompletionAtHead(facts);
  const ci = ciAtHead(facts);
  const head = s.head === UNKNOWN ? UNKNOWN : String(s.head).slice(0, 10);
  const out = [];

  out.push("");
  out.push(`PR #${s.pr}`);
  out.push(`HEAD ${head}`);
  if (s.pullRequest !== UNKNOWN) {
    const pr = s.pullRequest;
    out.push(
      `STATE ${String(pr.state).toUpperCase()}${pr.isDraft ? " (draft)" : ""}${pr.mergedAt ? ` merged ${pr.mergedAt}` : ""}`,
    );
    out.push(`BASE ${pr.baseRef} @ ${String(pr.baseSha).slice(0, 10)}`);
  }

  const ciDetail =
    ci.status === "RED"
      ? ` failing: ${ci.failing.join(", ")}`
      : ci.status === "PENDING"
        ? ` pending: ${ci.pending.join(", ")}`
        : ` ${DIM}(${ci.reason})${RESET}`;
  out.push(`CI ${ci.status} @ ${head}${ciDetail}`);
  // Completeness is shown, not implied: GREEN from a partial collection is the
  // defect this reporting exists to make impossible to miss.
  out.push(`  ${DIM}evidence: ${ci.completeness} collection, ${ci.atHead} run(s) bound to this head${RESET}`);

  out.push(`REVIEW ${review.status} @ ${head}`);
  out.push(`  ${DIM}${review.reason}${RESET}`);

  if (review.freshFindings !== UNKNOWN) {
    const bySev = s.findings.bySeverity;
    const sev = Object.keys(bySev).length
      ? ` (${Object.entries(bySev).sort().map(([k, v]) => `${k} ${v}`).join(", ")})`
      : "";
    out.push(`FRESH FINDINGS ${s.findings.fresh}${sev} ${DIM}raised at this head${RESET}`);
    out.push(
      `CARRIED ${s.findings.carried} ${DIM}raised at an earlier head; ${s.findings.reAnchored} of all comments are re-anchored and would read as current${RESET}`,
    );
    out.push(`ACKNOWLEDGEMENTS ${s.findings.acknowledgements} ${DIM}replies; never review completion${RESET}`);
  }
  out.push(
    `STALE REVIEW EVIDENCE ${review.staleEvidence?.length ?? UNKNOWN} ${DIM}bound to other heads${RESET}`,
  );
  // A look-alike verdict from an untrusted actor is shown rather than hidden,
  // precisely so it is visible WITHOUT ever counting as clean.
  const unauth = review.unauthorizedEvidence?.length ?? 0;
  if (unauth > 0) {
    out.push(`UNAUTHORIZED VERDICT-LIKE OBJECTS ${unauth} ${DIM}named this head but are not from the trusted reviewer${RESET}`);
    for (const u of review.unauthorizedEvidence) {
      out.push(`  ${DIM}${u.sourceType} ${u.sourceId} by ${u.actor} (id ${u.actorId})${RESET}`);
    }
  }

  if (review.freshFindings !== UNKNOWN && review.freshFindings.length) {
    out.push("");
    out.push("Findings raised at THIS head:");
    for (const f of review.freshFindings) {
      out.push(`  ${f.severity}  ${f.path}:${f.line}`);
      if (f.title) out.push(`      ${DIM}${f.title}${RESET}`);
    }
  }

  if (facts.unavailable.length) {
    out.push("");
    out.push("UNAVAILABLE (reported as UNKNOWN, never as none/clean):");
    for (const u of facts.unavailable) out.push(`  ${u.surface}: ${u.reason}`);
  }

  out.push("");
  out.push(
    `${DIM}Facts only. A positive state (GREEN/CLEAN) is emitted only from complete AND authorized evidence.${RESET}`,
  );
  out.push(`${DIM}Release readiness, findings state and stop laws are not evaluated here.${RESET}`);
  out.push("");
  return out.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("cli.mjs") && process.argv[2] === "shepherd") {
  process.exitCode = await shepherdCommand(process.argv.slice(3));
} else if (process.argv[1] && process.argv[1].endsWith("cli.mjs")) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const args = argv.filter((a) => !a.startsWith("--"));
  const [command, pr] = args;

  if (command !== "status" || !pr || !/^\d+$/.test(pr)) {
    usage();
    process.exit(command ? 2 : 0);
  }

  const facts = collectFacts({ pr: Number(pr) });
  if (json) {
    console.log(JSON.stringify(summarize(facts), null, 2));
  } else {
    console.log(renderHuman(facts));
  }
  // Exit 0 for a successful READ. A read is not a verdict, so an unread surface
  // must not masquerade as a failed check either.
  process.exit(facts.unavailable.length > 0 ? 3 : 0);
}

export { renderHuman };
