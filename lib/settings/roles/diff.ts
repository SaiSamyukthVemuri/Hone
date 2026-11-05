import {
  CATALOG,
  FIXED_OWNER_ONLY,
  effectiveScope,
  scopeRank,
  type PermissionDef,
  type Role,
  type Scope,
  type StudioPolicy,
} from "@/lib/permissions/catalog";
import { groupLabel } from "./model";

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

// "narrows": a practitioner loses access they have today. "safeguard": a rule that applies from the release without taking a
// practitioner's own access away (public endpoints, read state, flags). The permission core should say which (asked of Team,
// field `practitioner_access`); until it does, `narrowingKind` falls back to the ids known to be true losses.
export type NarrowingKind = "narrows" | "safeguard";
export type FixedNarrowing = { id: string; label: string; note: string | null; kind: NarrowingKind };

export type RoleDiff = {
  changes: RoleChange[];
  // Fixed owner-only items that take today's access AWAY from existing staff when the studio adopts (the catalog's existingEffect
  // 'narrows'). They are not keys, so the key comparison cannot see them; the owner must be told (Codex P2 on #1335).
  fixedNarrowings: FixedNarrowing[];
  widened: number;
  narrowed: number;
  newlyEnabledSensitive: number;
};

// What the enforcement release will take away from existing practitioners, whatever the owner does on this page. These are fixed
// owner-only items, so they are not keys and no setting can keep them. Shown as a standing notice (DN-25), not only in a preview.
export function releaseNarrowings(): FixedNarrowing[] {
  return FIXED_OWNER_ONLY.filter((f) => f.existingEffect === "narrows").map((f) => ({ id: f.id, label: f.label, note: f.note ?? null, kind: "narrows" as const }));
}

// TEMPORARY fallback until the core sends `practitioner_access`: the release narrowings that do take a practitioner's own access away.
const KNOWN_PRACTITIONER_LOSSES = new Set(["performer_change", "exposure_incident_history", "colleague_private_fields"]);
export function narrowingKind(id: string, fromCore: unknown): NarrowingKind {
  if (fromCore === "narrows" || fromCore === "safeguard") return fromCore;
  return KNOWN_PRACTITIONER_LOSSES.has(id) || releaseNarrowings().some((f) => f.id === id) ? "narrows" : "safeguard";
}

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
      groupLabel: groupLabel(d.group),
      from,
      to,
      direction: widens ? "widens" : "narrows",
      newlyEnabledSensitive: widens && d.sensitive === true,
      futureBusiness: d.affectsFutureStudioBusiness === true,
    });
  }
  const fixedNarrowings: FixedNarrowing[] =
    role === "practitioner" && before.basis === "existing_snapshot" && after.basis === "new_studio"
      ? releaseNarrowings()
      : [];
  return {
    changes,
    fixedNarrowings,
    widened: changes.filter((c) => c.direction === "widens").length,
    narrowed: changes.filter((c) => c.direction === "narrows").length,
    newlyEnabledSensitive: changes.filter((c) => c.newlyEnabledSensitive).length,
  };
}

/** The policy Reset to defaults and Adopt would set: the new-studio basis with no stored overrides. Gates stay as the operator set them. */
export const defaultsPolicy = (current: StudioPolicy): StudioPolicy => ({ basis: "new_studio", values: {}, gates: current.gates });
