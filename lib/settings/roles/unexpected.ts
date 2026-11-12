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

/**
 * After an uncertain save the page shows the permissions as they are NOW, with this owner's unsaved choices still on top. Only the keys
 * this owner actually changed (draft differs from the saved policy the draft was made against) are carried over; every other key takes
 * the fresh stored value. Keeping the whole old draft would make the next save "undo" another owner's concurrent change to a key this
 * owner never touched. A carried-over choice that already equals the fresh value is no longer an edit and drops out by itself. PURE.
 */
export function rebaseDrafts(
  drafts: Record<Role, StudioPolicy>,
  oldSaved: Record<Role, StudioPolicy>,
  fresh: Record<Role, StudioPolicy>,
): Record<Role, StudioPolicy> {
  const out = { ...fresh } as Record<Role, StudioPolicy>;
  for (const role of Object.keys(fresh) as Role[]) {
    const values = { ...fresh[role].values } as Record<string, Scope>;
    for (const [key, scope] of Object.entries(drafts[role].values) as [string, Scope][]) {
      if (oldSaved[role].values[key as keyof typeof oldSaved[Role]["values"]] !== scope) values[key] = scope;
    }
    out[role] = { ...fresh[role], values: values as unknown as StudioPolicy["values"] };
  }
  return out;
}

export const UNCERTAIN_SAVE_MESSAGE = "We couldn't confirm your change was saved. Review the current permissions below.";
