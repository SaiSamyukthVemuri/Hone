/**
 * scripts/synthetic-mirror/verify-plan.mjs — the pure plan verifier.
 *
 * PURE: no I/O, no clock, no database. Given a plan document and the pinned
 * expectations (target studio, source studio, the target's allowed practitioner
 * and services), it returns every reason the plan must NOT be executed.
 *
 * FAIL-CLOSED AND EXHAUSTIVE. It returns a LIST of violations rather than
 * throwing on the first, so an operator sees every problem at once; but any
 * non-empty list means refuse. A check that cannot be evaluated counts as a
 * violation, never as a pass.
 *
 * BOTH SIDES RUN THIS. The exporter runs it before writing a plan file, and the
 * executor runs it again after reading one. The executor never trusts the file
 * it was handed — it re-derives every primary key from the namespace itself, so
 * a plan whose ids were edited is rejected regardless of whether its digest was
 * recomputed to match.
 */

import {
  ALLOWED_COLUMNS,
  ALLOWED_VALUES,
  BODY_KEYS,
  CEILINGS,
  ENTITY_IDENTITY,
  ENTITY_ORDER,
  ENVELOPE_KEYS,
  FORBIDDEN_PLAN_KEYS,
  MUST_BE_NULL,
  SCHEMA_VERSION,
} from "./plan-schema.mjs";
import { deriveSyntheticId, isVersion8Uuid, ORDINAL_CEILING, SYNTHETIC_NAMESPACE } from "./identity.mjs";
import { digestBody } from "./plan-digest.mjs";
import { PROFILE_KEYS } from "./profile.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * @param {object} plan      the parsed plan envelope
 * @param {object} expected  { targetStudioId, sourceStudioId, practitionerId, serviceIds }
 * @returns {string[]} violations; empty means executable
 */
export function verifyPlan(plan, expected) {
  const v = [];
  const fail = (msg) => v.push(msg);

  // --- envelope ----------------------------------------------------------
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return ["plan is not an object"];
  }
  for (const k of Object.keys(plan)) {
    if (!ENVELOPE_KEYS.includes(k)) fail(`unknown top-level key "${k}"`);
  }
  if (plan.schema_version !== SCHEMA_VERSION) {
    fail(`schema_version must be exactly ${SCHEMA_VERSION} (got ${JSON.stringify(plan.schema_version)})`);
    // A different version means the rest of this file is not the right reader.
    return v;
  }
  const body = plan.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    fail("body is missing or not an object");
    return v;
  }
  for (const k of Object.keys(body)) {
    if (!BODY_KEYS.includes(k)) fail(`unknown body key "${k}"`);
  }

  // --- digest (integrity only — see plan-digest.mjs) ----------------------
  const recomputed = digestBody(body);
  if (plan.plan_id !== recomputed) {
    fail(`plan_id does not match the body digest (integrity check failed)`);
  }

  // --- namespace ---------------------------------------------------------
  const ns = body.namespace ?? {};
  if (ns.id !== SYNTHETIC_NAMESPACE) fail(`namespace.id must be "${SYNTHETIC_NAMESPACE}"`);
  if (ns.uuid_version !== 8) fail("namespace.uuid_version must be 8");
  if (ns.ordinal_ceiling !== ORDINAL_CEILING) fail("namespace.ordinal_ceiling does not match this build");

  // --- target binding ----------------------------------------------------
  const target = body.target ?? {};
  if (!UUID_RE.test(String(target.studio_id ?? ""))) fail("target.studio_id is not a UUID");
  if (!eq(target.studio_id, expected.targetStudioId)) {
    fail("target.studio_id differs from the configured target studio — REFUSING");
  }
  if (expected.sourceStudioId && eq(target.studio_id, expected.sourceStudioId)) {
    fail("target.studio_id IS the source studio — REFUSING");
  }
  if (!eq(target.practitioner_id, expected.practitionerId)) {
    fail("target.practitioner_id is not the configured target practitioner");
  }
  const allowedServices = new Set((expected.serviceIds ?? []).map((s) => String(s).toLowerCase()));
  for (const sid of target.service_ids ?? []) {
    if (!allowedServices.has(String(sid).toLowerCase())) {
      fail(`target.service_ids contains an unknown service "${sid}"`);
    }
  }

  // --- source profile is aggregate-only ----------------------------------
  const profile = body.source_profile ?? {};
  for (const k of Object.keys(profile)) {
    if (!PROFILE_KEYS.includes(k)) fail(`source_profile has non-aggregate key "${k}"`);
  }
  for (const [k, n] of Object.entries(profile)) {
    if (!Number.isInteger(n) || n < 0) fail(`source_profile.${k} is not a non-negative integer`);
  }

  // --- entities ----------------------------------------------------------
  const entities = body.entities ?? {};
  for (const name of Object.keys(entities)) {
    if (!ENTITY_ORDER.includes(name)) fail(`unknown writable entity "${name}" — REFUSING`);
  }

  const clientIds = new Set(
    (entities.clients ?? []).map((r) => String(r?.id ?? "").toLowerCase()),
  );
  const sessionIds = new Set(
    (entities.sessions ?? []).map((r) => String(r?.id ?? "").toLowerCase()),
  );
  const appointmentIds = new Set(
    (entities.appointments ?? []).map((r) => String(r?.id ?? "").toLowerCase()),
  );
  let total = 0;

  for (const name of ENTITY_ORDER) {
    const rows = entities[name];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) { fail(`entities.${name} is not an array`); continue; }

    total += rows.length;
    if (rows.length > CEILINGS.perEntity) {
      fail(`entities.${name} has ${rows.length} rows, above the per-entity ceiling ${CEILINGS.perEntity}`);
    }

    const allowed = ALLOWED_COLUMNS[name];
    const identity = ENTITY_IDENTITY[name];
    // Re-derive the whole legal id set once per entity.
    const derivable = new Set();
    for (let i = 0; i < ORDINAL_CEILING; i += 1) {
      derivable.add(deriveSyntheticId(target.studio_id, identity, i));
    }

    rows.forEach((row, index) => {
      const at = `entities.${name}[${index}]`;
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        fail(`${at} is not an object`);
        return;
      }

      // unknown column
      for (const col of Object.keys(row)) {
        if (!allowed.includes(col)) fail(`${at} has unknown writable column "${col}" — REFUSING`);
      }

      // primary key must be re-derivable under the namespace
      const id = String(row.id ?? "");
      if (!isVersion8Uuid(id)) {
        fail(`${at}.id is not a version-8 synthetic UUID — REFUSING`);
      } else if (!derivable.has(id)) {
        fail(`${at}.id is not re-derivable from the synthetic namespace — REFUSING`);
      }

      // studio binding on every row
      if (!eq(row.studio_id, target.studio_id)) {
        fail(`${at}.studio_id does not match the plan target — REFUSING`);
      }

      // contact fields that must be null
      for (const col of MUST_BE_NULL[name] ?? []) {
        if (row[col] !== null && row[col] !== undefined) {
          fail(`${at}.${col} must be null (provider-safety invariant) — REFUSING`);
        }
      }

      // closed value vocabularies
      for (const [col, vals] of Object.entries(ALLOWED_VALUES[name] ?? {})) {
        if (col in row && !vals.includes(row[col])) {
          fail(`${at}.${col} has value ${JSON.stringify(row[col])} outside the allowed set`);
        }
      }

      // foreign keys must point inside the generated/allowed universe
      if ("client_id" in row && !clientIds.has(String(row.client_id).toLowerCase())) {
        fail(`${at}.client_id references a client outside this plan — REFUSING`);
      }
      if ("practitioner_id" in row && row.practitioner_id !== null &&
          !eq(row.practitioner_id, expected.practitionerId)) {
        fail(`${at}.practitioner_id is not the configured target practitioner — REFUSING`);
      }
      if ("service_id" in row && row.service_id !== null &&
          !allowedServices.has(String(row.service_id).toLowerCase())) {
        fail(`${at}.service_id is not one of the target studio's services — REFUSING`);
      }
      // A session may chart only an appointment this same plan creates, and a
      // block may belong only to a session this same plan creates. Without
      // these the executor could be handed a row pointing at an EXISTING
      // (possibly real) appointment or session in the target studio.
      if ("appointment_id" in row && row.appointment_id !== null &&
          !appointmentIds.has(String(row.appointment_id).toLowerCase())) {
        fail(`${at}.appointment_id references an appointment outside this plan — REFUSING`);
      }
      if ("session_id" in row && !sessionIds.has(String(row.session_id).toLowerCase())) {
        fail(`${at}.session_id references a session outside this plan — REFUSING`);
      }
    });
  }

  if (total > CEILINGS.total) {
    fail(`plan has ${total} rows, above the total ceiling ${CEILINGS.total}`);
  }

  // --- expected counts must match what is actually present ---------------
  const counts = body.expected_counts ?? {};
  for (const name of ENTITY_ORDER) {
    if (!(name in counts)) continue;
    const actual = (entities[name] ?? []).length;
    if (counts[name] !== actual) {
      fail(`expected_counts.${name} is ${counts[name]} but the plan carries ${actual} rows`);
    }
  }

  // --- nothing that smells of source identity or a provider --------------
  //
  // Scanned over the DATA-BEARING sections only. `safety_assertions` and
  // `expected_counts` are excluded because both have closed key sets that are
  // verified exactly above, so neither can smuggle anything — and including
  // them produced a false positive against this very rule: the assertion key
  // `no_source_identifiers` literally contains "source_id". A guard that fires
  // on its own vocabulary trains the next author to delete the guard.
  const scanned = JSON.stringify({
    namespace: body.namespace,
    target: body.target,
    source_profile: body.source_profile,
    entities: body.entities,
  }).toLowerCase();
  for (const forbidden of FORBIDDEN_PLAN_KEYS) {
    if (scanned.includes(forbidden)) {
      fail(`plan contains forbidden term "${forbidden}" — REFUSING`);
    }
  }

  // --- safety assertions must be present and true ------------------------
  const sa = body.safety_assertions ?? {};
  for (const k of ["contact_fields_null", "all_ids_derivable", "no_source_identifiers", "payments_excluded"]) {
    if (sa[k] !== true) fail(`safety_assertions.${k} must be true`);
  }

  return v;
}

/**
 * Verify a RESET nomination: every id must be re-derivable for the pinned
 * target. A single unprovable id refuses the whole request rather than being
 * dropped from it, so a partially-tampered list can never be half-executed.
 */
export function verifyResetSelection(selection, expected) {
  const v = [];
  if (typeof selection !== "object" || selection === null) return ["reset selection is not an object"];

  for (const name of Object.keys(selection)) {
    if (!ENTITY_ORDER.includes(name)) v.push(`unknown entity "${name}" in reset selection — REFUSING`);
  }
  for (const name of ENTITY_ORDER) {
    const ids = selection[name];
    if (ids === undefined) continue;
    if (!Array.isArray(ids)) { v.push(`reset selection ${name} is not an array`); continue; }
    const identity = ENTITY_IDENTITY[name];
    const derivable = new Set();
    for (let i = 0; i < ORDINAL_CEILING; i += 1) {
      derivable.add(deriveSyntheticId(expected.targetStudioId, identity, i));
    }
    for (const id of ids) {
      if (!isVersion8Uuid(String(id)) || !derivable.has(String(id))) {
        v.push(`reset selection ${name} contains a non-derivable id — REFUSING the whole request`);
        break;
      }
    }
  }
  return v;
}
