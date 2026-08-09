/**
 * scripts/synthetic-mirror/plan-digest.mjs — canonical serialization + digest.
 *
 * WHAT THE DIGEST DOES AND DOES NOT PROVE
 * ---------------------------------------
 * `plan_id` is a plain SHA-256 over the canonical JSON of the plan body. It is
 * an INTEGRITY and REPRODUCIBILITY check:
 *
 *   - reproducibility — the same inputs regenerate the same body and therefore
 *     the same digest, so two operators can confirm they are looking at the
 *     same plan, and a re-export can be diffed against a stored one;
 *   - integrity against ACCIDENT — a truncated file, a partial write, a stray
 *     edit or a transfer error changes the digest.
 *
 * It proves NOTHING about authorship or authority. It is not a signature, not a
 * MAC and not evidence that this repository produced the plan: anyone able to
 * modify a plan can recompute a matching digest, because the algorithm is
 * public and unkeyed. Do not describe it as tamper-proof, authenticated or
 * trusted, and do not let an executor treat a matching digest as permission to
 * write. The executor's real defences are the closed schema, the pinned target
 * and the re-derivation of every id — all of which are re-checked independently
 * of the digest.
 *
 * If authenticated authorship is ever required, that needs a keyed MAC or a
 * signature with a key the plan author holds and the executor verifies. This is
 * deliberately not that, because Phase 2 has no key-distribution story.
 */

import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted, arrays order-preserving. */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

/** SHA-256 of the canonical body. See the header for what this does not mean. */
export function digestBody(body) {
  return createHash("sha256").update(canonicalize(body)).digest("hex");
}
