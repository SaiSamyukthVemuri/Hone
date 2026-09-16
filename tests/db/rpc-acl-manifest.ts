import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// Reviewed expectation manifest — browser-reachable SECURITY DEFINER commands
// ===========================================================================
//
// WHY THIS EXISTS AS DATA RATHER THAN AS A PARSER.
//
// The predecessor of this file tried to derive the final ACL of every function
// by reading the migration chain with regexes. Codex raised three P1s against
// it and all three had real instances here: it accumulated historical GRANT and
// REVOKE statements instead of modelling final state (54 fn+role pairs in this
// chain end in a grant after a revoke); it keyed functions by bare name, so the
// 9 overloaded names collapsed together; and it attributed the role templates of
// a whole DO block to every signature in it, though 13 blocks contain more than
// one loop. Two further shapes made the approach unsound in principle rather
// than merely incomplete: 39 DO blocks are conditional, so whether an ACL
// statement ran cannot be decided without executing it, and matching a loop's
// signature array to a declaration requires reimplementing
// pg_get_function_identity_arguments.
//
// So the authority moved: PostgreSQL interprets PostgreSQL. The oracle in
// tests/db/rpc-acl-oracle.db.test.ts reads pg_proc on a fully migrated database
// and compares the REAL final privileges against the reviewed expectations
// below. This file is the reviewed half — a human decision per command, not an
// inference.
//
// IDENTITY. Keyed by `schema.name(argtypes)` built from
// `oidvectortypes(proargtypes)`. Overloads are distinct rows, which is why
// start_session appears twice. Parameter NAMES are deliberately excluded so a
// rename is not a manifest change; argument TYPES are what identify a function.
//
// SCOPE. Every schema PostgREST is configured to expose, read from
// supabase/config.toml rather than assumed. Hard-coding `public` meant that
// exposing a schema in configuration alone — no migration, no new function —
// would silently drop it from coverage.
//
// WHAT THIS MANIFEST DOES NOT SAY. It records PRIVILEGE POSTURE: who may
// execute what. It does not certify that a command authorises its caller
// correctly. Those are different claims and only the first is provable from the
// catalog. Actor correctness is proved behaviourally, by tests that call a
// command as the wrong actor and assert the refusal — see
// tests/db/session-write-commands.db.test.ts,
// tests/db/cross-studio-isolation.db.test.ts and
// tests/db/session-block-electrolysis-commands.db.test.ts. An earlier revision
// of this suite tried to infer actor gating from `auth.uid()` appearing in a
// body or in a callee's name. Textual occurrence is not enforcement — a
// function that merely stamps auth.uid() into an audit column would have been
// certified — so that claim is gone rather than weakened.
//
// ADDING A COMMAND. A newly exposed command fails the oracle until it is listed
// here. That failure is the point: exposing a privileged command to a browser
// role should be a reviewed decision, not a default inherited from Supabase's
// ALTER DEFAULT PRIVILEGES.

export type RolePosture = {
  /** PUBLIC, i.e. every role including anon. */
  public: boolean;
  anon: boolean;
  authenticated: boolean;
  serviceRole: boolean;
};

export type ManifestEntry = {
  /** public.name(argtypes) — overload-distinguishing. */
  identity: string;
  posture: RolePosture;
  /** Required whenever anon may execute. */
  anonWhy?: string;
  /** Why service_role may execute, when that was a deliberate decision. */
  serviceRoleWhy?: string;
  /**
   * service_role can execute, and the intended posture has NOT been audited.
   * Carried as named debt rather than blessed: see LEGACY_SERVICE_ROLE_DEBT.
   */
  serviceRoleLegacyDebt?: true;
};

export const RPC_ACL_MANIFEST: readonly ManifestEntry[] = [
  {
    identity: "public.add_electrolysis_pass(uuid, uuid, uuid, jsonb, text, text[], text, uuid, text, numeric, numeric, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.archive_treatment_image(uuid, uuid)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.create_block_with_entry(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.create_laser_entry(uuid, uuid, text, integer, jsonb, text)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.create_session_block_with_areas(uuid, uuid, jsonb, jsonb)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleWhy: "declared by an explicit grant in its creating migration",
  },
  {
    identity: "public.create_treatment_image_metadata(uuid, uuid, uuid, uuid, text, text, text, text, bigint)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.edit_session_started_at(uuid, uuid, timestamp with time zone)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.get_appointment_payment_display(uuid, uuid)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleLegacyDebt: true,
  },
  {
    identity: "public.get_disputes_for_studio(uuid)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleLegacyDebt: true,
  },
  {
    identity: "public.get_payment_audit_for_appointment(uuid, uuid)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleLegacyDebt: true,
  },
  {
    identity: "public.get_refunds_for_appointment(uuid, uuid)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleLegacyDebt: true,
  },
  {
    identity: "public.get_studio_payment_settings_display(uuid, boolean)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleLegacyDebt: true,
  },
  {
    identity: "public.is_studio_member(uuid)",
    posture: { public: false, anon: true, authenticated: true, serviceRole: true },
    anonWhy:
      "0001 membership predicate: resolves through auth.uid(), so an anonymous caller can only ever receive false",
    serviceRoleLegacyDebt: true,
  },
  {
    identity: "public.is_studio_owner(uuid)",
    posture: { public: false, anon: true, authenticated: true, serviceRole: true },
    anonWhy:
      "0001 ownership predicate: resolves through auth.uid(), so an anonymous caller can only ever receive false",
    serviceRoleLegacyDebt: true,
  },
  {
    identity: "public.my_pending_invitation()",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleWhy: "declared by an explicit grant in its creating migration",
  },
  {
    identity: "public.reconcile_my_pending_invitation()",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleWhy: "declared by an explicit grant in its creating migration",
  },
  {
    identity: "public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.reorder_studio_service(uuid, uuid, text, integer)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleWhy: "declared by an explicit grant in its creating migration",
  },
  {
    identity: "public.session_is_visible(uuid)",
    posture: { public: false, anon: true, authenticated: true, serviceRole: true },
    anonWhy:
      "0001 visibility predicate: resolves through auth.uid(), so an anonymous caller can only ever receive false",
    serviceRoleLegacyDebt: true,
  },
  {
    identity: "public.set_next_session_note(uuid, uuid, text)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.set_own_calendar_feed_token_hash(uuid, text)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.set_own_default_machine_frequency(uuid, text)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.set_session_aftercare_explained(uuid, boolean)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.set_session_performer(uuid, uuid, uuid)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.set_session_price(uuid, uuid, integer)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.set_session_treatment_plan(uuid, uuid, uuid)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.set_treatment_image_note(uuid, uuid, text)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.show_studio_service(uuid, uuid)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleWhy: "declared by an explicit grant in its creating migration",
  },
  {
    identity: "public.soft_delete_session(uuid, uuid, text)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.soft_delete_session_area(uuid, uuid, text)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleLegacyDebt: true,
  },
  {
    identity: "public.soft_delete_session_block(uuid, uuid, uuid, text)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.start_session(uuid, text, uuid, integer)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.start_session(uuid, text, uuid, integer, uuid)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.supersede_appointment_settlement(uuid, uuid, text, integer, text, text, boolean)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.update_block_with_entry(uuid, uuid, uuid, jsonb, jsonb, jsonb, timestamp with time zone, boolean, uuid, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.update_own_practitioner_profile(uuid, text, text)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.update_session_block_with_areas(uuid, uuid, uuid, jsonb, jsonb, timestamp with time zone)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleWhy: "declared by an explicit grant in its creating migration",
  },
  {
    identity: "public.waive_appointment_fee(uuid, uuid, integer, text, boolean)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: false },
  },
  {
    identity: "public.whole_session_copy_source_descriptor(uuid, uuid)",
    posture: { public: false, anon: false, authenticated: true, serviceRole: true },
    serviceRoleWhy: "declared by an explicit grant in its creating migration",
  },];

/**
 * Commands whose service_role EXECUTE is inherited rather than decided. Their
 * exploitability was NOT investigated — doing so would have meant auditing the
 * payment-display and soft-delete surfaces, which is a separate piece of work.
 * They are named so the debt is visible and cannot grow silently.
 */
export const LEGACY_SERVICE_ROLE_DEBT: readonly string[] = RPC_ACL_MANIFEST.filter(
  (e) => e.serviceRoleLegacyDebt === true,
).map((e) => e.identity);

/**
 * The schemas PostgREST is configured to expose, read from supabase/config.toml.
 *
 * Deliberately a narrow reader for one key in one section, not a TOML parser:
 * it must fail loudly rather than quietly default, because a silent default is
 * exactly the failure this replaced. Reading a configured list is not the same
 * kind of act as interpreting SQL — the value is data, and this is the file
 * that owns it.
 */
export function exposedSchemas(): string[] {
  const raw = readFileSync(join(process.cwd(), "supabase/config.toml"), "utf8");
  const lines = raw.split("\n");
  let inApi = false;
  for (const line of lines) {
    const text = line.replace(/#.*$/, "").trim();
    if (/^\[[^\]]+\]$/.test(text)) {
      inApi = text === "[api]";
      continue;
    }
    if (!inApi) continue;
    const m = /^schemas\s*=\s*\[(.*)\]$/.exec(text);
    if (!m) continue;
    const schemas = m[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);
    if (schemas.length === 0) break;
    return schemas;
  }
  throw new Error(
    "supabase/config.toml has no [api] schemas list. The ACL oracle refuses to " +
      "guess which schemas are browser-exposed.",
  );
}
