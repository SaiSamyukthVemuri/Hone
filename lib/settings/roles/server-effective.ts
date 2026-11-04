import { catalogByKey, effectiveScope, enforcementOf, scopeRank, type Role, type Scope, type StudioPolicy } from "@/lib/permissions/catalog";

// The core's own answer for what is in force, carried beside the stored choices (get_role_permissions: `effective` and `source` per key).
//
// WHY. `effectiveScope` in the catalog is a TypeScript mirror of the resolver for the BASIS rules and the prerequisite cap. It cannot
// know the release rules (0287 activation rule): whether a key's enforcement is released yet, whether it is a `narrow` release, and
// whether the owner has activated it. Those live in per-studio database rows. So where the core has answered, the page shows the core's
// answer; the mirror is used only to describe an UNSAVED draft change, and never to claim more than the core says is in force.

export type ServerEffective = {
  /** The owner's saved choice per key, as the core returned it (absent = nothing stored). */
  stored: Record<string, Scope>;
  /** What is in force now, per key. */
  effective: Record<string, Scope>;
  /** Where the core says the base value came from: stored | default | snapshot | inactive_until_activated | unreleased. */
  source: Record<string, string>;
};

export type PolicyWithServer = StudioPolicy & { server?: ServerEffective };

/** A stored or default value exists but is inert until its key is released and the owner activates it. */
export function isInertUntilReleased(source: string | undefined): boolean {
  return source === "inactive_until_activated" || source === "unreleased";
}

/**
 * The effective scope the page should show for one key.
 * - No core answer: the mirror (the page then cannot save either).
 * - The key is inert (pending release or activation): the core's value. A draft cannot change it.
 * - The draft leaves this key's saved choice alone: the core's value.
 * - The draft changed this key: the mirror, but never above what the core says is in force for a key that cannot widen yet.
 * Prerequisites follow the key down in the mirror, so a draft that turns a prerequisite off lowers its dependents here too.
 */
export function shownEffectiveScope(role: Role, key: string, policy: PolicyWithServer): Scope {
  const mirror = effectiveScope(role, key, policy);
  const s = policy.server;
  const inForce = s?.effective[key];
  if (!s || inForce === undefined) return mirror;
  if (isInertUntilReleased(s.source[key])) return inForce;
  if (policy.values[key] === s.stored[key] && !prerequisiteChanged(role, key, policy, s)) return inForce;
  return scopeRank(mirror) > scopeRank(inForce) && enforcementOf(key) === "deny_only" ? inForce : mirror;
}

function prerequisiteChanged(role: Role, key: string, policy: PolicyWithServer, s: ServerEffective, seen = new Set<string>()): boolean {
  const def = catalogByKey.get(key);
  if (!def || seen.has(key)) return false;
  seen.add(key);
  return def.requires.some((r) => policy.values[r] !== s.stored[r] || prerequisiteChanged(role, r, policy, s, seen));
}

/** `discard` lists the roles whose saved choice differs from the studio's basis: those can be put back (an ordinary previewed save). */
export type PendingActivation = { key: string; label: string; roles: Role[]; discard: { role: Role; basis: Scope }[] };

/**
 * Keys the core holds a value for that are released but not yet activated by the owner (`inactive_until_activated`), with the roles
 * affected. `unreleased` keys are not here: nothing can activate them. Order follows the catalog so the list reads the same every time.
 */
export function pendingActivations(policies: Record<Role, PolicyWithServer>): PendingActivation[] {
  const out = new Map<string, Role[]>();
  for (const role of ["practitioner", "receptionist"] as const) {
    for (const [key, source] of Object.entries(policies[role]?.server?.source ?? {})) {
      if (source !== "inactive_until_activated") continue;
      out.set(key, [...(out.get(key) ?? []), role]);
    }
  }
  return [...out.entries()]
    .map(([key, roles]) => {
      const def = catalogByKey.get(key);
      const discard = roles.flatMap((role) => {
        const pol = policies[role];
        const basis = def ? (pol.basis === "new_studio" ? def.newStudioDefault[role] : def.existingSnapshot[role]) : undefined;
        const stored = pol.values[key];
        return basis !== undefined && stored !== undefined && stored !== basis ? [{ role, basis }] : [];
      });
      return { key, label: def?.label ?? key, roles, discard };
    })
    .sort((x, y) => x.label.localeCompare(y.label) || x.key.localeCompare(y.key));
}
