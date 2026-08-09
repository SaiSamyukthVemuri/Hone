/**
 * scripts/synthetic-mirror/config.mjs — operator configuration and guards.
 *
 * TENANCY MODEL (Phase 10/11)
 * ---------------------------
 * This is privileged, cross-studio TEST INFRASTRUCTURE. It must never become an
 * ordinary application capability, so:
 *
 *   - it lives under scripts/ and is imported by NOTHING in app/ or lib/ —
 *     pinned by tests/scripts/synthetic-mirror/tenancy.test.ts;
 *   - source and target are pinned SERVER-SIDE from environment variables. No
 *     argument, request, browser or studio member can choose either one;
 *   - there is no "clone any studio" surface: the source is read through one
 *     aggregate-only statement and the target through one allowlisted id;
 *   - no studio UUID and no operator UUID is hard-coded in source. The
 *     repository never learns who Sam is.
 *
 * KILL SWITCH (Phase 18)
 * ----------------------
 * Default OFF. `SYNTHETIC_MIRROR_ENABLED` must be the exact string "true" for
 * any mutating command to proceed. A failed safety check REFUSES rather than
 * continuing partially. Nothing here is coupled to Willow's availability: this
 * tool is downstream and read-only with respect to the source.
 */

export const ENV = Object.freeze({
  enabled: "SYNTHETIC_MIRROR_ENABLED",
  sourceStudioId: "SYNTHETIC_MIRROR_SOURCE_STUDIO_ID",
  targetStudioId: "SYNTHETIC_MIRROR_TARGET_STUDIO_ID",
  operatorEmail: "SYNTHETIC_MIRROR_OPERATOR_EMAIL",
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MirrorRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "MirrorRefusal";
  }
}

/**
 * Resolve configuration from the environment. Never throws for a read-only
 * command; `enabled` is reported so `status` can explain the posture.
 */
export function loadConfig(env = process.env) {
  return {
    enabled: env[ENV.enabled] === "true",
    sourceStudioId: env[ENV.sourceStudioId] ?? null,
    targetStudioId: env[ENV.targetStudioId] ?? null,
    operatorEmail: env[ENV.operatorEmail] ?? null,
  };
}

/**
 * Validate the configuration shape. Returns a list of refusal reasons; empty
 * means structurally usable. Kept separate from the assertions so `status` can
 * print every problem at once instead of failing on the first.
 */
export function configProblems(config) {
  const problems = [];
  if (!config.sourceStudioId || !UUID_RE.test(config.sourceStudioId)) {
    problems.push(`${ENV.sourceStudioId} is missing or not a UUID`);
  }
  if (!config.targetStudioId || !UUID_RE.test(config.targetStudioId)) {
    problems.push(`${ENV.targetStudioId} is missing or not a UUID`);
  }
  if (!config.operatorEmail || !config.operatorEmail.includes("@")) {
    problems.push(`${ENV.operatorEmail} is missing or not an address`);
  }
  if (
    config.sourceStudioId &&
    config.targetStudioId &&
    config.sourceStudioId.toLowerCase() === config.targetStudioId.toLowerCase()
  ) {
    problems.push(
      "source and target are the SAME studio — refusing to write fixtures into the source",
    );
  }
  return problems;
}

/** Hard gate for every mutating command. */
export function assertMutationAllowed(config) {
  const problems = configProblems(config);
  if (problems.length > 0) {
    throw new MirrorRefusal(`configuration refused:\n  - ${problems.join("\n  - ")}`);
  }
  if (!config.enabled) {
    throw new MirrorRefusal(
      `kill switch is OFF. Set ${ENV.enabled}=true to allow a mutating run. ` +
        "This is the default and is intentional.",
    );
  }
}

/**
 * Runtime ownership proof (Phase 11). Security is NOT keyed on the mutable
 * email string alone: the caller resolves the target studio's owner from the
 * database and passes it here, so the configured address must still hold an
 * ACTIVE OWNER membership of the configured target studio at run time.
 */
export function assertOperatorOwnsTarget(config, ownerRows) {
  const rows = Array.isArray(ownerRows) ? ownerRows : [];
  const match = rows.find(
    (r) =>
      typeof r?.email === "string" &&
      r.email.toLowerCase() === String(config.operatorEmail).toLowerCase() &&
      r.role === "owner" &&
      r.active === true &&
      String(r.studio_id).toLowerCase() === String(config.targetStudioId).toLowerCase(),
  );
  if (!match) {
    throw new MirrorRefusal(
      "operator does not hold an active OWNER membership of the configured target studio — refusing.",
    );
  }
  return true;
}

/**
 * Refuse to treat the source studio as a deletion/write target under any
 * circumstance, even if the environment is misconfigured to point at it.
 */
export function assertNotSource(config, studioId) {
  if (
    config.sourceStudioId &&
    String(studioId).toLowerCase() === String(config.sourceStudioId).toLowerCase()
  ) {
    throw new MirrorRefusal(
      "refusing: the requested studio is the configured SOURCE studio. " +
        "The mirror is strictly read-only with respect to the source.",
    );
  }
  if (String(studioId).toLowerCase() !== String(config.targetStudioId).toLowerCase()) {
    throw new MirrorRefusal(
      "refusing: the requested studio is neither the configured target nor a known studio.",
    );
  }
  return true;
}
