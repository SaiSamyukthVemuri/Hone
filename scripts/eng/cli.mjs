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
// It REPORTS. It does not decide, does not persist, and cannot merge. Release
// readiness, stop laws and the findings ledger are CP-005b/CP-005c, and the
// human output says so rather than leaving a reader to assume otherwise.
//
//   npm run eng -- status 613
//   npm run eng -- status 613 --json
// ---------------------------------------------------------------------------

import { collectFacts, UNKNOWN } from "./github-facts.mjs";
import { reviewCompletionAtHead, ciAtHead, summarize } from "./review-provenance.mjs";

const DIM = "[2m";
const RESET = "[0m";

function usage() {
  console.log(`
eng - read delivery state for one pull request, at its exact head

  npm run eng -- status <pr> [--json]

Reports GitHub facts only. It does not decide release readiness, does not
record findings, and cannot merge.
`);
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

if (process.argv[1] && process.argv[1].endsWith("cli.mjs")) {
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
