/**
 * scripts/synthetic-mirror/identity.mjs — provable synthetic identity.
 *
 * THE MARKER PROBLEM
 * ------------------
 * Reset must never delete a row it cannot POSITIVELY PROVE is synthetic, and
 * this feature is not allowed to add a schema column to say so (migrations
 * 0174-0178 are reserved by the security roadmap). So synthetic-ness is proved
 * by RECOMPUTATION rather than by a stored flag:
 *
 *     a row is synthetic  <=>  its primary key equals deriveSyntheticId(...)
 *                              for some ordinal below the ceiling
 *
 * Nothing is stored, nothing is trusted, and no clinical field is overloaded
 * with hidden control metadata. The proof is a pure function of (studio, kind,
 * ordinal), so it survives a lost state file, a crashed run, and a restore from
 * backup.
 *
 * WHY THIS ALSO SOLVES IDEMPOTENCY
 * --------------------------------
 * Because the id for "client #7 of studio X" is DETERMINISTIC, creating N
 * clients is just "ensure ordinals 0..N-1 exist". Re-running derives the same
 * ids, which collide on the primary key, so `on conflict (id) do nothing` makes
 * the whole reconciliation idempotent with NO watermark table, NO timestamp
 * comparison and NO source ids retained. Retries, crashes between writes,
 * concurrent runs and clock skew are all non-issues by construction — they were
 * only ever problems for a design that had to remember what it had done.
 *
 * UUID VERSION 8 IS A STRUCTURAL SEPARATOR
 * ----------------------------------------
 * Every id minted here is RFC 9562 version 8 (custom). Every organically
 * created Hone row uses `gen_random_uuid()`, which is version 4. A v4 id can
 * therefore NEVER be mistaken for a synthetic one, and a real client row can
 * never be swept up by reset even if the ordinal ceiling were misconfigured.
 * The authoritative test is still derivability; the version check is a cheap
 * structural invariant that fails closed.
 */

import { createHash } from "node:crypto";

// Fixed and deliberately NOT a secret. The security boundary for this tooling
// is service_role + the operator allowlist, never the obscurity of a namespace.
// Changing this string orphans every previously created synthetic row, so it is
// versioned rather than edited.
export const SYNTHETIC_NAMESPACE = "hone.synthetic-mirror.v1";

// Upper bound on ordinals considered when classifying or resetting. Sized well
// above any plausible studio (Willow is ~50 clients) and cheap to enumerate.
// A row beyond the ceiling is treated as NOT synthetic — fail closed.
export const ORDINAL_CEILING = 5000;

/** Entity kinds that get deterministic ids. */
export const SYNTHETIC_ENTITIES = Object.freeze([
  "client",
  "appointment",
  "session",
  "intake",
  "sterile_item",
]);

/**
 * Derive the deterministic synthetic UUID for (studio, entity, ordinal).
 * Returns an RFC 9562 v8 UUID string.
 */
export function deriveSyntheticId(studioId, entity, ordinal) {
  if (typeof studioId !== "string" || studioId.length === 0) {
    throw new TypeError("deriveSyntheticId: studioId must be a non-empty string");
  }
  if (!SYNTHETIC_ENTITIES.includes(entity)) {
    throw new TypeError(`deriveSyntheticId: unknown entity "${entity}"`);
  }
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new TypeError("deriveSyntheticId: ordinal must be a non-negative integer");
  }

  const digest = createHash("sha256")
    .update(`${SYNTHETIC_NAMESPACE}|${studioId}|${entity}|${ordinal}`)
    .digest();

  const b = Buffer.from(digest.subarray(0, 16));
  // Version 8 (custom) in the high nibble of byte 6; RFC 4122 variant in byte 8.
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;

  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** True if `id` is a well-formed UUID whose version nibble is 8. */
export function isVersion8Uuid(id) {
  return (
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
  );
}

/**
 * Build the full set of derivable synthetic ids for one studio + entity, up to
 * `ceiling`. This set IS the proof: membership means synthetic, absence means
 * "cannot prove synthetic" and therefore hands-off.
 */
export function syntheticIdSet(studioId, entity, ceiling = ORDINAL_CEILING) {
  const set = new Set();
  for (let i = 0; i < ceiling; i += 1) {
    set.add(deriveSyntheticId(studioId, entity, i));
  }
  return set;
}

/**
 * Positively classify one id. Fails closed: anything not derivable within the
 * ceiling is NOT synthetic, whatever it looks like.
 */
export function isSyntheticId(id, studioId, entity, ceiling = ORDINAL_CEILING) {
  if (!isVersion8Uuid(id)) return false;
  for (let i = 0; i < ceiling; i += 1) {
    if (deriveSyntheticId(studioId, entity, i) === id) return true;
  }
  return false;
}

/**
 * Partition a list of ids into provably-synthetic and everything else.
 * `unknown` is the list reset must refuse to touch.
 */
export function partitionIds(ids, studioId, entity, ceiling = ORDINAL_CEILING) {
  const derivable = syntheticIdSet(studioId, entity, ceiling);
  const synthetic = [];
  const unknown = [];
  for (const id of ids) {
    if (derivable.has(id)) synthetic.push(id);
    else unknown.push(id);
  }
  return { synthetic, unknown };
}
