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
import {
  LEDGER_PATH, currentEntry, enrol, forStopLaws, loadLedger, mark, repairRound, saveLedger,
} from "./ledger.mjs";

const DIM = "[2m";
const RESET = "[0m";

function usage() {
  console.log(`
eng - read delivery state for one pull request, at its exact head

  npm run eng -- status <pr> [--json]

  Enrol a finding into the durable ledger. Every semantic field is YOURS:
  nothing is read off the badge and nothing is inferred.

    npm run eng -- enrol <pr> <commentId> --severity P1 --family <slug> --class runtime|evidence
    npm run eng -- mark <id> REPAIRED --sha <sha>
    npm run eng -- mark <id> VERIFIED --sha <sha>
    npm run eng -- mark <id> ACCEPTED_RISK --sha <sha> --reason "..."
    npm run eng -- ledger [--at <sha>] [--json]

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

/** `--flag value` only. No positional guessing, no abbreviations. */
function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

/**
 * Locate ONE inline comment and return the identity facts for it.
 *
 * There is deliberately no candidate listing. A list of machine-selected
 * "probable findings" is how convenience becomes inference, and six retired
 * vehicles is enough evidence about that. The operator names the comment id.
 */
function sourceFor(prNumber, commentId) {
  const facts = collectFacts({ pr: prNumber });
  const inline = facts.inlineComments?.value;
  if (!inline || inline === UNKNOWN) {
    throw new Error(`the inline comments for #${prNumber} could not be read, so no identity can be proven`);
  }
  const c = inline.find((x) => x.id === commentId);
  if (!c) throw new Error(`comment ${commentId} is not an inline review comment on #${prNumber}`);
  return {
    pr: prNumber,
    commentId: c.id,
    raisedAtSha: c.originalCommitId,
    path: c.path,
    originalLine: c.originalLine,
    actorId: c.authorId ?? UNKNOWN,
    inReplyToId: c.inReplyToId ?? null,
  };
}

function renderLedger(ledger, at) {
  const rows = forStopLaws(ledger, at);
  if (rows.length === 0) return `\nno findings enrolled (${LEDGER_PATH})\n`;
  const out = ["", `FINDINGS LEDGER  ${rows.length} enrolled${at ? `  at ${String(at).slice(0, 10)}` : ""}`, ""];
  for (const r of rows) {
    const bound = r.state.state === UNKNOWN ? `${UNKNOWN} ${DIM}(${r.state.reason})${RESET}` : r.state.state;
    const risk = r.acceptedRiskBy ? ` | risk accepted by ${r.acceptedRiskBy}` : "";
    out.push(`  ${r.severity}  ${r.id}`,
      `      ${DIM}recorded ${r.recordedState}@${String(r.state.sha).slice(0, 10)} | at this head: ${bound}${RESET}`,
      `      ${DIM}family ${r.rootCauseFamily} | ${r.runtimeOrEvidence} | repair round ${r.repairRound}${risk}${RESET}`);
  }
  out.push("");
  out.push(`${DIM}Enrolment and every semantic field are the operator's. This ledger tracks state; it decides nothing.${RESET}`);
  out.push("");
  return out.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("cli.mjs")) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const args = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  const [command, pr, third] = args;
  const now = new Date().toISOString();
  const who = process.env.ENG_OPERATOR || process.env.USER || "";

  try {
    if (command === "enrol" || command === "enroll") {
      const next = enrol(loadLedger(), {
        source: sourceFor(Number(pr), Number(third)),
        severity: flag(argv, "severity"),
        rootCauseFamily: flag(argv, "family"),
        runtimeOrEvidence: flag(argv, "class"),
        by: who,
        at: now,
      });
      saveLedger(next);
      console.log(`enrolled ${next.findings.at(-1).id}\n  ${LEDGER_PATH} now holds ${next.findings.length} finding(s)`);
      process.exit(0);
    }

    if (command === "mark") {
      const next = mark(loadLedger(), pr, third, {
        sha: flag(argv, "sha"),
        by: who,
        at: now,
        reason: flag(argv, "reason"),
      });
      saveLedger(next);
      const f = next.findings.find((x) => x.id === pr);
      console.log(`${pr}\n  -> ${currentEntry(f).state}@${String(currentEntry(f).sha).slice(0, 10)} (repair round ${repairRound(f)})`);
      process.exit(0);
    }

    if (command === "ledger") {
      const at = flag(argv, "at");
      const ledger = loadLedger();
      console.log(json ? JSON.stringify(forStopLaws(ledger, at), null, 2) : renderLedger(ledger, at));
      process.exit(0);
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }

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

export { renderHuman, renderLedger, sourceFor };
