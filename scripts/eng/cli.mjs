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
import { reviewFactsAtHead, summarize } from "./review-provenance.mjs";

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
  const review = reviewFactsAtHead(facts);
  const ci = s.ci;
  const head = s.head === UNKNOWN ? UNKNOWN : String(s.head).slice(0, 10);
  const out = [];

  out.push("");
  out.push(`PR #${s.pr}   HEAD ${head}`);
  if (s.pullRequest !== UNKNOWN) {
    const pr = s.pullRequest;
    out.push(
      `STATE ${String(pr.state).toUpperCase()}${pr.isDraft ? " (draft)" : ""}${pr.mergedAt ? ` merged ${pr.mergedAt}` : ""}`,
    );
    out.push(`BASE ${pr.baseRef} @ ${String(pr.baseSha).slice(0, 10)}`);
  }

  // CI FACTS. Counts of what was seen - no verdict on what they add up to.
  out.push("");
  out.push("CI FACTS");
  out.push(`  checksObserved ${ci.checksObserved}   boundToHead ${ci.boundToHead}   foreign ${ci.foreign}`);
  out.push(`  completeness   ${ci.completeness} ${DIM}(${ci.reason})${RESET}`);
  out.push(`  passed ${ci.passedObserved}   skipped ${ci.skippedObserved}`);
  out.push(`  failuresObserved ${ci.failuresObserved === UNKNOWN ? UNKNOWN : ci.failuresObserved.length}${
    ci.failuresObserved !== UNKNOWN && ci.failuresObserved.length ? `  ${ci.failuresObserved.join(", ")}` : ""
  }`);
  out.push(`  stillRunning     ${ci.stillRunning === UNKNOWN ? UNKNOWN : ci.stillRunning.length}${
    ci.stillRunning !== UNKNOWN && ci.stillRunning.length ? `  ${ci.stillRunning.join(", ")}` : ""
  }`);

  // REVIEW FACTS.
  out.push("");
  out.push("REVIEW FACTS");
  out.push(`  verdictObjects ${s.review.verdictObjects}   atHead ${s.review.verdictsAtHead}   staleShas ${s.review.staleEvidence}`);
  out.push(`  unauthorizedAtHead ${s.review.unauthorizedAtHead}   unknownAuthorityAtHead ${s.review.unknownAuthorityAtHead}`);
  out.push(`  reviewRequestsAtHead ${s.review.requestsAtHead}`);
  if (s.review.trustedOutcomesAtHead !== UNKNOWN) {
    for (const t of s.review.trustedOutcomesAtHead) {
      out.push(`  ${DIM}trusted ${t.sourceType} ${t.sourceId} stated: ${t.statedOutcome}${RESET}`);
    }
  }
  // A look-alike verdict is SHOWN rather than hidden, precisely because it
  // never counted for anything.
  if (review.unauthorizedAtHead !== UNKNOWN && review.unauthorizedAtHead.length) {
    for (const u of review.unauthorizedAtHead) {
      out.push(`  ${DIM}unauthorized ${u.sourceType} ${u.sourceId} by ${u.actor} (id ${u.actorId})${RESET}`);
    }
  }

  // FINDINGS.
  out.push("");
  out.push("FINDINGS");
  const bySev = s.findings.bySeverity;
  const sev = bySev !== UNKNOWN && Object.keys(bySev).length
    ? ` [${Object.entries(bySev).sort().map(([k, v]) => `${k}x${v}`).join(" ")}]`
    : "";
  out.push(`  currentHead ${s.findings.currentHead}${sev}   carried ${s.findings.carried}   reAnchored ${s.findings.reAnchored}`);
  out.push(`  undecidableFreshness ${s.findings.undecidableFreshness}   acknowledgements ${s.findings.acknowledgements}`);
  if (review.currentFindings !== UNKNOWN) {
    for (const f of review.currentFindings) {
      // The ORIGINAL line, never the display line: GitHub rewrites the latter.
      out.push(`  ${f.severity} ${f.path}:${f.originalLine ?? UNKNOWN}  raised@${String(f.raisedAt ?? UNKNOWN).slice(0, 10)}  id ${f.id}`);
      if (f.title) out.push(`      ${DIM}${f.title}${RESET}`);
    }
  }

  out.push("");
  out.push("UNKNOWN EVIDENCE");
  if (facts.unavailable.length) {
    for (const u of facts.unavailable) out.push(`  ${u.surface}: ${u.reason}`);
  } else {
    out.push("  surfaces 0");
  }

  // A CONSTANT. Never computed, never conditional.
  out.push("");
  out.push(`CONTROL-PLANE RESULT: ${s.controlPlaneResult}`);
  out.push(
    `${DIM}Observed facts only. This tool does not emit GREEN, CLEAN, TRUSTED or RELEASE_READY,${RESET}`,
  );
  out.push(`${DIM}and never converts an absence of bad evidence into readiness. The operator decides.${RESET}`);
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
