import type { Role, Scope, StudioPolicy } from "@/lib/permissions/catalog";

// A request that ends in "unexpected" may or may not have committed. The page reads the policy back, and a moved version alone proves
// nothing: another writer can commit while our request fails. Success is claimed only when the reloaded choices equal the exact set
// this operation attempted. PURE.

export type AttemptedEdits = Partial<Record<Role, Record<string, Scope>>>;

export type UnexpectedOutcome = "unreadable" | "unchanged" | "landed" | "uncertain";

/** True only for a non-empty attempt every key of which is stored exactly as attempted. */
export function attemptLanded(attempted: AttemptedEdits | null, policies: Record<Role, StudioPolicy>): boolean {
  if (!attempted) return false;
  let any = false;
  for (const [role, edits] of Object.entries(attempted) as [Role, Record<string, Scope>][]) {
    for (const [key, scope] of Object.entries(edits)) {
      any = true;
      if (policies[role]?.values[key] !== scope) return false;
    }
  }
  return any;
}

/**
 * `attempted` is null for operations whose resulting set the page cannot state (reset, adopt): a moved version is then never proof.
 * A revocation (narrowing) is judged the same way as a widening.
 */
export function classifyUnexpected(args: {
  boundVersion: number;
  attempted: AttemptedEdits | null;
  fresh: { version: number; policies: Record<Role, StudioPolicy> } | null;
}): UnexpectedOutcome {
  if (!args.fresh) return "unreadable";
  if (args.fresh.version === args.boundVersion) return "unchanged";
  return attemptLanded(args.attempted, args.fresh.policies) ? "landed" : "uncertain";
}

export const UNCERTAIN_SAVE_MESSAGE = "We couldn't confirm your change was saved. Review the current permissions below.";
