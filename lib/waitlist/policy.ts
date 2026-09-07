import {
  FIFO_POLICY,
  SCORING_FACTORS,
  validateScoringPolicy,
  type ScoringFactor,
  type ScoringPolicy,
  type ScoringWeights,
  type UnknownFactorPolicy,
} from "./scoring";

// ===========================================================================
// WAIT-ADMIT-01 — RANKING POLICY: PARSE AND SERIALIZE
// ===========================================================================
//
// The boundary between a stored, operator-editable policy document and the
// typed policy the engine runs on. Pure, and deliberately written BEFORE the
// column that will hold it exists: the parse rules are what make that column
// safe to add later, and they are testable now.
//
// EVERYTHING IS UNTRUSTED. A jsonb column is not a type. Whatever ends up
// holding this — a `studios` column, a settings row, a config file — can
// contain a shape nobody in this codebase wrote: an older version, a
// hand-edited row, a partially-migrated document, a factor name that has since
// been renamed. Every field is therefore validated independently and a bad one
// is a REFUSAL, never a silent default.
//
// ---------------------------------------------------------------------------
// ABSENT MEANS FIFO. MALFORMED MEANS REFUSE.
// ---------------------------------------------------------------------------
//
// Those two are not the same and must never collapse into each other:
//
//   * A studio that has configured nothing has no document, and gets
//     FIFO_POLICY — today's exact queue order. Safe, and the correct reading of
//     "no policy expressed".
//
//   * A studio whose document is CORRUPT has expressed something, and we cannot
//     tell what. Falling back to FIFO there would silently discard a
//     configuration the operator believes is running, and the queue would
//     reorder with no error anywhere. So it returns an error the caller must
//     handle — show the operator that their policy is not running.
//
// UNKNOWN KEYS ARE IGNORED, NOT REJECTED. A document written by a later version
// carrying a sixth factor must not break a studio on an older deploy. Weights
// are read BY NAME from the known factor list, so an unrecognised key
// contributes nothing and costs nothing.
// ===========================================================================

const UNKNOWN_POLICIES: readonly UnknownFactorPolicy[] = [
  "neutral",
  "penalize",
  "exclude",
] as const;

const DAY_CLASSES = ["weekday", "weekend"] as const;

/** The serialized shape. Plain JSON: no Dates, no undefined, no functions. */
export type ScoringPolicyDocument = {
  readonly weights: Readonly<Record<string, number>>;
  readonly preferredDayClass: "weekday" | "weekend" | null;
  readonly unknownPolicy: string;
  readonly waitingTimeCapDays: number;
};

export type PolicyParseResult =
  | { readonly ok: true; readonly value: ScoringPolicy; readonly usedDefault: boolean }
  | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a stored policy document.
 *
 * `null` / `undefined` — the studio has configured nothing — returns
 * FIFO_POLICY with `usedDefault: true`, so a caller can tell "default" from
 * "explicitly configured to be identical to the default" when that matters for
 * what the operator UI shows.
 */
export function parseScoringPolicy(raw: unknown): PolicyParseResult {
  if (raw === null || raw === undefined) {
    return { ok: true, value: FIFO_POLICY, usedDefault: true };
  }
  if (!isRecord(raw)) {
    return { ok: false, error: "policy must be an object" };
  }

  const weightsRaw = raw.weights;
  if (weightsRaw !== undefined && !isRecord(weightsRaw)) {
    return { ok: false, error: "policy.weights must be an object" };
  }

  // Read by name from the KNOWN factor list. A key nobody here recognises is
  // never read, so it cannot contribute a weight to a factor that does not
  // exist, and a factor missing from the document is simply off (0).
  const weights: Record<ScoringFactor, number> = { ...FIFO_POLICY.weights };
  for (const factor of SCORING_FACTORS) {
    const value = weightsRaw?.[factor];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: `policy.weights.${factor} must be a finite number` };
    }
    weights[factor] = value;
  }

  const preferredRaw = raw.preferredDayClass ?? null;
  if (
    preferredRaw !== null &&
    !(DAY_CLASSES as readonly unknown[]).includes(preferredRaw)
  ) {
    return {
      ok: false,
      error: "policy.preferredDayClass must be 'weekday', 'weekend' or null",
    };
  }

  const unknownRaw = raw.unknownPolicy ?? FIFO_POLICY.unknownPolicy;
  if (!(UNKNOWN_POLICIES as readonly unknown[]).includes(unknownRaw)) {
    return {
      ok: false,
      error: "policy.unknownPolicy must be 'neutral', 'penalize' or 'exclude'",
    };
  }

  const capRaw = raw.waitingTimeCapDays ?? FIFO_POLICY.waitingTimeCapDays;
  if (typeof capRaw !== "number" || !Number.isFinite(capRaw) || capRaw <= 0) {
    return { ok: false, error: "policy.waitingTimeCapDays must be a positive number" };
  }

  const candidate: ScoringPolicy = {
    weights: weights as ScoringWeights,
    preferredDayClass: preferredRaw as ScoringPolicy["preferredDayClass"],
    unknownPolicy: unknownRaw as UnknownFactorPolicy,
    waitingTimeCapDays: capRaw,
  };

  // ONE VALIDATOR, NOT TWO. The engine's own rules (no negative weight, no
  // non-finite, positive cap) are re-run here rather than restated, so a policy
  // that parses is guaranteed to be one `rankWaitlistCandidates` accepts.
  const validated = validateScoringPolicy(candidate);
  if (!validated.ok) return { ok: false, error: validated.error };

  return { ok: true, value: validated.value, usedDefault: false };
}

/**
 * Serialize a policy for storage.
 *
 * Round-trips: `parseScoringPolicy(serializeScoringPolicy(p))` yields `p` for
 * every valid policy. Emits every known factor explicitly — including zeros —
 * so a stored document records what the studio decided rather than leaving a
 * later reader to infer it from an absence.
 */
export function serializeScoringPolicy(policy: ScoringPolicy): ScoringPolicyDocument {
  const weights: Record<string, number> = {};
  for (const factor of SCORING_FACTORS) weights[factor] = policy.weights[factor];
  return {
    weights,
    preferredDayClass: policy.preferredDayClass,
    unknownPolicy: policy.unknownPolicy,
    waitingTimeCapDays: policy.waitingTimeCapDays,
  };
}
