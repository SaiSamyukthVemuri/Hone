import {
  SCORING_FACTORS,
  type FactorContribution,
  type RankingResult,
  type ScoredCandidate,
  type ScoringFactor,
  type ScoringPolicy,
} from "./scoring";

// ===========================================================================
// WAIT-ADMIT-01 — DETERMINISTIC RANKING EXPLANATION
// ===========================================================================
//
// Turns a ranking into text a practitioner can read and an operator can paste
// into a ticket. Pure, and deterministic in the strong sense: the same
// RankingResult always yields byte-identical output. No clock, no locale
// lookup, no Map/Set iteration order, no floating-point drift in the rendered
// numbers — factors are emitted in the fixed SCORING_FACTORS order and every
// number is rounded once, here, at a stated precision.
//
// WHY THAT MATTERS BEYOND TIDINESS. This text is the audit trail for a
// decision about who gets offered treatment capacity first. If it re-orders
// between renders, two screenshots of the same queue disagree and neither can
// be trusted. Determinism is what makes an explanation evidence.
//
// ---------------------------------------------------------------------------
// IT EXPLAINS THE SCORE THAT WAS ACTUALLY USED
// ---------------------------------------------------------------------------
//
// Every line is derived from the FactorContribution the engine produced, never
// recomputed here. A second implementation of the arithmetic would be free to
// drift from the one that decided the order, and the explanation would then be
// a plausible story about a ranking that happened for different reasons.
//
// A factor that did not participate is NAMED AND EXPLAINED rather than hidden.
// "Availability: not stated (no effect)" tells a practitioner something real —
// go and ask this person — which a silently omitted line never would.
//
// NO CONTACT DETAIL, BY CONSTRUCTION. The engine is handed no name, email or
// phone, so no formatting mistake here can leak one. Output is keyed by entry
// id, and the caller joins that back to the display record.
// ===========================================================================

/** Fixed operator-facing names. Never derived from the identifier at runtime. */
const FACTOR_LABELS: Readonly<Record<ScoringFactor, string>> = {
  availabilityCompatibility: "Availability",
  preferenceAlignment: "Studio day preference",
  waitingTime: "Waiting time",
  serviceCompatibility: "Service match",
  capacityFit: "Capacity fit",
};

/**
 * Rendered precision. Two decimals is enough to distinguish adjacent ranks
 * without implying the inputs are precise to four.
 */
const SCORE_DP = 2;

function round(value: number, dp: number): string {
  // toFixed on a negative zero renders "-0.00"; normalising through +0 keeps
  // the output stable for a factor that scored exactly zero.
  return (value + 0).toFixed(dp);
}

export type ExplainedFactor = {
  readonly factor: ScoringFactor;
  readonly label: string;
  /** "decided" | "not_stated" | "not_applicable" | "off" */
  readonly status: "decided" | "not_stated" | "not_applicable" | "off";
  readonly detail: string;
  readonly weight: number;
  readonly contribution: number | null;
};

export type CandidateExplanation = {
  readonly entryId: string;
  readonly rank: number;
  readonly score: number;
  /** null when the join date is only a queue anchor — never rendered as 0. */
  readonly daysWaiting: number | null;
  readonly factors: readonly ExplainedFactor[];
  /** One-line summary, suitable for a table cell. */
  readonly summary: string;
};

function statusOf(c: FactorContribution): ExplainedFactor["status"] {
  if (c.weight === 0) return "off";
  if (c.contribution !== null) return "decided";
  return c.outcome.kind === "unknown" ? "not_stated" : "not_applicable";
}

function explainFactor(c: FactorContribution): ExplainedFactor {
  const status = statusOf(c);
  return {
    factor: c.factor,
    label: FACTOR_LABELS[c.factor],
    status,
    // Every outcome kind carries `detail`; the engine writes it, this module
    // never rephrases it. One source for the reason text, so an explanation
    // cannot describe the factor differently from how it was scored.
    detail: c.outcome.detail,
    weight: c.weight,
    contribution: c.contribution,
  };
}

/**
 * The one-line reason a candidate sits where it does.
 *
 * Names at most the two strongest participating factors. Listing all five
 * produces a sentence nobody reads; naming none produces a number nobody
 * trusts. When nothing participated it says so plainly and names the rule that
 * actually decided — the queue order — rather than implying the score did.
 */
function summarise(candidate: ScoredCandidate): string {
  const participating = candidate.factors
    .filter((f) => f.contribution !== null && f.weight > 0)
    .sort((a, b) => {
      const diff = (b.contribution ?? 0) - (a.contribution ?? 0);
      if (diff !== 0) return diff;
      // Deterministic tie-break on the fixed factor order, never on Array#sort
      // stability, so equal contributions always render in the same sequence.
      return SCORING_FACTORS.indexOf(a.factor) - SCORING_FACTORS.indexOf(b.factor);
    });

  if (participating.length === 0) {
    // "waiting 0d" for someone whose join date nobody has would be a lie in the
    // one line an operator actually reads. Say what is true instead.
    const wait =
      candidate.daysWaiting === null
        ? "join date unknown"
        : `waiting ${candidate.daysWaiting}d`;
    return `Queue order (${wait}) — no ranking factor applied`;
  }

  const top = participating
    .slice(0, 2)
    .map((f) => `${FACTOR_LABELS[f.factor]} ${round(f.contribution ?? 0, SCORE_DP)}`)
    .join(", ");
  return `Score ${round(candidate.score, SCORE_DP)} — ${top}`;
}

export function explainCandidate(candidate: ScoredCandidate): CandidateExplanation {
  // SCORING_FACTORS order, not the order the engine happened to push them in.
  const byFactor = new Map(candidate.factors.map((f) => [f.factor, f]));
  const factors = SCORING_FACTORS.flatMap((f) => {
    const contribution = byFactor.get(f);
    return contribution ? [explainFactor(contribution)] : [];
  });

  return {
    entryId: candidate.entryId,
    rank: candidate.rank,
    score: candidate.score,
    daysWaiting: candidate.daysWaiting,
    factors,
    summary: summarise(candidate),
  };
}

export type RankingExplanation = {
  readonly candidates: readonly CandidateExplanation[];
  readonly excluded: readonly { entryId: string; reason: string }[];
  readonly decidedBy: readonly ScoringFactor[];
  /** Plain-text rendering of the whole ranking. Stable byte-for-byte. */
  readonly text: string;
};

export function explainRanking(
  result: RankingResult,
  policy: ScoringPolicy,
): RankingExplanation {
  const candidates = result.ranked.map(explainCandidate);

  const header: string[] = [];
  header.push(
    result.decidedBy.length === 0
      ? "Policy: no active ranking factors — queue order (joined, then id)."
      : `Policy: ranked by ${result.decidedBy.map((f) => FACTOR_LABELS[f]).join(", ")}.`,
  );
  if (policy.preferredDayClass !== null) {
    header.push(`Studio prefers ${policy.preferredDayClass}-available candidates.`);
  }
  header.push(`Prospects who did not state a factor: ${policy.unknownPolicy}.`);

  const lines: string[] = [...header, ""];
  for (const c of candidates) {
    lines.push(`${c.rank}. ${c.entryId} — ${c.summary}`);
    for (const f of c.factors) {
      if (f.status === "off") continue;
      const rendered =
        f.status === "decided"
          ? `${round(f.contribution ?? 0, SCORE_DP)} (weight ${round(f.weight, SCORE_DP)})`
          : f.status === "not_stated"
            ? "not stated"
            : "not applicable";
      lines.push(`     ${f.label}: ${rendered} — ${f.detail}`);
    }
  }

  if (result.excluded.length > 0) {
    lines.push("");
    lines.push("Excluded:");
    for (const e of result.excluded) {
      lines.push(`  ${e.entryId} — ${e.reason}`);
    }
  }

  return {
    candidates,
    excluded: result.excluded.map((e) => ({ entryId: e.entryId, reason: e.reason })),
    decidedBy: result.decidedBy,
    text: lines.join("\n"),
  };
}
