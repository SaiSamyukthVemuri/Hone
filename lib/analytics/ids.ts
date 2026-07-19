// Opaque analytics identifier boundary (Correction 2).
//
// Every distinctId that reaches PostHog must be an opaque UUID (or the
// `studio:<uuid>` derivative) — never an email, phone, bearer token,
// token-bearing path, client name, or free text. The previous API accepted
// `distinctId: string`, which is NOT enforcement: any string typechecks.
//
// This module enforces two ways:
//   1. Type level — callers pass a discriminated `AnalyticsActor`
//      ({ kind: "user" | "studio"; id }), so a bare string cannot be handed in
//      as a distinctId by accident.
//   2. Runtime — `resolveDistinctId` validates the id is a UUID and returns a
//      branded `AnalyticsDistinctId`, or `null` if it is not. It FAILS CLOSED
//      (invalid -> null -> caller drops the event) and NEVER THROWS, so a bad
//      id can never affect a product path. It never returns or logs the
//      rejected value.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnalyticsActor =
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "studio"; readonly id: string };

declare const distinctIdBrand: unique symbol;
/** A validated, opaque analytics distinct id. Only produced by resolveDistinctId. */
export type AnalyticsDistinctId = string & {
  readonly [distinctIdBrand]: "AnalyticsDistinctId";
};

/** True iff `id` is a bare UUID. Non-throwing. */
export function isAnalyticsUuid(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

/**
 * Resolve an actor to an opaque distinct id, or null if its id is not a UUID.
 * Never throws; never surfaces the rejected value.
 */
export function resolveDistinctId(
  actor: AnalyticsActor,
): AnalyticsDistinctId | null {
  if (!isAnalyticsUuid(actor.id)) return null;
  const value = actor.kind === "studio" ? `studio:${actor.id}` : actor.id;
  return value as AnalyticsDistinctId;
}

// Coarse role enum permitted on a person profile (matches the practitioners
// CHECK constraint: role in ('owner','practitioner')). Anything else is dropped.
const ALLOWED_ROLES = new Set(["owner", "practitioner"]);

export type AnalyticsRole = "owner" | "practitioner";

/** Validate a coarse role enum, or null. Never throws. */
export function validateRole(role: unknown): AnalyticsRole | null {
  return typeof role === "string" && ALLOWED_ROLES.has(role)
    ? (role as AnalyticsRole)
    : null;
}
