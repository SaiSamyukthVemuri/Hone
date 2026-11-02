import {
  CATALOG,
  effectiveScope,
  scopeRank,
  type PermissionDef,
  type Role,
  type Scope,
  type StudioPolicy,
} from "@/lib/permissions/catalog";
import { GROUP_LABELS } from "./model";

// Before/after for Reset to defaults, the existing-studio review and Save. PURE. It compares EFFECTIVE scopes (what is in force),
// so a dependent that follows its prerequisite down shows as a change too, and a newly enabled sensitive key is flagged.

export type RoleChange = {
  key: string;
  label: string;
  group: string;
  groupLabel: string;
  from: Scope;
  to: Scope;
  direction: "widens" | "narrows";
  // Newly enabled access the owner must see: a sensitive key (financial, clinical, identity, bulk) going up.
  newlyEnabledSensitive: boolean;
  futureBusiness: boolean;
};

export type RoleDiff = {
  changes: RoleChange[];
  widened: number;
  narrowed: number;
  newlyEnabledSensitive: number;
};

export function diffPolicies(role: Role, before: StudioPolicy, after: StudioPolicy): RoleDiff {
  const changes: RoleChange[] = [];
  for (const d of CATALOG as readonly PermissionDef[]) {
    if (!d.offeredTo[role] && !d.ownerConfigurable) continue;
    const from = effectiveScope(role, d.key, before);
    const to = effectiveScope(role, d.key, after);
    if (from === to) continue;
    const widens = scopeRank(to) > scopeRank(from);
    changes.push({
      key: d.key,
      label: d.label,
      group: d.group,
      groupLabel: GROUP_LABELS[d.group] ?? d.group,
      from,
      to,
      direction: widens ? "widens" : "narrows",
      newlyEnabledSensitive: widens && d.sensitive === true,
      futureBusiness: d.affectsFutureStudioBusiness === true,
    });
  }
  return {
    changes,
    widened: changes.filter((c) => c.direction === "widens").length,
    narrowed: changes.filter((c) => c.direction === "narrows").length,
    newlyEnabledSensitive: changes.filter((c) => c.newlyEnabledSensitive).length,
  };
}

/** The policy Reset to defaults and Adopt would set: the new-studio basis with no stored overrides. Gates stay as the operator set them. */
export const defaultsPolicy = (current: StudioPolicy): StudioPolicy => ({ basis: "new_studio", values: {}, gates: current.gates });
