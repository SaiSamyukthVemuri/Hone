import {
  CATALOG,
  GATES,
  GROUPS,
  catalogByKey,
  checkChange,
  effectiveScope,
  scopeRank,
  scopesFor,
  type PermissionDef,
  type Role,
  type Scope,
  type StudioPolicy,
} from "@/lib/permissions/catalog";

// The Roles page's view model (R2). PURE: it reads the one permission catalog and a studio policy and says what the page shows
// and what each control may do. It never decides a permission itself: prerequisites, scopes and ship gates all come from the
// catalog's own helpers, so the page, the server and the database cannot drift. Setting one key never changes another.

export const ROLE_LABELS: Record<Role, string> = { practitioner: "Practitioner", receptionist: "Receptionist" };

// Page order is the catalog's GROUPS order; a group the catalog adds later falls back to a readable label and is shown last.
export const GROUP_LABELS: Record<string, string> = {
  appointments: "Appointments",
  clients_identity: "Clients and identity",
  clinical_records: "Clinical records",
  communications: "Communications",
  payments: "Payments",
  pricing: "Pricing",
  availability: "Availability",
  reports: "Reports",
  waitlist_operations: "Waitlist: entries",
  waitlist_rules: "Waitlist: rules and automation",
  accepting_new_clients: "Accepting new clients",
};

// A group the catalog adds before this map learns it still reads as words, never as an id.
export const groupLabel = (group: string): string => {
  if (GROUP_LABELS[group]) return GROUP_LABELS[group];
  const words = group.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const SCOPE_LABELS: Record<Scope, string> = { off: "Off", own: "Own assigned", studio: "Whole studio" };
// A boolean key is Off / On: "Whole studio" means nothing for a switch.
export const scopeLabel = (d: PermissionDef, scope: Scope): string =>
  d.scopes.length === 2 ? (scope === "off" ? "Off" : "On") : SCOPE_LABELS[scope];

export type OptionState = { scope: Scope; label: string; selected: boolean; disabled: boolean; reason: string | null };

export type RoleRow = {
  key: string;
  label: string;
  description: string;
  ownMeaning: string | null;
  chosen: Scope; // what the owner has set (or the basis value)
  effective: Scope; // what is actually in force after prerequisites and gates
  inactiveBecause: string | null; // set when effective is lower than chosen
  options: OptionState[];
  locked: string | null; // why no control is offered at all
  futureBusiness: boolean;
  sensitive: boolean;
  pendingDecision: boolean;
  gateNote: string | null;
  needs: string[]; // labels of prerequisites
  alsoSwitchesOff: string[]; // labels of dependents that follow this key down (their stored values are kept)
};

export type RoleGroupModel = { group: string; label: string; rows: RoleRow[] };

const isPending = (d: PermissionDef): boolean => (d as { pendingDecision?: boolean }).pendingDecision === true;

const dependentsOf = (key: string, role: Role): PermissionDef[] =>
  (CATALOG as readonly PermissionDef[]).filter((d) => d.requires.includes(key) && d.offeredTo[role]);

export function buildRoleModel(role: Role, policy: StudioPolicy): RoleGroupModel[] {
  const defs = CATALOG as readonly PermissionDef[];
  const order = [...GROUPS, ...Array.from(new Set(defs.map((d) => d.group))).filter((g) => !(GROUPS as readonly string[]).includes(g))];
  const out: RoleGroupModel[] = [];
  for (const group of order) {
    const rows: RoleRow[] = [];
    for (const d of defs.filter((x) => x.group === group)) {
      const chosen: Scope = policy.values[d.key] ?? (policy.basis === "new_studio" ? d.newStudioDefault[role] : d.existingSnapshot[role]);
      const effective = effectiveScope(role, d.key, policy);
      const locked = !d.ownerConfigurable
        ? "A fixed part of this role. It is not a switch."
        : !d.offeredTo[role]
          ? `Not offered to ${ROLE_LABELS[role].toLowerCase()}s in this version.`
          : null;
      const options: OptionState[] = scopesFor(d, role).map((scope) => {
        const check = scope === chosen || locked ? ({ ok: true } as const) : checkChange(role, d.key, scope, policy);
        return {
          scope,
          label: scopeLabel(d, scope),
          selected: scope === chosen,
          disabled: locked !== null || !check.ok,
          reason: check.ok ? null : check.reason,
        };
      });
      const dependents = dependentsOf(d.key, role).filter((x) => effectiveScope(role, x.key, policy) !== "off");
      const gate = d.shipGate?.[role];
      rows.push({
        key: d.key,
        label: d.label,
        description: d.description,
        ownMeaning: d.scopes.includes("own") && role === "practitioner" ? (d.own ?? null) : null,
        chosen,
        effective,
        inactiveBecause:
          scopeRank(effective) < scopeRank(chosen)
            ? gate && policy.gates?.[gate] !== true && scopeRank(chosen) > scopeRank(d.existingSnapshot[role])
              ? `Not yet available: ${GATES[gate]}.`
              : `Needs ${d.requires.map((r) => catalogByKey.get(r)?.label ?? r).join(", ")} turned on first.`
            : null,
        options,
        locked,
        futureBusiness: d.affectsFutureStudioBusiness === true,
        sensitive: d.sensitive === true,
        pendingDecision: isPending(d),
        gateNote: gate && policy.gates?.[gate] !== true ? GATES[gate] : null,
        needs: d.requires.map((r) => catalogByKey.get(r)?.label ?? r),
        alsoSwitchesOff: dependents.map((x) => x.label),
      });
    }
    if (rows.length > 0) out.push({ group, label: groupLabel(group), rows });
  }
  return out;
}

/** Apply one owner edit to a draft. It changes ONLY that key, and only when the catalog allows it; otherwise it returns the refusal. */
export function applyEdit(
  role: Role,
  policy: StudioPolicy,
  key: string,
  next: Scope,
): { ok: true; policy: StudioPolicy } | { ok: false; reason: string } {
  const current = policy.values[key];
  if (current === next) return { ok: true, policy };
  const def = catalogByKey.get(key);
  const basisValue = def ? (policy.basis === "new_studio" ? def.newStudioDefault[role] : def.existingSnapshot[role]) : undefined;
  if (current === undefined && basisValue === next) return { ok: true, policy };
  const check = checkChange(role, key, next, policy);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, policy: { ...policy, values: { ...policy.values, [key]: next } } };
}
